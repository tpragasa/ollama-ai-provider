/* eslint-disable camelcase */
import {
  LanguageModelV1,
  LanguageModelV1CallWarning,
  LanguageModelV1FinishReason,
  LanguageModelV1FunctionToolCall,
  LanguageModelV1StreamPart,
} from '@ai-sdk/provider'
import {
  combineHeaders,
  createJsonResponseHandler,
  generateId,
  ParseResult,
  postJsonToApi,
} from '@ai-sdk/provider-utils'
import { z } from 'zod'

import { convertToOllamaChatMessages } from '@/convert-to-ollama-chat-messages'
import { InferToolCallsFromStream } from '@/generate-tool/infer-tool-calls-from-stream'
import { mapOllamaFinishReason } from '@/map-ollama-finish-reason'
import { OllamaChatModelId, OllamaChatSettings } from '@/ollama-chat-settings'
import { ollamaFailedResponseHandler } from '@/ollama-error'
import { prepareTools } from '@/prepare-tools'
import { createJsonStreamResponseHandler, removeUndefined } from '@/utils'

interface OllamaChatConfig {
  baseURL: string
  fetch?: typeof fetch
  headers: () => Record<string, string | undefined>
  provider: string
}

export class OllamaChatLanguageModel implements LanguageModelV1 {
  readonly specificationVersion = 'v1'
  readonly defaultObjectGenerationMode = 'json'
  readonly supportsImageUrls = false

  constructor(
    public readonly modelId: OllamaChatModelId,
    public readonly settings: OllamaChatSettings,
    public readonly config: OllamaChatConfig,
  ) {}

  get supportsStructuredOutputs(): boolean {
    return this.settings.structuredOutputs ?? false
  }

  get provider(): string {
    return this.config.provider
  }

  private getArguments({
    frequencyPenalty,
    maxTokens,
    mode,
    presencePenalty,
    prompt,
    responseFormat,
    seed,
    stopSequences,
    temperature,
    topK,
    topP,
  }: Parameters<LanguageModelV1['doGenerate']>[0]) {
    const type = mode.type

    const warnings: LanguageModelV1CallWarning[] = []

    if (
      responseFormat !== undefined &&
      responseFormat.type === 'json' &&
      responseFormat.schema !== undefined &&
      !this.supportsStructuredOutputs
    ) {
      warnings.push({
        details:
          'JSON response format schema is only supported with structuredOutputs',
        setting: 'responseFormat',
        type: 'unsupported-setting',
      })
    }

    const baseArguments = {
      format: responseFormat?.type,
      model: this.modelId,
      options: removeUndefined({
        f16_kv: this.settings.f16Kv,
        frequency_penalty: frequencyPenalty,
        low_vram: this.settings.lowVram,
        main_gpu: this.settings.mainGpu,
        min_p: this.settings.minP,
        mirostat: this.settings.mirostat,
        mirostat_eta: this.settings.mirostatEta,
        mirostat_tau: this.settings.mirostatTau,
        num_batch: this.settings.numBatch,
        num_ctx: this.settings.numCtx,
        num_gpu: this.settings.numGpu,
        num_keep: this.settings.numKeep,
        num_predict: maxTokens,
        num_thread: this.settings.numThread,
        numa: this.settings.numa,
        penalize_newline: this.settings.penalizeNewline,
        presence_penalty: presencePenalty,
        repeat_last_n: this.settings.repeatLastN,
        repeat_penalty: this.settings.repeatPenalty,
        seed,
        stop: stopSequences,
        temperature,
        tfs_z: this.settings.tfsZ,
        top_k: topK,
        top_p: topP,
        typical_p: this.settings.typicalP,
        use_mlock: this.settings.useMlock,
        use_mmap: this.settings.useMmap,
        vocab_only: this.settings.vocabOnly,
      }),
    }

    switch (type) {
      case 'regular': {
        const { tools, toolWarnings } = prepareTools({
          mode,
        })

        return {
          args: {
            ...baseArguments,
            messages: convertToOllamaChatMessages(prompt),
            tools,
          },
          type,
          warnings: [...warnings, ...toolWarnings],
        }
      }

      case 'object-json': {
        return {
          args: {
            ...baseArguments,
            format:
              this.supportsStructuredOutputs && mode.schema !== undefined
                ? mode.schema
                : 'json',
            messages: convertToOllamaChatMessages(prompt),
          },
          type,
          warnings,
        }
      }

      case 'object-tool': {
        return {
          args: {
            ...baseArguments,
            messages: convertToOllamaChatMessages(prompt),
            tool_choice: {
              function: { name: mode.tool.name },
              type: 'function',
            },
            tools: [
              {
                function: {
                  description: mode.tool.description,
                  name: mode.tool.name,
                  parameters: mode.tool.parameters,
                },
                type: 'function',
              },
            ],
          },
          type,
          warnings,
        }
      }

      default: {
        const _exhaustiveCheck: string = type
        throw new Error(`Unsupported type: ${_exhaustiveCheck}`)
      }
    }
  }

  async doGenerate(
    options: Parameters<LanguageModelV1['doGenerate']>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV1['doGenerate']>>> {
    const { args, warnings } = this.getArguments(options)
    const body = {
      ...args,
      stream: false,
    }

    const { responseHeaders, value: response } = await postJsonToApi({
      abortSignal: options.abortSignal,
      body,
      failedResponseHandler: ollamaFailedResponseHandler,
      fetch: this.config.fetch,
      headers: combineHeaders(this.config.headers(), options.headers),
      successfulResponseHandler: createJsonResponseHandler(
        ollamaChatResponseSchema,
      ),
      url: `${this.config.baseURL}/chat`,
    })

    const { messages: rawPrompt, ...rawSettings } = body

    const toolCalls: LanguageModelV1FunctionToolCall[] | undefined =
      response.message.tool_calls?.map((toolCall) => ({
        args: JSON.stringify(toolCall.function.arguments),
        toolCallId: toolCall.id ?? generateId(),
        toolCallType: 'function',
        toolName: toolCall.function.name,
      }))

    return {
      finishReason: mapOllamaFinishReason({
        finishReason: response.done_reason,
        hasToolCalls: toolCalls !== undefined && toolCalls.length > 0,
      }),
      rawCall: { rawPrompt, rawSettings },
      rawResponse: { headers: responseHeaders },
      request: { body: JSON.stringify(body) },
      text: response.message.content ?? undefined,
      toolCalls,
      usage: {
        completionTokens: response.eval_count || 0,
        promptTokens: response.prompt_eval_count || 0,
        promptDuration: response.prompt_duration || 0,
        evalDuration: response.eval_duration || 0,
      },
      warnings,
    }
  }

  async doStream(
    options: Parameters<LanguageModelV1['doStream']>[0],
  ): Promise<Awaited<ReturnType<LanguageModelV1['doStream']>>> {
    if (this.settings.simulateStreaming) {
      const result = await this.doGenerate(options)

      const simulatedStream = new ReadableStream<LanguageModelV1StreamPart>({
        start(controller) {
          controller.enqueue({ type: 'response-metadata', ...result.response })
          if (result.text) {
            controller.enqueue({
              textDelta: result.text,
              type: 'text-delta',
            })
          }
          if (result.toolCalls) {
            for (const toolCall of result.toolCalls) {
              controller.enqueue({
                argsTextDelta: toolCall.args,
                toolCallId: toolCall.toolCallId,
                toolCallType: 'function',
                toolName: toolCall.toolName,
                type: 'tool-call-delta',
              })

              controller.enqueue({
                type: 'tool-call',
                ...toolCall,
              })
            }
          }
          controller.enqueue({
            finishReason: result.finishReason,
            logprobs: result.logprobs,
            providerMetadata: result.providerMetadata,
            type: 'finish',
            usage: result.usage,
          })
          controller.close()
        },
      })
      return {
        rawCall: result.rawCall,
        rawResponse: result.rawResponse,
        stream: simulatedStream,
        warnings: result.warnings,
      }
    }

    const { args: body, type, warnings } = this.getArguments(options)

    const { responseHeaders, value: response } = await postJsonToApi({
      abortSignal: options.abortSignal,
      body,
      failedResponseHandler: ollamaFailedResponseHandler,
      fetch: this.config.fetch,
      headers: combineHeaders(this.config.headers(), options.headers),
      successfulResponseHandler: createJsonStreamResponseHandler(
        ollamaChatStreamChunkSchema,
      ),
      url: `${this.config.baseURL}/chat`,
    })

    const { messages: rawPrompt, ...rawSettings } = body

    const tools =
      options.mode.type === 'regular'
        ? options.mode.tools
        : options.mode.type === 'object-tool'
          ? [options.mode.tool]
          : undefined

    const inferToolCallsFromStream = new InferToolCallsFromStream({
      tools,
      type,
    })

    let finishReason: LanguageModelV1FinishReason = 'other'
    let usage: { completionTokens: number; promptTokens: number; promptDuration?: number; evalDuration?: number } = {
      completionTokens: Number.NaN,
      promptTokens: Number.NaN,
      promptDuration: Number.NaN,
      evalDuration: Number.NaN,
    }

    const { experimentalStreamTools = true } = this.settings

    return {
      rawCall: { rawPrompt, rawSettings },
      rawResponse: { headers: responseHeaders },
      request: { body: JSON.stringify(body) },
      stream: response.pipeThrough(
        new TransformStream<
          ParseResult<z.infer<typeof ollamaChatStreamChunkSchema>>,
          LanguageModelV1StreamPart
        >({
          async flush(controller) {
            controller.enqueue({
              finishReason,
              type: 'finish',
              usage,
            })
          },
          async transform(chunk, controller) {
            if (!chunk.success) {
              controller.enqueue({ error: chunk.error, type: 'error' })
              return
            }

            const value = chunk.value

            if (value.done) {
              finishReason = inferToolCallsFromStream.finish({ controller })
              usage = {
                completionTokens: value.eval_count,
                promptTokens: value.prompt_eval_count || 0,
                promptDuration: value.prompt_duration || 0,
                evalDuration: value.eval_duration || 0,
              }

              return
            }

            if (experimentalStreamTools) {
              const isToolCallStream = inferToolCallsFromStream.parse({
                controller,
                delta: value.message.content,
              })

              if (isToolCallStream) {
                return
              }
            }

            if (value.message.content !== null) {
              controller.enqueue({
                textDelta: value.message.content,
                type: 'text-delta',
              })
            }
          },
        }),
      ),
      warnings,
    }
  }
}

const ollamaChatResponseSchema = z.object({
  created_at: z.string(),
  done: z.literal(true),
  done_reason: z.string().optional().nullable(),
  eval_count: z.number(),
  eval_duration: z.number(),
  load_duration: z.number().optional(),
  message: z.object({
    content: z.string(),
    role: z.string(),
    tool_calls: z
      .array(
        z.object({
          function: z.object({
            arguments: z.record(z.any()),
            name: z.string(),
          }),
          id: z.string().optional(),
        }),
      )
      .optional()
      .nullable(),
  }),
  model: z.string(),
  prompt_eval_count: z.number().optional(),
  prompt_eval_duration: z.number().optional(),
  total_duration: z.number(),
})

export type OllamaChatResponseSchema = z.infer<typeof ollamaChatResponseSchema>

const ollamaChatStreamChunkSchema = z.discriminatedUnion('done', [
  z.object({
    created_at: z.string(),
    done: z.literal(false),
    message: z.object({
      content: z.string(),
      role: z.string(),
    }),
    model: z.string(),
  }),
  z.object({
    created_at: z.string(),
    done: z.literal(true),
    eval_count: z.number(),
    eval_duration: z.number(),
    load_duration: z.number().optional(),
    model: z.string(),
    prompt_eval_count: z.number().optional(),
    prompt_eval_duration: z.number().optional(),
    total_duration: z.number(),
  }),
])
