import { z } from "zod";

const textPartSchema = z
  .object({
    type: z.literal("text"),
    text: z.string(),
  })
  .passthrough();

const imagePartSchema = z
  .object({
    type: z.literal("image_url"),
    image_url: z.object({ url: z.string().min(1) }).passthrough(),
  })
  .passthrough();

const functionCallSchema = z
  .object({
    id: z.string().min(1),
    type: z.literal("function"),
    function: z.object({
      name: z.string().min(1),
      arguments: z.string(),
    }),
  })
  .passthrough()
  .superRefine((value, context) => {
    try {
      JSON.parse(value.function.arguments);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["function", "arguments"],
        message: "Tool-call arguments must be valid JSON.",
      });
    }
  });

const standardMessageSchema = z
  .object({
    role: z.enum(["system", "developer", "user"]),
    content: z.union([z.string(), z.array(z.union([textPartSchema, imagePartSchema]))]),
  })
  .passthrough();

const assistantMessageSchema = z
  .object({
    role: z.literal("assistant"),
    content: z
      .union([z.string(), z.array(z.union([textPartSchema, imagePartSchema])), z.null()])
      .optional(),
    tool_calls: z.array(functionCallSchema).optional(),
  })
  .passthrough()
  .refine((value) => value.content != null || Boolean(value.tool_calls?.length), {
    message: "An assistant message needs content or tool_calls.",
  });

const toolMessageSchema = z
  .object({
    role: z.literal("tool"),
    tool_call_id: z.string().min(1),
    content: z.string(),
  })
  .passthrough();

const functionToolSchema = z
  .object({
    type: z.literal("function"),
    function: z.object({
      name: z.string().min(1),
      description: z.string().optional(),
      parameters: z.record(z.string(), z.unknown()).default({}),
    }),
  })
  .passthrough();

const toolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z
    .object({
      type: z.literal("function"),
      function: z.object({ name: z.string().min(1) }),
    })
    .passthrough(),
]);

const responseFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).passthrough(),
  z.object({ type: z.literal("json_object") }).passthrough(),
  z
    .object({
      type: z.literal("json_schema"),
      json_schema: z.object({
        name: z.string().min(1),
        schema: z.record(z.string(), z.unknown()),
      }),
    })
    .passthrough(),
]);

export const openAIChatRequestSchema = z
  .object({
    model: z.string().min(1),
    messages: z
      .array(z.union([standardMessageSchema, assistantMessageSchema, toolMessageSchema]))
      .min(1),
    max_completion_tokens: z.number().int().positive().optional(),
    max_tokens: z.number().int().positive().optional(),
    stream: z.boolean().default(false),
    stream_options: z
      .object({
        include_usage: z.boolean().optional(),
      })
      .passthrough()
      .optional(),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    stop: z.union([z.string().min(1), z.array(z.string().min(1)).min(1).max(4)]).optional(),
    n: z.literal(1).default(1),
    tools: z.array(functionToolSchema).optional(),
    tool_choice: toolChoiceSchema.optional(),
    response_format: responseFormatSchema.optional(),
    reasoning_effort: z.string().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    functions: z.never().optional(),
    function_call: z.never().optional(),
    audio: z.never().optional(),
    modalities: z.never().optional(),
    logprobs: z.never().optional(),
  })
  .passthrough();

export type OpenAIChatRequest = z.infer<typeof openAIChatRequestSchema>;
