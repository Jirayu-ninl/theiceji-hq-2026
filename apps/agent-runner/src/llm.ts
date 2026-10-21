import Anthropic from '@anthropic-ai/sdk'
import { type LlmConfig, providerFetch } from '@theiceji/hq-core/connections'
import { digitsOf, toMinor } from '@theiceji/hq-core/money'

/**
 * The builtin runner's model: Claude, through the official SDK, with the
 * owner's key from `provider_connections` (`llm:anthropic`). Every request
 * goes out through HQ's guarded fetch — the base URL is the owner's to set,
 * so it is pinned to a public address like any other provider endpoint.
 */

export const DEFAULT_MODEL = 'claude-opus-5'

/**
 * Anthropic list prices per million tokens (USD). Used only when the owner
 * left the key's prices empty and bills in USD; a budget in another currency
 * needs the owner's own prices — HQ never converts money.
 */
const LIST_PRICES: Record<string, { input: string; output: string }> = {
  'claude-fable-5-1': { input: '10', output: '50' },
  'claude-fable-5': { input: '10', output: '50' },
  'claude-opus-5-5': { input: '4', output: '20' },
  'claude-opus-5': { input: '5', output: '25' },
  'claude-opus-4-8': { input: '5', output: '25' },
  'claude-sonnet-5': { input: '2', output: '10' },
  'claude-haiku-4-5': { input: '1', output: '5' },
}

/** Models where a refusal is retried server-side on another model (API guide default). */
const FALLBACK_MODELS = new Set(['claude-opus-5', 'claude-fable-5-1'])

export type Pricing = {
  currency: string
  /** Minor units per million tokens, scaled ×10⁴ for sub-minor precision. */
  inputPerMTok: bigint
  outputPerMTok: bigint
}

export function pricingFor(config: LlmConfig, model: string): Pricing | null {
  const currency = config.currency ?? 'USD'
  const listed = currency === 'USD' ? LIST_PRICES[model] : undefined
  const input = config.inputPerMTok ?? listed?.input
  const output = config.outputPerMTok ?? listed?.output
  if (!input || !output) return null
  const scale = digitsOf(currency) + 4
  return {
    currency,
    inputPerMTok: toMinor(input, scale),
    outputPerMTok: toMinor(output, scale),
  }
}

export type TurnUsage = {
  input: number
  output: number
  cacheWrite: number
  cacheRead: number
}

/** Cost of a turn in minor units, rounded up — cache writes 1.25×, reads 0.1× input. */
export function costOf(pricing: Pricing, usage: TurnUsage): number {
  const inputEquivalent =
    BigInt(usage.input) * 100n +
    BigInt(usage.cacheWrite) * 125n +
    BigInt(usage.cacheRead) * 10n
  const scaled =
    inputEquivalent * pricing.inputPerMTok +
    BigInt(usage.output) * 100n * pricing.outputPerMTok
  // ÷100 (the multipliers) ÷10⁶ (per million) ÷10⁴ (the price scale).
  const divisor = 100n * 1_000_000n * 10_000n
  return Number((scaled + divisor - 1n) / divisor)
}

/** The SDK's fetch, through HQ's guard: public addresses only, a cap on size and time. */
const guardedFetch: typeof fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url
  const headers: Record<string, string> = {}
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value
  })
  const response = await providerFetch(url, {
    method: (init?.method as 'GET' | 'POST' | undefined) ?? 'GET',
    headers,
    ...(typeof init?.body === 'string' ? { body: init.body } : {}),
    timeoutMs: 10 * 60_000,
    maxBytes: 32 * 1024 ** 2,
  })
  return new Response(response.body as Uint8Array<ArrayBuffer>, {
    status: response.status,
    headers: response.headers,
  })
}) as typeof fetch

export function clientFor(config: LlmConfig, apiKey: string): Anthropic {
  return new Anthropic({
    apiKey,
    ...(config.baseUrl ? { baseURL: config.baseUrl } : {}),
    fetch: guardedFetch,
    maxRetries: 2,
  })
}

export type TurnRequest = {
  model: string
  system: string
  tools: Anthropic.Tool[]
  messages: Anthropic.MessageParam[]
  maxTokens: number
}

/**
 * One turn. On Claude Opus 5 and Fable 5.1 a policy refusal is retried on
 * another model server-side (`fallbacks: "default"`) — the answer says which
 * model served it. The system prompt and tools are cached across turns.
 */
export async function turn(
  client: Anthropic,
  request: TurnRequest,
): Promise<Anthropic.Beta.BetaMessage> {
  const fallback = FALLBACK_MODELS.has(request.model)
  return client.beta.messages.create({
    model: request.model,
    max_tokens: request.maxTokens,
    system: [
      {
        type: 'text',
        text: request.system,
        cache_control: { type: 'ephemeral' },
      },
    ],
    tools: request.tools,
    messages: request.messages as Anthropic.Beta.BetaMessageParam[],
    ...(fallback
      ? {
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default' as const,
        }
      : {}),
  })
}
