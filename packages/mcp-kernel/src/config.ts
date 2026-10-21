import { z } from 'zod'

/**
 * RFC 8707 resource identifiers — the MCP endpoint URL a token is valid at.
 *
 * Compared as canonical strings, never by prefix or host: a token minted for
 * `https://mcp.example.com/mcp` must not work at `/mcp-admin` or anywhere else
 * on the host. Canonical here means what clients send in practice (Claude
 * lower-cases the host and drops a trailing slash): scheme and host from URL
 * parsing, no fragment, no trailing slash on the path.
 *
 * Returns null for anything that isn't an http(s) URL. The authorization
 * server has to canonicalise the same way when it binds a grant to a
 * resource, or the two would disagree about which endpoint a token is for.
 */
export function canonicalResource(
  value: string | null | undefined,
): string | null {
  if (!value) return null
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  if (url.username || url.password) return null
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.protocol}//${url.host}${path}${url.search}`
}

/**
 * The configuration every MCP server in this monorepo shares, validated once
 * at boot and never read from `process.env` again.
 *
 * Each server extends it with what only it needs (`BaseConfigSchema.extend`)
 * and parses through `parseConfig`, which fails loudly naming EVERY missing or
 * malformed variable at once — so a five-variable misconfiguration costs one
 * deploy, not five.
 */
export const BaseConfigSchema = z.object({
  /**
   * The database the tokens live in — the authorization server's own, which
   * it migrates. Every bearer is looked up there, on every request.
   */
  DATABASE_URL: z.string().min(1),
  /** A long-running process, so a real pool rather than serverless' one. */
  DATABASE_POOL_MAX: z.coerce.number().int().min(1).max(50).default(5),

  /**
   * The canonical resource identifier (RFC 8707): the exact URL people paste
   * into Claude / ChatGPT, path included — e.g. `https://mcp.example.com/mcp`.
   * It must be listed in the authorization server's `MCP_RESOURCE_URLS`, or
   * no token is ever issued for it. Chosen once per environment: changing it
   * strands every connection.
   */
  MCP_PUBLIC_URL: z
    .url()
    .refine((value) => canonicalResource(value) !== null, {
      message: 'must be an http(s) URL without credentials',
    })
    .refine((value) => !/\/sse\/?$/.test(new URL(value).pathname), {
      message:
        'must not end in /sse — that path selects the deprecated SSE transport',
    })
    .transform((value) => canonicalResource(value) as string),

  /**
   * The authorization server's issuer — its origin, e.g.
   * `https://auth.example.com`. Exactly one: clients use the first they are
   * given and never fall back. Reduced to the bare origin so a trailing slash
   * can't break RFC 8414's byte-for-byte issuer match with the authorization
   * server's own `OAUTH_ISSUER`.
   */
  MCP_AUTHORIZATION_SERVER: z.url().transform((value) => new URL(value).origin),

  /** Optional `resource_documentation` in the protected-resource metadata. */
  MCP_DOCUMENTATION_URL: z.url().optional(),

  /**
   * Browser origins allowed to call the endpoint: hostnames, comma-separated.
   * A request carrying any other `Origin` is refused with 403 (a Streamable
   * HTTP MUST). Requests with no `Origin` pass — MCP clients aren't browsers.
   */
  MCP_ALLOWED_ORIGIN_HOSTS: z
    .string()
    .optional()
    .transform((value) =>
      (value ?? '')
        .split(',')
        .map((entry) => entry.trim())
        .filter(Boolean),
    ),

  /**
   * How many reverse proxies sit in front of this process and append to
   * `X-Forwarded-For`. The client address — what the per-address budgets key
   * on — is the entry that many hops from the right; anything to its left was
   * written by the client and is ignored. 0 = no proxy: use the socket
   * address and ignore the header entirely. Railway's edge is one hop.
   */
  MCP_TRUSTED_PROXY_HOPS: z.coerce.number().int().min(0).max(5).default(0),

  /** Largest request body, in bytes. A legitimate tool call is well under 4 MiB. */
  MCP_MAX_REQUEST_BYTES: z.coerce
    .number()
    .int()
    .min(16_384)
    .max(16_777_216)
    .default(4_194_304),

  HOST: z.string().optional(),

  /** Labels for the boot line. Railway sets both; nothing branches on them. */
  RAILWAY_SERVICE_NAME: z.string().optional(),
  RAILWAY_GIT_COMMIT_SHA: z.string().optional(),
})

export type BaseConfig = z.infer<typeof BaseConfigSchema>

/**
 * `PORT` with the server's own local default. Railway injects PORT in
 * production; locally each server owns one number, so several can run side
 * by side.
 */
export function portSchema(fallback: number) {
  return z.coerce.number().int().min(1).max(65535).default(fallback)
}

/**
 * Parse a server's schema out of the environment, naming every problem at
 * once. `name` prefixes the error so a container log says which service
 * refused to boot.
 */
export function parseConfig<Schema extends z.ZodObject>(
  name: string,
  schema: Schema,
  source: Record<string, string | undefined> = process.env,
): z.infer<Schema> {
  // A blank `KEY=` in a .env means "unset", not "the empty string".
  const present = Object.fromEntries(
    Object.entries(source).filter(
      ([, value]) => value !== undefined && value.trim() !== '',
    ),
  )
  const parsed = schema.safeParse(present)
  if (!parsed.success) {
    const problems = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('\n  ')
    throw new Error(`${name} config invalid:\n  ${problems}`)
  }
  return parsed.data as z.infer<Schema>
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || '(unparseable)'
  } catch {
    return '(unparseable)'
  }
}

/**
 * One boot line for what this process will actually talk to. `extra` holds
 * the segments only one server has (an upstream API, a scheduler); they sit
 * where a reader expects them, between the transport settings and the port.
 * Carries no secret.
 */
export function describeConfigLine(
  config: BaseConfig & { PORT: number },
  extra: readonly string[] = [],
): string {
  return [
    `resource ${config.MCP_PUBLIC_URL}`,
    `authorization server ${config.MCP_AUTHORIZATION_SERVER}`,
    `database ${hostOf(config.DATABASE_URL)} (pool ${config.DATABASE_POOL_MAX})`,
    `origins ${config.MCP_ALLOWED_ORIGIN_HOSTS.length > 0 ? config.MCP_ALLOWED_ORIGIN_HOSTS.join(' ') : '(none — browser callers refused)'}`,
    `body ≤ ${config.MCP_MAX_REQUEST_BYTES}B`,
    `client address ${config.MCP_TRUSTED_PROXY_HOPS > 0 ? `X-Forwarded-For −${config.MCP_TRUSTED_PROXY_HOPS}` : 'socket'}`,
    ...extra,
    `port ${config.PORT}`,
    ...(config.RAILWAY_GIT_COMMIT_SHA
      ? [`commit ${config.RAILWAY_GIT_COMMIT_SHA.slice(0, 7)}`]
      : []),
  ].join(' · ')
}
