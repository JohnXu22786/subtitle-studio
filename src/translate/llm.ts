/**
 * LLM backends with a common client interface.
 *
 * Two backends are provided:
 *
 * 1. `openai` — direct HTTP calls to any OpenAI-compatible chat-completions
 *    endpoint (works out of the box with DeepSeek's public API, Ollama,
 *    vLLM, etc.). Supports timeout, bounded retries with exponential backoff,
 *    and graceful fallback from JSON-mode requests.
 * 2. `dsh` — delegates to the host harness's `ctx.llm` seam (the `LlmRuntime`
 *    service in DeepSeek Harness). Used when the plugin runs inside dsh and
 *    `config.llm.provider` is set to `dsh`.
 *
 * Both backends return plain completion text plus (when the endpoint reports
 * it) token usage.
 */

export type LlmProvider = 'openai' | 'dsh'

export interface LlmSettings {
  provider?: LlmProvider
  /** OpenAI-compatible base URL, e.g. `https://api.deepseek.com/v1`. */
  baseUrl?: string
  apiKey?: string
  model?: string
  timeoutMs?: number
  maxRetries?: number
  /** Ask for a JSON object response (DeepSeek supports this). */
  jsonMode?: boolean
  temperature?: number
  /** Source-text character budget per translation request. */
  chunkChars?: number
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionUsage {
  inputTokens?: number
  outputTokens?: number
}

export interface CompletionResult {
  text: string
  usage?: CompletionUsage
}

/** Stable error taxonomy for translation orchestration. */
export type LlmErrorCode =
  | 'timeout'
  | 'aborted'
  | 'network'
  | 'auth'
  | 'rate_limit'
  | 'server_error'
  | 'invalid_request'
  | 'empty_response'
  | 'unsupported'

export class LlmError extends Error {
  override name = 'LlmError'
  readonly code: LlmErrorCode
  readonly retryable: boolean
  readonly httpStatus?: number

  constructor(code: LlmErrorCode, message: string, options: { httpStatus?: number; cause?: unknown } = {}) {
    super(message, { cause: options.cause })
    this.code = code
    this.httpStatus = options.httpStatus
    // A caller-initiated abort is never retried.
    this.retryable =
      (code === 'timeout' || code === 'network' || code === 'rate_limit' || code === 'server_error') &&
      this.code !== 'aborted'
  }
}

export interface LLMClient {
  complete(messages: ChatMessage[], options?: { jsonMode?: boolean }, signal?: AbortSignal): Promise<CompletionResult>
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504])

function classifyHttpResponse(status: number, bodyHint: string): LlmError {
  if (status === 401 || status === 403) {
    return new LlmError('auth', `authentication rejected by provider (HTTP ${status})`, { httpStatus: status })
  }
  if (RETRYABLE_STATUS.has(status)) {
    return new LlmError('rate_limit', `provider returned HTTP ${status}${bodyHint ? `: ${bodyHint}` : ''}`, {
      httpStatus: status,
    })
  }
  return new LlmError('invalid_request', `provider returned HTTP ${status}${bodyHint ? `: ${bodyHint}` : ''}`, {
    httpStatus: status,
  })
}

function joinUrl(base: string, suffix: string): string {
  return `${base.replace(/\/+$/, '')}/${suffix.replace(/^\/+/, '')}`
}

function applyTimeout(
  signal: AbortSignal | undefined,
  ms: number,
): { signal: AbortSignal; timer: NodeJS.Timeout; dispose: () => void } {
  const controller = new AbortController()
  // A DOMException named AbortError lets the fetch catch distinguish "our
  // timeout fired" (signal.aborted is false) from "the caller cancelled".
  const timer = setTimeout(
    () => controller.abort(new DOMException(`LLM request timed out after ${ms}ms`, 'AbortError')),
    ms,
  )
  const onAbort = (): void => controller.abort(signal?.reason)
  if (signal?.aborted) controller.abort(signal?.reason)
  signal?.addEventListener('abort', onAbort, { once: true })
  return {
    signal: controller.signal,
    timer,
    dispose: () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
    },
  }
}

interface OpenAiResponseBody {
  choices?: Array<{ message?: { content?: string | null } }>
  usage?: { prompt_tokens?: number; completion_tokens?: number }
  error?: { message?: string; type?: string }
}

export class OpenAiClient implements LLMClient {
  private readonly endpoint: string
  private readonly apiKey: string | undefined
  private readonly model: string
  private readonly timeoutMs: number
  private readonly maxRetries: number
  private readonly temperature: number
  private readonly jsonMode: boolean

  constructor(settings: LlmSettings, withDefaults: Required<Pick<LlmSettings, 'baseUrl' | 'model'>>) {
    this.endpoint = joinUrl(withDefaults.baseUrl, 'chat/completions')
    this.apiKey = settings.apiKey
    this.model = withDefaults.model
    this.timeoutMs = settings.timeoutMs ?? 120_000
    this.maxRetries = settings.maxRetries ?? 2
    this.temperature = settings.temperature ?? 0.2
    this.jsonMode = settings.jsonMode ?? false
  }

  async complete(
    messages: ChatMessage[],
    options: { jsonMode?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    if (signal?.aborted) throw new LlmError('aborted', 'request aborted by caller')
    let attempt = 0
    let jsonMode = options.jsonMode ?? this.jsonMode
    let lastError: LlmError | undefined

    while (true) {
      try {
        return await this.requestOnce(messages, jsonMode, signal)
      } catch (error) {
        lastError = error instanceof LlmError ? error : new LlmError('network', String((error as Error)?.message ?? error))
        // JSON-mode higher-level 400s are often caused by the provider refusing
        // `response_format`; retry the same payload in plain text mode.
        if (lastError.code === 'invalid_request' && lastError.httpStatus === 400 && jsonMode) {
          jsonMode = false
          continue
        }
        if (!lastError.retryable || attempt >= this.maxRetries) throw lastError
        attempt++
        await sleep(300 * 2 ** (attempt - 1) + Math.floor(Math.random() * 150))
      }
    }
  }

  private async requestOnce(
    messages: ChatMessage[],
    jsonMode: boolean,
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    const { signal: timeoutSignal, dispose } = applyTimeout(signal, this.timeoutMs)
    try {
      const body: Record<string, unknown> = {
        model: this.model,
        messages,
        temperature: this.temperature,
        stream: false,
      }
      if (jsonMode) body.response_format = { type: 'json_object' }

      let response: Response
      try {
        response = await fetch(this.endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal: timeoutSignal,
        })
      } catch (error) {
        const aborted = (error as Error)?.name === 'AbortError'
        // A caller-initiated abort must never be retried; only our own timeout
        // (or the underlying network error) is retryable.
        const code: LlmErrorCode = signal?.aborted === true ? 'aborted' : aborted ? 'timeout' : 'network'
        throw new LlmError(code, `failed to reach provider: ${(error as Error)?.message ?? error}`, {
          cause: error,
        })
      }

      const textPayload = await response.text().catch(() => '')
      const parsed = safeParseJson<OpenAiResponseBody>(textPayload)

      if (!response.ok) {
        const hint = parsed?.error?.message ?? textPayload.slice(0, 200)
        throw classifyHttpResponse(response.status, hint)
      }

      const content = parsed?.choices?.[0]?.message?.content ?? ''
      if (!content) {
        throw new LlmError('empty_response', 'provider returned an empty completion', { httpStatus: response.status })
      }

      const completionUsage = parsed?.usage
        ? {
            inputTokens: parsed.usage.prompt_tokens,
            outputTokens: parsed.usage.completion_tokens,
          }
        : undefined
      return { text: content, usage: completionUsage }
    } finally {
      dispose()
    }
  }
}

function safeParseJson<T>(text: string): T | undefined {
  try {
    return JSON.parse(text) as T
  } catch {
    return undefined
  }
}

/** Minimal shape of the host harness's `ctx.llm.stream` output chunk. */
interface DshStreamChunk {
  type?: string
  text?: unknown
  content?: unknown
  delta?: unknown
  kind?: string
  failure?: unknown
  usage?: { promptTokens?: number; completionTokens?: number }
}

/**
 * Backend that delegates to a harness-provided LLM seam (`ctx.llm.stream`).
 * The seam signature is intentionally structural: any object exposing
 * `stream(options): AsyncIterable<chunk>` is accepted, and unknown chunk
 * shapes degrade gracefully to text extraction.
 */
export class DshClient implements LLMClient {
  constructor(
    private readonly seam: { stream(options: unknown): AsyncIterable<DshStreamChunk> },
    private readonly model: string,
  ) {}

  async complete(
    messages: ChatMessage[],
    _options: { jsonMode?: boolean } = {},
    signal?: AbortSignal,
  ): Promise<CompletionResult> {
    if (typeof this.seam.stream !== 'function') {
      throw new LlmError('unsupported', 'ctx.llm seam does not provide a stream() method')
    }
    let text = ''
    const usage: CompletionUsage = {}
    try {
      for await (const chunk of this.seam.stream({ model: this.model, messages, signal })) {
        const type = chunk.type
        if (type === 'finish') {
          if (chunk.kind === 'error') {
            throw new LlmError('server_error', String(chunk.failure ?? 'llm stream failed'), { cause: chunk.failure })
          }
          if (chunk.kind === 'aborted') {
            throw new LlmError('aborted', 'llm stream aborted')
          }
          break
        }
        if (type === 'usage') {
          usage.inputTokens = chunk.usage?.promptTokens
          usage.outputTokens = chunk.usage?.completionTokens
          continue
        }
        const frag = extractTextFragment(chunk)
        if (frag) text += frag
      }
    } catch (error) {
      if (signal?.aborted) throw new LlmError('aborted', 'llm stream aborted', { cause: error })
      throw error
    }
    if (!text.trim()) {
      throw new LlmError('empty_response', 'llm seam returned no text')
    }
    return { text, usage: usage.inputTokens !== undefined || usage.outputTokens !== undefined ? usage : undefined }
  }
}

function extractTextFragment(chunk: DshStreamChunk): string | undefined {
  if (typeof chunk.text === 'string') return chunk.text
  if (typeof chunk.delta === 'string') return chunk.delta
  if (typeof chunk.delta === 'object' && chunk.delta !== null && typeof (chunk.delta as { content?: unknown }).content === 'string') {
    return (chunk.delta as { content: string }).content
  }
  if (typeof chunk.content === 'string') return chunk.content
  return undefined
}

export interface LlmSeam {
  stream(options: unknown): AsyncIterable<DshStreamChunk>
}

/** Build a client from settings, validating required fields eagerly. */
export function createLlmClient(
  settings: LlmSettings,
  deps: { seam?: LlmSeam } = {},
): LLMClient {
  const provider: LlmProvider = settings.provider ?? 'openai'
  const defaults = {
    baseUrl: settings.baseUrl ?? 'https://api.deepseek.com/v1',
    model: settings.model ?? 'deepseek-chat',
  }

  if (provider === 'dsh') {
    if (!deps.seam) {
      throw new LlmError('unsupported', 'provider "dsh" requires a ctx.llm seam (set config.llm.provider accordingly)')
    }
    return new DshClient(deps.seam, defaults.model)
  }

  if (!settings.apiKey) {
    throw new LlmError('auth', 'missing API key for OpenAI-compatible provider (config.llm.apiKey)')
  }
  return new OpenAiClient(settings, defaults)
}