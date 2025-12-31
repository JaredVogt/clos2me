import { useMemo, useRef, useState, useLayoutEffect } from "react"
import type { FabricState } from "./schema"
import { Crossbar } from "./Crossbar"
import type { CrossbarRef } from "./Crossbar"

type Props = {
  state: FabricState
  selectedInput: number | null
  onSelectInput: (id: number | null) => void
  // Route creation props
  onRouteClick?: (portId: number, isInput: boolean, event: React.MouseEvent) => void
  pendingInput?: number | null
  pendingOutputs?: number[]
}

type Cable = {
  fromRow: number
  fromPort: number  // spine index for ingress→spine, egress index for spine→egress
  toRow: number
  toPort: number
  owner: number
  stage: 1 | 2
}

export function FabricView({ state, selectedInput, onSelectInput, onRouteClick, pendingInput, pendingOutputs }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Refs for all crossbars
  const ingressRefs = useRef<(CrossbarRef | null)[]>([])
  const spineRefs = useRef<(CrossbarRef | null)[]>([])
  const egressRefs = useRef<(CrossbarRef | null)[]>([])

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
      }>
      spine: Array<{
        title: string
        inLabels: string[]
        outLabels: string[]
        paths: { inIdx: number; outIdx: number; owner: number }[]
      }>
      egress: Array<{
        title: string
        inLabels: string[]
        outLabels: string[]
        paths: { inIdx: number; outIdx: number; owner: number }[]
      }>
    } = { ingress: [], spine: [], egress: [] }

    // Ingress blocks
    for (let block = 0; block < state.TOTAL_BLOCKS; block++) {
      const basePort = block * state.N + 1
      const inLabels = Array.from({ length: state.N }, (_, k) => String(basePort + k))
      const outLabels = Array.from({ length: state.N }, (_, s) => `S${s + 1}`)

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
        paths
      })
    }

    // Spine switches
    for (let spine = 0; spine < state.N; spine++) {
      const inLabels = Array.from({ length: state.TOTAL_BLOCKS }, (_, b) => `I${b + 1}`)
      const outLabels = Array.from({ length: state.TOTAL_BLOCKS }, (_, e) => `E${e + 1}`)

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
        paths
      })
    }

    // Egress blocks
    for (let block = 0; block < state.TOTAL_BLOCKS; block++) {
      const basePort = block * state.N + 1
      const inLabels = Array.from({ length: state.N }, (_, s) => `S${s + 1}`)
      const outLabels = Array.from({ length: state.N }, (_, k) => String(basePort + k))

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
        paths
      })
    }

    return result
  }, [state])

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
            const isActive = c.owner === selectedInput
            const midX = (c.x1 + c.x2) / 2

            return (
              <path
                key={idx}
                d={`M ${c.x1} ${c.y1} C ${midX} ${c.y1}, ${midX} ${c.y2}, ${c.x2} ${c.y2}`}
                className={`interCable ${isActive ? "active" : ""}`}
                onClick={() => onSelectInput(c.owner)}
              />
            )
          })}
        </svg>
      )}

      {/* Column headers */}
      <div className="gridHeader">Ingress</div>
      <div className="gridHeader">Spine</div>
      <div className="gridHeader">Egress</div>

      {/* 10 rows of crossbars */}
      {Array.from({ length: state.TOTAL_BLOCKS }).map((_, row) => (
        <div key={row} className="gridRow">
          <Crossbar
            ref={el => { ingressRefs.current[row] = el }}
            {...crossbars.ingress[row]}
            selectedInput={selectedInput}
            onSelectInput={onSelectInput}
            onRouteClick={onRouteClick ? (label, isInput, e) => {
              // Only handle IN port clicks on ingress (selecting input)
              if (isInput) {
                const portId = parseInt(label)
                console.log(`[debug] FabricView ingress IN click: label=${label}, portId=${portId}, shiftKey=${e.shiftKey}`)
                if (!isNaN(portId)) onRouteClick(portId, true, e)
              }
            } : undefined}
            pendingInput={pendingInput}
          />
          <Crossbar
            ref={el => { spineRefs.current[row] = el }}
            {...crossbars.spine[row]}
            selectedInput={selectedInput}
            onSelectInput={onSelectInput}
          />
          <Crossbar
            ref={el => { egressRefs.current[row] = el }}
            {...crossbars.egress[row]}
            selectedInput={selectedInput}
            onSelectInput={onSelectInput}
            onRouteClick={onRouteClick ? (label, isInput, e) => {
              // Only handle OUT port clicks on egress (selecting output)
              if (!isInput) {
                const portId = parseInt(label)
                console.log(`[debug] FabricView egress OUT click: label=${label}, portId=${portId}, shiftKey=${e.shiftKey}, altKey=${e.altKey}`)
                if (!isNaN(portId)) onRouteClick(portId, false, e)
              }
            } : undefined}
            pendingOutputs={pendingOutputs}
          />
        </div>
      ))}
    </div>
  )
}
