import { z } from "zod"

const int = z.number().int()

export const fabricStateSchema = z.object({
  version: z.literal(1),
  N: int,
  TOTAL_BLOCKS: int,
  MAX_PORTS: int,
  s1_to_s2: z.array(z.array(int)),
  s2_to_s3: z.array(z.array(int)),
  s3_port_owner: z.array(int),
  s3_port_spine: z.array(int),
  desired_owner: z.array(int).optional(),
  lock_conflicts: z.array(z.object({
    input: int,
    egress_block: int,
    spine: int,
    reason: z.string()
  })).optional(),
  solve_ms: z.number().optional(),
  solve_total_ms: z.number().optional(),
  repack_count: int.optional(),
  reroutes_demands: int.optional(),
  reroutes_outputs: int.optional(),
  locked_demands: int.optional(),
  locked_outputs: int.optional()
})

export type FabricState = z.infer<typeof fabricStateSchema>

// Solver log entry types
export type LogLevel = 'summary' | 'route' | 'detail'
export type LogType = 'success' | 'error' | 'info' | 'warning'

export type LogEntry = {
  level: LogLevel
  timestamp: string
  message: string
  type: LogType
}

export const solverResponseSchema = fabricStateSchema.extend({
  solverLog: z.array(z.object({
    level: z.enum(['summary', 'route', 'detail']),
    timestamp: z.string(),
    message: z.string(),
    type: z.enum(['success', 'error', 'info', 'warning'])
  })).optional(),
  stability_changes: z.number().optional(),
  strict_stability: z.boolean().optional()
})

export type SolverResponse = z.infer<typeof solverResponseSchema>
