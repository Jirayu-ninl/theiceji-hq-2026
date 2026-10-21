import type { CallToolResult, JSONObject } from '@modelcontextprotocol/server'

export type Json = Record<string, unknown>

/** A successful tool answer: prose for the model, structured data for clients. */
export function ok(text: string, data?: Json): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    ...(data ? { structuredContent: data as JSONObject } : {}),
  }
}

/** A refusal the model can read and act on — HTTP 200, `isError: true`. */
export function fail(text: string): CallToolResult {
  return { content: [{ type: 'text', text }], isError: true }
}

/**
 * A typed refusal: the sentence for the model plus `{ error: { code,
 * retryable, … } }` a client can branch on without parsing prose.
 */
export function failWith(text: string, error: Json): CallToolResult {
  return {
    content: [{ type: 'text', text }],
    structuredContent: { ok: false, error } as JSONObject,
    isError: true,
  }
}

/** The most useful message in an unknown throw, GraphQL errors included. */
export function errorMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const shaped = error as {
      response?: { errors?: { message: string }[] }
      message?: string
    }
    const graphql = shaped.response?.errors
    if (Array.isArray(graphql) && graphql.length > 0) {
      return graphql.map((entry) => entry.message).join('; ')
    }
    if (shaped.message) return shaped.message
  }
  return String(error)
}
