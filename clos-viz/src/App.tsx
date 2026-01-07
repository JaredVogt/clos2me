import { useEffect, useMemo, useState, useRef, useCallback } from "react"
import { fabricStateSchema, solverResponseSchema, type FabricState, type LogEntry, type LogLevel } from "./schema"
import { deriveInputs } from "./derive"
import { FabricView } from "./FabricView"
import { LogPanel } from "./LogPanel"
import "./index.css"

type LockMap = Record<number, Record<number, number>>
type LockPayload = { input: number; egressBlock: number; spine: number }

export default function App() {
  const [state, setState] = useState<FabricState | null>(null)
  const [selectedInput, setSelectedInput] = useState<number | null>(null)
  const [filter, setFilter] = useState("")
  const [error, setError] = useState<string | null>(null)

  // Route files state
  const [routeFiles, setRouteFiles] = useState<string[]>([])
  const [selectedRoute, setSelectedRoute] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const uploadRef = useRef<HTMLInputElement>(null)

  // Dropdown state
  const [dropdownOpen, setDropdownOpen] = useState(false)
  const [renameFile, setRenameFile] = useState<string | null>(null)
  const [renameValue, setRenameValue] = useState("")
  const [showNewInput, setShowNewInput] = useState(false)
  const [newFileName, setNewFileName] = useState("")
  const dropdownRef = useRef<HTMLDivElement>(null)
  const renameInputRef = useRef<HTMLInputElement>(null)
  const newInputRef = useRef<HTMLInputElement>(null)

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

  // Crossbar size (default 10)
  const [crossbarSize, setCrossbarSize] = useState(10)
  const [sizeInput, setSizeInput] = useState("10")

  // Relay mode - toggle with 'c' key
  const [relayMode, setRelayMode] = useState(false)

  // Solver log state
  const [solverLog, setSolverLog] = useState<LogEntry[]>([])
  const [logLevel, setLogLevel] = useState<LogLevel>('summary')
  const [persistLog, setPersistLog] = useState(false)
  const [logPanelWidth, setLogPanelWidth] = useState(400)
  const [isResizing, setIsResizing] = useState(false)

  // Hover highlight state (for lock hover)
  const [hoveredInput, setHoveredInput] = useState<number | null>(null)
  const [hoveredFromLock, setHoveredFromLock] = useState(false)

  const inputs = useMemo(() => (state ? deriveInputs(state) : []), [state])

  // Helper to strip size suffix from filename for display
  // e.g., "stress_stability.10.txt" -> "stress_stability"
  const displayName = useCallback((filename: string) => {
    return filename.replace(/\.\d+\.txt$/, "")
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
  // Keyboard shortcuts: ESC cancels route, C toggles relay mode
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      // Don't trigger if typing in an input
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        return
      }

      if (e.key === 'Escape' && pendingInput !== null) {
        setPendingInput(null)
        setPendingOutputs([])
      }

      if (e.key === 'c' || e.key === 'C') {
        e.preventDefault()
        e.stopPropagation()
        setRelayMode(prev => !prev)
      }
    }

    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [pendingInput])

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
    setLoading(true)

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

    try {
      const res = await fetch("/api/process-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: newRoutes, strictStability, locks: buildLocksPayload(locksByInput) })
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
      setError(e instanceof Error ? e.message : "Failed to process routes")
      setPendingInput(null)
      setPendingOutputs([])
    } finally {
      setLoading(false)
    }
  }

  // Delete a route (Ctrl/Cmd+click on input)
  async function deleteRoute(inputId: number) {
    setError(null)
    setLoading(true)

    const newRoutes = { ...routes }
    delete newRoutes[inputId]

    try {
      const res = await fetch("/api/process-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: newRoutes, strictStability, locks: buildLocksPayload(locksByInput) })
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
      setError(e instanceof Error ? e.message : "Failed to delete route")
    } finally {
      setLoading(false)
    }
  }

  // Fetch crossbar size on mount
  useEffect(() => {
    fetchCrossbarSize()
  }, [])

  // Fetch route files when crossbar size changes
  useEffect(() => {
    fetchRouteFiles(crossbarSize)
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

  async function processRouteFile(filename: string) {
    setError(null)
    setLoading(true)
    setSelectedRoute(filename)
    setModifiedFile(null) // Clear modified state when loading a new file
    setLocksByInput({})

    // Extract size from filename (e.g., "test.8.txt" -> 8)
    const sizeMatch = filename.match(/\.(\d+)\.txt$/)
    const fileSize = sizeMatch ? parseInt(sizeMatch[1], 10) : crossbarSize

    // Update crossbar size to match file
    if (fileSize !== crossbarSize) {
      setCrossbarSize(fileSize)
      setSizeInput(String(fileSize))
    }

    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename, size: fileSize })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to process route file")
      }

      const json = await res.json()
      const parsed = solverResponseSchema.parse(json)
      setState(parsed)
      setSelectedInput(null)

      // Update solver log
      if (parsed.solverLog) {
        setSolverLog(prev => persistLog ? [...prev, ...parsed.solverLog] : parsed.solverLog)
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to process route file")
    } finally {
      setLoading(false)
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
    if (renameFile && renameInputRef.current) {
      renameInputRef.current.focus()
      renameInputRef.current.select()
    }
  }, [renameFile])

  async function applyLocksUpdate(nextLocks: LockMap, nextRoutes?: Record<number, number[]>) {
    if (!state) return
    setError(null)
    setLoading(true)
    const previousLocks = locksByInput
    setLocksByInput(nextLocks)

    const routesPayload = nextRoutes || buildRoutesFromState(state)
    const locksPayload = buildLocksPayload(nextLocks)

    try {
      const res = await fetch("/api/process-routes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ routes: routesPayload, strictStability, locks: locksPayload })
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
      setLocksByInput(previousLocks)
      setError(e instanceof Error ? e.message : "Failed to apply locks")
    } finally {
      setLoading(false)
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

  function onJsonFile(file: File) {
    setError(null)
    file.text().then(text => {
      try {
        const json = JSON.parse(text)
        const parsed = fabricStateSchema.parse(json)
        setState(parsed)
        setSelectedInput(null)
        setSelectedRoute(null)
      } catch (e) {
        setError(e instanceof Error ? e.message : "Failed to parse JSON")
      }
    })
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

  return (
    <div className="app">
      <header className="topbar">
        <div className="title">clos2me - clos visualizer</div>
        {relayMode && (
          <div className="relayModeIndicator">
            [C] Relay Mode
          </div>
        )}
        <div className="sizeSelector">
          <label>
            Size:
            <input
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
            />
            <datalist id="size-options">
              {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(n => (
                <option key={n} value={n}>{n}×{n}</option>
              ))}
            </datalist>
          </label>
        </div>
        <label className="stabilityToggle">
          <input
            type="checkbox"
            checked={strictStability}
            onChange={e => setStrictStability(e.target.checked)}
          />
          Strict Stability
        </label>
        <label className="file">
          <input
            type="file"
            accept="application/json"
            onChange={e => {
              const f = e.target.files?.[0]
              if (f) onJsonFile(f)
            }}
          />
          Load JSON
        </label>
      </header>

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
          {/* Route Files Section - Dropdown Selector */}
          <div className="panel">
            <div className="panelTitle">Route Files</div>

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
                      onClick={() => setShowNewInput(true)}
                    >
                      + New Route File
                    </button>
                  )}

                  {/* Upload option */}
                  <button
                    className="routeDropdownItem routeDropdownUpload"
                    onClick={() => {
                      uploadRef.current?.click()
                      setDropdownOpen(false)
                    }}
                  >
                    ↑ Upload Route File
                  </button>

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

            {/* Hidden file input for upload */}
            <input
              ref={uploadRef}
              type="file"
              accept=".txt"
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
          </div>

          {/* Locks Section */}
          <div className="panel">
            <div className="panelTitle">Locks ({lockList.length})</div>
            {lockList.length > 0 && (
              <button
                className="saveBtn fullWidth"
                onClick={clearAllLocks}
                disabled={loading}
              >
                Clear All Locks
              </button>
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
            <input
              className="search"
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
          level={logLevel}
          onLevelChange={setLogLevel}
          persistHistory={persistLog}
          onPersistChange={setPersistLog}
          onClear={() => setSolverLog([])}
        />
      </div>
    </div>
  )
}
