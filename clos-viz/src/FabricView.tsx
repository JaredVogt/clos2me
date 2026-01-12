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
  showFirmwareFills?: boolean
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
  isFiller?: boolean
}

type PortLockState = 'locked' | 'related' | 'none'

type CrossbarPath = {
  inIdx: number
  outIdx: number
  owner: number
  isFiller?: boolean
}

const fillOutToIn = (size: number, outToIn: number[]) => {
  const usedInputs = new Set<number>()
  for (const inIdx of outToIn) {
    if (inIdx >= 0) usedInputs.add(inIdx)
  }

  const unclaimedInputs: number[] = []
  for (let i = 0; i < size; i++) {
    if (!usedInputs.has(i)) unclaimedInputs.push(i)
  }

  const filled = [...outToIn]
  let cursor = 0
  for (let outIdx = 0; outIdx < size; outIdx++) {
    if (filled[outIdx] < 0) {
      if (cursor >= unclaimedInputs.length) break
      filled[outIdx] = unclaimedInputs[cursor++]
    }
  }

  return filled
}

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
  relayMode,
  showFirmwareFills = false
}: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null)

  // Refs for all crossbars
  const ingressRefs = useRef<(CrossbarRef | null)[]>([])
  const spineRefs = useRef<(CrossbarRef | null)[]>([])
  const egressRefs = useRef<(CrossbarRef | null)[]>([])

  // Hover tracking for relay mode
  const [hoveredCrossbar, setHoveredCrossbar] = useState<HoveredCrossbar | null>(null)
  const relayCloseTimerRef = useRef<number | null>(null)

  const cancelRelayClose = useCallback(() => {
    if (relayCloseTimerRef.current !== null) {
      window.clearTimeout(relayCloseTimerRef.current)
      relayCloseTimerRef.current = null
    }
  }, [])

  const scheduleRelayClose = useCallback(() => {
    const RELAY_HOVER_CLOSE_MS = 1200
    cancelRelayClose()
    relayCloseTimerRef.current = window.setTimeout(() => {
      setHoveredCrossbar(null)
      relayCloseTimerRef.current = null
    }, RELAY_HOVER_CLOSE_MS)
  }, [cancelRelayClose])

  // Handle crossbar hover
  const handleCrossbarHover = useCallback((column: 'ingress' | 'spine' | 'egress', row: number, event: React.MouseEvent) => {
    if (!relayMode) return
    cancelRelayClose()
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect()
    setHoveredCrossbar({
      column,
      row,
      position: { x: rect.right, y: rect.top + rect.height / 2 }
    })
  }, [cancelRelayClose, relayMode])

  const handleCrossbarLeave = useCallback((event?: React.MouseEvent) => {
    const relatedTarget = event?.relatedTarget as HTMLElement | null
    if (relatedTarget?.closest?.('.relayMatrix')) {
      return
    }
    scheduleRelayClose()
  }, [scheduleRelayClose])

  const [cablePositions, setCablePositions] = useState<{
    cables: Array<{ x1: number; y1: number; x2: number; y2: number; owner: number; stage: 1 | 2; isFiller?: boolean }>
    width: number
    height: number
  } | null>(null)

  const firmwareState = useMemo(() => {
    if (!showFirmwareFills) return null

    const s1FilledOwners: number[][] = Array.from({ length: state.TOTAL_BLOCKS }, () => Array(state.N).fill(0))
    const s1OutToInIdx: number[][] = Array.from({ length: state.TOTAL_BLOCKS }, () => Array(state.N).fill(-1))
    const s1IsFiller: boolean[][] = Array.from({ length: state.TOTAL_BLOCKS }, () => Array(state.N).fill(false))

    for (let block = 0; block < state.TOTAL_BLOCKS; block++) {
      const basePort = block * state.N + 1
      const outToInIdx: number[] = Array(state.N).fill(-1)

      for (let spine = 0; spine < state.N; spine++) {
        const owner = state.s1_to_s2[block]?.[spine] ?? 0
        if (owner > 0) {
          outToInIdx[spine] = owner - basePort
        } else {
          s1IsFiller[block][spine] = true
        }
      }

      const filled = fillOutToIn(state.N, outToInIdx)
      s1OutToInIdx[block] = filled
      for (let spine = 0; spine < state.N; spine++) {
        const inIdx = filled[spine]
        s1FilledOwners[block][spine] = basePort + inIdx
      }
    }

    const s2FilledOwners: number[][] = Array.from({ length: state.N }, () => Array(state.TOTAL_BLOCKS).fill(0))
    const s2OutToInIdx: number[][] = Array.from({ length: state.N }, () => Array(state.TOTAL_BLOCKS).fill(-1))
    const s2IsFiller: boolean[][] = Array.from({ length: state.N }, () => Array(state.TOTAL_BLOCKS).fill(false))

    for (let spine = 0; spine < state.N; spine++) {
      const outToInIdx: number[] = Array(state.TOTAL_BLOCKS).fill(-1)
      for (let egressBlock = 0; egressBlock < state.TOTAL_BLOCKS; egressBlock++) {
        const owner = state.s2_to_s3[spine]?.[egressBlock] ?? 0
        if (owner > 0) {
          const ingressBlock = Math.floor((owner - 1) / state.N)
          if (ingressBlock >= 0 && ingressBlock < state.TOTAL_BLOCKS) {
            outToInIdx[egressBlock] = ingressBlock
          }
        } else {
          s2IsFiller[spine][egressBlock] = true
        }
      }
      const filled = fillOutToIn(state.TOTAL_BLOCKS, outToInIdx)
      s2OutToInIdx[spine] = filled
      for (let egressBlock = 0; egressBlock < state.TOTAL_BLOCKS; egressBlock++) {
        const ingressBlock = filled[egressBlock]
        s2FilledOwners[spine][egressBlock] = s1FilledOwners[ingressBlock]?.[spine] ?? 0
      }
    }

    const s3FilledOwners: number[][] = Array.from({ length: state.TOTAL_BLOCKS }, () => Array(state.N).fill(0))
    const s3OutToInIdx: number[][] = Array.from({ length: state.TOTAL_BLOCKS }, () => Array(state.N).fill(-1))
    const s3IsFiller: boolean[][] = Array.from({ length: state.TOTAL_BLOCKS }, () => Array(state.N).fill(false))

    for (let block = 0; block < state.TOTAL_BLOCKS; block++) {
      const basePort = block * state.N + 1
      const outToInIdx: number[] = Array(state.N).fill(-1)
      for (let k = 0; k < state.N; k++) {
        const port = basePort + k
        const owner = state.s3_port_owner[port] ?? 0
        const spine = state.s3_port_spine[port] ?? -1
        if (owner > 0 && spine >= 0) {
          outToInIdx[k] = spine
        } else {
          s3IsFiller[block][k] = true
        }
      }
      const filled = fillOutToIn(state.N, outToInIdx)
      s3OutToInIdx[block] = filled
      for (let k = 0; k < state.N; k++) {
        const spine = filled[k]
        s3FilledOwners[block][k] = s2FilledOwners[spine]?.[block] ?? 0
      }
    }

    return {
      s1FilledOwners,
      s1OutToInIdx,
      s1IsFiller,
      s2FilledOwners,
      s2OutToInIdx,
      s2IsFiller,
      s3FilledOwners,
      s3OutToInIdx,
      s3IsFiller
    }
  }, [showFirmwareFills, state])

  // Build crossbar data for all 30 switches
  const crossbars = useMemo(() => {
    const result: {
      ingress: Array<{
        title: string
        inLabels: string[]
        outLabels: string[]
        paths: CrossbarPath[]
        inLockStates: PortLockState[]
        outLockStates: PortLockState[]
      }>
      spine: Array<{
        title: string
        inLabels: string[]
        outLabels: string[]
        paths: CrossbarPath[]
        inLockStates: PortLockState[]
        outLockStates: PortLockState[]
      }>
      egress: Array<{
        title: string
        inLabels: string[]
        outLabels: string[]
        paths: CrossbarPath[]
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

      const paths: CrossbarPath[] = []
      if (firmwareState) {
        for (let spine = 0; spine < state.N; spine++) {
          const inIdx = firmwareState.s1OutToInIdx[block]?.[spine] ?? -1
          const owner = firmwareState.s1FilledOwners[block]?.[spine] ?? 0
          const isFiller = firmwareState.s1IsFiller[block]?.[spine] ?? false
          if (inIdx >= 0) {
            paths.push({ inIdx, outIdx: spine, owner, isFiller })
          }
        }
      } else {
        for (let spine = 0; spine < state.N; spine++) {
          const owner = state.s1_to_s2[block]?.[spine] ?? 0
          if (owner) {
            const inIdx = owner - basePort
            if (inIdx >= 0 && inIdx < state.N) {
              paths.push({ inIdx, outIdx: spine, owner })
            }
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

      const paths: CrossbarPath[] = []
      if (firmwareState) {
        for (let egressBlock = 0; egressBlock < state.TOTAL_BLOCKS; egressBlock++) {
          const inIdx = firmwareState.s2OutToInIdx[spine]?.[egressBlock] ?? -1
          const owner = firmwareState.s2FilledOwners[spine]?.[egressBlock] ?? 0
          const isFiller = firmwareState.s2IsFiller[spine]?.[egressBlock] ?? false
          if (inIdx >= 0) {
            paths.push({ inIdx, outIdx: egressBlock, owner, isFiller })
          }
        }
      } else {
        for (let ingressBlock = 0; ingressBlock < state.TOTAL_BLOCKS; ingressBlock++) {
          const owner = state.s1_to_s2[ingressBlock]?.[spine] ?? 0
          if (!owner) continue

          for (let egressBlock = 0; egressBlock < state.TOTAL_BLOCKS; egressBlock++) {
            if ((state.s2_to_s3[spine]?.[egressBlock] ?? 0) === owner) {
              paths.push({ inIdx: ingressBlock, outIdx: egressBlock, owner })
            }
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

      const paths: CrossbarPath[] = []
      if (firmwareState) {
        for (let k = 0; k < state.N; k++) {
          const inIdx = firmwareState.s3OutToInIdx[block]?.[k] ?? -1
          const owner = firmwareState.s3FilledOwners[block]?.[k] ?? 0
          const isFiller = firmwareState.s3IsFiller[block]?.[k] ?? false
          if (inIdx >= 0) {
            paths.push({ inIdx, outIdx: k, owner, isFiller })
          }
        }
      } else {
        for (let k = 0; k < state.N; k++) {
          const port = basePort + k
          const owner = state.s3_port_owner[port] ?? 0
          const spine = state.s3_port_spine[port] ?? -1

          if (owner && spine >= 0) {
            paths.push({ inIdx: spine, outIdx: k, owner })
          }
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
  }, [state, locksByInput, firmwareState])

  // Build inter-column cables
  const cables = useMemo(() => {
    const list: Cable[] = []

    if (firmwareState) {
      // Stage 1: Ingress OUT → Spine IN
      for (let block = 0; block < state.TOTAL_BLOCKS; block++) {
        for (let spine = 0; spine < state.N; spine++) {
          list.push({
            fromRow: block,
            fromPort: spine,
            toRow: spine,
            toPort: block,
            owner: firmwareState.s1FilledOwners[block]?.[spine] ?? 0,
            stage: 1,
            isFiller: firmwareState.s1IsFiller[block]?.[spine] ?? false
          })
        }
      }

      // Stage 2: Spine OUT → Egress IN
      for (let spine = 0; spine < state.N; spine++) {
        for (let egress = 0; egress < state.TOTAL_BLOCKS; egress++) {
          list.push({
            fromRow: spine,
            fromPort: egress,
            toRow: egress,
            toPort: spine,
            owner: firmwareState.s2FilledOwners[spine]?.[egress] ?? 0,
            stage: 2,
            isFiller: firmwareState.s2IsFiller[spine]?.[egress] ?? false
          })
        }
      }
    } else {
      // Stage 1: Ingress OUT → Spine IN
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
    }

    return list
  }, [state, firmwareState])

  // Compute relay data for hovered crossbar
  const relayData = useMemo(() => {
    if (!hoveredCrossbar) return null

    const { column, row } = hoveredCrossbar

    const buildRelays = (
      rows: number,
      cols: number,
      outToInIdx: number[],
      owners: number[],
      fillers?: boolean[]
    ) => {
      const relays: Array<Array<{ isActive: boolean; owner: number; isFiller?: boolean }>> = Array.from(
        { length: rows },
        () => Array.from({ length: cols }, () => ({ isActive: false, owner: 0 }))
      )

      for (let outIdx = 0; outIdx < cols; outIdx++) {
        const inIdx = outToInIdx[outIdx]
        if (inIdx >= 0 && inIdx < rows) {
          relays[inIdx][outIdx] = {
            isActive: true,
            owner: owners[outIdx] ?? 0,
            isFiller: fillers?.[outIdx] ?? false
          }
        }
      }

      return relays
    }

    if (column === 'ingress') {
      // Ingress block: rows = local input ports, cols = spines
      const block = row
      const basePort = block * state.N + 1
      const inLabels = Array.from({ length: state.N }, (_, k) => portToProPatch(basePort + k))
      const outLabels = Array.from({ length: state.N }, (_, s) => `S${s + 1}`)

      const relays = firmwareState
        ? buildRelays(
            state.N,
            state.N,
            firmwareState.s1OutToInIdx[block] ?? [],
            firmwareState.s1FilledOwners[block] ?? [],
            firmwareState.s1IsFiller[block]
          )
        : (() => {
            const grid: Array<Array<{ isActive: boolean; owner: number; isFiller?: boolean }>> = []
            for (let i = 0; i < state.N; i++) {
              const rowRelays: Array<{ isActive: boolean; owner: number; isFiller?: boolean }> = []
              const portId = basePort + i
              for (let j = 0; j < state.N; j++) {
                const owner = state.s1_to_s2[block]?.[j] ?? 0
                const isActive = owner === portId && owner > 0
                rowRelays.push({ isActive, owner: isActive ? owner : 0 })
              }
              grid.push(rowRelays)
            }
            return grid
          })()

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

      const relays = firmwareState
        ? buildRelays(
            state.TOTAL_BLOCKS,
            state.TOTAL_BLOCKS,
            firmwareState.s2OutToInIdx[spine] ?? [],
            firmwareState.s2FilledOwners[spine] ?? [],
            firmwareState.s2IsFiller[spine]
          )
        : (() => {
            const grid: Array<Array<{ isActive: boolean; owner: number; isFiller?: boolean }>> = []
            for (let ingressBlock = 0; ingressBlock < state.TOTAL_BLOCKS; ingressBlock++) {
              const rowRelays: Array<{ isActive: boolean; owner: number; isFiller?: boolean }> = []
              const ingressOwner = state.s1_to_s2[ingressBlock]?.[spine] ?? 0

              for (let egressBlock = 0; egressBlock < state.TOTAL_BLOCKS; egressBlock++) {
                const egressOwner = state.s2_to_s3[spine]?.[egressBlock] ?? 0
                // Relay is active if ingress trunk is active AND egress trunk has same owner
                const isActive = ingressOwner > 0 && egressOwner === ingressOwner
                rowRelays.push({ isActive, owner: isActive ? ingressOwner : 0 })
              }
              grid.push(rowRelays)
            }
            return grid
          })()

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

      const relays = firmwareState
        ? buildRelays(
            state.N,
            state.N,
            firmwareState.s3OutToInIdx[block] ?? [],
            firmwareState.s3FilledOwners[block] ?? [],
            firmwareState.s3IsFiller[block]
          )
        : (() => {
            const grid: Array<Array<{ isActive: boolean; owner: number; isFiller?: boolean }>> = []
            for (let spine = 0; spine < state.N; spine++) {
              const rowRelays: Array<{ isActive: boolean; owner: number; isFiller?: boolean }> = []
              for (let k = 0; k < state.N; k++) {
                const port = basePort + k
                const owner = state.s3_port_owner[port] ?? 0
                const portSpine = state.s3_port_spine[port] ?? -1
                // Relay is active if this port uses this spine
                const isActive = owner > 0 && portSpine === spine
                rowRelays.push({ isActive, owner: isActive ? owner : 0 })
              }
              grid.push(rowRelays)
            }
            return grid
          })()

      return {
        title: `Egr ${String(block + 1).padStart(2, '0')} Relays`,
        inLabels,
        outLabels,
        relays
      }
    }

    return null
  }, [hoveredCrossbar, state, firmwareState])

  // Measure cable positions
  function measureCables() {
    const container = containerRef.current
    if (!container) return

    const rect = container.getBoundingClientRect()
    const measured: Array<{ x1: number; y1: number; x2: number; y2: number; owner: number; stage: 1 | 2; isFiller?: boolean }> = []

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
          stage: cable.stage,
          isFiller: cable.isFiller
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
                className={`interCable ${c.isFiller ? "filler" : ""} ${isActive ? "active" : ""} ${isLockedActive ? "locked" : ""}`}
                onClick={() => {
                  if (c.owner > 0) onSelectInput(c.owner)
                }}
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
          onHover={cancelRelayClose}
          onClose={handleCrossbarLeave}
        />
      )}
    </div>
  )
}
