import type { FabricState } from "./schema"

export type InputSummary = {
  inputId: number
  ingressBlock: number
  spinesUsed: number[]
  egressBlocksUsed: number[]
  outputs: number[]
}

export function deriveInputs(state: FabricState) {
  const outputsByInput = new Map<number, number[]>()

  for (let p = 1; p <= state.MAX_PORTS; p++) {
    const owner = state.s3_port_owner[p] ?? 0
    if (!owner) continue
    const list = outputsByInput.get(owner) ?? []
    list.push(p)
    outputsByInput.set(owner, list)
  }

  const summaries: InputSummary[] = []

  for (const [inputId, outputs] of outputsByInput.entries()) {
    const ingressBlock = Math.floor((inputId - 1) / state.N)
    const spineSet = new Set<number>()
    const egressSet = new Set<number>()

    for (let s = 0; s < state.N; s++) {
      if ((state.s1_to_s2[ingressBlock]?.[s] ?? 0) === inputId) spineSet.add(s)
      for (let e = 0; e < state.TOTAL_BLOCKS; e++) {
        if ((state.s2_to_s3[s]?.[e] ?? 0) === inputId) {
          spineSet.add(s)
          egressSet.add(e)
        }
      }
    }

    summaries.push({
      inputId,
      ingressBlock,
      spinesUsed: [...spineSet].sort((a, b) => a - b),
      egressBlocksUsed: [...egressSet].sort((a, b) => a - b),
      outputs: outputs.slice().sort((a, b) => a - b)
    })
  }

  summaries.sort((a, b) => a.inputId - b.inputId)
  return summaries
}

export function getBlock(port: number, N: number) {
  return Math.floor((port - 1) / N)
}
