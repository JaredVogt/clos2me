#!/usr/bin/env node

import express from "express"
import cors from "cors"
import multer from "multer"
import { spawn } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"
import dotenv from "dotenv"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()

// Load .env from repo root and local clos-viz (local overrides root)
dotenv.config({ path: path.join(__dirname, "..", ".env") })
dotenv.config({ path: path.join(__dirname, ".env"), override: true })

const rawPort = process.env.PORT || process.env.API_PORT
const parsedPort = rawPort ? parseInt(rawPort, 10) : NaN
const PORT = Number.isFinite(parsedPort) ? parsedPort : 4121

const ROUTES_DIR = path.join(__dirname, "public", "routes")
const STATES_DIR = path.join(__dirname, "public", "states")
const ROUTER_PATH = path.join(__dirname, "..", "clos_mult_router")

// Cache last fabric state for stability preservation
let lastState = null
let lastLocks = []

// Current crossbar size (default 10)
let currentSize = 10

let activeRun = null
let runCounter = 0

const progressRegex = /PROGRESS:\s+(\d+)\s+attempts in\s+(\d+)s\s+\(depth=(\d+)\/(\d+),\s+best_cost=([-\d]+)\)/

function beginRun(child, tmpFiles = []) {
  if (activeRun && activeRun.status === "running") {
    return null
  }

  runCounter += 1
  activeRun = {
    id: runCounter,
    child,
    startTime: Date.now(),
    status: "running",
    cancelled: false,
    tmpFiles,
    onCancel: null,
    progress: {
      attemptsTotal: 0n,
      depth: null,
      maxDepth: null,
      bestCost: null,
      lastStatsLine: null
    }
  }

  return activeRun
}

function cleanupRun(run) {
  for (const file of run.tmpFiles || []) {
    try {
      if (fs.existsSync(file)) fs.unlinkSync(file)
    } catch (err) {
      console.error(`Failed to remove temp file ${file}:`, err.message)
    }
  }
}

function finishRun(run) {
  if (!run) return
  cleanupRun(run)
  if (activeRun && activeRun.id === run.id) {
    activeRun = null
  }
}

function updateRunProgress(run, line) {
  if (!run) return
  const trimmed = line.replace(/^\[S\]\s*/, "").trim()
  if (!trimmed) return

  if (trimmed.includes("PROGRESS:")) {
    const match = progressRegex.exec(trimmed)
    if (match) {
      const attempts = BigInt(match[1])
      run.progress.attemptsTotal += attempts
      run.progress.depth = parseInt(match[3], 10)
      run.progress.maxDepth = parseInt(match[4], 10)
      run.progress.bestCost = parseInt(match[5], 10)
    }
  }

  if (trimmed.includes("STATS:")) {
    run.progress.lastStatsLine = trimmed
  }
}

function buildRunSummary(run) {
  const elapsedSeconds = Math.floor((Date.now() - run.startTime) / 1000)
  const attempts = run.progress.attemptsTotal > 0n ? run.progress.attemptsTotal.toString() : null
  return {
    attempts,
    elapsedSeconds,
    depth: run.progress.depth,
    maxDepth: run.progress.maxDepth,
    bestCost: run.progress.bestCost,
    lastStatsLine: run.progress.lastStatsLine
  }
}

// Parse router stdout into structured log entries
function parseRouterLog(stdout, state = {}) {
  const entries = []
  const timestamp = new Date().toISOString()

  // Extract fabric summary as a single entry
  const summaryStart = stdout.indexOf('=== Fabric Summary ===')
  let fabricSummaryText = null
  if (summaryStart !== -1) {
    fabricSummaryText = stdout.slice(summaryStart)
      .split('\n')
      .filter(l => l.trim())
      .join('\n')
  }

  // Only parse lines before the fabric summary
  const mainOutput = summaryStart !== -1 ? stdout.slice(0, summaryStart) : stdout
  const lines = mainOutput.split('\n').filter(line => line.trim())

  for (const line of lines) {
    const cleanLine = line.replace(/^\[S\]\s*/, '').trim()
    if (!cleanLine) continue
    let entry = null

    // Summary level entries
    if (cleanLine.includes('REPACK OK:') || cleanLine.includes('REPAIR OK:')) {
      entry = { level: 'summary', type: 'success', message: cleanLine }
    } else if (cleanLine.includes('STATS:')) {
      entry = { level: 'summary', type: 'info', message: cleanLine }
    } else if (cleanLine.includes('FAIL:')) {
      entry = { level: 'summary', type: 'error', message: cleanLine }
    } else if (cleanLine.startsWith('PROGRESS:')) {
      entry = { level: 'summary', type: 'info', message: cleanLine }
    }
    // Route level entries
    else if (cleanLine.includes('>> ROUTE:')) {
      entry = { level: 'route', type: 'info', message: cleanLine }
    } else if (cleanLine.includes('ROLLBACK:')) {
      entry = { level: 'route', type: 'warning', message: cleanLine }
    }
    // Detail level entries
    else if (cleanLine.includes('UNSAT DETAILS:') || cleanLine.includes('VALIDATION')) {
      entry = { level: 'detail', type: 'error', message: cleanLine }
    } else if (cleanLine.includes('Egress block') || cleanLine.includes('Ingress block')) {
      entry = { level: 'detail', type: 'info', message: cleanLine }
    } else if (cleanLine.startsWith('---')) {
      // Skip separator lines
      continue
    } else {
      // Other output as detail
      entry = { level: 'detail', type: 'info', message: cleanLine }
    }

    if (entry) {
      entries.push({ ...entry, timestamp })
    }
  }

  // Add summary info from state
  if (state.strict_stability !== undefined) {
    entries.unshift({
      level: 'summary',
      type: 'info',
      message: `Strict stability: ${state.strict_stability ? 'enabled' : 'disabled'}`,
      timestamp
    })
  }
  if (state.incremental !== undefined) {
    entries.unshift({
      level: 'summary',
      type: 'info',
      message: `Incremental repair: ${state.incremental ? 'enabled' : 'disabled'}`,
      timestamp
    })
  }
  if (state.stability_changes !== undefined && state.stability_changes > 0) {
    entries.push({
      level: 'summary',
      type: 'warning',
      message: `Stability changes: ${state.stability_changes} routes rerouted`,
      timestamp
    })
  }

  // Add fabric summary as single summary-level entry
  if (fabricSummaryText) {
    entries.push({
      level: 'summary',
      type: 'info',
      message: fabricSummaryText,
      timestamp
    })
  }

  return entries
}

// Ensure routes and states directories exist
if (!fs.existsSync(ROUTES_DIR)) {
  fs.mkdirSync(ROUTES_DIR, { recursive: true })
}
if (!fs.existsSync(STATES_DIR)) {
  fs.mkdirSync(STATES_DIR, { recursive: true })
}

app.use(cors())
app.use(express.json())

// Configure multer for route file uploads
const routeStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ROUTES_DIR),
  filename: (req, file, cb) => {
    // Sanitize filename and add size suffix
    let name = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")
    // Strip existing extensions to get base name
    const baseName = name.replace(/\.\d+\.txt$/, "").replace(/\.txt$/, "")
    // Add current size suffix
    const finalName = `${baseName}.${currentSize}.txt`
    cb(null, finalName)
  }
})
const upload = multer({ storage: routeStorage })

// Configure multer for state file uploads
const stateStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, STATES_DIR),
  filename: (req, file, cb) => {
    // Sanitize filename and add size suffix
    let name = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")
    // Strip existing extensions to get base name
    const baseName = name.replace(/\.\d+\.json$/, "").replace(/\.json$/, "")
    // Add current size suffix
    const finalName = `${baseName}.${currentSize}.json`
    cb(null, finalName)
  }
})
const uploadState = multer({ storage: stateStorage })

// GET /api/routes - List route files filtered by crossbar size
// Query param: ?size=10 (defaults to current size)
app.get("/api/routes", (req, res) => {
  try {
    const size = parseInt(req.query.size, 10) || currentSize
    const suffix = `.${size}.txt`

    const files = fs.readdirSync(ROUTES_DIR)
      .filter(f => f.endsWith(suffix))
      .sort()
    res.json({ files })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/routes/:filename - Return raw route file contents
app.get("/api/routes/:filename", (req, res) => {
  const { filename } = req.params
  const filepath = path.join(ROUTES_DIR, filename)

  // Security: ensure file is within ROUTES_DIR
  if (!filepath.startsWith(ROUTES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "Route file not found" })
  }

  try {
    const contents = fs.readFileSync(filepath, "utf-8")
    res.type("text/plain").send(contents)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/routes - Upload a new route file
app.post("/api/routes", upload.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" })
  }
  res.json({ filename: req.file.filename, message: "File uploaded successfully" })
})

// POST /api/routes/create - Create a new empty route file
// Body: { filename: "myroute", size?: 10 }
// Creates file as: myroute.{size}.txt
app.post("/api/routes/create", (req, res) => {
  const { filename, size } = req.body
  const targetSize = parseInt(size, 10) || currentSize

  if (!filename) {
    return res.status(400).json({ error: "No filename provided" })
  }

  // Strip any existing extensions for clean naming
  let baseName = filename.replace(/\.\d+\.txt$/, "").replace(/\.txt$/, "")

  // Validate base filename (alphanumeric, dashes, underscores)
  if (!/^[a-zA-Z0-9_-]+$/.test(baseName)) {
    return res.status(400).json({ error: "Invalid filename. Use only letters, numbers, dashes, and underscores." })
  }

  // Build final name with size suffix
  const finalName = `${baseName}.${targetSize}.txt`
  const filepath = path.join(ROUTES_DIR, finalName)

  // Security: ensure file is within ROUTES_DIR
  if (!filepath.startsWith(ROUTES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  // Check if file already exists
  if (fs.existsSync(filepath)) {
    return res.status(409).json({ error: "File already exists" })
  }

  try {
    fs.writeFileSync(filepath, "")
    res.json({ filename: finalName, success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/routes/:filename - Rename a route file
// Preserves the size suffix from the original filename
app.patch("/api/routes/:filename", (req, res) => {
  const { filename } = req.params
  const { newName } = req.body

  if (!newName) {
    return res.status(400).json({ error: "No new name provided" })
  }

  // Validate original filename
  if (filename.includes("..") || filename.includes("/")) {
    return res.status(400).json({ error: "Invalid filename" })
  }

  // Extract size from original filename (e.g., "test.10.txt" -> "10")
  const sizeMatch = filename.match(/\.(\d+)\.txt$/)
  const size = sizeMatch ? sizeMatch[1] : currentSize

  // Strip any extensions from new name to get base name
  const baseName = newName.replace(/\.\d+\.txt$/, "").replace(/\.txt$/, "")

  // Validate base name
  if (!/^[a-zA-Z0-9_-]+$/.test(baseName)) {
    return res.status(400).json({ error: "Invalid new filename. Use only letters, numbers, dashes, and underscores." })
  }

  // Build final name preserving size suffix
  const finalNewName = `${baseName}.${size}.txt`

  const oldPath = path.join(ROUTES_DIR, filename)
  const newPath = path.join(ROUTES_DIR, finalNewName)

  // Security: ensure both paths are within ROUTES_DIR
  if (!oldPath.startsWith(ROUTES_DIR) || !newPath.startsWith(ROUTES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  // Check source exists
  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ error: "File not found" })
  }

  // Check destination doesn't exist
  if (fs.existsSync(newPath) && oldPath !== newPath) {
    return res.status(409).json({ error: "A file with that name already exists" })
  }

  try {
    fs.renameSync(oldPath, newPath)
    res.json({ filename: finalNewName, success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/routes/:filename - Delete a route file
app.delete("/api/routes/:filename", (req, res) => {
  const filename = req.params.filename
  const filepath = path.join(ROUTES_DIR, filename)

  // Security: ensure file is within ROUTES_DIR
  if (!filepath.startsWith(ROUTES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath)
      res.json({ message: "File deleted" })
    } else {
      res.status(404).json({ error: "File not found" })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/routes/:filename - Update a route file with new routes
app.put("/api/routes/:filename", (req, res) => {
  const { filename } = req.params
  const { routes } = req.body

  // Validate filename (prevent path traversal)
  if (filename.includes("..") || filename.includes("/")) {
    return res.status(400).json({ error: "Invalid filename" })
  }

  const filepath = path.join(ROUTES_DIR, filename)

  // Security: ensure file is within ROUTES_DIR
  if (!filepath.startsWith(ROUTES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  // Check file exists
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "File not found" })
  }

  if (!routes || typeof routes !== "object") {
    return res.status(400).json({ error: "No routes provided" })
  }

  try {
    // Convert routes object to file format
    // Format: "input.output1.output2..."
    const lines = Object.entries(routes)
      .sort(([a], [b]) => Number(a) - Number(b))
      .map(([input, outputs]) => `${input}.${outputs.sort((a, b) => a - b).join(".")}`)

    fs.writeFileSync(filepath, lines.join("\n") + "\n")
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================================
// STATE FILE ENDPOINTS (JSON fabric states)
// ============================================================================

// GET /api/states - List state files filtered by crossbar size
// Query param: ?size=10 (defaults to current size)
app.get("/api/states", (req, res) => {
  try {
    const size = parseInt(req.query.size, 10) || currentSize
    const suffix = `.${size}.json`

    const files = fs.readdirSync(STATES_DIR)
      .filter(f => f.endsWith(suffix))
      .sort()
    res.json({ files })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// GET /api/states/:filename - Return state file contents
app.get("/api/states/:filename", (req, res) => {
  const { filename } = req.params
  const filepath = path.join(STATES_DIR, filename)

  // Security: ensure file is within STATES_DIR
  if (!filepath.startsWith(STATES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "State file not found" })
  }

  try {
    const contents = fs.readFileSync(filepath, "utf-8")
    res.type("application/json").send(contents)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/states - Upload a new state file
app.post("/api/states", uploadState.single("file"), (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: "No file uploaded" })
  }
  res.json({ filename: req.file.filename, message: "File uploaded successfully" })
})

// POST /api/states/create - Create a new state file with provided content
// Body: { filename: "mystate", size?: 10, state: {...} }
app.post("/api/states/create", (req, res) => {
  const { filename, size, state } = req.body
  const targetSize = parseInt(size, 10) || currentSize

  if (!filename) {
    return res.status(400).json({ error: "No filename provided" })
  }

  if (!state || typeof state !== "object") {
    return res.status(400).json({ error: "No state object provided" })
  }

  // Strip any existing extensions for clean naming
  let baseName = filename.replace(/\.\d+\.json$/, "").replace(/\.json$/, "")

  // Validate base filename
  if (!/^[a-zA-Z0-9_-]+$/.test(baseName)) {
    return res.status(400).json({ error: "Invalid filename. Use only letters, numbers, dashes, and underscores." })
  }

  // Build final name with size suffix
  const finalName = `${baseName}.${targetSize}.json`
  const filepath = path.join(STATES_DIR, finalName)

  // Security: ensure file is within STATES_DIR
  if (!filepath.startsWith(STATES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  // Check if file already exists
  if (fs.existsSync(filepath)) {
    return res.status(409).json({ error: "File already exists" })
  }

  try {
    fs.writeFileSync(filepath, JSON.stringify(state, null, 2))
    res.json({ filename: finalName, success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PUT /api/states/:filename - Update a state file with new content
app.put("/api/states/:filename", (req, res) => {
  const { filename } = req.params
  const { state } = req.body

  // Validate filename (prevent path traversal)
  if (filename.includes("..") || filename.includes("/")) {
    return res.status(400).json({ error: "Invalid filename" })
  }

  const filepath = path.join(STATES_DIR, filename)

  // Security: ensure file is within STATES_DIR
  if (!filepath.startsWith(STATES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  // Check file exists
  if (!fs.existsSync(filepath)) {
    return res.status(404).json({ error: "File not found" })
  }

  if (!state || typeof state !== "object") {
    return res.status(400).json({ error: "No state object provided" })
  }

  try {
    fs.writeFileSync(filepath, JSON.stringify(state, null, 2))
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH /api/states/:filename - Rename a state file
app.patch("/api/states/:filename", (req, res) => {
  const { filename } = req.params
  const { newName } = req.body

  if (!newName) {
    return res.status(400).json({ error: "No new name provided" })
  }

  // Validate original filename
  if (filename.includes("..") || filename.includes("/")) {
    return res.status(400).json({ error: "Invalid filename" })
  }

  // Extract size from original filename
  const sizeMatch = filename.match(/\.(\d+)\.json$/)
  const size = sizeMatch ? sizeMatch[1] : currentSize

  // Strip any extensions from new name to get base name
  const baseName = newName.replace(/\.\d+\.json$/, "").replace(/\.json$/, "")

  // Validate base name
  if (!/^[a-zA-Z0-9_-]+$/.test(baseName)) {
    return res.status(400).json({ error: "Invalid new filename. Use only letters, numbers, dashes, and underscores." })
  }

  // Build final name preserving size suffix
  const finalNewName = `${baseName}.${size}.json`

  const oldPath = path.join(STATES_DIR, filename)
  const newPath = path.join(STATES_DIR, finalNewName)

  // Security: ensure both paths are within STATES_DIR
  if (!oldPath.startsWith(STATES_DIR) || !newPath.startsWith(STATES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  // Check source exists
  if (!fs.existsSync(oldPath)) {
    return res.status(404).json({ error: "File not found" })
  }

  // Check destination doesn't exist
  if (fs.existsSync(newPath) && oldPath !== newPath) {
    return res.status(409).json({ error: "A file with that name already exists" })
  }

  try {
    fs.renameSync(oldPath, newPath)
    res.json({ filename: finalNewName, success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// DELETE /api/states/:filename - Delete a state file
app.delete("/api/states/:filename", (req, res) => {
  const filename = req.params.filename
  const filepath = path.join(STATES_DIR, filename)

  // Security: ensure file is within STATES_DIR
  if (!filepath.startsWith(STATES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  try {
    if (fs.existsSync(filepath)) {
      fs.unlinkSync(filepath)
      res.json({ message: "File deleted" })
    } else {
      res.status(404).json({ error: "File not found" })
    }
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ============================================================================
// SOLVER ENDPOINTS
// ============================================================================

// POST /api/process - Run router on a route file
app.post("/api/process", async (req, res) => {
  const { filename, size, incremental } = req.body

  if (!filename) {
    return res.status(400).json({ error: "No filename provided" })
  }

  // Update crossbar size if provided
  if (size !== undefined) {
    const s = parseInt(size, 10)
    if (s >= 2) {
      currentSize = s
    }
  }

  const routePath = path.join(ROUTES_DIR, filename)

  // Security: ensure file is within ROUTES_DIR
  if (!routePath.startsWith(ROUTES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  if (!fs.existsSync(routePath)) {
    return res.status(404).json({ error: "Route file not found" })
  }

  // Check if router binary exists
  if (!fs.existsSync(ROUTER_PATH)) {
    return res.status(500).json({ error: "Router binary not found. Run: gcc -O2 -Wall -std=c11 ../clos_mult_router.c -o ../clos_mult_router" })
  }

  if (activeRun && activeRun.status === "running") {
    return res.status(409).json({ error: "Solver already running" })
  }

  // Clear locks when loading a file (but preserve lastState for delta tracking)
  lastLocks = []

  // Create temp files for JSON output and previous state
  const tmpJson = path.join(__dirname, ".tmp_state.json")
  const tmpPrevState = path.join(__dirname, ".tmp_prev_state.json")
  const tmpFiles = [tmpJson, tmpPrevState]

  const args = [routePath, "--json", tmpJson, "--size", String(currentSize)]
  if (lastState) {
    fs.writeFileSync(tmpPrevState, JSON.stringify(lastState))
    args.push("--previous-state", tmpPrevState)
  }
  if (incremental) {
    args.push("--incremental")
  }

  const child = spawn(ROUTER_PATH, args)
  const run = beginRun(child, tmpFiles)
  if (!run) {
    child.kill()
    return res.status(409).json({ error: "Solver already running" })
  }

  let stdout = ""
  let stdoutBuffer = ""
  let stderr = ""

  child.stdout.on("data", (data) => {
    const chunk = data.toString()
    stdout += chunk
    stdoutBuffer += chunk
    const lines = stdoutBuffer.split("\n")
    stdoutBuffer = lines.pop()
    for (const line of lines) {
      updateRunProgress(run, line)
    }
  })

  child.stderr.on("data", (data) => {
    stderr += data.toString()
  })

  child.on("close", (code) => {
    if (stdoutBuffer.trim()) {
      updateRunProgress(run, stdoutBuffer)
    }
    const summary = buildRunSummary(run)
    const cancelled = run.cancelled

    if (cancelled) {
      finishRun(run)
      return res.status(409).json({ error: "Run cancelled", summary })
    }

    if (code !== 0) {
      finishRun(run)
      return res.status(500).json({ error: stderr || `Process exited with code ${code}` })
    }

    try {
      const stateJson = fs.readFileSync(tmpJson, "utf-8")
      const state = JSON.parse(stateJson)

      const solverLog = parseRouterLog(stdout, state)
      lastState = state

      if (state.lock_conflicts && state.lock_conflicts.length > 0) {
        finishRun(run)
        return res.status(409).json({ error: "Locked path conflict", lockConflicts: state.lock_conflicts })
      }

      finishRun(run)
      res.json({ ...state, solverLog })
    } catch (err) {
      finishRun(run)
      res.status(500).json({ error: err.message })
    }
  })
})

// GET /api/process-stream - SSE endpoint for streaming solver output
// Query: ?filename=routes.txt&size=10&incremental=true
app.get("/api/process-stream", (req, res) => {
  const { filename, size, incremental } = req.query

  if (!filename) {
    return res.status(400).json({ error: "No filename provided" })
  }

  // Update crossbar size if provided
  if (size !== undefined) {
    const s = parseInt(size, 10)
    if (s >= 2) {
      currentSize = s
    }
  }

  const routePath = path.join(ROUTES_DIR, filename)

  // Security: ensure file is within ROUTES_DIR
  if (!routePath.startsWith(ROUTES_DIR)) {
    return res.status(403).json({ error: "Invalid path" })
  }

  if (!fs.existsSync(routePath)) {
    return res.status(404).json({ error: "Route file not found" })
  }

  if (!fs.existsSync(ROUTER_PATH)) {
    return res.status(500).json({ error: "Router binary not found" })
  }

  // Set up SSE headers
  res.setHeader("Content-Type", "text/event-stream")
  res.setHeader("Cache-Control", "no-cache")
  res.setHeader("Connection", "keep-alive")
  res.flushHeaders()

  if (activeRun && activeRun.status === "running") {
    res.write(`data: ${JSON.stringify({ type: "complete", error: "Solver already running" })}\n\n`)
    res.end()
    return
  }

  // Clear locks when loading a file (but preserve lastState for delta tracking)
  lastLocks = []

  // Create temp files
  const tmpJson = path.join(__dirname, ".tmp_state.json")
  const tmpPrevState = path.join(__dirname, ".tmp_prev_state.json")
  const tmpFiles = [tmpJson, tmpPrevState]

  // Build args array for spawn
  const args = [routePath, "--json", tmpJson, "--size", String(currentSize)]

  if (lastState) {
    fs.writeFileSync(tmpPrevState, JSON.stringify(lastState))
    args.push("--previous-state", tmpPrevState)
  }
  if (incremental === "true") {
    args.push("--incremental")
  }

  // Spawn the router process
  const child = spawn(ROUTER_PATH, args)
  const run = beginRun(child, tmpFiles)

  if (!run) {
    child.kill()
    res.write(`data: ${JSON.stringify({ type: "complete", error: "Solver already running" })}\n\n`)
    res.end()
    return
  }

  run.onCancel = () => {
    try {
      const summary = buildRunSummary(run)
      res.write(`data: ${JSON.stringify({ type: "complete", error: "Run cancelled", summary })}\n\n`)
      res.end()
    } catch (err) {
      // ignore write errors on cancel
    }
  }
  let stdoutBuffer = ""

  // Stream stdout lines as SSE events
  child.stdout.on("data", (data) => {
    stdoutBuffer += data.toString()
    const lines = stdoutBuffer.split("\n")
    stdoutBuffer = lines.pop() // Keep incomplete line in buffer

    for (const line of lines) {
      updateRunProgress(run, line)
      if (line.trim() && !res.writableEnded) {
        // Send each line as an SSE event
        res.write(`data: ${JSON.stringify({ type: "log", line })}\n\n`)
      }
    }
  })

  child.stderr.on("data", (data) => {
    if (!res.writableEnded) {
      res.write(`data: ${JSON.stringify({ type: "error", message: data.toString() })}\n\n`)
    }
  })

  child.on("close", (code) => {
    const canWrite = !res.writableEnded
    // Send any remaining buffered output
    if (stdoutBuffer.trim()) {
      updateRunProgress(run, stdoutBuffer)
      if (canWrite) {
        res.write(`data: ${JSON.stringify({ type: "log", line: stdoutBuffer })}\n\n`)
      }
    }

    const summary = buildRunSummary(run)
    const cancelled = run.cancelled

    if (cancelled) {
      finishRun(run)
      if (canWrite) res.end()
      return
    }

    if (code !== 0) {
      finishRun(run)
      if (canWrite) {
        res.write(`data: ${JSON.stringify({ type: "complete", error: `Process exited with code ${code}` })}\n\n`)
        res.end()
      }
      return
    }

    try {
      // Read the final JSON state
      const stateJson = fs.readFileSync(tmpJson, "utf-8")
      const state = JSON.parse(stateJson)

      // Cache for future incremental updates
      lastState = state

      // Send the complete state
      if (canWrite) {
        res.write(`data: ${JSON.stringify({ type: "complete", state, summary })}\n\n`)
      }
    } catch (err) {
      if (canWrite) {
        res.write(`data: ${JSON.stringify({ type: "complete", error: err.message })}\n\n`)
      }
    }
    finishRun(run)
    if (canWrite) res.end()
  })

  // Handle client disconnect
  req.on("close", () => {
    if (activeRun && activeRun.id === run.id) {
      activeRun.cancelled = true
    }
    child.kill()
  })
})

// POST /api/process-routes - Process routes from JSON directly
// Body: { routes: { [inputId: string]: number[] }, strictStability?: boolean, incremental?: boolean, size?: number }
// e.g., { routes: { "1": [21, 22], "7": [31, 44, 92] }, strictStability: true, incremental: true, size: 8 }
app.post("/api/process-routes", (req, res) => {
  const { routes, strictStability, incremental, size, locks } = req.body

  if (!routes || typeof routes !== "object") {
    return res.status(400).json({ error: "No routes provided" })
  }

  // Update crossbar size if provided
  if (size !== undefined) {
    const s = parseInt(size, 10)
    if (s >= 2) {
      currentSize = s
    }
  }

  // Check if router binary exists
  if (!fs.existsSync(ROUTER_PATH)) {
    return res.status(500).json({ error: "Router binary not found" })
  }

  if (activeRun && activeRun.status === "running") {
    return res.status(409).json({ error: "Solver already running" })
  }

  // Convert routes object to route file format
  // Format: input.output1.output2.output3...
  const lines = []
  for (const [inputId, outputs] of Object.entries(routes)) {
    if (Array.isArray(outputs) && outputs.length > 0) {
      lines.push(`${inputId}.${outputs.join(".")}`)
    }
  }

  if (lines.length === 0) {
    return res.status(400).json({ error: "No valid routes provided" })
  }

  // Write temp route file
  const tmpRoutes = path.join(__dirname, ".tmp_routes.txt")
  const tmpJson = path.join(__dirname, ".tmp_state.json")
  const tmpPrevState = path.join(__dirname, ".tmp_prev_state.json")
  const tmpLocks = path.join(__dirname, ".tmp_locks.json")
  const tmpFiles = [tmpRoutes, tmpJson, tmpPrevState, tmpLocks]

  fs.writeFileSync(tmpRoutes, lines.join("\n"))

  const args = [tmpRoutes, "--json", tmpJson, "--size", String(currentSize)]

  if (lastState) {
    fs.writeFileSync(tmpPrevState, JSON.stringify(lastState))
    args.push("--previous-state", tmpPrevState)
  }

  const lockArray = Array.isArray(locks) ? locks : []
  if (lockArray.length > 0) {
    fs.writeFileSync(tmpLocks, JSON.stringify({ locks: lockArray }))
    args.push("--locks", tmpLocks)
  }

  if (strictStability) {
    args.push("--strict-stability")
  }
  if (incremental) {
    args.push("--incremental")
  }

  const child = spawn(ROUTER_PATH, args)
  const run = beginRun(child, tmpFiles)
  if (!run) {
    child.kill()
    return res.status(409).json({ error: "Solver already running" })
  }

  let stdout = ""
  let stdoutBuffer = ""
  let stderr = ""

  child.stdout.on("data", (data) => {
    const chunk = data.toString()
    stdout += chunk
    stdoutBuffer += chunk
    const linesOut = stdoutBuffer.split("\n")
    stdoutBuffer = linesOut.pop()
    for (const line of linesOut) {
      updateRunProgress(run, line)
    }
  })

  child.stderr.on("data", (data) => {
    stderr += data.toString()
  })

  child.on("close", (code) => {
    if (stdoutBuffer.trim()) {
      updateRunProgress(run, stdoutBuffer)
    }
    const summary = buildRunSummary(run)
    const cancelled = run.cancelled

    if (cancelled) {
      finishRun(run)
      return res.status(409).json({ error: "Run cancelled", summary })
    }

    if (code !== 0) {
      const combinedOutput = `${stdout}\n${stderr}`
      if (combinedOutput.includes("Strict stability")) {
        finishRun(run)
        return res.status(409).json({ error: "Strict stability enabled - would require rerouting existing connections" })
      }
      finishRun(run)
      return res.status(500).json({ error: stderr || `Process exited with code ${code}` })
    }

    try {
      const stateJson = fs.readFileSync(tmpJson, "utf-8")
      const state = JSON.parse(stateJson)

      const solverLog = parseRouterLog(stdout, state)
      lastState = state
      lastLocks = lockArray

      if (state.lock_conflicts && state.lock_conflicts.length > 0) {
        finishRun(run)
        return res.status(409).json({ error: "Locked path conflict", lockConflicts: state.lock_conflicts })
      }

      finishRun(run)
      res.json({ ...state, solverLog })
    } catch (err) {
      finishRun(run)
      res.status(500).json({ error: err.message })
    }
  })
})

// POST /api/cancel-run - Cancel active solver run
app.post("/api/cancel-run", (req, res) => {
  if (!activeRun || activeRun.status !== "running") {
    return res.status(409).json({ error: "No active solver run" })
  }

  const run = activeRun
  run.cancelled = true
  run.status = "cancelling"
  const summary = buildRunSummary(run)

  try {
    if (run.onCancel) {
      run.onCancel()
    }
  } catch (err) {
    // ignore onCancel errors
  }

  try {
    run.child.kill("SIGTERM")
  } catch (err) {
    console.error("Failed to SIGTERM solver:", err.message)
  }

  setTimeout(() => {
    if (run.child && run.child.exitCode === null) {
      try {
        run.child.kill("SIGKILL")
      } catch (err) {
        console.error("Failed to SIGKILL solver:", err.message)
      }
    }
  }, 1500)

  res.json({ success: true, summary })
})

// GET /api/size - Get current crossbar size
app.get("/api/size", (req, res) => {
  res.json({ size: currentSize })
})

// POST /api/size - Set crossbar size
app.post("/api/size", (req, res) => {
  const { size } = req.body

  if (size === undefined) {
    return res.status(400).json({ error: "No size provided" })
  }

  const s = parseInt(size, 10)
  if (s < 2) {
    return res.status(400).json({ error: "Size must be >= 2" })
  }

  currentSize = s
  lastState = null  // Clear cached state when size changes
  lastLocks = []
  res.json({ size: currentSize })
})

// POST /api/clear-state - Clear cached routing state (for fresh loads without delta tracking)
app.post("/api/clear-state", (req, res) => {
  lastState = null
  lastLocks = []
  console.log('[debug] State cleared - next load will start fresh')
  res.json({ success: true, message: "State cleared" })
})

app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`)
  console.log(`Routes directory: ${ROUTES_DIR}`)
  console.log(`Router binary: ${ROUTER_PATH}`)
})
