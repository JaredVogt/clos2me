type RelayCell = {
  isActive: boolean
  owner: number
}

type Props = {
  title: string
  inLabels: string[]
  outLabels: string[]
  // 2D array: relays[inIdx][outIdx] = { isActive, owner }
  relays: RelayCell[][]
  selectedInput: number | null
  position: { x: number; y: number }
  onClose: () => void
}

export function RelayMatrix({ title, inLabels, outLabels, relays, selectedInput, position, onClose }: Props) {
  // Calculate which rows and columns have any active relays
  const activeRows = new Set<number>()
  const activeCols = new Set<number>()
  const selectedRows = new Set<number>()
  const selectedCols = new Set<number>()

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
    }
  }

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
      className="relayMatrix"
      style={{ left: x, top: y }}
      onMouseLeave={onClose}
    >
      <div className="relayMatrixTitle">{title}</div>
      <div className="relayGrid">
        {/* Header row with output labels (1-10) */}
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

        {/* Data rows (1-10) */}
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
              const isSelected = isActive && cell?.owner === selectedInput

              return (
                <div
                  key={j}
                  className={`relayCell ${isActive ? 'active' : 'unused'} ${isSelected ? 'selected' : ''}`}
                  title={isActive ? `Owner: ${cell?.owner}` : 'Unused'}
                />
              )
            })}
          </div>
        ))}
      </div>
      <div className="relayLegend">
        <span className="legendItem"><span className="legendDot unused" /> Unused</span>
        <span className="legendItem"><span className="legendDot active" /> Active</span>
        <span className="legendItem"><span className="legendDot selected" /> Selected</span>
      </div>
    </div>
  )
}
