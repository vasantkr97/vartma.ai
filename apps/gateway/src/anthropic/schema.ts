import { z } from "zod";

const textBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

const imageBlockSchema = z
  .object({
    type: z.literal("image"),
    source: z.discriminatedUnion("type", [
      z.object({
        type: z.literal("base64"),
        media_type: z.string().min(1),
        data: z.string().min(1),
      }),
      z.object({
        type: z.literal("url"),
        url: z.url(),
      }),
    ]),
  })
  .passthrough();

const toolUseBlockSchema = z
  .object({
    type: z.literal("tool_use"),
    id: z.string().min(1),
    name: z.string().min(1),
    input: z.unknown(),
  })
  .passthrough();

const thinkingBlockSchema = z
  .object({
    type: z.literal("thinking"),
    thinking: z.string(),
    signature: z.string(),
  })
  .passthrough();

const redactedThinkingBlockSchema = z
  .object({
    type: z.literal("redacted_thinking"),
    data: z.string(),
  })
  .passthrough();

const toolResultBlockSchema = z
  .object({
    type: z.literal("tool_result"),
    tool_use_id: z.string().min(1),
    content: z.union([z.string(), z.array(z.union([textBlockSchema, imageBlockSchema]))]),
    is_error: z.boolean().optional(),
  })
  .passthrough();

export const anthropicContentBlockSchema = z.discriminatedUnion("type", [
  textBlockSchema,
  imageBlockSchema,
  thinkingBlockSchema,
  redactedThinkingBlockSchema,
  toolUseBlockSchema,
  toolResultBlockSchema,
]);

export type AnthropicContentBlock = z.infer<typeof anthropicContentBlockSchema>;

export const anthropicMessageSchema = z
  .object({
    role: z.enum(["user", "assistant"]),
    content: z.union([z.string(), z.array(anthropicContentBlockSchema)]),
  })
  .passthrough();

const systemBlockSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

const toolSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    input_schema: z.record(z.string(), z.unknown()),
  })
  .passthrough();

const toolChoiceSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("auto") }).passthrough(),
  z.object({ type: z.literal("any") }).passthrough(),
  z.object({ type: z.literal("none") }).passthrough(),
  z.object({ type: z.literal("tool"), name: z.string().min(1) }).passthrough(),
]);

const thinkingSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("adaptive") }).passthrough(),
  z
    .object({
      type: z.literal("enabled"),
      budget_tokens: z.number().int().positive(),
    })
    .passthrough(),
  z.object({ type: z.literal("disabled") }).passthrough(),
]);

export const anthropicMessagesRequestSchema = z
  .object({
    model: z.string().min(1),
    max_tokens: z.number().int().positive(),
    messages: z.array(anthropicMessageSchema).min(1),
    system: z.union([z.string(), z.array(systemBlockSchema)]).optional(),
    stream: z.boolean().default(false),
    tools: z.array(toolSchema).optional(),
    tool_choice: toolChoiceSchema.optional(),
    temperature: z.number().min(0).max(1).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop_sequences: z.array(z.string().min(1)).max(4).optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    thinking: thinkingSchema.optional(),
  })
  .passthrough();

export type AnthropicMessagesRequest = z.infer<typeof anthropicMessagesRequestSchema>;
