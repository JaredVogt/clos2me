import { useEffect, useMemo, useState, useRef, useCallback } from "react"
import { fabricStateSchema, solverResponseSchema, type FabricState, type LogEntry, type LogLevel, type LogType } from "./schema"
import { deriveInputs } from "./derive"
import { FabricView } from "./FabricView"
import { LogPanel } from "./LogPanel"
import { ShortcutsDialog } from "./ShortcutsDialog"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select"
import { Checkbox } from "@/components/ui/checkbox"
import { Label } from "@/components/ui/label"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { Input } from "@/components/ui/input"
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs"
import "./index.css"

type LockMap = Record<number, Record<number, number>>
type LockPayload = { input: number; egressBlock: number; spine: number }
type RouteMap = Record<number, number[]>
type PreserveMode = "none" | "all" | "locked"

const normalizeOutputs = (outputs: number[]) => {
  const unique = Array.from(new Set(outputs))
  unique.sort((a, b) => a - b)
  return unique
}

const parseRoutesText = (text: string): RouteMap => {
  const routes: Record<number, Set<number>> = {}
  const lines = text.split(/\r?\n/)
  for (const rawLine of lines) {
    const line = rawLine.split('#')[0].trim()
    if (!line) continue
    const parts = line.split('.').map(part => part.trim()).filter(Boolean)
    if (parts.length < 2) continue
    const inputId = Number(parts[0])
    if (!Number.isFinite(inputId) || inputId <= 0) continue
    const outputs = routes[inputId] || new Set<number>()
    for (let i = 1; i < parts.length; i++) {
      const outputId = Number(parts[i])
      if (!Number.isFinite(outputId) || outputId <= 0) continue
      outputs.add(outputId)
    }
    routes[inputId] = outputs
  }

  const parsed: RouteMap = {}
  for (const [inputId, outputs] of Object.entries(routes)) {
    parsed[Number(inputId)] = normalizeOutputs(Array.from(outputs))
  }
  return parsed
}

const outputsEqual = (a: number[], b: number[]) => {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
}

const buildLockedRoutes = (currentState: FabricState, locks: LockMap) => {
  const lockedRoutes: RouteMap = {}
  const lockedOutputOwners = new Map<number, number>()
  const lockedInputs = new Set<number>(Object.keys(locks).map(key => Number(key)))

  for (let port = 1; port <= currentState.MAX_PORTS; port++) {
    const owner = currentState.s3_port_owner[port]
    if (!owner || owner <= 0) continue
    const locksForInput = locks[owner]
    if (!locksForInput) continue
    const egressBlock = Math.floor((port - 1) / currentState.N)
    if (locksForInput[egressBlock] === undefined) continue
    if (!lockedRoutes[owner]) lockedRoutes[owner] = []
    lockedRoutes[owner].push(port)
    lockedOutputOwners.set(port, owner)
  }

  for (const [inputId, outputs] of Object.entries(lockedRoutes)) {
    lockedRoutes[Number(inputId)] = normalizeOutputs(outputs)
  }

  return { lockedRoutes, lockedOutputOwners, lockedInputs }
}

const findLockedConflicts = (
  routes: RouteMap,
  lockedRoutes: RouteMap,
  lockedOutputOwners: Map<number, number>,
  lockedInputs: Set<number>
) => {
  const inputConflicts = new Set<number>()
  const outputConflicts = new Set<number>()

  for (const [inputIdRaw, outputs] of Object.entries(routes)) {
    const inputId = Number(inputIdRaw)
    const lockedOutputs = lockedRoutes[inputId]
    if (lockedOutputs) {
      if (!outputsEqual(outputs, lockedOutputs)) {
        inputConflicts.add(inputId)
      }
    } else if (lockedInputs.has(inputId)) {
      inputConflicts.add(inputId)
    }

    for (const output of outputs) {
      const lockedOwner = lockedOutputOwners.get(output)
      if (lockedOwner && lockedOwner !== inputId) {
        outputConflicts.add(output)
      }
    }
  }

  return {
    inputConflicts: Array.from(inputConflicts).sort((a, b) => a - b),
    outputConflicts: Array.from(outputConflicts).sort((a, b) => a - b)
  }
}

const mergeLockedRoutes = (routes: RouteMap, lockedRoutes: RouteMap) => {
  const merged: RouteMap = { ...routes }
  for (const [inputId, outputs] of Object.entries(lockedRoutes)) {
    merged[Number(inputId)] = outputs
  }
  return merged
}

const extractFabricSummary = (entries: LogEntry[]) => {
  const summaryIndex = entries.findIndex(entry => entry.message.includes('=== Fabric Summary ==='))
  if (summaryIndex === -1) {
    return { entries, fabricSummary: null as string | null }
  }
  const fabricSummary = entries[summaryIndex].message
  const nextEntries = [...entries.slice(0, summaryIndex), ...entries.slice(summaryIndex + 1)]
  return { entries: nextEntries, fabricSummary }
}

export default function App() {
  const [state, setState] = useState<FabricState | null>(null)
  const [selectedInput, setSelectedInput] = useState<number | null>(null)
  const [filter, setFilter] = useState("")
  const [error, setError] = useState<string | null>(null)

  // Route files state
  const [routeFiles, setRouteFiles] = useState<string[]>([])
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [solverRunning, setSolverRunning] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  // State files state (for JSON fabric states)
  const [stateFiles, setStateFiles] = useState<string[]>([])
  const [selectedStateFile, setSelectedStateFile] = useState<string | null>(null)
  const stateUploadRef = useRef<HTMLInputElement>(null)

  // Tab state for file manager
  const [activeTab, setActiveTab] = useState<'routes' | 'states'>('routes')

  // Dropdown state
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [renameFile, setRenameFile] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [showNewInput, setShowNewInput] = useState(false)
  const [newFileName, setNewFileName] = useState("")
  const [showSaveAsInput, setShowSaveAsInput] = useState(false)
  const [saveAsName, setSaveAsName] = useState("")
  const dropdownRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const newInputRef = useRef<HTMLInputElement>(null)
  const saveAsInputRef = useRef<HTMLInputElement>(null)
  const skipNewInputBlurRef = useRef(false)
  const skipSaveAsInputBlurRef = useRef(false)

  // Route creation state
  const [pendingInput, setPendingInput] = useState<number | null>(null)
  const [pendingOutputs, setPendingOutputs] = useState<number[]>([])
  const [routes, setRoutes] = useState<Record<number, number[]>>({})
  const [modifiedFile, setModifiedFile] = useState<string | null>(null)
  const [lastRoutedInput, setLastRoutedInput] = useState<number | null>(null)

  // Locks: input -> egressBlock -> spine
  const [locksByInput, setLocksByInput] = useState<LockMap>({})

  // Stability mode
  const [strictStability, setStrictStability] = useState(false)
  const [incremental, setIncremental] = useState(false)

  // Crossbar size (default 10)
  const [crossbarSize, setCrossbarSize] = useState(10)
  const [sizeInput, setSizeInput] = useState("10")

  // Solver selection: "clos" (clos_mult_router) or "pp128" (pp128_solver)
  type SolverType = "clos" | "pp128"
  const [solver, setSolver] = useState<SolverType>("clos")

  // Handle solver change - pp128 requires 8×8 crossbar, then re-solve
  const handleSolverChange = async (newSolver: SolverType) => {
    setSolver(newSolver)

    // pp128 requires 8×8
    let effectiveSize = crossbarSize
    if (newSolver === "pp128" && crossbarSize !== 8) {
      await handleSizeChange(8)
      effectiveSize = 8
    }

    // If we have a selected route file, re-process it with the new solver
    // This handles the case where previous solver failed and state is empty
    // Pass newSolver explicitly since setSolver is async and state hasn't updated yet
    if (selectedRoute) {
      await processRouteFile(selectedRoute, newSolver)
      return
    }

    // Fallback: Re-run solver with current routes if we have state
    if (state) {
      const currentRoutes = buildRoutesFromState(state)
      if (Object.keys(currentRoutes).length > 0) {
        setError(null)
        cancelRequestedRef.current = false
        setRunSummary(null)
        setLoading(true)
        setSolverRunning(true)
        setSolverLog([])
        setFabricSummary(null)

        const controller = new AbortController()
        runAbortRef.current = controller

        try {
          const res = await fetch("/api/process-routes", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            signal: controller.signal,
            body: JSON.stringify({
              routes: currentRoutes,
              strictStability,
              incremental,
              locks: buildLocksPayload(locksByInput),
              solver: newSolver,
              size: effectiveSize
            })
          })

          if (!res.ok) {
            const err = await res.json()
            throw new Error(err.error || "Failed to re-solve with new solver")
          }

          const json = await res.json()
          const parsed = solverResponseSchema.parse(json)
          setState(parsed)

          if (parsed.solverLog) {
            const { entries, fabricSummary: summary } = extractFabricSummary(parsed.solverLog)
            setSolverLog(entries)
            setFabricSummary(summary)
          }
        } catch (e) {
          if (e instanceof DOMException && e.name === "AbortError" && cancelRequestedRef.current) {
            return
          }
          setError(e instanceof Error ? e.message : "Failed to re-solve")
        } finally {
          if (runAbortRef.current === controller) {
            runAbortRef.current = null
          }
          setLoading(false)
          setSolverRunning(false)
        }
      }
    }
  }

  // Relay mode - toggle with 'c' key
  const [relayMode, setRelayMode] = useState(false)
  const [showFirmwareFills, setShowFirmwareFills] = useState(false)
  const [showMults, setShowMults] = useState(false)

  // Shortcuts dialog - toggle with 'k' key
  const [showShortcutsDialog, setShowShortcutsDialog] = useState(false)

  // Chain highlighting for PropatchMD files
  const [chainInputs, setChainInputs] = useState<Record<number, number[]> | null>(null)
  const [chainHighlightInputs, setChainHighlightInputs] = useState<number[]>([])

  // Solver log state
  const [solverLog, setSolverLog] = useState<LogEntry[]>([])
  const [fabricSummary, setFabricSummary] = useState<string | null>(null)
  const [runSummary, setRunSummary] = useState<string | null>(null)
  const [logLevel, setLogLevel] = useState<LogLevel>('summary')
  const [persistLog, setPersistLog] = useState(false)
  const [preserveMode, setPreserveMode] = useState<PreserveMode>("all")
  const [logPanelWidth, setLogPanelWidth] = useState(400)
  const [isResizing, setIsResizing] = useState(false)

  // Hover highlight state (for lock hover)
  const [hoveredInput, setHoveredInput] = useState<number | null>(null)
  const [hoveredFromLock, setHoveredFromLock] = useState(false)
  const eventSourceRef = useRef<EventSource | null>(null)
  const runAbortRef = useRef<AbortController | null>(null)
  const cancelRequestedRef = useRef(false)

  const inputs = useMemo(() => (state ? deriveInputs(state) : []), [state])

  // Helper to format filename for display
  // Route/state files: "stress_stability.10.txt" -> "stress_stability"
  // PropatchMD files: "Tom.propatchs" -> "Tom.propatchs" (show extension for distinction)
  const displayName = useCallback((filename: string) => {
    if (filename.endsWith('.propatchs')) {
      return filename  // Show full name with extension
    }
    return filename.replace(/\.\d+\.(txt|json)$/, "")
  }, [])

  const buildRoutesFromState = useCallback((currentState: FabricState | null) => {
    const nextRoutes: Record<number, number[]> = {}
    if (!currentState) return nextRoutes
    for (let port = 1; port <= currentState.MAX_PORTS; port++) {
      const owner = currentState.s3_port_owner[port]
      if (owner && owner > 0) {
        if (!nextRoutes[owner]) nextRoutes[owner] = []
        nextRoutes[owner].push(port)
      }
    }
    return nextRoutes
  }, [])

  // Helper to trigger file download in browser
  const downloadFile = useCallback((content: string, filename: string, mimeType: string) => {
    const blob = new Blob([content], { type: mimeType })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    a.click()
    URL.revokeObjectURL(url)
  }, [])

  // Export current state as JSON file
  const exportStateAsJson = useCallback(() => {
    if (!state) return
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `fabric-state-${timestamp}.json`
    downloadFile(JSON.stringify(state, null, 2), filename, 'application/json')
  }, [state, downloadFile])

  // Export current routes as .txt file (input.output format)
  const exportRoutesAsTxt = useCallback(() => {
    if (!state) return
    const currentRoutes = buildRoutesFromState(state)
    const lines: string[] = []
    for (const [input, outputs] of Object.entries(currentRoutes)) {
      for (const output of outputs) {
        lines.push(`${input}.${output}`)
      }
    }
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
    const filename = `routes-${timestamp}.txt`
    downloadFile(lines.join('\n'), filename, 'text/plain')
  }, [state, buildRoutesFromState, downloadFile])

  const buildLocksPayload = useCallback((locks: LockMap): LockPayload[] => {
    const payload: LockPayload[] = []
    for (const [inputId, blocks] of Object.entries(locks)) {
      const input = Number(inputId)
      for (const [egressBlock, spine] of Object.entries(blocks)) {
        payload.push({ input, egressBlock: Number(egressBlock), spine })
      }
    }
    return payload
  }, [])

  const formatCount = useCallback((value: string | null) => {
    if (!value) return "unknown"
    return value.replace(/\B(?=(\d{3})+(?!\d))/g, ",")
  }, [])

  const formatRunSummary = useCallback((summary: {
    attempts: string | null
    elapsedSeconds: number
    depth?: number | null
    maxDepth?: number | null
    bestCost?: number | null
    lastStatsLine?: string | null
  }) => {
    const attemptsText = formatCount(summary.attempts)
    const details = []
    if (summary.depth !== null && summary.depth !== undefined && summary.maxDepth !== null && summary.maxDepth !== undefined) {
      details.push(`depth ${summary.depth}/${summary.maxDepth}`)
    }
    if (summary.bestCost !== null && summary.bestCost !== undefined) {
      details.push(`best_cost=${summary.bestCost}`)
    }
    const base = `Cancelled after ${attemptsText} attempts in ${summary.elapsedSeconds}s${details.length ? ` (${details.join(", ")})` : ""}`
    if (summary.lastStatsLine) {
      return `${base} · ${summary.lastStatsLine}`
    }
    return base
  }, [formatCount])

  // Debug: log state changes
  useEffect(() => {
    console.log(`[debug] State changed: pendingInput=${pendingInput}, pendingOutputs=[${pendingOutputs.join(',')}]`)
  }, [pendingInput, pendingOutputs])

  // Derive routes from current state when it changes
  useEffect(() => {
    if (!state) {
      setRoutes({})
      return
    }
    setRoutes(buildRoutesFromState(state))
  }, [state, buildRoutesFromState])

  // Prune stale locks when state changes
  useEffect(() => {
    if (!state) {
      if (Object.keys(locksByInput).length > 0) setLocksByInput({})
      return
    }

    const ownedBlocks: Record<number, Set<number>> = {}
    for (let port = 1; port <= state.MAX_PORTS; port++) {
      const owner = state.s3_port_owner[port]
      if (!owner || owner <= 0) continue
      const block = Math.floor((port - 1) / state.N)
      if (!ownedBlocks[owner]) ownedBlocks[owner] = new Set()
      ownedBlocks[owner].add(block)
    }

    const nextLocks: LockMap = {}
    for (const [inputId, blocks] of Object.entries(locksByInput)) {
      const input = Number(inputId)
      const owned = ownedBlocks[input]
      if (!owned) continue
      for (const [egressBlock, spine] of Object.entries(blocks)) {
        const e = Number(egressBlock)
        if (owned.has(e)) {
          if (!nextLocks[input]) nextLocks[input] = {}
          nextLocks[input][e] = spine
        }
      }
    }

    const prevJson = JSON.stringify(locksByInput)
    const nextJson = JSON.stringify(nextLocks)
    if (prevJson !== nextJson) {
      setLocksByInput(nextLocks)
    }
  }, [state, locksByInput])
  // Keyboard shortcuts: ESC cancels route, C toggles relay mode, K toggles shortcuts dialog
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't trigger if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      if (e.key === 'Escape') {
        if (showShortcutsDialog) {
          setShowShortcutsDialog(false)
        } else if (pendingInput !== null) {
          setPendingInput(null)
          setPendingOutputs([])
        }
      }

      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault()
        e.stopPropagation()
        setRelayMode(prev => !prev)
      }

      if (e.key === 'k' || e.key === 'K') {
        e.preventDefault()
        e.stopPropagation()
        setShowShortcutsDialog(prev => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pendingInput, showShortcutsDialog])

  // Handle log panel resize
  useEffect(() => {
    if (!isResizing) return

    const handleMouseMove = (e: MouseEvent) => {
      const newWidth = window.innerWidth - e.clientX
      setLogPanelWidth(Math.max(200, Math.min(800, newWidth)))
    }

    const handleMouseUp = () => {
      setIsResizing(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizing])

  // Handle route creation clicks (Click = create, Shift-click = add multicast)
  async function handleRouteClick(portId: number, isInput: boolean, event: React.MouseEvent) {
    console.log(`[debug] handleRouteClick: portId=${portId}, isInput=${isInput}, shiftKey=${event.shiftKey}`)
    console.log(`[debug] Current state: pendingInput=${pendingInput}, pendingOutputs=[${pendingOutputs.join(',')}]`)

    // Cmd/Ctrl-click toggles locks
    if (event.metaKey || event.ctrlKey) {
      if (isInput) {
        if (event.shiftKey) {
          if (routes[portId]) {
            console.log(`[debug] Cmd/Ctrl+Shift-click: deleting route for input ${portId}`)
            await deleteRoute(portId)
          }
        } else {
          console.log(`[debug] Cmd/Ctrl-click: toggling lock for input ${portId}`)
          await toggleInputLock(portId)
        }
      } else {
        console.log(`[debug] Cmd/Ctrl-click: toggling lock for output ${portId}`)
        await toggleOutputLock(portId)
      }
      return
    }

    if (isInput) {
      // Click on input port - select it for routing
      setPendingInput(portId)
      setPendingOutputs([])
      console.log(`[debug] Selected input ${portId} for routing`)
    } else {
      // Click on output port
      if (event.shiftKey) {
        // Shift-click: add output to existing route for lastRoutedInput
        if (lastRoutedInput === null) {
          console.log(`[debug] No previous route, ignoring shift-click`)
          return
        }
        const currentOutputs = routes[lastRoutedInput] || []
        if (currentOutputs.includes(portId)) {
          console.log(`[debug] Output ${portId} already in route, skipping`)
          return
        }
        const outputs = [...currentOutputs, portId]
        console.log(`[debug] Shift-click: adding output ${portId} to input ${lastRoutedInput}, outputs [${outputs.join(',')}]`)
        await submitRoute(lastRoutedInput, outputs)
      } else {
        // Regular click: create route with pendingInput
        if (pendingInput === null) {
          console.log(`[debug] No input selected, ignoring output click`)
          return
        }
        console.log(`[debug] Click: creating route: input ${pendingInput} → output [${portId}]`)
        await submitRoute(pendingInput, [portId])
      }
    }
  }

  // Submit a new route to the API
  async function submitRoute(inputId: number, outputIds: number[]) {
    setError(null)
    cancelRequestedRef.current = false
    setRunSummary(null)
    setLoading(true)
    setSolverRunning(true)

    // Derive current routes directly from state to avoid race conditions
    // (the `routes` state may be stale if useEffect hasn't run yet)
    const currentRoutes = buildRoutesFromState(state)

    // Build new routes map
    const newRoutes = { ...currentRoutes }

    // Remove this input's existing routes
    delete newRoutes[inputId]

    // Remove outputs from other inputs if they're already used
    for (const outputId of outputIds) {
      for (const [existingInput, existingOutputs] of Object.entries(newRoutes)) {
        const idx = existingOutputs.indexOf(outputId)
        if (idx !== -1) {
          existingOutputs.splice(idx, 1)
          if (existingOutputs.length === 0) {
            delete newRoutes[Number(existingInput)]
          }
        }
      }
    }

    // Add the new route
    newRoutes[inputId] = outputIds

    const controller = new AbortController()
    runAbortRef.current = controller

    try {
      const res = await fetch("/api/process-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ routes: newRoutes, strictStability, incremental, locks: buildLocksPayload(locksByInput), solver })
      })

      if (!res.ok) {
        const err = await res.json()
        const detail = err.lockConflicts ? ` (${err.lockConflicts.length} lock conflict${err.lockConflicts.length === 1 ? '' : 's'})` : ""
        throw new Error((err.error || "Failed to process routes") + detail)
      }

      const json = await res.json()
      const parsed = solverResponseSchema.parse(json)
      setState(parsed)
      setSelectedInput(inputId) // Select the newly created route

      // Update solver log
      if (parsed.solverLog) {
        setSolverLog(prev => persistLog ? [...prev, ...parsed.solverLog] : parsed.solverLog)
      }

      // Track that we modified the currently selected file
      if (selectedRoute) {
        setModifiedFile(selectedRoute)
      }

      // Clear pending state - route is complete
      // Remember input for shift+click to add more outputs
      setLastRoutedInput(inputId)
      setPendingInput(null)
      setPendingOutputs([])
      console.log(`[debug] Route created: input ${inputId} → outputs [${outputIds.join(',')}]`)
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError" && cancelRequestedRef.current) {
        return
      }
      setError(e instanceof Error ? e.message : "Failed to process routes")
      setPendingInput(null)
      setPendingOutputs([])
    } finally {
      if (runAbortRef.current === controller) {
        runAbortRef.current = null
      }
      setLoading(false)
      setSolverRunning(false)
    }
  }

  // Delete a route (Ctrl/Cmd+click on input)
  async function deleteRoute(inputId: number) {
    setError(null)
    cancelRequestedRef.current = false
    setRunSummary(null)
    setLoading(true)
    setSolverRunning(true)

    const newRoutes = { ...routes }
    delete newRoutes[inputId]

    const controller = new AbortController()
    runAbortRef.current = controller

    try {
      const res = await fetch("/api/process-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ routes: newRoutes, strictStability, incremental, locks: buildLocksPayload(locksByInput), solver })
      })

      if (!res.ok) {
        const err = await res.json()
        const detail = err.lockConflicts ? ` (${err.lockConflicts.length} lock conflict${err.lockConflicts.length === 1 ? '' : 's'})` : ""
        throw new Error((err.error || "Failed to delete route") + detail)
      }

      const json = await res.json()
      const parsed = solverResponseSchema.parse(json)
      setState(parsed)
      setSelectedInput(null)
      setPendingInput(null)
      setPendingOutputs([])

      // Update solver log
      if (parsed.solverLog) {
        setSolverLog(prev => persistLog ? [...prev, ...parsed.solverLog] : parsed.solverLog)
      }

      // Track modification if we loaded from a file
      if (selectedRoute) {
        setModifiedFile(selectedRoute)
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError" && cancelRequestedRef.current) {
        return
      }
      setError(e instanceof Error ? e.message : "Failed to delete route")
    } finally {
      if (runAbortRef.current === controller) {
        runAbortRef.current = null
      }
      setLoading(false)
      setSolverRunning(false)
    }
  }

  // Fetch crossbar size on mount
  useEffect(() => {
    fetchCrossbarSize()
  }, [])

  // Fetch route and state files when crossbar size changes
  useEffect(() => {
    fetchRouteFiles(crossbarSize)
    fetchStateFiles(crossbarSize)
  }, [crossbarSize])

  async function fetchCrossbarSize() {
    try {
      const res = await fetch("/api/size")
      const data = await res.json()
      if (data.size) {
        setCrossbarSize(data.size)
        setSizeInput(String(data.size))
      }
    } catch (e) {
      console.error("Failed to fetch crossbar size:", e)
    }
  }

  async function handleSizeChange(newSize: number) {
    setError(null)
    setLoading(true)

    try {
      const res = await fetch("/api/size", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ size: newSize })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to set size")
      }

      setCrossbarSize(newSize)
      setSizeInput(String(newSize))
      // Clear state when size changes - user should reload a route file
      setState(null)
      setRoutes({})
      setSelectedInput(null)
      setSelectedRoute(null)
      setModifiedFile(null)
      setLocksByInput({})
      setSolverLog([])
      setRunSummary(null)
    } catch (e) {
      setSizeInput(String(crossbarSize))
      setError(e instanceof Error ? e.message : "Failed to set size")
    } finally {
      setLoading(false)
    }
  }

  async function commitSizeInput(nextValue?: string) {
    const raw = (nextValue ?? sizeInput).trim()
    const parsed = parseInt(raw, 10)
    if (!Number.isFinite(parsed) || parsed < 2) {
      setSizeInput(String(crossbarSize))
      return
    }
    if (parsed === crossbarSize) {
      setSizeInput(String(crossbarSize))
      return
    }
    await handleSizeChange(parsed)
  }

  async function fetchRouteFiles(size: number = crossbarSize) {
    try {
      const res = await fetch(`/api/routes?size=${size}`)
      const data = await res.json()
      setRouteFiles(data.files || [])
    } catch (e) {
      console.error("Failed to fetch routes:", e)
    }
  }

  async function fetchStateFiles(size: number = crossbarSize) {
    try {
      const res = await fetch(`/api/states?size=${size}`)
      const data = await res.json()
      setStateFiles(data.files || [])
    } catch (e) {
      console.error("Failed to fetch states:", e)
    }
  }

  // Clear server-side routing state (for fresh loads without delta tracking)
  async function clearState() {
    try {
      const res = await fetch("/api/clear-state", { method: "POST" })
      if (!res.ok) throw new Error("Failed to clear state")
      console.log("State cleared - next load will start fresh")
    } catch (e) {
      console.error("Failed to clear state:", e)
    }
  }

  async function cancelSolverRun() {
    if (!solverRunning) return
    cancelRequestedRef.current = true
    setError(null)

    try {
      const res = await fetch("/api/cancel-run", { method: "POST" })
      const data = await res.json()
      if (!res.ok) {
        throw new Error(data.error || "Failed to cancel run")
      }

      if (eventSourceRef.current) {
        eventSourceRef.current.close()
        eventSourceRef.current = null
      }

      if (runAbortRef.current) {
        runAbortRef.current.abort()
        runAbortRef.current = null
      }

      setLoading(false)
      setSolverRunning(false)

      if (data.summary) {
        setRunSummary(formatRunSummary(data.summary))
      }
    } catch (e) {
      cancelRequestedRef.current = false
      setError(e instanceof Error ? e.message : "Failed to cancel run")
    }
  }

  async function processRouteFileLockedOnly(filename: string, fileSize: number) {
    if (!state || Object.keys(locksByInput).length === 0) {
      return
    }

    if (state.N !== fileSize) {
      setError(`Locked paths can't be preserved across size changes (${state.N} → ${fileSize}).`)
      return
    }

    let fileText = ""
    try {
      const res = await fetch(`/api/routes/${encodeURIComponent(filename)}`)
      if (!res.ok) {
        const errText = await res.text()
        throw new Error(errText || "Failed to read route file")
      }
      fileText = await res.text()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to read route file")
      return
    }

    const fileRoutes = parseRoutesText(fileText)
    const { lockedRoutes, lockedOutputOwners, lockedInputs } = buildLockedRoutes(state, locksByInput)
    const { inputConflicts, outputConflicts } = findLockedConflicts(
      fileRoutes,
      lockedRoutes,
      lockedOutputOwners,
      lockedInputs
    )

    if (inputConflicts.length > 0 || outputConflicts.length > 0) {
      const parts = []
      if (inputConflicts.length > 0) {
        parts.push(`inputs ${inputConflicts.join(", ")}`)
      }
      if (outputConflicts.length > 0) {
        parts.push(`outputs ${outputConflicts.join(", ")}`)
      }
      setError(`Locked path conflict: ${parts.join("; ")}. Repeat the locked routes exactly or remove them.`)
      return
    }

    const mergedRoutes = mergeLockedRoutes(fileRoutes, lockedRoutes)

    cancelRequestedRef.current = false
    setRunSummary(null)
    setLoading(true)
    setSolverRunning(true)
    setSolverLog([])
    setFabricSummary(null)
    setSelectedRoute(filename)
    setModifiedFile(null)

    if (fileSize !== crossbarSize) {
      setCrossbarSize(fileSize)
      setSizeInput(String(fileSize))
    }

    await clearState()

    const controller = new AbortController()
    runAbortRef.current = controller

    try {
      const res = await fetch("/api/process-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          routes: mergedRoutes,
          strictStability,
          incremental,
          locks: buildLocksPayload(locksByInput),
          size: fileSize,
          solver
        })
      })

      if (!res.ok) {
        const err = await res.json()
        const detail = err.lockConflicts ? ` (${err.lockConflicts.length} lock conflict${err.lockConflicts.length === 1 ? '' : 's'})` : ""
        throw new Error((err.error || "Failed to process routes") + detail)
      }

      const json = await res.json()
      const parsed = solverResponseSchema.parse(json)
      setState(parsed)
      setSelectedInput(null)

      if (parsed.solverLog) {
        const { entries, fabricSummary: summary } = extractFabricSummary(parsed.solverLog)
        setSolverLog(prev => persistLog ? [...prev, ...entries] : entries)
        setFabricSummary(summary)
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError" && cancelRequestedRef.current) {
        return
      }
      setError(e instanceof Error ? e.message : "Failed to process routes")
    } finally {
      if (runAbortRef.current === controller) {
        runAbortRef.current = null
      }
      setLoading(false)
      setSolverRunning(false)
    }
  }

  async function processRouteFile(filename: string, solverOverride?: SolverType) {
    setError(null)
    cancelRequestedRef.current = false
    setRunSummary(null)

    // Extract size from filename (e.g., "test.8.txt" -> 8)
    const sizeMatch = filename.match(/\.(\d+)\.txt$/)
    const fileSize = sizeMatch ? parseInt(sizeMatch[1], 10) : crossbarSize

    const preserveLockedOnly = preserveMode === "locked"
    const hasLocks = !!state && Object.keys(locksByInput).length > 0

    if (preserveLockedOnly && hasLocks) {
      await processRouteFileLockedOnly(filename, fileSize)
      return
    }

    setLoading(true)
    setSolverRunning(true)
    setSolverLog([]) // Clear log - new run makes previous log stale
    setFabricSummary(null) // Clear summary - new run replaces it
    setSelectedRoute(filename)
    setModifiedFile(null) // Clear modified state when loading a new file
    setLocksByInput({})

    // Clear server state if we're not preserving all
    if (preserveMode !== "all") {
      await clearState()
    }

    // Update crossbar size to match file
    if (fileSize !== crossbarSize) {
      setCrossbarSize(fileSize)
      setSizeInput(String(fileSize))
    }

    // Use SSE for streaming solver output
    const effectiveSolver = solverOverride ?? solver
    const url = `/api/process-stream?filename=${encodeURIComponent(filename)}&size=${fileSize}&incremental=${incremental}&solver=${effectiveSolver}`
    const eventSource = new EventSource(url)
    eventSourceRef.current = eventSource

    // Track if we're in the Fabric Summary section
    let inSummary = false
    let summaryLines: string[] = []

    eventSource.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data)

        if (data.type === "log") {
          // Strip [S] prefix since LogPanel adds its own level indicator
          const cleanLine = data.line.replace(/^\[S\]\s*/, '')

          // Check if we're entering the Fabric Summary section
          if (data.line.includes('=== Fabric Summary ===')) {
            inSummary = true
          }

          // Route summary lines to fabricSummary, others to log
          if (inSummary) {
            summaryLines.push(cleanLine)
            setFabricSummary(summaryLines.join('\n'))
          } else {
            // Categorize log level to match parseRouterLog in server.js
            // Summary: REPACK OK, STATS, FAIL
            // Route: >> ROUTE, ROLLBACK
            // Detail: everything else (heatmap, port selections, etc.)
            let level: LogLevel = 'detail'
            let type: LogType = 'info'

            if (data.line.includes('REPACK OK')) {
              level = 'summary'; type = 'success'
            } else if (data.line.includes('STATS:')) {
              level = 'summary'; type = 'info'
            } else if (cleanLine.startsWith('PROGRESS:')) {
              level = 'summary'; type = 'info'
            } else if (data.line.includes('FAIL:')) {
              level = 'summary'; type = 'error'
            } else if (data.line.includes('>> ROUTE:')) {
              level = 'route'; type = 'info'
            } else if (data.line.includes('ROLLBACK:')) {
              level = 'route'; type = 'warning'
            }
            // else: keep as detail (heatmap, port selections, PROGRESS, etc.)

            const entry: LogEntry = {
              level,
              timestamp: new Date().toISOString(),
              message: cleanLine,
              type
            }
            setSolverLog(prev => [...prev, entry])
          }
        } else if (data.type === "error") {
          const entry: LogEntry = {
            level: "summary",
            timestamp: new Date().toISOString(),
            message: `ERROR: ${data.message}`,
            type: "error"
          }
          setSolverLog(prev => [...prev, entry])
        } else if (data.type === "complete") {
          eventSource.close()
          eventSourceRef.current = null
          cancelRequestedRef.current = false

          if (data.error) {
            setError(data.error)
          } else if (data.state) {
            const parsed = solverResponseSchema.parse(data.state)
            setState(parsed)
            setSelectedInput(null)
          }
          // Store chain inputs for PropatchMD files (for chain highlighting)
          console.log(`[debug] chainInputs received from server:`, data.chainInputs)
          setChainInputs(data.chainInputs || null)
          setChainHighlightInputs([])
          setLoading(false)
          setSolverRunning(false)
        }
      } catch (e) {
        console.error("SSE parse error:", e)
      }
    }

    eventSource.onerror = () => {
      eventSource.close()
      eventSourceRef.current = null
      if (!cancelRequestedRef.current) {
        setError("Connection to solver lost")
      }
      setLoading(false)
      setSolverRunning(false)
    }
  }

  async function uploadRouteFile(file: File) {
    setError(null)
    const formData = new FormData()
    formData.append("file", file)

    try {
      const res = await fetch("/api/routes", {
        method: "POST",
        body: formData
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to upload file")
      }

      await fetchRouteFiles()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload file")
    }
  }

  // State file management functions
  async function uploadStateFile(file: File) {
    setError(null)
    const formData = new FormData()
    formData.append("file", file)

    try {
      const res = await fetch("/api/states", {
        method: "POST",
        body: formData
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to upload state file")
      }

      await fetchStateFiles()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to upload state file")
    }
  }

  async function loadStateFile(filename: string) {
    setError(null)
    setLoading(true)

    try {
      const res = await fetch(`/api/states/${encodeURIComponent(filename)}`)
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to load state file")
      }

      const stateData = await res.json()
      const parsed = fabricStateSchema.parse(stateData)
      setState(parsed)
      setSelectedStateFile(filename)
      setSelectedInput(null)
      setLocksByInput({})
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load state file")
    } finally {
      setLoading(false)
    }
  }

  async function saveStateFile(filename: string) {
    if (!state) return
    setError(null)
    setLoading(true)

    try {
      const res = await fetch(`/api/states/${encodeURIComponent(filename)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ state })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to save state file")
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save state file")
    } finally {
      setLoading(false)
    }
  }

  async function saveAsStateFile(name: string) {
    if (!name.trim() || !state) {
      setShowSaveAsInput(false)
      setSaveAsName("")
      return
    }

    setError(null)
    setLoading(true)

    try {
      const res = await fetch("/api/states/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: name.trim(), size: crossbarSize, state })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to create state file")
      }

      const data = await res.json()
      await fetchStateFiles()
      setSelectedStateFile(data.filename)
      setShowSaveAsInput(false)
      setSaveAsName("")
      setDropdownOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save state file")
    } finally {
      setLoading(false)
    }
  }

  async function renameStateFile(oldName: string, newName: string) {
    if (!newName.trim() || newName === displayName(oldName)) {
      setRenameFile(null)
      setRenameValue("")
      return
    }

    setError(null)

    try {
      const res = await fetch(`/api/states/${encodeURIComponent(oldName)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: newName.trim() })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to rename state file")
      }

      const data = await res.json()
      await fetchStateFiles()

      if (selectedStateFile === oldName) {
        setSelectedStateFile(data.filename)
      }

      setRenameFile(null)
      setRenameValue("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename state file")
    }
  }

  async function deleteStateFile(filename: string) {
    setError(null)

    try {
      const res = await fetch(`/api/states/${encodeURIComponent(filename)}`, {
        method: "DELETE"
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to delete state file")
      }

      await fetchStateFiles()

      if (selectedStateFile === filename) {
        setSelectedStateFile(null)
      }

      setDropdownOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete state file")
    }
  }

  async function saveRouteFile(filename: string) {
    setError(null)
    setLoading(true)

    try {
      const res = await fetch(`/api/routes/${encodeURIComponent(filename)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to save routes")
      }

      setModifiedFile(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save routes")
    } finally {
      setLoading(false)
    }
  }

  async function saveAsRouteFile(name: string) {
    if (!name.trim()) {
      setShowSaveAsInput(false)
      setSaveAsName("")
      return
    }

    setError(null)
    setLoading(true)

    try {
      const res = await fetch("/api/routes/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: name.trim(), size: crossbarSize })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to create file")
      }

      const data = await res.json()
      const routesPayload = state ? buildRoutesFromState(state) : routes

      const saveRes = await fetch(`/api/routes/${encodeURIComponent(data.filename)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: routesPayload })
      })

      if (!saveRes.ok) {
        const err = await saveRes.json()
        throw new Error(err.error || "Failed to save routes")
      }

      await fetchRouteFiles()
      setSelectedRoute(data.filename)
      setModifiedFile(null)
      setShowSaveAsInput(false)
      setSaveAsName("")
      setDropdownOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to save file")
    } finally {
      setLoading(false)
    }
  }

  // Create a new empty route file
  async function createNewRouteFile(name: string) {
    if (!name.trim()) return

    setError(null)
    try {
      const res = await fetch("/api/routes/create", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: name.trim(), size: crossbarSize })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to create file")
      }

      const data = await res.json()
      await fetchRouteFiles()

      // Process the new file to initialize empty state with correct crossbar size
      await processRouteFile(data.filename)
      setModifiedFile(null)
      setShowNewInput(false)
      setNewFileName("")
      setDropdownOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to create file")
    }
  }

  // Rename a route file
  async function renameRouteFile(oldName: string, newName: string) {
    if (!newName.trim() || newName.trim() === oldName) {
      setRenameFile(null)
      setRenameValue("")
      return
    }

    setError(null)
    try {
      const res = await fetch(`/api/routes/${encodeURIComponent(oldName)}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ newName: newName.trim() })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to rename file")
      }

      const data = await res.json()
      await fetchRouteFiles()

      // Update selected route if we renamed the current one
      if (selectedRoute === oldName) {
        setSelectedRoute(data.filename)
      }
      if (modifiedFile === oldName) {
        setModifiedFile(data.filename)
      }

      setRenameFile(null)
      setRenameValue("")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to rename file")
    }
  }

  // Delete a route file
  async function deleteRouteFile(filename: string) {
    if (!window.confirm(`Delete "${filename}"?`)) return

    setError(null)
    try {
      const res = await fetch(`/api/routes/${encodeURIComponent(filename)}`, {
        method: "DELETE"
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to delete file")
      }

      await fetchRouteFiles()

      // Clear state if we deleted the current file
      if (selectedRoute === filename) {
        setSelectedRoute(null)
        setState(null)
        setModifiedFile(null)
      }

      setDropdownOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to delete file")
    }
  }

  // Close dropdown when clicking outside
  useEffect(() => {
    if (!dropdownOpen) return

    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setDropdownOpen(false)
        setShowNewInput(false)
        setNewFileName("")
        setShowSaveAsInput(false)
        setSaveAsName("")
        setRenameFile(null)
        setRenameValue("")
      }
    }

    document.addEventListener("mousedown", handleClickOutside)
    return () => document.removeEventListener("mousedown", handleClickOutside)
  }, [dropdownOpen])

  // Focus inputs when they appear
  useEffect(() => {
    if (showNewInput && newInputRef.current) {
      newInputRef.current.focus()
    }
  }, [showNewInput])

  useEffect(() => {
    if (showSaveAsInput && saveAsInputRef.current) {
      saveAsInputRef.current.focus()
      saveAsInputRef.current.select()
    }
  }, [showSaveAsInput])

  useEffect(() => {
    if (renameFile && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renameFile])

  async function applyLocksUpdate(nextLocks: LockMap, nextRoutes?: Record<number, number[]>) {
    if (!state) return
    setError(null)
    cancelRequestedRef.current = false
    setRunSummary(null)
    setLoading(true)
    setSolverRunning(true)
    const previousLocks = locksByInput
    setLocksByInput(nextLocks)

    const routesPayload = nextRoutes || buildRoutesFromState(state)
    const locksPayload = buildLocksPayload(nextLocks)

    const controller = new AbortController()
    runAbortRef.current = controller

    try {
      const res = await fetch("/api/process-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({ routes: routesPayload, strictStability, incremental, locks: locksPayload, solver })
      })

      if (!res.ok) {
        const err = await res.json()
        const detail = err.lockConflicts ? ` (${err.lockConflicts.length} lock conflict${err.lockConflicts.length === 1 ? '' : 's'})` : ""
        throw new Error((err.error || "Failed to apply locks") + detail)
      }

      const json = await res.json()
      const parsed = solverResponseSchema.parse(json)
      setState(parsed)

      if (parsed.solverLog) {
        setSolverLog(prev => persistLog ? [...prev, ...parsed.solverLog] : parsed.solverLog)
      }

      if (selectedRoute) {
        setModifiedFile(selectedRoute)
      }
    } catch (e) {
      if (e instanceof DOMException && e.name === "AbortError" && cancelRequestedRef.current) {
        return
      }
      setLocksByInput(previousLocks)
      setError(e instanceof Error ? e.message : "Failed to apply locks")
    } finally {
      if (runAbortRef.current === controller) {
        runAbortRef.current = null
      }
      setLoading(false)
      setSolverRunning(false)
    }
  }

  async function toggleInputLock(inputId: number) {
    if (!state) return
    const nextLocks: LockMap = { ...locksByInput }

    const outputs = routes[inputId] || buildRoutesFromState(state)[inputId] || []
    if (outputs.length === 0) return

    const blocks: Record<number, number> = {}
    for (const out of outputs) {
      const spine = state.s3_port_spine[out]
      if (spine === undefined || spine < 0) continue
      const egressBlock = Math.floor((out - 1) / state.N)
      blocks[egressBlock] = spine
    }

    const blockEntries = Object.entries(blocks)
    if (blockEntries.length === 0) return

    const existing = nextLocks[inputId] || {}
    const fullyLocked = blockEntries.every(([blockKey, spine]) => existing[Number(blockKey)] === spine)

    if (fullyLocked) {
      delete nextLocks[inputId]
    } else {
      nextLocks[inputId] = blocks
    }

    await applyLocksUpdate(nextLocks)
  }

  async function toggleOutputLock(portId: number) {
    if (!state) return
    const owner = state.s3_port_owner[portId]
    const spine = state.s3_port_spine[portId]
    if (!owner || owner <= 0 || spine === undefined || spine < 0) return

    const egressBlock = Math.floor((portId - 1) / state.N)
    const nextLocks: LockMap = { ...locksByInput }
    const current = nextLocks[owner] ? { ...nextLocks[owner] } : {}

    if (current[egressBlock] === spine) {
      delete current[egressBlock]
      if (Object.keys(current).length === 0) {
        delete nextLocks[owner]
      } else {
        nextLocks[owner] = current
      }
      await applyLocksUpdate(nextLocks)
      return
    }

    current[egressBlock] = spine
    nextLocks[owner] = current
    await applyLocksUpdate(nextLocks)
  }

  const filteredInputs = useMemo(() => {
    if (!filter.trim()) return inputs
    const q = filter.trim()
    return inputs.filter(i => String(i.inputId).includes(q))
  }, [inputs, filter])

  const lockList = useMemo(() => {
    const list: Array<{ input: number; egressBlock: number; spine: number }> = []
    for (const [inputId, blocks] of Object.entries(locksByInput)) {
      const input = Number(inputId)
      for (const [egressBlock, spine] of Object.entries(blocks)) {
        list.push({ input, egressBlock: Number(egressBlock), spine })
      }
    }
    return list.sort((a, b) => a.input - b.input || a.egressBlock - b.egressBlock)
  }, [locksByInput])

  async function clearAllLocks() {
    await applyLocksUpdate({})
  }

  const highlightInput = hoveredInput ?? selectedInput
  const highlightMode = hoveredInput && hoveredFromLock ? 'locked' : 'normal'

  const handleHoverInput = useCallback((inputId: number | null, fromLock: boolean) => {
    setHoveredInput(inputId)
    setHoveredFromLock(fromLock)
  }, [])

  // Chain hover handler for PropatchMD files - highlights entire chain when Option key is held
  const handleChainHover = useCallback((inputId: number | null, event?: React.MouseEvent) => {
    console.log(`[debug] handleChainHover: inputId=${inputId}, altKey=${event?.altKey}, hasChainInputs=${!!chainInputs}`)
    // Check altKey directly from the mouse event (works reliably on Mac)
    if (!event?.altKey || !chainInputs || inputId === null) {
      setChainHighlightInputs([])
      return
    }

    // Find which chain this input belongs to
    for (const [chainId, inputs] of Object.entries(chainInputs)) {
      if (inputs.includes(inputId)) {
        console.log(`[debug] Found input ${inputId} in chain ${chainId}, highlighting:`, inputs)
        setChainHighlightInputs(inputs)
        return
      }
    }
    setChainHighlightInputs([])
  }, [chainInputs])

  return (
    <div className="app">
      <TooltipProvider>
        <header className="topbar">
          <div className="title">
            clos2me - clos visualizer
            <span className="buildInfo">{__GIT_BRANCH__} @ {__GIT_COMMIT__}</span>
          </div>
          {relayMode && (
            <div className="relayModeIndicator">
              [C] Relay Mode
            </div>
          )}
          <div style={{ flex: 1 }} />

          {solverRunning && (
            <Button variant="destructive" size="sm" onClick={cancelSolverRun}>
              Kill Run
            </Button>
          )}
        </header>
      </TooltipProvider>

      {error && <div className="error">{error}</div>}

      {pendingInput !== null && (
        <div className="routeStatus">
          Creating route from <strong>Input {pendingInput}</strong>
          {pendingOutputs.length > 0 && (
            <> → Outputs: {pendingOutputs.join(", ")}</>
          )}
          <span className="routeHint">
            {pendingOutputs.length === 0
              ? " (Click output to route, Shift-click to add multicast)"
              : " (Shift-click to add more outputs)"}
          </span>
          <button className="cancelBtn" onClick={() => { setPendingInput(null); setPendingOutputs([]) }}>
            Cancel
          </button>
        </div>
      )}

      <div className="body" style={{ gridTemplateColumns: `280px minmax(0, 960px) 6px 1fr` }}>
        <aside className="sidebar">
          {/* File Manager Section with Tabs */}
          <div className="panel">
            <Tabs value={activeTab} onValueChange={(v) => setActiveTab(v as 'routes' | 'states')}>
              <TabsList className="mb-3">
                <TabsTrigger value="routes">Routes</TabsTrigger>
                <TabsTrigger value="states">States</TabsTrigger>
              </TabsList>

              <TabsContent value="routes" className="mt-0">
                <div className="routeSelector" ref={dropdownRef}>
                  {/* Dropdown trigger */}
              <button
                className={`routeDropdownTrigger ${modifiedFile ? "hasChanges" : ""}`}
                onClick={() => setDropdownOpen(!dropdownOpen)}
                disabled={loading}
              >
                <span className="routeFileName">
                  {selectedRoute ? displayName(selectedRoute) : "Select route file..."}
                  {modifiedFile && selectedRoute && <span className="modifiedDot"> •</span>}
                </span>
                <span className="dropdownChevron">{dropdownOpen ? "▲" : "▼"}</span>
              </button>

              {/* Dropdown menu */}
              {dropdownOpen && (
                <div className="routeDropdownMenu">
                  {/* New file option */}
                  {showNewInput ? (
                    <div className="routeDropdownItem routeDropdownNewInput">
                      <input
                        ref={newInputRef}
                        type="text"
                        className="routeNameInput"
                        placeholder="filename.txt"
                        value={newFileName}
                        onChange={e => setNewFileName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") {
                            createNewRouteFile(newFileName)
                          } else if (e.key === "Escape") {
                            setShowNewInput(false)
                            setNewFileName("")
                          }
                        }}
                        onBlur={() => {
                          if (skipNewInputBlurRef.current) {
                            skipNewInputBlurRef.current = false
                            return
                          }
                          if (newFileName.trim()) {
                            createNewRouteFile(newFileName)
                          } else {
                            setShowNewInput(false)
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      className="routeDropdownItem routeDropdownNew"
                      onMouseDown={() => {
                        skipSaveAsInputBlurRef.current = true
                      }}
                      onClick={() => {
                        setShowSaveAsInput(false)
                        setSaveAsName("")
                        setShowNewInput(true)
                      }}
                    >
                      + New
                    </button>
                  )}

                  {/* Upload option */}
                  <button
                    className="routeDropdownItem routeDropdownUpload"
                    onMouseDown={() => {
                      skipNewInputBlurRef.current = true
                      skipSaveAsInputBlurRef.current = true
                    }}
                    onClick={() => {
                      uploadRef.current?.click()
                      setDropdownOpen(false)
                    }}
                  >
                    ↑ Upload
                  </button>

                  {/* Download/Export option */}
                  <button
                    className="routeDropdownItem routeDropdownDownload"
                    onClick={() => {
                      exportRoutesAsTxt()
                      setDropdownOpen(false)
                    }}
                    disabled={!state}
                  >
                    ↓ Download
                  </button>

                  {/* Save As option */}
                  {showSaveAsInput ? (
                    <div className="routeDropdownItem routeDropdownNewInput">
                      <input
                        ref={saveAsInputRef}
                        type="text"
                        className="routeNameInput"
                        placeholder="filename.txt"
                        value={saveAsName}
                        onChange={e => setSaveAsName(e.target.value)}
                        onKeyDown={e => {
                          if (e.key === "Enter") {
                            saveAsRouteFile(saveAsName)
                          } else if (e.key === "Escape") {
                            setShowSaveAsInput(false)
                            setSaveAsName("")
                          }
                        }}
                        onBlur={() => {
                          if (skipSaveAsInputBlurRef.current) {
                            skipSaveAsInputBlurRef.current = false
                            return
                          }
                          if (saveAsName.trim()) {
                            saveAsRouteFile(saveAsName)
                          } else {
                            setShowSaveAsInput(false)
                          }
                        }}
                      />
                    </div>
                  ) : (
                    <button
                      className="routeDropdownItem routeDropdownSaveAs"
                      onMouseDown={() => {
                        skipNewInputBlurRef.current = true
                      }}
                      onClick={() => {
                        setShowNewInput(false)
                        setNewFileName("")
                        setShowSaveAsInput(true)
                        setSaveAsName(selectedRoute ? displayName(selectedRoute) : "")
                      }}
                    >
                      Save As...
                    </button>
                  )}

                  <div className="routeDropdownDivider" />

                  {/* File list */}
                  {routeFiles.length === 0 ? (
                    <div className="routeDropdownHint">No route files found</div>
                  ) : (
                    routeFiles.map(f => (
                      <div
                        key={f}
                        className={`routeDropdownItem ${selectedRoute === f ? "active" : ""}`}
                      >
                        {renameFile === f ? (
                          <input
                            ref={renameInputRef}
                            type="text"
                            className="routeNameInput"
                            value={renameValue}
                            onChange={e => setRenameValue(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") {
                                renameRouteFile(f, renameValue)
                              } else if (e.key === "Escape") {
                                setRenameFile(null)
                                setRenameValue("")
                              }
                            }}
                            onBlur={() => renameRouteFile(f, renameValue)}
                            onClick={e => e.stopPropagation()}
                          />
                        ) : (
                          <>
                            <button
                              className="routeDropdownItemMain"
                              onClick={() => {
                                processRouteFile(f)
                                setDropdownOpen(false)
                              }}
                            >
                              {displayName(f)}
                              {modifiedFile === f && <span className="modifiedDot"> •</span>}
                            </button>
                            <div className="routeDropdownActions">
                              <button
                                onClick={e => {
                                  e.stopPropagation()
                                  setRenameFile(f)
                                  setRenameValue(displayName(f))
                                }}
                              >
                                Rename
                              </button>
                              <button
                                className="delete"
                                onClick={e => {
                                  e.stopPropagation()
                                  deleteRouteFile(f)
                                }}
                                title="Delete"
                              >
                                ✕
                              </button>
                            </div>
                          </>
                        )}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>

            {/* Preserve State selector - controls delta tracking across file switches */}
            <TooltipProvider>
              <div className="preserveStateControls">
                <div className="preserveStateLabel">Preserve state</div>
                <RadioGroup value={preserveMode} onValueChange={(v) => setPreserveMode(v as PreserveMode)} className="flex flex-col gap-2.5 mt-2">
                  <div className="flex items-center gap-2.5">
                    <RadioGroupItem value="all" id="preserve-all" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Label htmlFor="preserve-all" className="cursor-pointer text-sm">All</Label>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p>Keep all routes when switching files</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <RadioGroupItem value="locked" id="preserve-locked" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Label htmlFor="preserve-locked" className="cursor-pointer text-sm">Locked paths only</Label>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p>Only preserve locked routes when switching files</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <RadioGroupItem value="none" id="preserve-none" />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Label htmlFor="preserve-none" className="cursor-pointer text-sm">None</Label>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p>Clear all routes when switching files</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </RadioGroup>
              </div>

              {/* Calculation Options */}
              <div className="calcOptionsPanel">
                <div className="preserveStateLabel">Calculation Options</div>
                <div className="flex flex-col gap-3 mt-2">
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      id="strictStability"
                      checked={strictStability}
                      onCheckedChange={(checked) => setStrictStability(checked === true)}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Label htmlFor="strictStability" className="cursor-pointer text-sm">
                          Strict Stability
                        </Label>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p>Require stable routing without rearrangements</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                  <div className="flex items-center gap-2.5">
                    <Checkbox
                      id="incremental"
                      checked={incremental}
                      onCheckedChange={(checked) => setIncremental(checked === true)}
                    />
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Label htmlFor="incremental" className="cursor-pointer text-sm">
                          Incremental Repair
                        </Label>
                      </TooltipTrigger>
                      <TooltipContent side="right">
                        <p>Try to repair routes incrementally instead of full recalculation</p>
                      </TooltipContent>
                    </Tooltip>
                  </div>
                </div>
              </div>
            </TooltipProvider>

            {/* Hidden file input for upload */}
            <input
              ref={uploadRef}
              type="file"
              accept=".txt,.propatchs"
              style={{ display: "none" }}
              onChange={e => {
                const f = e.target.files?.[0]
                if (f) uploadRouteFile(f)
                e.target.value = ""
              }}
            />

            {/* Save button - shown when file is modified */}
            {modifiedFile && (
              <button
                className="saveBtn fullWidth"
                onClick={() => saveRouteFile(modifiedFile)}
                disabled={loading}
              >
                Save Changes
              </button>
            )}
              </TabsContent>

              <TabsContent value="states" className="mt-0">
                <div className="routeSelector" ref={dropdownRef}>
                  {/* Dropdown trigger */}
                  <button
                    className="routeDropdownTrigger"
                    onClick={() => setDropdownOpen(!dropdownOpen)}
                    disabled={loading}
                  >
                    <span className="routeFileName">
                      {selectedStateFile ? displayName(selectedStateFile) : "Select state file..."}
                    </span>
                    <span className="dropdownChevron">{dropdownOpen ? "▲" : "▼"}</span>
                  </button>

                  {/* Dropdown menu */}
                  {dropdownOpen && (
                    <div className="routeDropdownMenu">
                      {/* Upload option */}
                      <button
                        className="routeDropdownItem routeDropdownUpload"
                        onClick={() => {
                          stateUploadRef.current?.click()
                          setDropdownOpen(false)
                        }}
                      >
                        ↑ Upload
                      </button>

                      {/* Download/Export option */}
                      <button
                        className="routeDropdownItem routeDropdownDownload"
                        onClick={() => {
                          exportStateAsJson()
                          setDropdownOpen(false)
                        }}
                        disabled={!state}
                      >
                        ↓ Download
                      </button>

                      {/* Save As option */}
                      {showSaveAsInput ? (
                        <div className="routeDropdownItem routeDropdownNewInput">
                          <input
                            ref={saveAsInputRef}
                            type="text"
                            className="routeNameInput"
                            placeholder="filename.json"
                            value={saveAsName}
                            onChange={e => setSaveAsName(e.target.value)}
                            onKeyDown={e => {
                              if (e.key === "Enter") {
                                saveAsStateFile(saveAsName)
                              } else if (e.key === "Escape") {
                                setShowSaveAsInput(false)
                                setSaveAsName("")
                              }
                            }}
                            onBlur={() => {
                              if (skipSaveAsInputBlurRef.current) {
                                skipSaveAsInputBlurRef.current = false
                                return
                              }
                              if (saveAsName.trim()) {
                                saveAsStateFile(saveAsName)
                              } else {
                                setShowSaveAsInput(false)
                              }
                            }}
                          />
                        </div>
                      ) : (
                        <button
                          className="routeDropdownItem routeDropdownSaveAs"
                          onClick={() => {
                            setShowSaveAsInput(true)
                            setSaveAsName(selectedStateFile ? displayName(selectedStateFile) : "")
                          }}
                          disabled={!state}
                        >
                          Save As...
                        </button>
                      )}

                      <div className="routeDropdownDivider" />

                      {/* File list */}
                      {stateFiles.length === 0 ? (
                        <div className="routeDropdownHint">No state files found</div>
                      ) : (
                        stateFiles.map(f => (
                          <div
                            key={f}
                            className={`routeDropdownItem ${selectedStateFile === f ? "active" : ""}`}
                          >
                            {renameFile === f ? (
                              <input
                                ref={renameInputRef}
                                type="text"
                                className="routeNameInput"
                                value={renameValue}
                                onChange={e => setRenameValue(e.target.value)}
                                onKeyDown={e => {
                                  if (e.key === "Enter") {
                                    renameStateFile(f, renameValue)
                                  } else if (e.key === "Escape") {
                                    setRenameFile(null)
                                    setRenameValue("")
                                  }
                                }}
                                onBlur={() => renameStateFile(f, renameValue)}
                                onClick={e => e.stopPropagation()}
                              />
                            ) : (
                              <>
                                <button
                                  className="routeDropdownItemMain"
                                  onClick={() => {
                                    loadStateFile(f)
                                    setDropdownOpen(false)
                                  }}
                                >
                                  {displayName(f)}
                                </button>
                                <div className="routeDropdownActions">
                                  <button
                                    onClick={e => {
                                      e.stopPropagation()
                                      setRenameFile(f)
                                      setRenameValue(displayName(f))
                                    }}
                                  >
                                    Rename
                                  </button>
                                  <button
                                    className="delete"
                                    onClick={e => {
                                      e.stopPropagation()
                                      deleteStateFile(f)
                                    }}
                                    title="Delete"
                                  >
                                    ✕
                                  </button>
                                </div>
                              </>
                            )}
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>

                {/* Hidden file input for state upload */}
                <input
                  ref={stateUploadRef}
                  type="file"
                  accept=".json"
                  style={{ display: "none" }}
                  onChange={e => {
                    const f = e.target.files?.[0]
                    if (f) uploadStateFile(f)
                    e.target.value = ""
                  }}
                />

                {/* Save button - save current state to selected file */}
                {selectedStateFile && state && (
                  <button
                    className="saveBtn fullWidth"
                    onClick={() => saveStateFile(selectedStateFile)}
                    disabled={loading}
                  >
                    Save State
                  </button>
                )}
              </TabsContent>
            </Tabs>
          </div>

          {/* Crossbar Size */}
          <div className="panel">
            <div className="panelTitle">Crossbar Size</div>
            <div className="sizeSelector sidebar">
              <Input
                type="number"
                min={2}
                step={1}
                list="size-options"
                value={sizeInput}
                onChange={e => setSizeInput(e.target.value)}
                onBlur={() => commitSizeInput()}
                onKeyDown={e => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur()
                  }
                }}
                disabled={loading}
                className="w-full"
              />
              <datalist id="size-options">
                {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(n => (
                  <option key={n} value={n}>{n}×{n}</option>
                ))}
              </datalist>
            </div>
          </div>

          {/* Locks Section */}
          <div className="panel">
            <div className="panelTitle">Locks ({lockList.length})</div>
            {lockList.length > 0 && (
              <Button
                variant="secondary"
                className="w-full"
                onClick={clearAllLocks}
                disabled={loading}
              >
                Clear All Locks
              </Button>
            )}
            <div className="list">
              {lockList.length === 0 && <div className="hint">No locks</div>}
              {lockList.map((l, idx) => (
                <div key={`${l.input}-${l.egressBlock}-${l.spine}-${idx}`} className="row">
                  <div className="rowMain">
                    <div className="rowId">In {l.input}</div>
                    <div className="rowMeta">
                      Egr {l.egressBlock + 1} · Spine {l.spine + 1}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Active Inputs Section */}
          <div className="panel">
            <div className="panelTitle">Active Inputs ({inputs.length})</div>
            <Input
              className="mb-2"
              placeholder="Filter by input id"
              value={filter}
              onChange={e => setFilter(e.target.value)}
            />
            <div className="list">
              {filteredInputs.map(i => (
                <button
                  key={i.inputId}
                  className={selectedInput === i.inputId ? "row active" : "row"}
                  onClick={() => setSelectedInput(prev => prev === i.inputId ? null : i.inputId)}
                >
                  <div className="rowMain">
                    <div className="rowId">In {i.inputId}</div>
                    <div className="rowMeta">
                      {i.outputs.length} outs · {i.egressBlocksUsed.length} egr · {i.spinesUsed.length} spines
                    </div>
                  </div>
                </button>
              ))}
              {!state && <div className="hint">Select a route file to begin</div>}
              {state && inputs.length === 0 && <div className="hint">No active inputs</div>}
            </div>
          </div>
        </aside>

        <main className="main">
          {loading && <div className="loading">Processing...</div>}
          {state ? (
            <FabricView
              state={state}
              selectedInput={selectedInput}
              highlightInput={highlightInput}
              highlightMode={highlightMode}
              locksByInput={locksByInput}
              onSelectInput={id => setSelectedInput(id)}
              onHoverInput={handleHoverInput}
              onRouteClick={handleRouteClick}
              pendingInput={pendingInput}
              pendingOutputs={pendingOutputs}
              activeInputCount={inputs.length}
              activeOutputCount={inputs.reduce((sum, i) => sum + i.outputs.length, 0)}
              relayMode={relayMode}
              showFirmwareFills={showFirmwareFills}
              onShowFirmwareFillsChange={setShowFirmwareFills}
              showMults={showMults}
              onShowMultsChange={setShowMults}
              solver={solver}
              onSolverChange={handleSolverChange}
              loading={loading}
              solverRunning={solverRunning}
              chainHighlightInputs={chainHighlightInputs}
              onChainHover={handleChainHover}
            />
          ) : (
            <div className="empty">Select a route file from the sidebar to visualize the fabric</div>
          )}
        </main>

        <div
          className="resizeHandle"
          onMouseDown={() => setIsResizing(true)}
        />

        <LogPanel
          entries={solverLog}
          fabricSummary={fabricSummary}
          runSummary={runSummary}
          level={logLevel}
          onLevelChange={setLogLevel}
          persistHistory={persistLog}
          onPersistChange={setPersistLog}
          onClear={() => { setSolverLog([]); setFabricSummary(null); setRunSummary(null) }}
        />
      </div>

      {showShortcutsDialog && (
        <ShortcutsDialog onClose={() => setShowShortcutsDialog(false)} />
      )}
    </div>
  )
}
