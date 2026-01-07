import { useMemo, useRef, useState, useLayoutEffect, useCallback } from "react"
import type { FabricState } from "./schema"
import { Crossbar } from "./Crossbar"
import type { CrossbarRef } from "./Crossbar"
import { RelayMatrix } from "./RelayMatrix"
import { portToProPatch, parsePortId } from "./utils"

type Props = {
  state: FabricState
  selectedInput: number | null
  highlightInput?: number | null
  highlightMode?: 'normal' | 'locked'
  locksByInput?: Record<number, Record<number, number>>
  onSelectInput: (id: number | null) => void
  onHoverInput?: (id: number | null, fromLock: boolean) => void
  // Route creation props
  onRouteClick?: (portId: number, isInput: boolean, event: React.MouseEvent) => void
  pendingInput?: number | null
  pendingOutputs?: number[]
  // Usage counts
  activeInputCount?: number
  activeOutputCount?: number
  // Relay mode
  relayMode?: boolean
}

type HoveredCrossbar = {
  column: 'ingress' | 'spine' | 'egress'
  row: number
  position: { x: number; y: number }
}

type Cable = {
  fromRow: number
  fromPort: number  // spine index for ingress→spine, egress index for spine→egress
  toRow: number
  toPort: number
  owner: number
  stage: 1 | 2
}

type PortLockState = 'locked' | 'related' | 'none'

export function FabricView({
  state,
  selectedInput,
  highlightInput = null,
  highlightMode = 'normal',
  locksByInput = {},
  onSelectInput,
  onHoverInput,
  onRouteClick,
  pendingInput,
  pendingOutputs,
  activeInputCount,
  activeOutputCount,
  relayMode
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Refs for all crossbars
  const ingressRefs = useRef<(CrossbarRef | null)[]>([])
  const spineRefs = useRef<(CrossbarRef | null)[]>([])
  const egressRefs = useRef<(CrossbarRef | null)[]>([])

  // Hover tracking for relay mode
  const [hoveredCrossbar, setHoveredCrossbar] = useState<HoveredCrossbar | null>(null)

  // Handle crossbar hover
  const handleCrossbarHover = useCallback((column: 'ingress' | 'spine' | 'egress', row: number, event: React.MouseEvent) => {
    if (!relayMode) return
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    setHoveredCrossbar({
      column,
      row,
      position: { x: rect.right, y: rect.top + rect.height / 2 }
    })
  }, [relayMode])

  const handleCrossbarLeave = useCallback(() => {
    setHoveredCrossbar(null)
  }, [])

  const [cablePositions, setCablePositions] = useState<{
    cables: Array<{ x1: number; y1: number; x2: number; y2: number; owner: number; stage: 1 | 2 }>
    width: number
    height: number
  } | null>(null)

  // Build crossbar data for all 30 switches
  const crossbars = useMemo(() => {
    const result: {
      ingress: Array<{
        title: string
        inLabels: string[]
        outLabels: string[]
        paths: { inIdx: number; outIdx: number; owner: number }[]
        inLockStates: PortLockState[]
        outLockStates: PortLockState[]
      }>
      spine: Array<{
        title: string
        inLabels: string[]
        outLabels: string[]
        paths: { inIdx: number; outIdx: number; owner: number }[]
        inLockStates: PortLockState[]
        outLockStates: PortLockState[]
      }>
      egress: Array<{
        title: string
        inLabels: string[]
        outLabels: string[]
        paths: { inIdx: number; outIdx: number; owner: number }[]
        inLockStates: PortLockState[]
        outLockStates: PortLockState[]
      }>
    } = { ingress: [], spine: [], egress: [] }

    const lockedInputs = new Set<number>(
      Object.keys(locksByInput).map(id => Number(id))
    )

    const usedBlocksByInput: Record<number, Set<number>> = {}
    for (let port = 1; port <= state.MAX_PORTS; port++) {
      const owner = state.s3_port_owner[port]
      if (!owner || owner <= 0) continue
      const block = Math.floor((port - 1) / state.N)
      if (!usedBlocksByInput[owner]) usedBlocksByInput[owner] = new Set()
      usedBlocksByInput[owner].add(block)
    }

    const initLockMatrix = (rows: number, cols: number) =>
      Array.from({ length: rows }, () => Array.from({ length: cols }, () => 'none' as PortLockState))

    const ingressOutLocks = initLockMatrix(state.TOTAL_BLOCKS, state.N)
    const spineInLocks = initLockMatrix(state.N, state.TOTAL_BLOCKS)
    const spineOutLocks = initLockMatrix(state.N, state.TOTAL_BLOCKS)
    const egressInLocks = initLockMatrix(state.TOTAL_BLOCKS, state.N)

    const hardLockedInputs = new Set<number>()
    for (const [inputId, blocks] of Object.entries(locksByInput)) {
      const input = Number(inputId)
      const lockedBlocks = Object.keys(blocks).map(Number)
      const usedBlocks = usedBlocksByInput[input] || new Set()
      if (lockedBlocks.length === 0 || usedBlocks.size === 0) continue
      const coversAll = lockedBlocks.length === usedBlocks.size && lockedBlocks.every(b => usedBlocks.has(b))
      if (coversAll) hardLockedInputs.add(input)
    }

    const setLockState = (matrix: PortLockState[][], row: number, col: number, next: PortLockState) => {
      const current = matrix[row][col]
      if (current === 'locked') return
      if (next === 'locked') {
        matrix[row][col] = 'locked'
      } else if (current === 'none') {
        matrix[row][col] = 'related'
      }
    }

    for (const [inputId, blocks] of Object.entries(locksByInput)) {
      const input = Number(inputId)
      const ingressBlock = Math.floor((input - 1) / state.N)
      const usedBlocks = usedBlocksByInput[input] || new Set()
      for (const [egressBlockStr, spine] of Object.entries(blocks)) {
        const egressBlock = Number(egressBlockStr)
        if (!usedBlocks.has(egressBlock)) continue
        if (spine < 0 || spine >= state.N) continue
        if (ingressBlock < 0 || ingressBlock >= state.TOTAL_BLOCKS) continue
        const isHard = hardLockedInputs.has(input)
        const lockState: PortLockState = isHard ? 'locked' : 'related'
        setLockState(ingressOutLocks, ingressBlock, spine, lockState)
        setLockState(spineInLocks, spine, ingressBlock, lockState)
        setLockState(spineOutLocks, spine, egressBlock, lockState)
        setLockState(egressInLocks, egressBlock, spine, lockState)
      }
    }

    // Ingress blocks
    for (let block = 0; block < state.TOTAL_BLOCKS; block++) {
      const basePort = block * state.N + 1
      const inLabels = Array.from({ length: state.N }, (_, k) => portToProPatch(basePort + k))
      const outLabels = Array.from({ length: state.N }, (_, s) => `S${s + 1}`)
      const inLockStates: PortLockState[] = Array.from({ length: state.N }, (_, k) => {
        const inputId = basePort + k
        return lockedInputs.has(inputId) ? 'locked' : 'none'
      })
      const outLockStates: PortLockState[] = Array.from({ length: state.N }, (_, s) => (
        ingressOutLocks[block]?.[s] ?? 'none'
      ))

      const paths: { inIdx: number; outIdx: number; owner: number }[] = []
      for (let spine = 0; spine < state.N; spine++) {
        const owner = state.s1_to_s2[block]?.[spine] ?? 0
        if (owner) {
          const inIdx = owner - basePort
          if (inIdx >= 0 && inIdx < state.N) {
            paths.push({ inIdx, outIdx: spine, owner })
          }
        }
      }

      result.ingress.push({
        title: `Ingr ${String(block + 1).padStart(2, "0")}`,
        inLabels,
        outLabels,
        paths,
        inLockStates,
        outLockStates
      })
    }

    // Spine switches
    for (let spine = 0; spine < state.N; spine++) {
      const inLabels = Array.from({ length: state.TOTAL_BLOCKS }, (_, b) => `I${b + 1}`)
      const outLabels = Array.from({ length: state.TOTAL_BLOCKS }, (_, e) => `E${e + 1}`)
      const inLockStates: PortLockState[] = Array.from({ length: state.TOTAL_BLOCKS }, (_, b) => (
        spineInLocks[spine]?.[b] ?? 'none'
      ))
      const outLockStates: PortLockState[] = Array.from({ length: state.TOTAL_BLOCKS }, (_, e) => (
        spineOutLocks[spine]?.[e] ?? 'none'
      ))

      const paths: { inIdx: number; outIdx: number; owner: number }[] = []

      for (let ingressBlock = 0; ingressBlock < state.TOTAL_BLOCKS; ingressBlock++) {
        const owner = state.s1_to_s2[ingressBlock]?.[spine] ?? 0
        if (!owner) continue

        for (let egressBlock = 0; egressBlock < state.TOTAL_BLOCKS; egressBlock++) {
          if ((state.s2_to_s3[spine]?.[egressBlock] ?? 0) === owner) {
            paths.push({ inIdx: ingressBlock, outIdx: egressBlock, owner })
          }
        }
      }

      result.spine.push({
        title: `Spine ${String(spine + 1).padStart(2, "0")}`,
        inLabels,
        outLabels,
        paths,
        inLockStates,
        outLockStates
      })
    }

    // Egress blocks
    for (let block = 0; block < state.TOTAL_BLOCKS; block++) {
      const basePort = block * state.N + 1
      const inLabels = Array.from({ length: state.N }, (_, s) => `S${s + 1}`)
      const outLabels = Array.from({ length: state.N }, (_, k) => portToProPatch(basePort + k))
      const inLockStates: PortLockState[] = Array.from({ length: state.N }, (_, s) => (
        egressInLocks[block]?.[s] ?? 'none'
      ))
      const outLockStates: PortLockState[] = Array.from({ length: state.N }, (_, k) => {
        const port = basePort + k
        const owner = state.s3_port_owner[port] ?? 0
        if (!owner) return 'none'
        const ownerLocks = locksByInput[owner]
        if (!ownerLocks || Object.keys(ownerLocks).length === 0) return 'none'
        return ownerLocks[block] !== undefined ? 'locked' : 'related'
      })

      const paths: { inIdx: number; outIdx: number; owner: number }[] = []

      for (let k = 0; k < state.N; k++) {
        const port = basePort + k
        const owner = state.s3_port_owner[port] ?? 0
        const spine = state.s3_port_spine[port] ?? -1

        if (owner && spine >= 0) {
          paths.push({ inIdx: spine, outIdx: k, owner })
        }
      }

      result.egress.push({
        title: `Egr ${String(block + 1).padStart(2, "0")}`,
        inLabels,
        outLabels,
        paths,
        inLockStates,
        outLockStates
      })
    }

    return result
  }, [state, locksByInput])

  // Build inter-column cables
  const cables = useMemo(() => {
    const list: Cable[] = []

    // Stage 1: Ingress OUT → Spine IN
    // Ingress block B, OUT port S connects to Spine S, IN port B
    for (let block = 0; block < state.TOTAL_BLOCKS; block++) {
      for (let spine = 0; spine < state.N; spine++) {
        const owner = state.s1_to_s2[block]?.[spine] ?? 0
        if (owner) {
          list.push({
            fromRow: block,
            fromPort: spine,
            toRow: spine,
            toPort: block,
            owner,
            stage: 1
          })
        }
      }
    }

    // Stage 2: Spine OUT → Egress IN
    // Spine S, OUT port E connects to Egress block E, IN port S
    for (let spine = 0; spine < state.N; spine++) {
      for (let egress = 0; egress < state.TOTAL_BLOCKS; egress++) {
        const owner = state.s2_to_s3[spine]?.[egress] ?? 0
        if (owner) {
          list.push({
            fromRow: spine,
            fromPort: egress,
            toRow: egress,
            toPort: spine,
            owner,
            stage: 2
          })
        }
      }
    }

    return list
  }, [state])

  // Compute relay data for hovered crossbar
  const relayData = useMemo(() => {
    if (!hoveredCrossbar) return null

    const { column, row } = hoveredCrossbar

    if (column === 'ingress') {
      // Ingress block: rows = local input ports, cols = spines
      const block = row
      const basePort = block * state.N + 1
      const inLabels = Array.from({ length: state.N }, (_, k) => portToProPatch(basePort + k))
      const outLabels = Array.from({ length: state.N }, (_, s) => `S${s + 1}`)

      const relays: Array<Array<{ isActive: boolean; owner: number }>> = []
      for (let i = 0; i < state.N; i++) {
        const rowRelays: Array<{ isActive: boolean; owner: number }> = []
        const portId = basePort + i
        for (let j = 0; j < state.N; j++) {
          const owner = state.s1_to_s2[block]?.[j] ?? 0
          const isActive = owner === portId && owner > 0
          rowRelays.push({ isActive, owner: isActive ? owner : 0 })
        }
        relays.push(rowRelays)
      }

      return {
        title: `Ingr ${String(block + 1).padStart(2, '0')} Relays`,
        inLabels,
        outLabels,
        relays
      }
    }

    if (column === 'spine') {
      // Spine: rows = ingress blocks, cols = egress blocks
      const spine = row
      const inLabels = Array.from({ length: state.TOTAL_BLOCKS }, (_, b) => `I${b + 1}`)
      const outLabels = Array.from({ length: state.TOTAL_BLOCKS }, (_, e) => `E${e + 1}`)

      const relays: Array<Array<{ isActive: boolean; owner: number }>> = []
      for (let ingressBlock = 0; ingressBlock < state.TOTAL_BLOCKS; ingressBlock++) {
        const rowRelays: Array<{ isActive: boolean; owner: number }> = []
        const ingressOwner = state.s1_to_s2[ingressBlock]?.[spine] ?? 0

        for (let egressBlock = 0; egressBlock < state.TOTAL_BLOCKS; egressBlock++) {
          const egressOwner = state.s2_to_s3[spine]?.[egressBlock] ?? 0
          // Relay is active if ingress trunk is active AND egress trunk has same owner
          const isActive = ingressOwner > 0 && egressOwner === ingressOwner
          rowRelays.push({ isActive, owner: isActive ? ingressOwner : 0 })
        }
        relays.push(rowRelays)
      }

      return {
        title: `Spine ${String(spine + 1).padStart(2, '0')} Relays`,
        inLabels,
        outLabels,
        relays
      }
    }

    if (column === 'egress') {
      // Egress block: rows = spines, cols = local output ports
      const block = row
      const basePort = block * state.N + 1
      const inLabels = Array.from({ length: state.N }, (_, s) => `S${s + 1}`)
      const outLabels = Array.from({ length: state.N }, (_, k) => portToProPatch(basePort + k))

      const relays: Array<Array<{ isActive: boolean; owner: number }>> = []
      for (let spine = 0; spine < state.N; spine++) {
        const rowRelays: Array<{ isActive: boolean; owner: number }> = []
        for (let k = 0; k < state.N; k++) {
          const port = basePort + k
          const owner = state.s3_port_owner[port] ?? 0
          const portSpine = state.s3_port_spine[port] ?? -1
          // Relay is active if this port uses this spine
          const isActive = owner > 0 && portSpine === spine
          rowRelays.push({ isActive, owner: isActive ? owner : 0 })
        }
        relays.push(rowRelays)
      }

      return {
        title: `Egr ${String(block + 1).padStart(2, '0')} Relays`,
        inLabels,
        outLabels,
        relays
      }
    }

    return null
  }, [hoveredCrossbar, state])

  // Measure cable positions
  function measureCables() {
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const measured: Array<{ x1: number; y1: number; x2: number; y2: number; owner: number; stage: 1 | 2 }> = []

    for (const cable of cables) {
      let from: { x: number; y: number } | null = null
      let to: { x: number; y: number } | null = null

      if (cable.stage === 1) {
        // Ingress OUT → Spine IN
        from = ingressRefs.current[cable.fromRow]?.getOutPortPosition(cable.fromPort) ?? null
        to = spineRefs.current[cable.toRow]?.getInPortPosition(cable.toPort) ?? null
      } else {
        // Spine OUT → Egress IN
        from = spineRefs.current[cable.fromRow]?.getOutPortPosition(cable.fromPort) ?? null
        to = egressRefs.current[cable.toRow]?.getInPortPosition(cable.toPort) ?? null
      }

      if (from && to) {
        measured.push({
          x1: from.x - rect.left,
          y1: from.y - rect.top,
          x2: to.x - rect.left,
          y2: to.y - rect.top,
          owner: cable.owner,
          stage: cable.stage
        })
      }
    }

    setCablePositions({ cables: measured, width: rect.width, height: rect.height })
  }

  useLayoutEffect(() => {
    // Delay measurement to ensure crossbars have rendered
    const timer = setTimeout(measureCables, 50)
    const onResize = () => measureCables()
    window.addEventListener("resize", onResize)
    return () => {
      clearTimeout(timer)
      window.removeEventListener("resize", onResize)
    }
  }, [state, cables])

  return (
    <div className="fabricGrid" ref={containerRef}>
      {/* Inter-column cables SVG */}
      {cablePositions && (
        <svg className="cablesSvg" width={cablePositions.width} height={cablePositions.height}>
          {cablePositions.cables.map((c, idx) => {
            const isActive = c.owner === highlightInput
            const isLockedActive = isActive && highlightMode === 'locked'
            const midX = (c.x1 + c.x2) / 2

            return (
              <path
                key={idx}
                d={`M ${c.x1} ${c.y1} C ${midX} ${c.y1}, ${midX} ${c.y2}, ${c.x2} ${c.y2}`}
                className={`interCable ${isActive ? "active" : ""} ${isLockedActive ? "locked" : ""}`}
                onClick={() => onSelectInput(c.owner)}
              />
            )
          })}
        </svg>
      )}

      {/* Column headers */}
      <div className="gridHeader">Input{activeInputCount !== undefined ? ` (${activeInputCount})` : ''}</div>
      <div className="gridHeader">Spine</div>
      <div className="gridHeader">Output{activeOutputCount !== undefined ? ` (${activeOutputCount})` : ''}</div>

      {/* 10 rows of crossbars */}
      {Array.from({ length: state.TOTAL_BLOCKS }).map((_, row) => (
        <div key={row} className="gridRow">
          <div
            className={`crossbarWrapper ${relayMode ? 'relayModeActive' : ''}`}
            onMouseEnter={(e) => handleCrossbarHover('ingress', row, e)}
            onMouseLeave={handleCrossbarLeave}
          >
            <Crossbar
              ref={el => { ingressRefs.current[row] = el }}
              {...crossbars.ingress[row]}
              highlightInput={highlightInput}
              highlightMode={highlightMode}
              onHoverInput={onHoverInput}
              onSelectInput={onSelectInput}
              onRouteClick={onRouteClick ? (label, isInput, e) => {
                // Only handle IN port clicks on ingress (selecting input)
                if (isInput) {
                  const portId = parsePortId(label)
                  console.log(`[debug] FabricView ingress IN click: label=${label}, portId=${portId}, shiftKey=${e.shiftKey}`)
                  if (!isNaN(portId)) onRouteClick(portId, true, e)
                }
              } : undefined}
              pendingInput={pendingInput}
            />
          </div>
          <div
            className={`crossbarWrapper ${relayMode ? 'relayModeActive' : ''}`}
            onMouseEnter={(e) => handleCrossbarHover('spine', row, e)}
            onMouseLeave={handleCrossbarLeave}
          >
            <Crossbar
              ref={el => { spineRefs.current[row] = el }}
              {...crossbars.spine[row]}
              highlightInput={highlightInput}
              highlightMode={highlightMode}
              onHoverInput={onHoverInput}
              onSelectInput={onSelectInput}
            />
          </div>
          <div
            className={`crossbarWrapper ${relayMode ? 'relayModeActive' : ''}`}
            onMouseEnter={(e) => handleCrossbarHover('egress', row, e)}
            onMouseLeave={handleCrossbarLeave}
          >
            <Crossbar
              ref={el => { egressRefs.current[row] = el }}
              {...crossbars.egress[row]}
              highlightInput={highlightInput}
              highlightMode={highlightMode}
              onHoverInput={onHoverInput}
              onSelectInput={onSelectInput}
              onRouteClick={onRouteClick ? (label, isInput, e) => {
                // Only handle OUT port clicks on egress (selecting output)
                if (!isInput) {
                  const portId = parsePortId(label)
                  console.log(`[debug] FabricView egress OUT click: label=${label}, portId=${portId}, shiftKey=${e.shiftKey}, altKey=${e.altKey}`)
                  if (!isNaN(portId)) onRouteClick(portId, false, e)
                }
              } : undefined}
              pendingOutputs={pendingOutputs}
            />
          </div>
        </div>
      ))}

      {/* Relay Matrix Overlay */}
      {relayMode && relayData && hoveredCrossbar && (
        <RelayMatrix
          title={relayData.title}
          inLabels={relayData.inLabels}
          outLabels={relayData.outLabels}
          relays={relayData.relays}
          selectedInput={selectedInput}
          position={hoveredCrossbar.position}
          onClose={handleCrossbarLeave}
        />
      )}
    </div>
  )
}
