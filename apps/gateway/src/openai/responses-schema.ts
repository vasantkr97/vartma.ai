import { z } from "zod";

const inputTextSchema = z
  .object({
    type: z.enum(["input_text", "output_text", "text"]),
    text: z.string(),
  })
  .passthrough();

const inputImageSchema = z
  .object({
    type: z.literal("input_image"),
    image_url: z.string().min(1),
  })
  .passthrough();

const messageSchema = z
  .object({
    type: z.literal("message").optional(),
    role: z.enum(["system", "developer", "user", "assistant"]),
    content: z.union([z.string(), z.array(z.union([inputTextSchema, inputImageSchema]))]),
  })
  .passthrough();

const functionCallSchema = z
  .object({
    type: z.literal("function_call"),
    call_id: z.string().min(1),
    name: z.string().min(1),
    arguments: z.string(),
  })
  .passthrough()
  .superRefine((value, context) => {
    try {
      JSON.parse(value.arguments);
    } catch {
      context.addIssue({
        code: "custom",
        path: ["arguments"],
        message: "Function-call arguments must be valid JSON.",
      });
    }
  });

const functionCallOutputSchema = z
  .object({
    type: z.literal("function_call_output"),
    call_id: z.string().min(1),
    output: z.union([z.string(), z.record(z.string(), z.unknown())]),
  })
  .passthrough();

const reasoningInputSchema = z
  .object({
    type: z.literal("reasoning"),
  })
  .passthrough();

const inputItemSchema = z.union([
  messageSchema,
  functionCallSchema,
  functionCallOutputSchema,
  reasoningInputSchema,
]);

const functionToolSchema = z
  .object({
    type: z.literal("function"),
    name: z.string().min(1),
    description: z.string().optional(),
    parameters: z.record(z.string(), z.unknown()).default({}),
  })
  .passthrough();

const toolChoiceSchema = z.union([
  z.enum(["auto", "none", "required"]),
  z
    .object({
      type: z.literal("function"),
      name: z.string().min(1),
    })
    .passthrough(),
]);

const textFormatSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("text") }).passthrough(),
  z.object({ type: z.literal("json_object") }).passthrough(),
  z
    .object({
      type: z.literal("json_schema"),
      name: z.string().min(1),
      schema: z.record(z.string(), z.unknown()),
    })
    .passthrough(),
]);

export const openAIResponsesRequestSchema = z
  .object({
    model: z.string().min(1),
    input: z.union([z.string(), z.array(inputItemSchema).min(1)]),
    instructions: z.string().optional(),
    max_output_tokens: z.number().int().positive().default(4096),
    stream: z.boolean().default(false),
    store: z.literal(false).default(false),
    background: z.literal(false).default(false),
    parallel_tool_calls: z.boolean().default(true),
    truncation: z.enum(["auto", "disabled"]).default("disabled"),
    temperature: z.number().min(0).max(2).optional(),
    top_p: z.number().min(0).max(1).optional(),
    tools: z.array(functionToolSchema).optional(),
    tool_choice: toolChoiceSchema.optional(),
    text: z
      .object({
        format: textFormatSchema.optional(),
      })
      .passthrough()
      .optional(),
    reasoning: z
      .object({
        effort: z.string().optional(),
        summary: z.string().optional(),
      })
      .passthrough()
      .optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    previous_response_id: z.string().optional(),
    conversation: z.unknown().optional(),
    include: z.never().optional(),
    max_tool_calls: z.never().optional(),
  })
  .passthrough()
  .superRefine((value, context) => {
    if (value.previous_response_id !== undefined || value.conversation !== undefined) {
      context.addIssue({
        code: "custom",
        path: [value.previous_response_id !== undefined ? "previous_response_id" : "conversation"],
        message:
          "Server-managed conversation references are not portable across routed providers; send explicit input history.",
      });
    }
  });

export type OpenAIResponsesRequest = z.infer<typeof openAIResponsesRequestSchema>;
