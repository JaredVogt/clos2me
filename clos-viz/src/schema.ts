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
  desired_owner: z.array(int).optional()
})

export type FabricState = z.infer<typeof fabricStateSchema>
