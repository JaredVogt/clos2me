#!/usr/bin/env node

import express from "express"
import cors from "cors"
import multer from "multer"
import { execSync } from "child_process"
import fs from "fs"
import path from "path"
import { fileURLToPath } from "url"

const __filename = fileURLToPath(import.meta.url)
const __dirname = path.dirname(__filename)

const app = express()
const PORT = 4121

const ROUTES_DIR = path.join(__dirname, "public", "routes")
const ROUTER_PATH = path.join(__dirname, "..", "clos_mult_router")

// Cache last fabric state for stability preservation
let lastState = null

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
    let entry = null

    // Summary level entries
    if (line.includes('REPACK OK:')) {
      entry = { level: 'summary', type: 'success', message: line.trim() }
    } else if (line.includes('FAIL:')) {
      entry = { level: 'summary', type: 'error', message: line.trim() }
    }
    // Route level entries
    else if (line.includes('>> ROUTE:')) {
      entry = { level: 'route', type: 'info', message: line.trim() }
    } else if (line.includes('ROLLBACK:')) {
      entry = { level: 'route', type: 'warning', message: line.trim() }
    }
    // Detail level entries
    else if (line.includes('UNSAT DETAILS:') || line.includes('VALIDATION')) {
      entry = { level: 'detail', type: 'error', message: line.trim() }
    } else if (line.includes('Egress block') || line.includes('Ingress block')) {
      entry = { level: 'detail', type: 'info', message: line.trim() }
    } else if (line.trim().startsWith('---')) {
      // Skip separator lines
      continue
    } else if (line.trim()) {
      // Other output as detail
      entry = { level: 'detail', type: 'info', message: line.trim() }
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

// Ensure routes directory exists
if (!fs.existsSync(ROUTES_DIR)) {
  fs.mkdirSync(ROUTES_DIR, { recursive: true })
}

app.use(cors())
app.use(express.json())

// Configure multer for file uploads
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, ROUTES_DIR),
  filename: (req, file, cb) => {
    // Sanitize filename
    const name = file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")
    cb(null, name)
  }
})
const upload = multer({ storage })

// GET /api/routes - List all route files
app.get("/api/routes", (req, res) => {
  try {
    const files = fs.readdirSync(ROUTES_DIR)
      .filter(f => f.endsWith(".txt"))
      .sort()
    res.json({ files })
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
app.post("/api/routes/create", (req, res) => {
  const { filename } = req.body

  if (!filename) {
    return res.status(400).json({ error: "No filename provided" })
  }

  // Validate filename (alphanumeric, dashes, underscores, dots)
  if (!/^[a-zA-Z0-9._-]+$/.test(filename)) {
    return res.status(400).json({ error: "Invalid filename. Use only letters, numbers, dashes, underscores, and dots." })
  }

  // Ensure .txt extension
  const finalName = filename.endsWith(".txt") ? filename : filename + ".txt"
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
app.patch("/api/routes/:filename", (req, res) => {
  const { filename } = req.params
  const { newName } = req.body

  if (!newName) {
    return res.status(400).json({ error: "No new name provided" })
  }

  // Validate both filenames
  if (filename.includes("..") || filename.includes("/")) {
    return res.status(400).json({ error: "Invalid filename" })
  }
  if (!/^[a-zA-Z0-9._-]+$/.test(newName)) {
    return res.status(400).json({ error: "Invalid new filename. Use only letters, numbers, dashes, underscores, and dots." })
  }

  // Ensure .txt extension
  const finalNewName = newName.endsWith(".txt") ? newName : newName + ".txt"

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

// POST /api/process - Run router on a route file
app.post("/api/process", (req, res) => {
  const { filename } = req.body

  if (!filename) {
    return res.status(400).json({ error: "No filename provided" })
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

  try {
    // Clear previous state when loading a file (fresh start)
    lastState = null

    // Create temp file for JSON output
    const tmpJson = path.join(__dirname, ".tmp_state.json")

    // Run the router and capture stdout
    const stdout = execSync(`"${ROUTER_PATH}" "${routePath}" --json "${tmpJson}"`, {
      encoding: "utf-8",
      timeout: 60000
    })

    // Read and return the JSON
    const stateJson = fs.readFileSync(tmpJson, "utf-8")
    const state = JSON.parse(stateJson)

    // Parse stdout into log entries
    const solverLog = parseRouterLog(stdout, state)

    // Cache for future incremental updates
    lastState = state

    // Clean up
    fs.unlinkSync(tmpJson)

    res.json({ ...state, solverLog })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// POST /api/process-routes - Process routes from JSON directly
// Body: { routes: { [inputId: string]: number[] }, strictStability?: boolean }
// e.g., { routes: { "1": [21, 22], "7": [31, 44, 92] }, strictStability: true }
app.post("/api/process-routes", (req, res) => {
  const { routes, strictStability } = req.body

  if (!routes || typeof routes !== "object") {
    return res.status(400).json({ error: "No routes provided" })
  }

  // Check if router binary exists
  if (!fs.existsSync(ROUTER_PATH)) {
    return res.status(500).json({ error: "Router binary not found" })
  }

  try {
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

    fs.writeFileSync(tmpRoutes, lines.join("\n"))

    // Build command with optional previous state and strict stability
    let cmd = `"${ROUTER_PATH}" "${tmpRoutes}" --json "${tmpJson}"`

    if (lastState) {
      fs.writeFileSync(tmpPrevState, JSON.stringify(lastState))
      cmd += ` --previous-state "${tmpPrevState}"`
    }

    if (strictStability) {
      cmd += " --strict-stability"
    }

    // Run the router and capture stdout
    const stdout = execSync(cmd, {
      encoding: "utf-8",
      timeout: 60000
    })

    // Read and return the JSON
    const stateJson = fs.readFileSync(tmpJson, "utf-8")
    const state = JSON.parse(stateJson)

    // Parse stdout into log entries
    const solverLog = parseRouterLog(stdout, state)

    // Cache for future incremental updates
    lastState = state

    // Clean up
    fs.unlinkSync(tmpRoutes)
    fs.unlinkSync(tmpJson)
    if (fs.existsSync(tmpPrevState)) {
      fs.unlinkSync(tmpPrevState)
    }

    res.json({ ...state, solverLog })
  } catch (err) {
    // Check if this is a strict stability failure
    if (err.message && err.message.includes("Strict stability")) {
      return res.status(409).json({ error: "Strict stability enabled - would require rerouting existing connections" })
    }
    res.status(500).json({ error: err.message })
  }
})

app.listen(PORT, () => {
  console.log(`API server running at http://localhost:${PORT}`)
  console.log(`Routes directory: ${ROUTES_DIR}`)
  console.log(`Router binary: ${ROUTER_PATH}`)
})
