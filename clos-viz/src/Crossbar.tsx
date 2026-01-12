import { useLayoutEffect, useRef, useState, useImperativeHandle, forwardRef } from "react"
import { parsePortId } from "./utils"

type Path = {
  inIdx: number
  outIdx: number
  owner: number
  isFiller?: boolean
}

type Props = {
  title: string
  inLabels: string[]
  outLabels: string[]
  paths: Path[]
  highlightInput?: number | null
  highlightMode?: 'normal' | 'locked'
  onSelectInput: (id: number | null) => void
  onHoverInput?: (id: number | null, fromLock: boolean) => void
  inLockStates?: Array<'locked' | 'related' | 'none'>
  outLockStates?: Array<'locked' | 'related' | 'none'>
  // Route creation props
  onRouteClick?: (label: string, isInput: boolean, event: React.MouseEvent) => void
  pendingInput?: number | null
  pendingOutputs?: number[]
}

type PortPos = { x: number; y: number }

export type CrossbarRef = {
  getInPortPosition: (idx: number) => PortPos | null
  getOutPortPosition: (idx: number) => PortPos | null
}

export const Crossbar = forwardRef<CrossbarRef, Props>(function Crossbar(
  {
    title,
    inLabels,
    outLabels,
    paths,
    highlightInput = null,
    highlightMode = 'normal',
    onSelectInput,
    onHoverInput,
    onRouteClick,
    inLockStates = [],
    outLockStates = [],
    pendingInput,
    pendingOutputs = []
  },
  ref
) {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const inPortRefs = useRef<(HTMLDivElement | null)[]>([])
  const outPortRefs = useRef<(HTMLDivElement | null)[]>([])

  const [positions, setPositions] = useState<{
    inPorts: PortPos[]
    outPorts: PortPos[]
    width: number
    height: number
  } | null>(null)

  function measure() {
    const container = containerRef.current
    if (!container) return
    const rect = container.getBoundingClientRect()

    const read = (el: HTMLDivElement | null): PortPos => {
      if (!el) return { x: 0, y: 0 }
      const r = el.getBoundingClientRect()
      return {
        x: r.left - rect.left + r.width / 2,
        y: r.top - rect.top + r.height / 2
      }
    }

    const inPorts = inLabels.map((_, i) => read(inPortRefs.current[i]))
    const outPorts = outLabels.map((_, i) => read(outPortRefs.current[i]))

    setPositions({ inPorts, outPorts, width: rect.width, height: rect.height })
  }

  // Expose methods to get port positions in page coordinates
  useImperativeHandle(ref, () => ({
    getInPortPosition: (idx: number) => {
      const el = inPortRefs.current[idx]
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    },
    getOutPortPosition: (idx: number) => {
      const el = outPortRefs.current[idx]
      if (!el) return null
      const r = el.getBoundingClientRect()
      return { x: r.left + r.width / 2, y: r.top + r.height / 2 }
    }
  }))

  useLayoutEffect(() => {
    measure()
    const onResize = () => measure()
    window.addEventListener("resize", onResize)
    return () => window.removeEventListener("resize", onResize)
  }, [inLabels, outLabels])

  return (
    <div className="crossbar">
      <div className="crossbarTitle">{title}</div>
      <div className="crossbarBody" ref={containerRef}>
        {/* IN ports */}
        <div className="crossbarPorts inPorts">
          {inLabels.map((label, i) => {
            const isActive = paths.some(p => p.inIdx === i && p.owner === highlightInput)
            const isUsed = paths.some(p => p.inIdx === i)
            const isPending = pendingInput !== null && pendingInput === parsePortId(label)
            const lockState = inLockStates[i] ?? 'none'
            const isLocked = lockState === 'locked'
            const isRelated = lockState === 'related'

            return (
              <div
                key={i}
                ref={el => { inPortRefs.current[i] = el }}
                className={`crossbarPort ${isPending ? "pending" : isActive ? "active" : isUsed ? "used" : ""} ${isLocked ? "locked" : isRelated ? "related" : ""}`}
                onClick={(e) => {
                  if (e.altKey) {
                    // Option-click: highlight/select route
                    const path = paths.find(p => p.inIdx === i)
                    if (path && path.owner > 0) onSelectInput(path.owner)
                  } else if (onRouteClick) {
                    // Click or Shift-click: route creation
                    onRouteClick(label, true, e)
                  }
                }}
                onMouseEnter={() => {
                  const path = paths.find(p => p.inIdx === i)
                  if (path && path.owner > 0 && onHoverInput) onHoverInput(path.owner, lockState !== 'none')
                }}
                onMouseLeave={() => onHoverInput && onHoverInput(null, false)}
                title={label}
              >
                <span className="portDot" />
                <span className="portText">{label}</span>
              </div>
            )
          })}
        </div>

        {/* SVG for internal paths */}
        {positions && (
          <svg className="crossbarSvg" width={positions.width} height={positions.height}>
            {paths.map((p, idx) => {
              const from = positions.inPorts[p.inIdx]
              const to = positions.outPorts[p.outIdx]
              if (!from || !to) return null

              const isActive = p.owner === highlightInput
              const isLockedActive = isActive && highlightMode === 'locked'

              // Draw Bezier curve
              const midX = (from.x + to.x) / 2

              return (
                <path
                  key={idx}
                  d={`M ${from.x} ${from.y} C ${midX} ${from.y}, ${midX} ${to.y}, ${to.x} ${to.y}`}
                  className={`crossbarPath ${p.isFiller ? "filler" : ""} ${isActive ? "active" : ""} ${isLockedActive ? "locked" : ""}`}
                  onClick={() => {
                    if (p.owner > 0) onSelectInput(p.owner)
                  }}
                />
              )
            })}
          </svg>
        )}

        {/* OUT ports */}
        <div className="crossbarPorts outPorts">
          {outLabels.map((label, i) => {
            const isActive = paths.some(p => p.outIdx === i && p.owner === highlightInput)
            const isUsed = paths.some(p => p.outIdx === i)
            const isPendingOut = pendingOutputs.includes(parsePortId(label))
            const lockState = outLockStates[i] ?? 'none'
            const isLocked = lockState === 'locked'
            const isRelated = lockState === 'related'

            return (
              <div
                key={i}
                ref={el => { outPortRefs.current[i] = el }}
                className={`crossbarPort ${isPendingOut ? "pendingOut" : isActive ? "active" : isUsed ? "used" : ""} ${isLocked ? "locked" : isRelated ? "related" : ""}`}
                onClick={(e) => {
                  console.log(`[debug] OUT port click: label=${label}, altKey=${e.altKey}, shiftKey=${e.shiftKey}, onRouteClick=${!!onRouteClick}`)
                  if (e.altKey) {
                    // Option-click: highlight/select route
                    const path = paths.find(p => p.outIdx === i)
                    if (path && path.owner > 0) onSelectInput(path.owner)
                  } else if (onRouteClick) {
                    // Click or Shift-click: route creation
                    onRouteClick(label, false, e)
                  }
                }}
                onMouseEnter={() => {
                  const path = paths.find(p => p.outIdx === i)
                  if (path && path.owner > 0 && onHoverInput) onHoverInput(path.owner, lockState !== 'none')
                }}
                onMouseLeave={() => onHoverInput && onHoverInput(null, false)}
                title={label}
              >
                <span className="portText">{label}</span>
                <span className="portDot" />
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
})
