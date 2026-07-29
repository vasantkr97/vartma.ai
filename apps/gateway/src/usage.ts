import { USAGE_GROUPINGS, type UsageAnalyticsQuery } from "@vartma/database";
import { z } from "zod";

const usageQuerySchema = z
  .object({
    from: z.string().min(1).optional(),
    to: z.string().min(1).optional(),
    provider: z.string().trim().min(1).max(200).optional(),
    model: z.string().trim().min(1).max(300).optional(),
    routing_mode: z.enum(["quality", "balanced", "eco", "fixed"]).optional(),
    session_id: z.string().trim().min(1).max(200).optional(),
    group_by: z.enum(USAGE_GROUPINGS).default("model"),
  })
  .strict();

const MAX_RANGE_MS = 366 * 24 * 60 * 60 * 1_000;
const DEFAULT_RANGE_MS = 30 * 24 * 60 * 60 * 1_000;

export function parseUsageAnalyticsQuery(
  query: unknown,
  now: Date = new Date(),
): UsageAnalyticsQuery {
  const parsed = usageQuerySchema.parse(query);
  const to = parsed.to ? parseTimestamp(parsed.to, "to") : now;
  const from = parsed.from
    ? parseTimestamp(parsed.from, "from")
    : new Date(to.getTime() - DEFAULT_RANGE_MS);
  if (from.getTime() >= to.getTime()) {
    throw new Error('"from" must be earlier than the exclusive "to" timestamp.');
  }
  if (to.getTime() - from.getTime() > MAX_RANGE_MS) {
    throw new Error("Usage analytics ranges cannot exceed 366 days.");
  }
  return {
    from,
    to,
    groupBy: parsed.group_by,
    ...(parsed.provider ? { provider: parsed.provider } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.routing_mode ? { routingMode: parsed.routing_mode } : {}),
    ...(parsed.session_id ? { sessionId: parsed.session_id } : {}),
  };
}

function parseTimestamp(value: string, field: string): Date {
  const timestamp = new Date(value);
  if (Number.isNaN(timestamp.getTime())) {
    throw new Error(`"${field}" must be an ISO-8601 timestamp or date.`);
  }
  return timestamp;
}
