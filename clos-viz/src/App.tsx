import { useEffect, useMemo, useState, useRef } from "react"
import { fabricStateSchema, type FabricState } from "./schema"
import { deriveInputs } from "./derive"
import { FabricView } from "./FabricView"
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

  // Route creation state
  const [pendingInput, setPendingInput] = useState<number | null>(null)
  const [pendingOutputs, setPendingOutputs] = useState<number[]>([])
  const [routes, setRoutes] = useState<Record<number, number[]>>({})
  const [modifiedFile, setModifiedFile] = useState<string | null>(null)

  // Stability mode
  const [strictStability, setStrictStability] = useState(false)

  const inputs = useMemo(() => (state ? deriveInputs(state) : []), [state])

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

  // Handle route creation clicks (Click = create, Shift-click = add multicast)
  async function handleRouteClick(portId: number, isInput: boolean, event: React.MouseEvent) {
    console.log(`[debug] handleRouteClick: portId=${portId}, isInput=${isInput}, shiftKey=${event.shiftKey}`)
    console.log(`[debug] Current state: pendingInput=${pendingInput}, pendingOutputs=[${pendingOutputs.join(',')}]`)

    if (isInput) {
      // Click on input port - select it for routing
      setPendingInput(portId)
      setPendingOutputs([])
      console.log(`[debug] Selected input ${portId} for routing`)
    } else {
      // Click on output port
      if (pendingInput === null) {
        console.log(`[debug] No input selected, ignoring output click`)
        return
      }

      if (event.shiftKey) {
        // Shift-click: add output to route and submit immediately
        if (pendingOutputs.includes(portId)) {
          console.log(`[debug] Output ${portId} already in route, skipping`)
          return
        }
        const outputs = [...pendingOutputs, portId]
        console.log(`[debug] Shift-click: adding output ${portId}, creating route: input ${pendingInput} → outputs [${outputs.join(',')}]`)
        await submitRoute(pendingInput, outputs)
      } else {
        // Click: create/replace route with just this output
        console.log(`[debug] Click: creating route: input ${pendingInput} → output [${portId}]`)
        await submitRoute(pendingInput, [portId])
      }
    }
  }

  // Submit a new route to the API
  async function submitRoute(inputId: number, outputIds: number[]) {
    setError(null)
    setLoading(true)

    // Build new routes map
    const newRoutes = { ...routes }

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
      const parsed = fabricStateSchema.parse(json)
      setState(parsed)
      setSelectedInput(inputId) // Select the newly created route
      // Track that we modified the currently selected file
      if (selectedRoute) {
        setModifiedFile(selectedRoute)
      }

      // Keep input selected so user can add more outputs with Shift+Option
      // Set pendingOutputs to current outputs so Shift+Option adds to them
      setPendingOutputs(outputIds)
      console.log(`[debug] Route created. Keeping input ${inputId} selected with outputs [${outputIds.join(',')}]`)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to process routes")
      setPendingInput(null)
      setPendingOutputs([])
    } finally {
      setLoading(false)
    }
  }

  // Fetch route files on mount
  useEffect(() => {
    fetchRouteFiles()
  }, [])

  async function fetchRouteFiles() {
    try {
      const res = await fetch("/api/routes")
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

    try {
      const res = await fetch("/api/process", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename })
      })

      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || "Failed to process route file")
      }

      const json = await res.json()
      const parsed = fabricStateSchema.parse(json)
      setState(parsed)
      setSelectedInput(null)
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
        <div className="title">Clos Fabric Visualizer</div>
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

      <div className="body">
        <aside className="sidebar">
          {/* Route Files Section */}
          <div className="panel">
            <div className="panelTitle">Route Files</div>
            <div className="list routeList">
              {routeFiles.map(f => (
                <div key={f} className="routeFileRow">
                  <button
                    className={selectedRoute === f ? "row active" : "row"}
                    onClick={() => processRouteFile(f)}
                    disabled={loading}
                  >
                    <div className="rowMain">
                      <div className="rowId">{f}</div>
                    </div>
                  </button>
                  {modifiedFile === f && (
                    <button
                      className="saveBtn"
                      onClick={(e) => { e.stopPropagation(); saveRouteFile(f); }}
                      disabled={loading}
                    >
                      Save
                    </button>
                  )}
                </div>
              ))}
              {routeFiles.length === 0 && (
                <div className="hint">No route files found</div>
              )}
            </div>
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
            <button
              className="uploadBtn"
              onClick={() => uploadRef.current?.click()}
            >
              Upload Route File
            </button>
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
            />
          ) : (
            <div className="empty">Select a route file from the sidebar to visualize the fabric</div>
          )}
        </main>
      </div>
    </div>
  )
}
