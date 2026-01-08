import { useMemo, useRef, useEffect, useState } from "react"
import type { LogEntry, LogLevel } from "./schema"

type Props = {
  entries: LogEntry[]
  fabricSummary: string | null
  runSummary: string | null
  level: LogLevel
  onLevelChange: (level: LogLevel) => void
  persistHistory: boolean
  onPersistChange: (persist: boolean) => void
  onClear: () => void
}

const levelOrder: LogLevel[] = ['summary', 'route', 'detail']

export function LogPanel({
  entries,
  fabricSummary,
  runSummary,
  level,
  onLevelChange,
  persistHistory,
  onPersistChange,
  onClear
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)
  const panelRef = useRef<HTMLElement>(null)
  const [summaryHeight, setSummaryHeight] = useState(150)
  const [hasUserResized, setHasUserResized] = useState(false)
  const [isResizingSummary, setIsResizingSummary] = useState(false)
  const lastPanelHeightRef = useRef<number | null>(null)

  const MIN_SUMMARY_HEIGHT = 50
  const MIN_LOG_HEIGHT = 120
  const SUMMARY_HANDLE_HEIGHT = 6

  // Filter entries based on selected level
  // 'summary' shows only summary, 'route' shows summary+route, 'detail' shows all
  const filteredEntries = useMemo(() => {
    const levelIdx = levelOrder.indexOf(level)
    return entries.filter(e => levelOrder.indexOf(e.level) <= levelIdx)
  }, [entries, level])

  // Auto-scroll to bottom when new entries arrive
  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight
    }
  }, [filteredEntries.length])

  // Handle summary resize drag
  useEffect(() => {
    if (!isResizingSummary) return

    const handleMouseMove = (e: MouseEvent) => {
      if (!panelRef.current) return
      const panelRect = panelRef.current.getBoundingClientRect()
      const newHeight = panelRect.bottom - e.clientY
      const headerEl = panelRef.current.querySelector('.logHeader') as HTMLElement | null
      const headerHeight = headerEl ? headerEl.getBoundingClientRect().height : 0
      const maxHeight = Math.max(
        MIN_SUMMARY_HEIGHT,
        panelRect.height - headerHeight - SUMMARY_HANDLE_HEIGHT - MIN_LOG_HEIGHT
      )
      setSummaryHeight(Math.max(MIN_SUMMARY_HEIGHT, Math.min(maxHeight, newHeight)))
      setHasUserResized(true)
    }

    const handleMouseUp = () => {
      setIsResizingSummary(false)
    }

    document.addEventListener('mousemove', handleMouseMove)
    document.addEventListener('mouseup', handleMouseUp)
    document.body.style.cursor = 'row-resize'
    document.body.style.userSelect = 'none'

    return () => {
      document.removeEventListener('mousemove', handleMouseMove)
      document.removeEventListener('mouseup', handleMouseUp)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
  }, [isResizingSummary])

  // Default summary height to 1/3 of available space (2/3 reserved for log)
  useEffect(() => {
    if (!panelRef.current) return

    const computeDefault = () => {
      if (!panelRef.current) return
      const panelHeight = panelRef.current.clientHeight
      const headerEl = panelRef.current.querySelector('.logHeader') as HTMLElement | null
      const headerHeight = headerEl ? headerEl.getBoundingClientRect().height : 0
      const available = Math.max(0, panelHeight - headerHeight - SUMMARY_HANDLE_HEIGHT)
      const maxSummary = Math.max(
        MIN_SUMMARY_HEIGHT,
        available - MIN_LOG_HEIGHT
      )
      const target = Math.max(MIN_SUMMARY_HEIGHT, Math.min(maxSummary, Math.floor(available / 3)))
      setSummaryHeight(target)
      lastPanelHeightRef.current = panelHeight
    }

    if (!hasUserResized) {
      computeDefault()
    }

    const ro = new ResizeObserver(() => {
      if (hasUserResized) return
      computeDefault()
    })
    ro.observe(panelRef.current)

    return () => {
      ro.disconnect()
    }
  }, [hasUserResized])

  // Group entries by run (using timestamp proximity)
  const groupedEntries = useMemo(() => {
    const groups: { timestamp: string; entries: LogEntry[] }[] = []
    let currentGroup: LogEntry[] = []
    let lastTimestamp = ''

    for (const entry of filteredEntries) {
      // New group if timestamp differs by more than 1 second
      const entryTime = new Date(entry.timestamp).getTime()
      const lastTime = lastTimestamp ? new Date(lastTimestamp).getTime() : 0

      if (!lastTimestamp || Math.abs(entryTime - lastTime) < 1000) {
        currentGroup.push(entry)
      } else {
        if (currentGroup.length > 0) {
          groups.push({ timestamp: lastTimestamp, entries: currentGroup })
        }
        currentGroup = [entry]
      }
      lastTimestamp = entry.timestamp
    }

    if (currentGroup.length > 0) {
      groups.push({ timestamp: lastTimestamp, entries: currentGroup })
    }

    return groups
  }, [filteredEntries])

  const formatTime = (iso: string) => {
    const d = new Date(iso)
    return d.toLocaleTimeString()
  }

  return (
    <aside className="logPanel" ref={panelRef}>
      <div className="logHeader">
        <div className="logTitle">Solver Log</div>
        <div className="logControls">
          <select
            value={level}
            onChange={e => onLevelChange(e.target.value as LogLevel)}
            className="logLevelSelect"
          >
            <option value="summary">Summary</option>
            <option value="route">Per-route</option>
            <option value="detail">Full Detail</option>
          </select>
          <label className="logPersist">
            <input
              type="checkbox"
              checked={persistHistory}
              onChange={e => onPersistChange(e.target.checked)}
            />
            Keep History
          </label>
          <button className="logClearBtn" onClick={onClear}>Clear</button>
        </div>
      </div>

      <div className="logEntries" ref={scrollRef}>
        {groupedEntries.length === 0 ? (
          <div className="logEmpty">No solver runs yet</div>
        ) : (
          groupedEntries.map((group, groupIdx) => (
            <div key={groupIdx} className="logGroup">
              <div className="logGroupHeader">{formatTime(group.timestamp)}</div>
              {group.entries.map((entry, idx) => (
                <div
                  key={idx}
                  className={`logEntry logEntry--${entry.type} logEntry--${entry.level}`}
                >
                  <span className="logEntryLevel">[{entry.level[0].toUpperCase()}]</span>
                  <span className="logEntryMessage">{entry.message}</span>
                </div>
              ))}
            </div>
          ))
        )}
      </div>

      {(runSummary || fabricSummary) && (
        <>
          <div
            className="summaryResizeHandle"
            onMouseDown={() => setIsResizingSummary(true)}
          />
          <div className="fabricSummary" style={{ height: summaryHeight }}>
            {runSummary && <div className="runSummary">Run Summary: {runSummary}</div>}
            {fabricSummary && <pre>{fabricSummary}</pre>}
          </div>
        </>
      )}
    </aside>
  )
}
