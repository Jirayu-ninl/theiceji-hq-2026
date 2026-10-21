import type {
  CallToolResult,
  ToolAnnotations,
} from '@modelcontextprotocol/server'
import type { z } from 'zod'
import type { Logger } from '../log'

/**
 * The workspace contract — the MCP twin of the consuming app's own navigation
 * registry.
 *
 * Each workspace is one folder under a server's `src/workspaces/` exporting a
 * `defineWorkspace({...})`: an id, a paragraph of instructions for the model,
 * and its tools. Tool names go on the wire as `<workspace>_<name>`, and every
 * tool names the one scope it needs — a connection that doesn't hold it never
 * sees the tool.
 *
 * The kernel only knows the part of a call every server shares: who is
 * calling (`Caller`) and where to log (`ToolContext`). A server widens both —
 * its own scope vocabulary, whatever it knows about the person behind the
 * token, a database handle — and gets context-typed `defineTool` /
 * `defineWorkspace` from `toolkit<Context>()`, so its tools receive exactly
 * the context it builds and can only name scopes it actually has.
 *
 * Adding a workspace to a server:
 *   1. add its scopes to the server's scope vocabulary — the list it hands
 *      `createFetchHandler` as `scopes`, which the authorization server's
 *      consent screen renders too
 *   2. create src/workspaces/<id>/index.ts with that server's `defineWorkspace`
 *   3. append it to `WORKSPACES` in the server's src/workspaces/index.ts
 */

/** Who is calling — resolved from the bearer token before any tool runs. */
export type Caller<S extends string = string> = {
  /** `oauth` = a consented app, `personal` = a hand-made token, `local` = stdio. */
  via: 'oauth' | 'personal' | 'local'
  /** The account the connection belongs to; null only over local stdio without one. */
  userId: string | null
  /** The grant behind the token; null over local stdio. */
  grantId: string | null
  /** The app or token name, for logs. */
  label: string
  /** What the connection may do, in the server's own vocabulary. */
  scopes: ReadonlySet<S>
}

/**
 * What every tool and resource is handed. A server extends it (and its
 * `Caller`) with what its own tools need, and builds one per request.
 */
export type ToolContext = {
  caller: Caller
  log: Logger
}

/**
 * The scope vocabulary a context's caller is expressed in — `string` for the
 * base context, the server's own union (`'x:read' | 'x:write'`) once it has
 * narrowed `Caller`. Tools and resources are typed with it, so naming a scope
 * the server doesn't have is a compile error, not a tool nobody can ever see.
 */
export type ScopeOf<C extends ToolContext> =
  C['caller']['scopes'] extends ReadonlySet<infer S extends string> ? S : never

export type ToolDefinition<
  C extends ToolContext = ToolContext,
  Input extends z.ZodObject = z.ZodObject,
> = {
  /** Bare name; the wire name is `<workspace>_<name>`. */
  name: string
  title: string
  description: string
  scope: ScopeOf<C>
  input: Input
  annotations: ToolAnnotations
  run: (args: z.infer<Input>, context: C) => Promise<CallToolResult>
}

export type AnyTool<C extends ToolContext = ToolContext> = ToolDefinition<
  C,
  z.ZodObject
>

/**
 * A document a workspace serves over `resources/read`.
 *
 * Instructions have to stay short — they are prepended to every session. A
 * resource is where the long form lives: the order the tools go in, what each
 * step is actually for, and the rules behind the refusals. It is fetched when
 * it is wanted rather than paid for on every connection, and, like a tool, it
 * is only offered to a connection whose scopes reach it.
 */
export type WorkspaceResource<C extends ToolContext = ToolContext> = {
  /** Stable URI, e.g. `mcp://<workspace>/playbook`. */
  uri: string
  /** Bare name; listed as `<workspace>_<name>`. */
  name: string
  title: string
  description: string
  mimeType: string
  /** The one scope a connection needs to see it. */
  scope: ScopeOf<C>
  read: (context: C) => string | Promise<string>
}

export type Workspace<C extends ToolContext = ToolContext> = {
  /** The tool-name prefix; by convention also the prefix of its scopes. */
  id: string
  label: string
  description: string
  /** Workspace-specific guidance for the model, referring to wire names. */
  instructions: string
  tools: readonly AnyTool<C>[]
  resources?: readonly WorkspaceResource<C>[]
}

/** `defineTool` and `defineWorkspace`, bound to one server's context type. */
export type Toolkit<C extends ToolContext> = {
  /** Keeps each tool's argument types precise, then erases them for the registry. */
  defineTool: <Input extends z.ZodObject>(
    tool: ToolDefinition<C, Input>,
  ) => AnyTool<C>
  defineWorkspace: (workspace: Workspace<C>) => Workspace<C>
}

/**
 * The contract specialised to a server's own context:
 *
 * ```ts
 * export const { defineTool, defineWorkspace } = toolkit<MyToolContext>()
 * ```
 *
 * Nothing happens at runtime — both functions return what they are given.
 * The point is the types: every tool's `run` receives `MyToolContext`, and its
 * `scope` must be one of that context's scopes.
 */
export function toolkit<C extends ToolContext>(): Toolkit<C> {
  return {
    defineTool: (tool) => tool as unknown as AnyTool<C>,
    defineWorkspace: (workspace) => workspace,
  }
}

/** For the base context. A server with its own context uses `toolkit<C>()`. */
export function defineTool<Input extends z.ZodObject>(
  tool: ToolDefinition<ToolContext, Input>,
): AnyTool {
  return tool as unknown as AnyTool
}

export function defineWorkspace(workspace: Workspace): Workspace {
  return workspace
}
