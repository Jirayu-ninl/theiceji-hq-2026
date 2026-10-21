/**
 * The permission vocabulary for connected apps.
 *
 * One scope per module capability, named `<module>:<capability>`;
 * `workspace` is the group the consent screen and Connections page show
 * it under — the module id, `hq` or `ops`. The MCP
 * server lists a tool only when the connection holds that tool's scope — a
 * tool the grant can't use is absent, not listed-then-refused. A new module
 * adds its rows here (and to its manifest in packages/hq-core), and its MCP
 * tools name them.
 */

export type ScopeLevel = 'read' | 'write' | 'publish'

export type ScopeDefinition = {
  readonly scope: string
  readonly workspace: string
  readonly label: string
  readonly description: string
  readonly level: ScopeLevel
}

export const SCOPES = [
  /* ── One scope set per module ─────────────────────────
   * `<module>:read` reads, `<module>:write` drafts inside the operating
   * policy, `<module>:operate` may spend or let something leave HQ — again
   * only inside the policy. `ops:decide` is one kernel scope for every
   * decision. Nothing here reaches policies, budgets, connections, marking
   * paid or sending a quote: those are the owner's, in HQ.
   */
  {
    scope: 'hq:read',
    workspace: 'hq',
    label: 'See your projects',
    description:
      'List your projects and their modules, read the brief of what waits for you and what is running, search across HQ, and see what this connection may do. Nothing is changed by reading.',
    level: 'read',
  },
  {
    scope: 'notes:read',
    workspace: 'notes',
    label: 'Read notes',
    description: 'Read your notes, their labels and where each was promoted.',
    level: 'read',
  },
  {
    scope: 'notes:write',
    workspace: 'notes',
    label: 'Write notes',
    description:
      'Capture and edit notes, and promote a note into a card, prompt, shot or event — where your operating policy allows drafting.',
    level: 'write',
  },
  {
    scope: 'board:read',
    workspace: 'board',
    label: 'Read boards',
    description:
      'Read boards, lanes and cards, including prices and due dates.',
    level: 'read',
  },
  {
    scope: 'board:write',
    workspace: 'board',
    label: 'Work the boards',
    description:
      'Create, edit and move cards. Never marks a card paid — that stays yours.',
    level: 'write',
  },
  {
    scope: 'prompts:read',
    workspace: 'prompts',
    label: 'Read the prompt library',
    description: 'Read prompts, their variants and example media.',
    level: 'read',
  },
  {
    scope: 'prompts:write',
    workspace: 'prompts',
    label: 'Write prompts',
    description:
      'Save prompts and variants and attach examples from your assets, where your operating policy allows drafting.',
    level: 'write',
  },
  {
    scope: 'assets:read',
    workspace: 'assets',
    label: 'Read assets',
    description:
      'List assets and generation jobs and get short-lived download links. Files stay where you keep them — R2 or your Google Drive.',
    level: 'read',
  },
  {
    scope: 'assets:write',
    workspace: 'assets',
    label: 'Upload assets',
    description:
      'Upload files and record generated results into your projects. Never deletes a ready asset.',
    level: 'write',
  },
  {
    scope: 'assets:operate',
    workspace: 'assets',
    label: 'Queue generation',
    description:
      'Queue image and video generation that can spend, up to the budgets and providers your operating policy names. A kill switch stops it.',
    level: 'publish',
  },
  {
    scope: 'story:read',
    workspace: 'story',
    label: 'Read stories',
    description: 'Read scripts, characters, scenes and the shot board.',
    level: 'read',
  },
  {
    scope: 'story:write',
    workspace: 'story',
    label: 'Write stories',
    description:
      'Save scripts and shots where your operating policy allows drafting.',
    level: 'write',
  },
  {
    scope: 'calendar:read',
    workspace: 'calendar',
    label: 'Read the calendar',
    description: 'Read events in HQ, including the ones synced with Google.',
    level: 'read',
  },
  {
    scope: 'calendar:write',
    workspace: 'calendar',
    label: 'Add events',
    description:
      'Create events in HQ. Whether an event syncs to Google stays your choice per event.',
    level: 'write',
  },
  {
    scope: 'quotes:read',
    workspace: 'quotes',
    label: 'Read quotes',
    description: 'Read quotes, their lines, totals and clients.',
    level: 'read',
  },
  {
    scope: 'quotes:write',
    workspace: 'quotes',
    label: 'Draft quotes',
    description:
      'Draft quotes. Never sends one — sending a quote to a client stays yours.',
    level: 'write',
  },
  {
    scope: 'publish:read',
    workspace: 'publish',
    label: 'Read posts',
    description: 'Read accounts, posts, their evidence and readings.',
    level: 'read',
  },
  {
    scope: 'publish:write',
    workspace: 'publish',
    label: 'Prepare posts',
    description:
      'Plan posts, record readings and record posts made by hand, where your operating policy allows it.',
    level: 'write',
  },
  {
    scope: 'publish:operate',
    workspace: 'publish',
    label: 'Publish',
    description:
      'Dispatch posts you or your policy authorized, reconcile them and cancel them, only to the accounts your operating policy names.',
    level: 'publish',
  },
  {
    scope: 'market:read',
    workspace: 'market',
    label: 'Read the shop',
    description: 'Read marketplaces, products, listings, orders and payouts.',
    level: 'read',
  },
  {
    scope: 'market:write',
    workspace: 'market',
    label: 'Prepare listings',
    description:
      'Prepare listings and record sales and payouts where your operating policy allows it.',
    level: 'write',
  },
  {
    scope: 'market:operate',
    workspace: 'market',
    label: 'List and sell',
    description:
      'Dispatch authorized listings to the marketplaces your policy names and reconcile them. A kill switch stops it.',
    level: 'publish',
  },
  {
    scope: 'experiments:read',
    workspace: 'experiments',
    label: 'Read experiments',
    description: 'Read experiments, variants, items, decisions and learnings.',
    level: 'read',
  },
  {
    scope: 'experiments:write',
    workspace: 'experiments',
    label: 'Run experiments',
    description:
      'Create and update experiments and record learnings where your operating policy allows drafting.',
    level: 'write',
  },
  {
    scope: 'readings:read',
    workspace: 'readings',
    label: 'Read results',
    description:
      'Read readings, money and generation cost across your projects, compared at the same age.',
    level: 'read',
  },
  {
    scope: 'agents:operate',
    workspace: 'agents',
    label: 'Work as an agent',
    description:
      'Claim tasks with a lease, heartbeat and checkpoint them, leave proposals for you to accept, ask you for help, pull events and record cost. Only inside your operating policy.',
    level: 'write',
  },
  {
    scope: 'ops:decide',
    workspace: 'ops',
    label: 'Decide under your policy',
    description:
      'Record decisions (keep, iterate, stop) and authorize releases where your operating policy lets the server decide. Never records a human approval on your behalf.',
    level: 'write',
  },
] as const satisfies readonly ScopeDefinition[]

export type Scope = (typeof SCOPES)[number]['scope']

export const ALL_SCOPES: readonly Scope[] = SCOPES.map((entry) => entry.scope)

/**
 * Requested and honoured, but not an HQ permission. Claude appends it to an
 * authorization request only when the authorization server advertises it.
 * HQ issues a refresh token either way, so it never reaches a grant.
 */
export const OFFLINE_ACCESS = 'offline_access'

const KNOWN = new Set<string>(ALL_SCOPES)

export const isScope = (value: string): value is Scope => KNOWN.has(value)

/**
 * The known scopes in a space-separated string, deduplicated, in catalog
 * order. Unknown words (`openid`, `offline_access`, another server's scopes)
 * are ignored rather than refused — a client asking in a dialect HQ doesn't
 * speak still gets the part it understood.
 */
export function parseScopes(raw: string | null | undefined): Scope[] {
  const asked = new Set((raw ?? '').split(/\s+/).filter(Boolean))
  return ALL_SCOPES.filter((scope) => asked.has(scope))
}

/** The canonical wire form: known scopes only, catalog order, space-separated. */
export function formatScopes(scopes: Iterable<string>): string {
  const held = new Set(scopes)
  return ALL_SCOPES.filter((scope) => held.has(scope)).join(' ')
}

export function scopeDefinition(scope: Scope): ScopeDefinition {
  return SCOPES.find((entry) => entry.scope === scope) as ScopeDefinition
}
