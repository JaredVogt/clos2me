import { useMemo, useRef, useEffect } from "react"
import type { LogEntry, LogLevel } from "./schema"

type Props = {
  entries: LogEntry[]
  level: LogLevel
  onLevelChange: (level: LogLevel) => void
  persistHistory: boolean
  onPersistChange: (persist: boolean) => void
  onClear: () => void
}

const levelOrder: LogLevel[] = ['summary', 'route', 'detail']

export function LogPanel({
  entries,
  level,
  onLevelChange,
  persistHistory,
  onPersistChange,
  onClear
}: Props) {
  const scrollRef = useRef<HTMLDivElement>(null)

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
    <aside className="logPanel">
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
    </aside>
  )
}
