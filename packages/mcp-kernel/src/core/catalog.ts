import { type CallToolResult, McpServer } from '@modelcontextprotocol/server'
import { errorMessage, fail } from './results'
import type { AnyTool, ToolContext, Workspace } from './workspace'

/** How a server names itself — on the wire, to the model, and to the owner. */
export type ServerIdentity = {
  /** `implementation.name` in the MCP handshake. */
  name: string
  version: string
  /**
   * The paragraph prepended to every session, before each workspace's own
   * instructions — what this server is and how its tool names read.
   */
  preamble: string
  /**
   * RFC 9728 `resource_name`: what a client shows the owner while they
   * consent. The resource server's own name, never the authorization
   * server's. The gate also uses it in the refusals a caller reads ("That is
   * not a <resourceName> access token.").
   */
  resourceName: string
  /**
   * The sentence a credential-less or rejected caller reads — usually
   * "Connect <resourceName> to continue."
   */
  connectPrompt: string
}

export type CatalogEntry<C extends ToolContext = ToolContext> = {
  workspace: Workspace<C>
  tool: AnyTool<C>
  wireName: string
}

/** Every tool of every workspace, with its wire name. */
export function catalog<C extends ToolContext>(
  workspaces: readonly Workspace<C>[],
): CatalogEntry<C>[] {
  return workspaces.flatMap((workspace) =>
    workspace.tools.map((tool) => ({
      workspace,
      tool,
      wireName: `${workspace.id}_${tool.name}`,
    })),
  )
}

export function instructionsFor<C extends ToolContext>(
  workspaces: readonly Workspace<C>[],
  preamble: string,
): string {
  return [
    preamble,
    ...workspaces.map(
      (workspace) =>
        `## ${workspace.label} workspace (\`${workspace.id}_*\`)\n${workspace.instructions}`,
    ),
  ].join('\n\n')
}

/**
 * One McpServer for one caller.
 *
 * Built per request (over HTTP) because the tool list is a function of the
 * caller's scopes: only tools the connection may use are registered, so a
 * forbidden tool is absent from `tools/list` rather than listed and refused.
 *
 * The context is the server's own — built by it from the verified caller
 * (`createFetchHandler`'s `context`) or by hand over stdio — and handed as-is
 * to every tool and resource this server registers.
 */
export function buildServer<C extends ToolContext>(input: {
  context: C
  workspaces: readonly Workspace<C>[]
  identity: ServerIdentity
}): McpServer {
  const { context, workspaces, identity } = input
  const { caller, log } = context
  const held: ReadonlySet<string> = caller.scopes
  const visible = catalog(workspaces).filter((entry) =>
    held.has(entry.tool.scope),
  )
  const present = workspaces.filter((workspace) =>
    visible.some((entry) => entry.workspace === workspace),
  )

  const readable = present.flatMap((workspace) =>
    (workspace.resources ?? []).filter((resource) => held.has(resource.scope)),
  )

  const server = new McpServer(
    { name: identity.name, version: identity.version },
    {
      /* Stated, not left off: an empty `tools: {}` advertises
         `listChanged: true`, a notification this server never sends. The list
         changes only when a connection's permissions do, which means a new
         token and a new request. The same holds for resources. */
      capabilities: {
        tools: { listChanged: false },
        ...(readable.length > 0
          ? { resources: { listChanged: false, subscribe: false } }
          : {}),
      },
      instructions: instructionsFor(present, identity.preamble),
    },
  )

  for (const resource of readable) {
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: resource.mimeType,
      },
      async (uri) => {
        const text = await resource.read(context)
        log.info(`resource ${resource.uri} · ${caller.label} · ok`)
        return {
          contents: [{ uri: uri.href, mimeType: resource.mimeType, text }],
        }
      },
    )
  }

  for (const { tool, wireName } of visible) {
    server.registerTool(
      wireName,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args): Promise<CallToolResult> => {
        const started = Date.now()
        try {
          const result = await tool.run(args as never, context)
          log.info(
            `${wireName} · ${caller.label} · ${result.isError ? 'refused' : 'ok'} · ${Date.now() - started}ms`,
          )
          return result
        } catch (error) {
          const incident = crypto.randomUUID().slice(0, 8)
          log.error(
            `${wireName} · ${caller.label} · threw (incident ${incident}): ${errorMessage(error)}`,
          )
          return fail(
            `${tool.title} failed unexpectedly (incident ${incident}): ${errorMessage(error)}. Check the current state before retrying.`,
          )
        }
      },
    )
  }

  return server
}
