import { useMemo, useState } from "react"

type RelayCell = {
  isActive: boolean
  owner: number
  isFiller?: boolean
}

type TreebarCell = {
  state: 'hiz' | 'set' | 'reset'
  owner: number
  isSelected: boolean
}

type Props = {
  title: string
  inLabels: string[]
  outLabels: string[]
  // 2D array: relays[inIdx][outIdx] = { isActive, owner }
  relays: RelayCell[][]
  selectedInput: number | null
  position: { x: number; y: number }
  onHover?: () => void
  onClose: (event?: React.MouseEvent<HTMLDivElement>) => void
}

type TreeNode =
  | { kind: 'leaf'; input: number }
  | { kind: 'relay'; index: number; left: TreeNode; right: TreeNode }

const buildTreebarLayout = (size: number) => {
  if (size <= 1) {
    return { relayCount: 0, statesByInput: Array.from({ length: size }, () => []), rowLabels: [] as string[] }
  }

  let relayIndex = 0
  let nodes: TreeNode[] = Array.from({ length: size }, (_, i) => ({ kind: 'leaf', input: i }))

  while (nodes.length > 1) {
    const next: TreeNode[] = []
    for (let i = 0; i < nodes.length; i += 2) {
      if (i + 1 < nodes.length) {
        const node: TreeNode = { kind: 'relay', index: relayIndex++, left: nodes[i], right: nodes[i + 1] }
        next.push(node)
      } else {
        next.push(nodes[i])
      }
    }
    nodes = next
  }

  const relayCount = relayIndex
  const statesByInput = Array.from({ length: size }, () => Array(relayCount).fill(-1))
  const root = nodes[0]

  const traverse = (node: TreeNode, state: number[]) => {
    if (node.kind === 'leaf') {
      statesByInput[node.input] = state
      return
    }
    const leftState = [...state]
    leftState[node.index] = 1
    traverse(node.left, leftState)
    const rightState = [...state]
    rightState[node.index] = 0
    traverse(node.right, rightState)
  }

  traverse(root, Array(relayCount).fill(-1))

  const padWidth = Math.max(2, String(relayCount).length)
  const rowLabels = Array.from({ length: relayCount }, (_, i) => `K${String(i + 1).padStart(padWidth, '0')}`)

  return { relayCount, statesByInput, rowLabels }
}

export function RelayMatrix({ title, inLabels, outLabels, relays, selectedInput, position, onHover, onClose }: Props) {
  const [viewMode, setViewMode] = useState<'xy' | 'treebar'>('xy')
  const treebarSupport = relays.length > 1 && relays.length === outLabels.length
  const treebarLayout = useMemo(
    () => (treebarSupport ? buildTreebarLayout(relays.length) : null),
    [treebarSupport, relays.length]
  )

  // Calculate which rows and columns have any active relays
  const activeRows = new Set<number>()
  const activeCols = new Set<number>()
  const selectedRows = new Set<number>()
  const selectedCols = new Set<number>()
  let hasFiller = false

  for (let i = 0; i < relays.length; i++) {
    for (let j = 0; j < (relays[i]?.length ?? 0); j++) {
      const cell = relays[i][j]
      if (cell?.isActive) {
        activeRows.add(i)
        activeCols.add(j)
        if (cell.owner === selectedInput) {
          selectedRows.add(i)
          selectedCols.add(j)
        }
      }
      if (cell?.isFiller) hasFiller = true
    }
  }

  const treebarData = useMemo(() => {
    if (!treebarSupport || !treebarLayout) return null

    const outputInputs = outLabels.map((_, outIdx) => {
      let inputIdx = -1
      let owner = 0
      for (let inIdx = 0; inIdx < relays.length; inIdx++) {
        const cell = relays[inIdx]?.[outIdx]
        if (cell?.isActive) {
          inputIdx = inIdx
          owner = cell.owner
          break
        }
      }
      return { inputIdx, owner }
    })

    const rows: TreebarCell[][] = []
    for (let row = 0; row < treebarLayout.relayCount; row++) {
      const rowCells: TreebarCell[] = []
      for (let outIdx = 0; outIdx < outLabels.length; outIdx++) {
        const { inputIdx, owner } = outputInputs[outIdx]
        const stateValue = inputIdx >= 0 ? treebarLayout.statesByInput[inputIdx]?.[row] ?? -1 : -1
        const state = stateValue === -1 ? 'hiz' : stateValue === 1 ? 'set' : 'reset'
        const isSelected = stateValue !== -1 && owner > 0 && owner === selectedInput
        rowCells.push({ state, owner: stateValue === -1 ? 0 : owner, isSelected })
      }
      rows.push(rowCells)
    }

    const treebarActiveRows = new Set<number>()
    const treebarActiveCols = new Set<number>()
    const treebarSelectedRows = new Set<number>()
    const treebarSelectedCols = new Set<number>()

    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < rows[i].length; j++) {
        const cell = rows[i][j]
        if (cell.state !== 'hiz') {
          treebarActiveRows.add(i)
          treebarActiveCols.add(j)
          if (cell.isSelected) {
            treebarSelectedRows.add(i)
            treebarSelectedCols.add(j)
          }
        }
      }
    }

    return {
      rows,
      activeRows: treebarActiveRows,
      activeCols: treebarActiveCols,
      selectedRows: treebarSelectedRows,
      selectedCols: treebarSelectedCols,
      outputInputs
    }
  }, [outLabels, relays, selectedInput, treebarLayout, treebarSupport])

  // Adjust position to stay on screen
  const margin = 20
  const estimatedWidth = 300
  const estimatedHeight = 320

  let x = position.x + 10
  let y = position.y - estimatedHeight / 2

  // Keep on screen
  if (x + estimatedWidth > window.innerWidth - margin) {
    x = position.x - estimatedWidth - 10
  }
  if (y < margin) {
    y = margin
  }
  if (y + estimatedHeight > window.innerHeight - margin) {
    y = window.innerHeight - margin - estimatedHeight
  }

  return (
    <div
      className={`relayMatrix ${viewMode === 'treebar' ? 'treebarMode' : 'xyMode'}`}
      style={{ left: x, top: y }}
      onMouseEnter={onHover}
      onMouseLeave={onClose}
    >
      <div className="relayMatrixHeader">
        <div className="relayMatrixTitle">{title}</div>
        <div className="relayMatrixTabs">
          <button
            className={`relayMatrixTab ${viewMode === 'xy' ? 'active' : ''}`}
            type="button"
            onClick={() => setViewMode('xy')}
          >
            XY
          </button>
          <button
            className={`relayMatrixTab ${viewMode === 'treebar' ? 'active' : ''} ${treebarSupport ? '' : 'disabled'}`}
            type="button"
            onClick={() => setViewMode('treebar')}
            title={treebarSupport ? 'Treebar relay view' : 'Treebar view requires a square crossbar (N>1)'}
            aria-disabled={!treebarSupport}
          >
            Treebar
          </button>
        </div>
      </div>

      {viewMode === 'xy' && (
        <div className="relayGrid">
          {/* Header row with output labels */}
          <div className="relayRow relayHeaderRow">
            <div className="relayHeaderCell relayCorner" />
            {outLabels.map((_, j) => (
              <div
                key={j}
                className={`relayHeaderCell relayHeaderCol ${activeCols.has(j) ? 'active' : ''} ${selectedCols.has(j) ? 'selected' : ''}`}
              >
                {j + 1}
              </div>
            ))}
          </div>

          {/* Data rows */}
          {inLabels.map((_, i) => (
            <div key={i} className="relayRow relayDataRow">
              <div
                className={`relayHeaderCell relayRowLabel ${activeRows.has(i) ? 'active' : ''} ${selectedRows.has(i) ? 'selected' : ''}`}
              >
                {i + 1}
              </div>
              {outLabels.map((_, j) => {
                const cell = relays[i]?.[j]
                const isActive = cell?.isActive ?? false
                const isFiller = cell?.isFiller ?? false
                const isSelected = isActive && cell?.owner === selectedInput
                const cellClass = isActive ? (isFiller ? 'filler' : 'active') : 'unused'

                return (
                  <div
                    key={j}
                    className={`relayCell ${cellClass} ${isSelected ? 'selected' : ''}`}
                    title={isActive ? `${isFiller ? 'Firmware fill | ' : ''}Owner: ${cell?.owner}` : 'Unused'}
                  />
                )
              })}
            </div>
          ))}
        </div>
      )}

      {viewMode === 'treebar' && treebarSupport && treebarData && treebarLayout && (
        <div className="relayGrid relayGridTreebar">
          <div className="relayRow relayHeaderRow">
            <div className="relayHeaderCell relayCorner" />
            {outLabels.map((_, j) => (
              <div
                key={j}
                className={`relayHeaderCell relayHeaderCol ${treebarData.activeCols.has(j) ? 'active' : ''} ${treebarData.selectedCols.has(j) ? 'selected' : ''}`}
              >
                {j + 1}
              </div>
            ))}
          </div>

          {treebarLayout.rowLabels.map((label, rowIdx) => (
            <div key={label} className="relayRow relayDataRow">
              <div
                className={`relayHeaderCell relayRowLabel ${treebarData.activeRows.has(rowIdx) ? 'active' : ''} ${treebarData.selectedRows.has(rowIdx) ? 'selected' : ''}`}
              >
                {label}
              </div>
              {outLabels.map((_, colIdx) => {
                const cell = treebarData.rows[rowIdx]?.[colIdx]
                const stateClass = cell.state === 'hiz' ? 'treebarHiz' : cell.state === 'set' ? 'treebarSet' : 'treebarReset'
                const title = cell.state === 'hiz'
                  ? 'Hi-Z (unchanged)'
                  : `Relay ${label} ${cell.state === 'set' ? 'SET' : 'RESET'} | Owner ${cell.owner}`

                return (
                  <div
                    key={colIdx}
                    className={`relayCell ${stateClass} ${cell.isSelected ? 'treebarSelected' : ''}`}
                    title={title}
                  />
                )
              })}
            </div>
          ))}
        </div>
      )}

      {viewMode === 'treebar' && !treebarSupport && (
        <div className="relayMatrixUnsupported">
          Treebar view requires a square crossbar with N &gt; 1.
        </div>
      )}

      {viewMode === 'xy' && (
        <div className="relayLegend">
          <span className="legendItem"><span className="legendDot unused" /> Unused</span>
          <span className="legendItem"><span className="legendDot active" /> Active</span>
          {hasFiller && <span className="legendItem"><span className="legendDot filler" /> Filled</span>}
          <span className="legendItem"><span className="legendDot selected" /> Selected</span>
        </div>
      )}

      {viewMode === 'treebar' && (
        <div className="relayLegend">
          <span className="legendItem"><span className="legendDot treebarHiz" /> Hi-Z</span>
          <span className="legendItem"><span className="legendDot treebarSet" /> Set</span>
          <span className="legendItem"><span className="legendDot treebarReset" /> Reset</span>
          <span className="legendItem"><span className="legendDot treebarSelected" /> Selected</span>
        </div>
      )}
    </div>
  )
}
