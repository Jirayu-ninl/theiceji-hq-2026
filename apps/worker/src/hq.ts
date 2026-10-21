import {
  Client,
  StreamableHTTPClientTransport,
} from '@modelcontextprotocol/client'

/**
 * The worker's only way into HQ: HQ's MCP tools (`agents_*`, `assets_*`), over
 * HTTP, with a personal access token created as a *worker* in HQ → Settings →
 * Connections. It holds no database credentials and no storage keys — uploads
 * and downloads go through the short-lived URLs HQ signs for it.
 */

export type HqRecord = Record<string, unknown>

/** A typed refusal from HQ (`{ ok: false, error: { code, retryable } }`). */
export class HqRefusal extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly retryable: string | null,
  ) {
    super(message)
    this.name = 'HqRefusal'
  }
}

export type Hq = {
  call: (tool: string, args: HqRecord) => Promise<HqRecord>
  close: () => Promise<void>
}

type ToolResult = {
  isError?: boolean
  content?: { type: string; text?: string }[]
  structuredContent?: HqRecord
}

export function answer(result: ToolResult): HqRecord {
  const data = result.structuredContent ?? {}
  if (result.isError) {
    const error = (data.error ?? {}) as {
      code?: string
      message?: string
      retryable?: string
    }
    const text = result.content?.find((part) => part.type === 'text')?.text
    throw new HqRefusal(
      error.code ?? 'refused',
      error.message ?? text ?? 'HQ refused the call.',
      error.retryable ?? null,
    )
  }
  return data
}

export async function connectHq(options: {
  url: string
  token: string
  name?: string
}): Promise<Hq> {
  const client = new Client({
    name: options.name ?? 'theiceji-hq-worker',
    version: '0.1.0',
  })
  await client.connect(
    new StreamableHTTPClientTransport(new URL(options.url), {
      requestInit: { headers: { authorization: `Bearer ${options.token}` } },
    }),
  )
  return {
    call: async (tool, args) =>
      answer(
        (await client.callTool({ name: tool, arguments: args })) as ToolResult,
      ),
    close: () => client.close(),
  }
}

/** Moving bytes through HQ's signed URLs. Swappable so tests can use a fixture bucket. */
export type Transfer = {
  upload: (
    grant: { url: string; method: string; headers: Record<string, string> },
    bytes: Uint8Array,
  ) => Promise<void>
  download: (url: string) => Promise<Uint8Array>
}

export const httpTransfer: Transfer = {
  upload: async (grant, bytes) => {
    const response = await fetch(grant.url, {
      method: grant.method,
      headers: grant.headers,
      body: new Blob([bytes as BlobPart]),
    })
    if (!response.ok)
      throw new Error(`Upload refused by storage (${response.status}).`)
  },
  download: async (url) => {
    const response = await fetch(url)
    if (!response.ok)
      throw new Error(`Download refused by storage (${response.status}).`)
    return new Uint8Array(await response.arrayBuffer())
  },
}
