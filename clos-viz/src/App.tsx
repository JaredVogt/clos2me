import { useEffect, useMemo, useState, useRef, useCallback } from "react"
import { solverResponseSchema, type FabricState, type LogEntry, type LogLevel } from "./schema"
import { deriveInputs } from "./derive"
import { FabricView } from "./FabricView"
import { LogPanel } from "./LogPanel"
import "./index.css"

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

  // Stability mode
  const [strictStability, setStrictStability] = useState(false)

  // Crossbar size (4-10, default 10)
  const [crossbarSize, setCrossbarSize] = useState(10)

  // Relay mode - toggle with 'c' key
  const [relayMode, setRelayMode] = useState(false)

  // Solver log state
  const [solverLog, setSolverLog] = useState<LogEntry[]>([])
  const [logLevel, setLogLevel] = useState<LogLevel>('summary')
  const [persistLog, setPersistLog] = useState(false)
  const [logPanelWidth, setLogPanelWidth] = useState(400)
  const [isResizing, setIsResizing] = useState(false)

  const inputs = useMemo(() => (state ? deriveInputs(state) : []), [state])

  // Helper to strip size suffix from filename for display
  // e.g., "stress_stability.10.txt" -> "stress_stability"
  const displayName = useCallback((filename: string) => {
    return filename.replace(/\.\d+\.txt$/, "")
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
    // Build routes map from s3_port_owner
    const newRoutes: Record<number, number[]> = {}
    for (let port = 1; port <= state.MAX_PORTS; port++) {
      const owner = state.s3_port_owner[port]
      if (owner && owner > 0) {
        if (!newRoutes[owner]) newRoutes[owner] = []
        newRoutes[owner].push(port)
      }
    }
    setRoutes(newRoutes)
  }, [state])

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

    if (isInput) {
      // Check for Ctrl+click (Windows/Linux) or Cmd+click (Mac) to DELETE
      if (event.ctrlKey || event.metaKey) {
        if (routes[portId]) {
          console.log(`[debug] Ctrl/Cmd-click: deleting route for input ${portId}`)
          await deleteRoute(portId)
        }
        return
      }
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
    const currentRoutes: Record<number, number[]> = {}
    if (state) {
      for (let port = 1; port <= state.MAX_PORTS; port++) {
        const owner = state.s3_port_owner[port]
        if (owner && owner > 0) {
          if (!currentRoutes[owner]) currentRoutes[owner] = []
          currentRoutes[owner].push(port)
        }
      }
    }

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
        body: JSON.stringify({ routes: newRoutes, strictStability })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to process routes")
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
        body: JSON.stringify({ routes: newRoutes, strictStability })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to delete route")
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
      if (data.size) setCrossbarSize(data.size)
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
      // Clear state when size changes - user should reload a route file
      setState(null)
      setRoutes({})
      setSelectedInput(null)
      setSelectedRoute(null)
      setModifiedFile(null)
      setSolverLog([])
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to set size")
    } finally {
      setLoading(false)
    }
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

    // Extract size from filename (e.g., "test.8.txt" -> 8)
    const sizeMatch = filename.match(/\.(\d+)\.txt$/)
    const fileSize = sizeMatch ? parseInt(sizeMatch[1], 10) : crossbarSize

    // Update crossbar size to match file
    if (fileSize !== crossbarSize) {
      setCrossbarSize(fileSize)
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
            <select
              value={crossbarSize}
              onChange={e => handleSizeChange(parseInt(e.target.value, 10))}
              disabled={loading}
            >
              {[2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14].map(n => (
                <option key={n} value={n}>{n}×{n}</option>
              ))}
            </select>
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
              onSelectInput={id => setSelectedInput(id)}
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
