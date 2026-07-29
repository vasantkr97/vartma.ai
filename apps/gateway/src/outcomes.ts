import { SESSION_OUTCOME_KINDS } from "@vartma/routing";
import { z } from "zod";

export const sessionOutcomeSchema = z
  .object({
    kind: z.enum(SESSION_OUTCOME_KINDS),
    request_id: z.string().min(1).optional(),
    source: z.string().min(1).max(100).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
  })
  .strict();
