import { assetAccess } from '@theiceji/hq-assets/assets'
import { link, refsOf } from '@theiceji/hq-core/refs'
import {
  PUBLISH_EVIDENCE_LEVELS,
  PUBLISH_PLATFORMS,
  PUBLISH_POST_STATUSES,
  type PublishEvidenceLevel,
} from '@theiceji/hq-db/enums'
import {
  type AssetRow,
  assetAssets,
  type OpsPolicyRow,
  type OpsReleaseAuthorizationRow,
  opsReleaseAuthorizations,
  type ProjectRow,
  type ProviderConnectionRow,
  type PublishAccountRow,
  type PublishIntentRow,
  type PublishPostRow,
  type PublishReadingRow,
  projects,
  providerConnections,
  publishAccounts,
  publishIntents,
  publishPosts,
  publishReadings,
  type RefRow,
  refs,
} from '@theiceji/hq-db/schema'
import { type Actor, assertCan, can } from '@theiceji/hq-ops/access'
import { schedulerActor } from '@theiceji/hq-ops/actors'
import { dbNow, type Reader, type Tx } from '@theiceji/hq-ops/db'
import {
  capabilityUnavailable,
  conflict,
  invalid,
  notFound,
  policyBlocked,
  reauthRequired,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  type Blocker,
  consumeAuthorization,
  issueAuthorization,
} from '@theiceji/hq-ops/release'
import {
  choice,
  idempotencyKey,
  optionalChoice,
  optionalRecordId,
  parseInput,
  recordId,
  revision,
  text,
} from '@theiceji/hq-ops/schemas'
import { unseal } from '@theiceji/hq-ops/secrets'
import {
  assertModuleOn,
  audit,
  auditTrail,
  authorize,
  ownedProject,
  ownedRecord,
  ownedRow,
  returned,
  runOperation,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { parseInstant } from '@theiceji/hq-ops/time'
import { auditSnapshot, diffFields } from '@theiceji/hq-ops/values'
import { and, asc, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm'
import type { PgUpdateSetSource } from 'drizzle-orm/pg-core'
import { z } from 'zod'
import {
  type AdapterContext,
  publishAdapter,
  RemoteReauth,
  RemoteRejected,
  RemoteUnknown,
  type Submitted,
} from './adapters'
import {
  assetBinding,
  hashPayload,
  PLATFORM_RULES,
  type PostAsset,
  payloadOf,
  postBlockers,
  postParts,
} from './payload'
import { currentReadings, type LatestReading } from './readings'

/**
 * Publish: a channel project's accounts and its posts,
 * from a plan to a post that is out, with evidence.
 *
 * · **Planning is drafting.** Anyone who may write to Publish — the owner, or
 *   an agent whose policy allows drafting — plans and edits posts.
 * · **Clearing is the owner's.** A post goes out only under a release
 *   authorization (hq-ops) bound to the hash of exactly what it sends: the
 *   owner's approval, or a policy the owner set to release by itself. Editing
 *   a cleared post makes the clearance stop fitting; the post goes back to
 *   planned and says why.
 * · **Two ways out.** By hand: someone posts it on the platform and records
 *   the URL (`recordManualPost`) — an agent may do that only under a live
 *   clearance, which it consumes. Through an API: `dispatchPost` consumes the
 *   clearance and hands the payload to the platform's adapter; an answer that
 *   never came back is `unknown` and is reconciled by reading the platform,
 *   never sent twice. HQ ships no platform adapter yet, so
 *   by hand is the path that works today, and the API path says so in words.
 * · **Out means evidence.** A post is `posted` only with a time, how we know
 *   (`owner_attested`, `agent_attested`, a screenshot, an export) and a URL
 *   or external ID; `verified` only when the platform read it back.
 */

registerConstraintMessages({
  publish_accounts_handle_key:
    'That account is already in this project. Restore it instead.',
  publish_posts_external_key: 'That post is already on the record.',
  publish_posts_url_key: 'A post with that URL is already on the record.',
  publish_posts_evidence_check:
    'A post that is out needs a time, evidence and a URL or post ID.',
  publish_intents_live_key: 'This post is already being sent.',
  publish_posts_asset_fk: 'That file isn’t yours to post.',
  publish_readings_supersedes_key: 'That reading was already corrected.',
})

/* ── Shapes ─────────────────────────────────────────────────────────── */

export type ProjectLite = Pick<
  ProjectRow,
  'id' | 'slug' | 'name' | 'color' | 'status' | 'kind' | 'timezone' | 'currency'
>

const projectLite = {
  id: projects.id,
  slug: projects.slug,
  name: projects.name,
  color: projects.color,
  status: projects.status,
  kind: projects.kind,
  timezone: projects.timezone,
  currency: projects.currency,
}

/**
 * How an account gets posts out: `api` — HQ can post through its connection;
 * `manual` — someone posts by hand and records it; `reconnect` — its
 * connection needs the owner.
 */
export type AccountReadiness = {
  mode: 'api' | 'manual' | 'reconnect'
  note: string
}

export type AccountView = PublishAccountRow & {
  readiness: AccountReadiness
  connection: Pick<ProviderConnectionRow, 'id' | 'label' | 'status'> | null
  posts: number
}

export type PostListItem = PublishPostRow & {
  account: Pick<PublishAccountRow, 'id' | 'platform' | 'handle'>
  project: ProjectLite
  /** With the owner's title for it (HQ shows it); `name` stays the file's. */
  asset: (PostAsset & Pick<AssetRow, 'title'>) | null
  /** The live clearance, if any. */
  clearance: Pick<
    OpsReleaseAuthorizationRow,
    'id' | 'mode' | 'expiresAt' | 'approvedBy'
  > | null
  /** Current lifetime readings by metric. */
  latest: Record<string, LatestReading>
}

export type PostDetail = {
  post: PublishPostRow
  account: AccountView
  project: ProjectRow
  /** What goes out, with the owner's title for it (HQ shows it). */
  asset: (PostAsset & Pick<AssetRow, 'title'>) | null
  clearance: OpsReleaseAuthorizationRow | null
  /** Why it can't be cleared or sent as it stands; empty when it can. */
  blockers: Blocker[]
  payloadHash: string
  intents: PublishIntentRow[]
  /** Every reading, newest first — corrections included, marked by `supersededBy`. */
  readings: (PublishReadingRow & { supersededBy: string | null })[]
  latest: Record<string, LatestReading>
  refs: RefRow[]
  history: Awaited<ReturnType<typeof auditTrail>>
}

const POST_OUT = ['posted', 'verified', 'removed'] as const

/* ── Small inputs ───────────────────────────────────────────────────── */

const url = (label: string) =>
  z.preprocess(
    (value) =>
      typeof value === 'string' ? value.trim() || null : (value ?? undefined),
    z
      .string()
      .max(600, `${label} must be 600 characters or fewer.`)
      .regex(
        /^https?:\/\/\S+$/i,
        `${label} must start with http:// or https://.`,
      )
      .nullable()
      .optional(),
  )

/** An instant: ISO with a zone, or a local `YYYY-MM-DDTHH:mm` in the project's zone. */
const instant = (label: string) =>
  z
    .union([z.string().max(40), z.date()])
    .nullable()
    .optional()
    .describe(label)

function toInstant(
  raw: string | Date | null | undefined,
  timeZone: string,
  label: string,
): Date | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null || raw === '') return null
  if (raw instanceof Date) return raw
  const parsed = parseInstant(raw, timeZone)
  if (!parsed)
    throw invalid(`${label} must be a date and time.`, {
      [label]: 'Use YYYY-MM-DDTHH:mm.',
    })
  return parsed
}

const disclosureSchema = z
  .object({
    aiGenerated: z.boolean().optional(),
    affiliate: z.boolean().optional(),
    text: text.optional('Disclosure', 300),
  })
  .optional()

/* ── Accounts ───────────────────────────────────────────────────────── */

function readinessOf(
  account: PublishAccountRow,
  connection: Pick<ProviderConnectionRow, 'id' | 'label' | 'status'> | null,
): AccountReadiness {
  const label = PLATFORM_RULES[account.platform].label
  if (account.platform === 'manual')
    return { mode: 'manual', note: 'Posted by hand, recorded here.' }
  if (!connection)
    return {
      mode: 'manual',
      note: `No ${label} connection — post by hand and record it.`,
    }
  if (connection.status !== 'connected')
    return {
      mode: 'reconnect',
      note: `The ${label} connection needs you in Settings › Connections.`,
    }
  if (!publishAdapter(account.platform))
    return {
      mode: 'manual',
      note: `HQ can’t post to ${label} by itself yet — post by hand and record it.`,
    }
  return { mode: 'api', note: `HQ posts through ${connection.label}.` }
}

async function accountViews(
  reader: Reader,
  ownerId: string,
  where: ReturnType<typeof and>,
): Promise<AccountView[]> {
  const counts = reader
    .select({
      accountId: publishPosts.accountId,
      n: sql<number>`count(*)::int`.as('n'),
    })
    .from(publishPosts)
    .where(eq(publishPosts.ownerId, ownerId))
    .groupBy(publishPosts.accountId)
    .as('post_counts')
  const rows = await reader
    .select({
      account: publishAccounts,
      connection: {
        id: providerConnections.id,
        label: providerConnections.label,
        status: providerConnections.status,
      },
      posts: counts.n,
    })
    .from(publishAccounts)
    .leftJoin(
      providerConnections,
      eq(providerConnections.id, publishAccounts.connectionId),
    )
    .leftJoin(counts, eq(counts.accountId, publishAccounts.id))
    .where(and(eq(publishAccounts.ownerId, ownerId), where))
    .orderBy(asc(publishAccounts.platform), asc(publishAccounts.handle))
  return rows.map((row) => {
    const connection = row.connection?.id ? row.connection : null
    return {
      ...row.account,
      connection,
      readiness: readinessOf(row.account, connection),
      posts: row.posts ?? 0,
    }
  })
}

/** A project's accounts, archived ones last and only when asked. */
export async function listAccounts(
  actor: Actor,
  raw: { projectId: string; includeArchived?: boolean },
): Promise<AccountView[]> {
  const input = parseInput(
    z.object({
      projectId: recordId('Project'),
      includeArchived: z.boolean().optional(),
    }),
    raw,
  )
  return withReader(async (db) => {
    const project = await ownedProject(
      db,
      actor,
      input.projectId,
      'publish',
      'read',
    )
    assertModuleOn(project, 'publish')
    const rows = await accountViews(
      db,
      actor.userId,
      and(
        eq(publishAccounts.projectId, project.id),
        input.includeArchived ? undefined : isNull(publishAccounts.archivedAt),
      ),
    )
    return rows.sort(
      (a, b) => Number(Boolean(a.archivedAt)) - Number(Boolean(b.archivedAt)),
    )
  })
}

const accountSchema = z.object({
  projectId: recordId('Project'),
  accountId: optionalRecordId('Account'),
  expectedRevision: revision.optional(),
  platform: choice(
    PUBLISH_PLATFORMS,
    'Choose Facebook, YouTube, TikTok or Other.',
  ),
  handle: text.required('Handle', 120),
  profileUrl: url('Profile URL'),
  externalAccountId: text.optional('Account ID', 120),
  connectionId: optionalRecordId('Connection'),
  notes: text.optional('Notes', 4000),
})

export type SaveAccountInput = z.input<typeof accountSchema>

/**
 * Add an account to a project, or change one. Where a channel posts is the
 * owner's to say; an agent asks instead.
 */
export async function saveAccount(
  actor: Actor,
  raw: SaveAccountInput,
): Promise<PublishAccountRow> {
  const input = parseInput(accountSchema, raw)
  return withTransaction(async (tx) => {
    const project = await ownedProject(
      tx,
      actor,
      input.projectId,
      'publish',
      'write',
      'owner_only',
    )
    assertModuleOn(project, 'publish')
    if (input.connectionId) {
      const [connection] = await tx
        .select()
        .from(providerConnections)
        .where(
          and(
            eq(providerConnections.id, input.connectionId),
            eq(providerConnections.ownerId, actor.userId),
          ),
        )
        .limit(1)
      if (!connection || connection.revokedAt) throw notFound('Connection')
      if (connection.provider !== input.platform)
        throw invalid(
          `That connection is for ${connection.provider}, not ${PLATFORM_RULES[input.platform].label}.`,
          { connectionId: 'Choose a connection for this platform.' },
        )
    }
    const fields = {
      platform: input.platform,
      handle: input.handle as string,
      profileUrl: input.profileUrl ?? null,
      externalAccountId: input.externalAccountId ?? null,
      connectionId: input.connectionId ?? null,
      notes: input.notes ?? '',
    }
    if (!input.accountId) {
      const [row] = await tx
        .insert(publishAccounts)
        .values({
          ownerId: actor.userId,
          createdBy: actor.userId,
          projectId: project.id,
          ...fields,
        })
        .returning()
      const account = returned(row)
      await audit(tx, actor, {
        projectId: project.id,
        action: 'publish.account.create',
        targetType: 'publish_account',
        targetId: account.id,
        afterRevision: account.revision,
        changes: auditSnapshot({
          platform: account.platform,
          handle: account.handle,
          connection: account.connectionId,
        }),
      })
      return account
    }
    const [current] = await tx
      .select()
      .from(publishAccounts)
      .where(
        and(
          eq(publishAccounts.id, input.accountId),
          eq(publishAccounts.ownerId, actor.userId),
          eq(publishAccounts.projectId, project.id),
        ),
      )
      .for('update')
    if (!current) throw notFound('Account')
    if (input.expectedRevision && current.revision !== input.expectedRevision)
      throw conflict()
    const changes = diffFields(
      current as unknown as Record<string, unknown>,
      fields,
    )
    if (Object.keys(changes).length === 0) return current
    const [row] = await tx
      .update(publishAccounts)
      .set({
        ...fields,
        revision: sql`${publishAccounts.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(publishAccounts.id, current.id))
      .returning()
    const account = returned(row)
    await audit(tx, actor, {
      projectId: project.id,
      action: 'publish.account.update',
      targetType: 'publish_account',
      targetId: account.id,
      beforeRevision: current.revision,
      afterRevision: account.revision,
      changes,
    })
    return account
  })
}

/** Archive an account (its posts stay on the record) or restore it. The owner's. */
export async function setAccountArchived(
  actor: Actor,
  raw: { accountId: string; expectedRevision: number; archived: boolean },
): Promise<PublishAccountRow> {
  const input = parseInput(
    z.object({
      accountId: recordId('Account'),
      expectedRevision: revision,
      archived: z.boolean(),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { row, project } = await ownedRecord<PublishAccountRow>(
      tx,
      actor,
      publishAccounts,
      input.accountId,
      'publish',
      'write',
      'Account',
      'owner_only',
    )
    if (row.revision !== input.expectedRevision) throw conflict()
    if (Boolean(row.archivedAt) === input.archived) return row
    const [saved] = await tx
      .update(publishAccounts)
      .set({
        archivedAt: input.archived ? sql`now()` : null,
        revision: sql`${publishAccounts.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(eq(publishAccounts.id, row.id))
      .returning()
    const account = returned(saved)
    await audit(tx, actor, {
      projectId: project?.id ?? null,
      action: input.archived
        ? 'publish.account.archive'
        : 'publish.account.restore',
      targetType: 'publish_account',
      targetId: account.id,
      beforeRevision: row.revision,
      afterRevision: account.revision,
    })
    return account
  })
}

/* ── Reading posts ──────────────────────────────────────────────────── */

async function liveClearances(
  reader: Reader,
  ownerId: string,
  postIds: readonly string[],
): Promise<Map<string, OpsReleaseAuthorizationRow>> {
  if (postIds.length === 0) return new Map()
  const rows = await reader
    .select()
    .from(opsReleaseAuthorizations)
    .where(
      and(
        eq(opsReleaseAuthorizations.ownerId, ownerId),
        eq(opsReleaseAuthorizations.module, 'publish'),
        eq(opsReleaseAuthorizations.subjectType, 'post'),
        inArray(opsReleaseAuthorizations.subjectId, [...postIds]),
        eq(opsReleaseAuthorizations.status, 'active'),
        sql`${opsReleaseAuthorizations.expiresAt} > now()`,
      ),
    )
    .orderBy(desc(opsReleaseAuthorizations.createdAt))
  const out = new Map<string, OpsReleaseAuthorizationRow>()
  for (const row of rows)
    if (!out.has(row.subjectId)) out.set(row.subjectId, row)
  return out
}

const listSchema = z.object({
  projectId: optionalRecordId('Project'),
  accountId: optionalRecordId('Account'),
  status: z.array(z.enum(PUBLISH_POST_STATUSES)).optional(),
  limit: z.number().int().min(1).max(500).optional(),
})

export type ListPostsInput = z.input<typeof listSchema>

/**
 * Posts of one project, or of every project with Publish on — newest plans
 * and newest posts first, each with its account, file, live clearance and
 * current readings.
 */
export async function listPosts(
  actor: Actor,
  raw: ListPostsInput = {},
): Promise<PostListItem[]> {
  const input = parseInput(listSchema, raw)
  return withReader(async (db) => {
    if (input.projectId) {
      const project = await ownedProject(
        db,
        actor,
        input.projectId,
        'publish',
        'read',
      )
      assertModuleOn(project, 'publish')
    } else await authorize(db, actor, null, 'publish', 'read')
    const rows = await db
      .select({
        post: publishPosts,
        account: {
          id: publishAccounts.id,
          platform: publishAccounts.platform,
          handle: publishAccounts.handle,
        },
        project: projectLite,
        asset: {
          id: assetAssets.id,
          name: assetAssets.name,
          title: assetAssets.title,
          kind: assetAssets.kind,
          mime: assetAssets.mime,
          status: assetAssets.status,
          sha256: assetAssets.sha256,
          bytes: assetAssets.bytes,
          origin: assetAssets.origin,
        },
      })
      .from(publishPosts)
      .innerJoin(
        publishAccounts,
        eq(publishAccounts.id, publishPosts.accountId),
      )
      .innerJoin(projects, eq(projects.id, publishPosts.projectId))
      .leftJoin(assetAssets, eq(assetAssets.id, publishPosts.assetId))
      .where(
        and(
          eq(publishPosts.ownerId, actor.userId),
          input.projectId
            ? eq(publishPosts.projectId, input.projectId)
            : sql`(${projects.status} <> 'archived' and ${projects.modules} -> 'enabled' ? 'publish')`,
          input.accountId
            ? eq(publishPosts.accountId, input.accountId)
            : undefined,
          input.status?.length
            ? inArray(publishPosts.status, input.status)
            : undefined,
        ),
      )
      .orderBy(
        sql`coalesce(${publishPosts.postedAt}, ${publishPosts.scheduledFor}, ${publishPosts.createdAt}) desc`,
      )
      .limit(input.limit ?? 200)
    const ids = rows.map((row) => row.post.id)
    const [clearances, latest] = await Promise.all([
      liveClearances(db, actor.userId, ids),
      currentReadings(db, actor.userId, { postIds: ids }),
    ])
    return rows.map((row) => {
      const clearance = clearances.get(row.post.id)
      return {
        ...row.post,
        account: row.account,
        project: row.project,
        asset: row.asset?.id ? row.asset : null,
        clearance: clearance
          ? {
              id: clearance.id,
              mode: clearance.mode,
              expiresAt: clearance.expiresAt,
              approvedBy: clearance.approvedBy,
            }
          : null,
        latest: latest.get(row.post.id) ?? {},
      }
    })
  })
}

/** One post with everything the detail panel shows. */
export async function getPost(
  actor: Actor,
  postId: string,
): Promise<PostDetail> {
  return withReader(async (db) => {
    const { project } = await ownedRecord<PublishPostRow>(
      db,
      actor,
      publishPosts,
      postId,
      'publish',
      'read',
      'Post',
    )
    if (!project) throw notFound('Post')
    const { post, account, asset } = await postParts(db, actor.userId, postId)
    const [
      accounts,
      clearances,
      intents,
      readings,
      latest,
      links,
      history,
      titled,
    ] = await Promise.all([
      accountViews(db, actor.userId, eq(publishAccounts.id, account.id)),
      liveClearances(db, actor.userId, [post.id]),
      db
        .select()
        .from(publishIntents)
        .where(eq(publishIntents.postId, post.id))
        .orderBy(desc(publishIntents.createdAt)),
      db
        .select()
        .from(publishReadings)
        .where(
          and(
            eq(publishReadings.ownerId, actor.userId),
            eq(publishReadings.postId, post.id),
          ),
        )
        .orderBy(desc(publishReadings.observedAt))
        .limit(200),
      currentReadings(db, actor.userId, { postIds: [post.id] }),
      refsOf(db, actor.userId, { type: 'post', id: post.id }),
      auditTrail(db, actor.userId, [post.id], 30),
      // The owner's title, for HQ to show; the file goes out under its name.
      asset
        ? db
            .select({ title: assetAssets.title })
            .from(assetAssets)
            .where(
              and(
                eq(assetAssets.id, asset.id),
                eq(assetAssets.ownerId, actor.userId),
              ),
            )
            .limit(1)
        : Promise.resolve([]),
    ])
    const successor = new Map(
      readings
        .filter((row) => row.supersedesId)
        .map((row) => [row.supersedesId as string, row.id]),
    )
    return {
      post,
      account: returned(accounts[0]),
      project,
      asset: asset ? { ...asset, title: titled[0]?.title ?? null } : null,
      clearance: clearances.get(post.id) ?? null,
      blockers: postBlockers(post, account, asset),
      payloadHash: hashPayload(payloadOf(post, account, asset)),
      intents,
      readings: readings.map((row) => ({
        ...row,
        supersededBy: successor.get(row.id) ?? null,
      })),
      latest: latest.get(post.id) ?? {},
      refs: links,
      history,
    }
  })
}

/* ── Writing posts ──────────────────────────────────────────────────── */

/** The post, locked, with its project — for a write. */
async function postForWrite(
  tx: Tx,
  actor: Actor,
  postId: string,
  capability: 'write' | 'operate',
  requirement?: 'owner_only' | 'publish' | 'draft',
): Promise<{
  post: PublishPostRow
  project: ProjectRow
  /** The owner's policy an agent is acting under; null for the owner. */
  policy: OpsPolicyRow | null
}> {
  assertCan(actor, 'publish', capability)
  const { row: post, project } = await ownedRow<PublishPostRow>(
    tx,
    actor,
    publishPosts,
    postId,
    'Post',
    { lock: true },
  )
  if (!project) throw notFound('Post')
  const policy = await authorize(
    tx,
    actor,
    project,
    'publish',
    capability,
    requirement,
  )
  assertModuleOn(project, 'publish')
  return { post, project, policy }
}

/** An agent publishes only to accounts the owner's policy names. */
function assertAccountAllowed(
  policy: OpsPolicyRow | null,
  account: PublishAccountRow,
): void {
  if (policy && !policy.allowedAccountIds.includes(account.id))
    throw policyBlocked(
      `The operating policy doesn’t allow posting to ${account.handle}. Only the owner can add it.`,
      {
        blockers: [
          {
            key: 'target_not_allowed',
            message: `${account.handle} isn’t in the policy’s accounts.`,
          },
        ],
      },
    )
}

async function savePost(
  tx: Tx,
  post: PublishPostRow,
  patch: PgUpdateSetSource<typeof publishPosts>,
): Promise<PublishPostRow> {
  const [row] = await tx
    .update(publishPosts)
    .set({
      ...patch,
      revision: sql`${publishPosts.revision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(
      and(
        eq(publishPosts.id, post.id),
        eq(publishPosts.revision, post.revision),
      ),
    )
    .returning()
  if (!row) throw conflict()
  return row
}

/** Revoke every live clearance of a post, inside the caller's transaction. */
async function revokeClearances(
  tx: Tx,
  actor: Actor,
  post: PublishPostRow,
  reason: string,
): Promise<number> {
  const revoked = await tx
    .update(opsReleaseAuthorizations)
    .set({ status: 'revoked', revokedAt: sql`now()`, statusReason: reason })
    .where(
      and(
        eq(opsReleaseAuthorizations.ownerId, actor.userId),
        eq(opsReleaseAuthorizations.module, 'publish'),
        eq(opsReleaseAuthorizations.subjectType, 'post'),
        eq(opsReleaseAuthorizations.subjectId, post.id),
        eq(opsReleaseAuthorizations.status, 'active'),
      ),
    )
    .returning({ id: opsReleaseAuthorizations.id })
  for (const row of revoked)
    await audit(tx, actor, {
      projectId: post.projectId,
      action: 'release.revoke',
      targetType: 'release_authorization',
      targetId: row.id,
      reason,
    })
  return revoked.length
}

async function accountOf(
  tx: Reader,
  ownerId: string,
  projectId: string,
  accountId: string,
): Promise<PublishAccountRow> {
  const [account] = await tx
    .select()
    .from(publishAccounts)
    .where(
      and(
        eq(publishAccounts.id, accountId),
        eq(publishAccounts.ownerId, ownerId),
        eq(publishAccounts.projectId, projectId),
      ),
    )
    .limit(1)
  if (!account) throw notFound('Account')
  return account
}

async function assetFor(
  tx: Tx,
  actor: Actor,
  project: ProjectRow,
  assetId: string,
): Promise<AssetRow> {
  const { row: asset } = await ownedRecord<AssetRow>(
    tx,
    actor,
    assetAssets,
    assetId,
    'assets',
    'read',
    'Asset',
  )
  if (asset.status === 'rejected')
    throw invalid('That file was rejected; choose another.')
  if (asset.projectId && asset.projectId !== project.id)
    throw invalid('That file belongs to another project.', {
      assetId: 'Choose a file of this project.',
    })
  return asset
}

const planSchema = z.object({
  projectId: recordId('Project'),
  accountId: recordId('Account'),
  assetId: optionalRecordId('Asset'),
  title: text.optional('Title', 200),
  caption: text.optional('Caption', 5000),
  disclosure: disclosureSchema,
  scheduledFor: instant('Scheduled for'),
  /** The board card this post comes from — linked `card —published_as→ post`. */
  fromCardId: optionalRecordId('Card'),
  idempotencyKey: idempotencyKey.optional(),
})

export type PlanPostInput = z.input<typeof planSchema>

/** A new planned post. Nothing leaves HQ until the owner clears it. */
export async function planPost(
  actor: Actor,
  raw: PlanPostInput,
): Promise<PublishPostRow> {
  const input = parseInput(planSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'publish_plan',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const project = await ownedProject(
          tx,
          actor,
          input.projectId,
          'publish',
          'write',
        )
        assertModuleOn(project, 'publish')
        const account = await accountOf(
          tx,
          actor.userId,
          project.id,
          input.accountId,
        )
        if (account.archivedAt)
          throw invalid(`The account ${account.handle} is archived.`)
        const asset = input.assetId
          ? await assetFor(tx, actor, project, input.assetId)
          : null
        const [row] = await tx
          .insert(publishPosts)
          .values({
            ownerId: actor.userId,
            createdBy: actor.userId,
            projectId: project.id,
            accountId: account.id,
            assetId: asset?.id ?? null,
            title: input.title ?? null,
            caption: input.caption ?? '',
            disclosure: {
              // A generated file says so unless someone turns it off.
              aiGenerated:
                input.disclosure?.aiGenerated ?? asset?.origin === 'generated',
              affiliate: input.disclosure?.affiliate ?? false,
              ...(input.disclosure?.text
                ? { text: input.disclosure.text }
                : {}),
            },
            scheduledFor:
              toInstant(input.scheduledFor, project.timezone, 'scheduledFor') ??
              null,
          })
          .returning()
        const post = returned(row)
        if (input.fromCardId)
          await link(
            tx,
            actor,
            { type: 'card', id: input.fromCardId },
            { type: 'post', id: post.id },
            'published_as',
          )
        await audit(tx, actor, {
          projectId: project.id,
          action: 'publish.post.plan',
          targetType: 'post',
          targetId: post.id,
          afterRevision: post.revision,
          changes: auditSnapshot({
            account: account.handle,
            platform: account.platform,
            asset: asset?.name ?? null,
            title: post.title,
            scheduledFor: post.scheduledFor?.toISOString() ?? null,
          }),
        })
        return post
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.post_id
    if (typeof id !== 'string') throw conflict()
    return (await getPost(actor, id)).post
  }
  await outcome.complete({ post_id: outcome.value.id })
  return outcome.value
}

const updateSchema = z.object({
  postId: recordId('Post'),
  expectedRevision: revision,
  accountId: recordId('Account').optional(),
  assetId: optionalRecordId('Asset'),
  title: text.optional('Title', 200),
  caption: text.optional('Caption', 5000),
  disclosure: disclosureSchema,
  scheduledFor: instant('Scheduled for'),
  idempotencyKey: idempotencyKey.optional(),
})

export type UpdatePostInput = z.input<typeof updateSchema>

/**
 * Change a post that hasn't gone out. Absent fields stay as they are. If the
 * change touches what it would send, a live clearance stops fitting: it is
 * revoked and the post goes back to planned, saying why.
 */
export async function updatePost(
  actor: Actor,
  raw: UpdatePostInput,
): Promise<PublishPostRow> {
  const input = parseInput(updateSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'publish_update',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { post, project } = await postForWrite(
          tx,
          actor,
          input.postId,
          'write',
        )
        if (post.revision !== input.expectedRevision) throw conflict()
        if (!['planned', 'scheduled', 'failed'].includes(post.status))
          throw invalid(
            `This post is ${post.status}. What is out stays as it went out.`,
          )
        const before = await postParts(tx, actor.userId, post.id)
        const patch: Partial<typeof publishPosts.$inferInsert> = {}
        if (
          input.accountId !== undefined &&
          input.accountId !== post.accountId
        ) {
          const account = await accountOf(
            tx,
            actor.userId,
            project.id,
            input.accountId,
          )
          if (account.archivedAt)
            throw invalid(`The account ${account.handle} is archived.`)
          patch.accountId = account.id
        }
        if (input.assetId !== undefined)
          patch.assetId = input.assetId
            ? (await assetFor(tx, actor, project, input.assetId)).id
            : null
        if (input.title !== undefined) patch.title = input.title ?? null
        if (input.caption !== undefined) patch.caption = input.caption ?? ''
        if (input.disclosure !== undefined)
          patch.disclosure = {
            aiGenerated:
              input.disclosure.aiGenerated ?? post.disclosure.aiGenerated,
            affiliate: input.disclosure.affiliate ?? post.disclosure.affiliate,
            ...((input.disclosure.text ?? post.disclosure.text)
              ? { text: input.disclosure.text ?? post.disclosure.text }
              : {}),
          }
        if (input.scheduledFor !== undefined)
          patch.scheduledFor =
            toInstant(input.scheduledFor, project.timezone, 'scheduledFor') ??
            null
        const changes = diffFields(
          post as unknown as Record<string, unknown>,
          patch,
        )
        if (Object.keys(changes).length === 0) return post
        let saved = await savePost(tx, post, patch)
        const after = await postParts(tx, actor.userId, saved.id)
        const moved =
          hashPayload(payloadOf(before.post, before.account, before.asset)) !==
          hashPayload(payloadOf(after.post, after.account, after.asset))
        if (moved && post.status !== 'planned') {
          await revokeClearances(
            tx,
            actor,
            saved,
            'The post changed after it was cleared.',
          )
          saved = await savePost(tx, saved, {
            status: 'planned',
            statusReason: 'Changed after it was cleared — clear it again.',
          })
        }
        await audit(tx, actor, {
          projectId: project.id,
          action: 'publish.post.update',
          targetType: 'post',
          targetId: saved.id,
          beforeRevision: post.revision,
          afterRevision: saved.revision,
          changes: { ...changes, ...(moved ? { payloadChanged: true } : {}) },
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay')
    return (await getPost(actor, input.postId)).post
  await outcome.complete({ post_id: outcome.value.id })
  return outcome.value
}

export type AuthorizeOutcome = {
  post: PublishPostRow
  authorization: OpsReleaseAuthorizationRow | null
  blockers: Blocker[]
}

/**
 * Clear a post to go out — the owner approving exactly this payload, or (for
 * an agent) the owner's policy doing it, when the policy is set to release
 * by itself. Returns the reasons instead when it can't be cleared.
 */
export async function authorizePost(
  actor: Actor,
  raw: {
    postId: string
    expectedRevision?: number
    mode?: 'human_approval' | 'policy_gated'
  },
): Promise<AuthorizeOutcome> {
  const input = parseInput(
    z.object({
      postId: recordId('Post'),
      expectedRevision: revision.optional(),
      mode: z.enum(['human_approval', 'policy_gated']).optional(),
    }),
    raw,
  )
  const mode =
    input.mode ?? (actor.type === 'user' ? 'human_approval' : 'policy_gated')
  return withTransaction(async (tx) => {
    const { row: post, project } = await ownedRow<PublishPostRow>(
      tx,
      actor,
      publishPosts,
      input.postId,
      'Post',
      { lock: true },
    )
    if (!project) throw notFound('Post')
    assertModuleOn(project, 'publish')
    if (input.expectedRevision && post.revision !== input.expectedRevision)
      throw conflict()
    const parts = await postParts(tx, actor.userId, post.id)
    const outcome = await issueAuthorization(tx, actor, project, {
      module: 'publish',
      subjectType: 'post',
      subjectId: post.id,
      payloadHash: hashPayload(
        payloadOf(parts.post, parts.account, parts.asset),
      ),
      mode,
    })
    if (!outcome.ok)
      return { post, authorization: null, blockers: outcome.blockers }
    const saved =
      post.status === 'scheduled' && !post.statusReason
        ? post
        : await savePost(tx, post, { status: 'scheduled', statusReason: null })
    await audit(tx, actor, {
      projectId: project.id,
      action: 'publish.post.clear',
      targetType: 'post',
      targetId: saved.id,
      beforeRevision: post.revision,
      afterRevision: saved.revision,
      changes: {
        mode,
        authorization: outcome.authorization.id,
        expiresAt: outcome.authorization.expiresAt.toISOString(),
      },
    })
    return { post: saved, authorization: outcome.authorization, blockers: [] }
  })
}

/** Take a post's clearance back; it returns to planned. */
export async function unschedulePost(
  actor: Actor,
  raw: { postId: string; expectedRevision: number; reason?: string },
): Promise<PublishPostRow> {
  const input = parseInput(
    z.object({
      postId: recordId('Post'),
      expectedRevision: revision,
      reason: text.optional('Reason', 500),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { post, project } = await postForWrite(
      tx,
      actor,
      input.postId,
      'write',
    )
    if (post.revision !== input.expectedRevision) throw conflict()
    if (post.status !== 'scheduled')
      throw invalid(
        `Only a scheduled post can be taken back; this one is ${post.status}.`,
      )
    const reason = input.reason ?? 'Taken back before it went out.'
    await revokeClearances(tx, actor, post, reason)
    const saved = await savePost(tx, post, {
      status: 'planned',
      statusReason: reason,
    })
    await audit(tx, actor, {
      projectId: project.id,
      action: 'publish.post.unschedule',
      targetType: 'post',
      targetId: saved.id,
      beforeRevision: post.revision,
      afterRevision: saved.revision,
      reason,
    })
    return saved
  })
}

/** Delete a plan that never went anywhere. The owner's. */
export async function deletePost(
  actor: Actor,
  raw: { postId: string; expectedRevision: number },
): Promise<void> {
  const input = parseInput(
    z.object({ postId: recordId('Post'), expectedRevision: revision }),
    raw,
  )
  await withTransaction(async (tx) => {
    const { post, project } = await postForWrite(
      tx,
      actor,
      input.postId,
      'write',
      'owner_only',
    )
    if (post.revision !== input.expectedRevision) throw conflict()
    if (post.status !== 'planned' && post.status !== 'failed')
      throw invalid('Only a planned post can be deleted. Take it back first.')
    const [intent] = await tx
      .select({ id: publishIntents.id })
      .from(publishIntents)
      .where(eq(publishIntents.postId, post.id))
      .limit(1)
    if (intent)
      throw invalid('This post was sent once; it stays on the record.')
    await revokeClearances(tx, actor, post, 'The post was deleted.')
    await tx
      .delete(refs)
      .where(
        and(
          eq(refs.ownerId, actor.userId),
          or(
            and(eq(refs.fromType, 'post'), eq(refs.fromId, post.id)),
            and(eq(refs.toType, 'post'), eq(refs.toId, post.id)),
          ),
        ),
      )
    await tx.delete(publishPosts).where(eq(publishPosts.id, post.id))
    await audit(tx, actor, {
      projectId: project.id,
      action: 'publish.post.delete',
      targetType: 'post',
      targetId: post.id,
      beforeRevision: post.revision,
      changes: auditSnapshot({ title: post.title, caption: post.caption }),
    })
  })
}

const manualSchema = z.object({
  postId: recordId('Post'),
  expectedRevision: revision.optional(),
  url: url('Post URL'),
  externalId: text.optional('Post ID', 200),
  postedAt: instant('Posted at'),
  evidenceLevel: optionalChoice(
    PUBLISH_EVIDENCE_LEVELS,
    'Say how you know it is out.',
  ),
  evidenceNote: text.optional('Evidence note', 1000),
  idempotencyKey: idempotencyKey.optional(),
})

export type RecordManualInput = z.input<typeof manualSchema>

/**
 * A post made by hand, on the record: its URL or post ID, when, and how we
 * know. An agent may record one only under a live clearance of exactly this
 * payload, which it uses up; the owner's own word is enough, and uses up a
 * clearance if there is one.
 */
export async function recordManualPost(
  actor: Actor,
  raw: RecordManualInput,
): Promise<PublishPostRow> {
  const input = parseInput(manualSchema, raw)
  if (!input.url && !input.externalId)
    throw invalid('Give the post’s URL or its ID on the platform.', {
      url: 'Paste the link to the post.',
    })
  const outcome = await runOperation(
    actor,
    {
      operation: 'publish_record_manual',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        const { post, project, policy } = await postForWrite(
          tx,
          actor,
          input.postId,
          'operate',
          'publish',
        )
        if (input.expectedRevision && post.revision !== input.expectedRevision)
          throw conflict()
        if (post.status !== 'planned' && post.status !== 'scheduled')
          throw invalid(`This post is already ${post.status}.`)
        const parts = await postParts(tx, actor.userId, post.id)
        assertAccountAllowed(policy, parts.account)
        const clearance = (
          await liveClearances(tx, actor.userId, [post.id])
        ).get(post.id)
        const person = actor.type === 'user'
        if (!person && !clearance)
          throw policyBlocked(
            'The owner hasn’t cleared this post. Ask them to authorize it in HQ, or with agents_request_human.',
            {
              blockers: [
                {
                  key: 'not_cleared',
                  message: 'No live clearance for this post.',
                },
              ],
            },
          )
        if (clearance)
          await consumeAuthorization(tx, actor, {
            authorizationId: clearance.id,
            payloadHash: hashPayload(
              payloadOf(parts.post, parts.account, parts.asset),
            ),
            assetSha256: parts.asset ? assetBinding(parts.asset) : undefined,
            targetRef: parts.account.id,
          })
        const now = await dbNow(tx)
        const postedAt =
          toInstant(input.postedAt, project.timezone, 'postedAt') ?? now
        if (postedAt.getTime() > now.getTime() + 60_000)
          throw invalid('A post can’t have gone out in the future.', {
            postedAt: 'Use the time it went out.',
          })
        const evidence: PublishEvidenceLevel = person
          ? input.evidenceLevel && input.evidenceLevel !== 'provider_verified'
            ? input.evidenceLevel
            : 'owner_attested'
          : input.evidenceLevel === 'platform_export' ||
              input.evidenceLevel === 'screenshot'
            ? input.evidenceLevel
            : 'agent_attested'
        const saved = await savePost(tx, post, {
          status: 'posted',
          postedAt,
          url: input.url ?? null,
          externalId: input.externalId ?? null,
          evidenceLevel: evidence,
          evidenceNote: input.evidenceNote ?? null,
          statusReason: null,
        })
        await audit(tx, actor, {
          projectId: project.id,
          action: 'publish.post.record_manual',
          targetType: 'post',
          targetId: saved.id,
          beforeRevision: post.revision,
          afterRevision: saved.revision,
          changes: {
            url: saved.url,
            externalId: saved.externalId,
            postedAt: postedAt.toISOString(),
            evidence,
            clearance: clearance?.id ?? null,
          },
        })
        return saved
      }),
  )
  if (outcome.kind === 'replay')
    return (await getPost(actor, input.postId)).post
  await outcome.complete({ post_id: outcome.value.id })
  return outcome.value
}

/** A post that came down (by the owner, the platform or anyone): on the record as removed. */
export async function markRemoved(
  actor: Actor,
  raw: { postId: string; expectedRevision: number; reason: string },
): Promise<PublishPostRow> {
  const input = parseInput(
    z.object({
      postId: recordId('Post'),
      expectedRevision: revision,
      reason: text.required('Reason', 500),
    }),
    raw,
  )
  return withTransaction(async (tx) => {
    const { post, project } = await postForWrite(
      tx,
      actor,
      input.postId,
      'write',
    )
    if (post.revision !== input.expectedRevision) throw conflict()
    if (post.status !== 'posted' && post.status !== 'verified')
      throw invalid('Only a post that is out can be marked removed.')
    const saved = await savePost(tx, post, {
      status: 'removed',
      removedAt: sql`now()`,
      statusReason: input.reason as string,
    })
    await audit(tx, actor, {
      projectId: project.id,
      action: 'publish.post.remove',
      targetType: 'post',
      targetId: saved.id,
      beforeRevision: post.revision,
      afterRevision: saved.revision,
      reason: input.reason as string,
    })
    return saved
  })
}

/* ── Dispatch through a platform's API ──────────────────────────────── */

async function connectionFor(
  reader: Reader,
  ownerId: string,
  account: PublishAccountRow,
): Promise<ProviderConnectionRow> {
  const label = PLATFORM_RULES[account.platform].label
  if (!account.connectionId)
    throw capabilityUnavailable(
      `The account ${account.handle} has no ${label} connection. Post it by hand and record it (publish_record_manual).`,
    )
  const [connection] = await reader
    .select()
    .from(providerConnections)
    .where(
      and(
        eq(providerConnections.id, account.connectionId),
        eq(providerConnections.ownerId, ownerId),
      ),
    )
    .limit(1)
  if (!connection || connection.revokedAt || !connection.secretSealed)
    throw capabilityUnavailable(
      `The ${label} connection is gone. The owner reconnects it in Settings › Connections.`,
    )
  if (connection.status !== 'connected')
    throw reauthRequired(
      `The ${label} connection needs the owner (${connection.status}). Settings › Connections.`,
    )
  return connection
}

function contextFor(
  actor: Actor,
  connection: ProviderConnectionRow,
  assetId: string | null,
  key: string,
): AdapterContext {
  return {
    connection: {
      id: connection.id,
      config: connection.config,
      secret: unseal(connection.secretSealed as string),
    },
    fetch: globalThis.fetch,
    idempotencyKey: key,
    assetUrl: async () =>
      assetId
        ? (await assetAccess(actor, { assetId, ttlSeconds: 3600 })).url
        : null,
  }
}

export type DispatchOutcome = {
  post: PublishPostRow
  intent: PublishIntentRow
  /** `verified` — live and read back; `submitted` — accepted, not read back yet; `unknown` — reconcile; `failed`. */
  result: 'verified' | 'submitted' | 'unknown' | 'failed'
  message: string
}

async function settleSubmit(
  actor: Actor,
  intentId: string,
  result:
    | { kind: 'ok'; submitted: Submitted }
    | { kind: 'unknown'; error: string }
    | { kind: 'failed'; error: string },
): Promise<{ post: PublishPostRow; intent: PublishIntentRow }> {
  return withTransaction(async (tx) => {
    const [intent] = await tx
      .select()
      .from(publishIntents)
      .where(
        and(
          eq(publishIntents.id, intentId),
          eq(publishIntents.ownerId, actor.userId),
        ),
      )
      .for('update')
    if (!intent) throw notFound('Dispatch')
    const [post] = await tx
      .select()
      .from(publishPosts)
      .where(eq(publishPosts.id, intent.postId))
      .for('update')
    if (!post) throw notFound('Post')
    let savedIntent: PublishIntentRow
    let savedPost = post
    if (result.kind === 'ok') {
      const { submitted } = result
      const verified =
        submitted.verified &&
        Boolean(submitted.remotePostId || submitted.remoteUrl)
      savedIntent = returned(
        (
          await tx
            .update(publishIntents)
            .set({
              status: verified ? 'verified' : 'submitted',
              remotePostId: submitted.remotePostId,
              remoteUrl: submitted.remoteUrl,
              remotePublishedAt: submitted.publishedAt,
              verification: submitted.fields ?? {},
              verifiedAt: verified ? sql`now()` : null,
              nextAttemptAt: verified ? null : sql`now() + interval '1 minute'`,
              error: null,
              revision: sql`${publishIntents.revision} + 1`,
              updatedAt: sql`now()`,
            })
            .where(eq(publishIntents.id, intent.id))
            .returning()
        )[0],
      )
      if (verified)
        savedPost = await savePost(tx, post, {
          status: 'verified',
          postedAt: submitted.publishedAt ?? sql`now()`,
          url: submitted.remoteUrl,
          externalId: submitted.remotePostId,
          evidenceLevel: 'provider_verified',
          statusReason: null,
        })
    } else if (result.kind === 'unknown') {
      savedIntent = returned(
        (
          await tx
            .update(publishIntents)
            .set({
              status: 'unknown',
              error: result.error,
              nextAttemptAt: sql`now() + interval '1 minute'`,
              revision: sql`${publishIntents.revision} + 1`,
              updatedAt: sql`now()`,
            })
            .where(eq(publishIntents.id, intent.id))
            .returning()
        )[0],
      )
    } else {
      savedIntent = returned(
        (
          await tx
            .update(publishIntents)
            .set({
              status: 'failed',
              error: result.error,
              nextAttemptAt: null,
              revision: sql`${publishIntents.revision} + 1`,
              updatedAt: sql`now()`,
            })
            .where(eq(publishIntents.id, intent.id))
            .returning()
        )[0],
      )
      savedPost = await savePost(tx, post, {
        status: 'failed',
        statusReason: result.error,
      })
    }
    await audit(tx, actor, {
      projectId: post.projectId,
      action: `publish.dispatch.${savedIntent.status}`,
      targetType: 'post',
      targetId: post.id,
      beforeRevision: post.revision,
      afterRevision: savedPost.revision,
      changes: {
        intent: savedIntent.id,
        remotePostId: savedIntent.remotePostId,
        error: savedIntent.error,
      },
    })
    return { post: savedPost, intent: savedIntent }
  })
}

/**
 * Send a cleared post through its platform's API, now. The clearance is used
 * up in the same commit that records the dispatch, then the adapter is
 * called outside any transaction. An answer that never comes back leaves the
 * dispatch `unknown` for the reconcile to settle — it is never sent again.
 */
export async function dispatchPost(
  actor: Actor,
  raw: { postId: string; idempotencyKey: string },
): Promise<DispatchOutcome> {
  const input = parseInput(
    z.object({ postId: recordId('Post'), idempotencyKey }),
    raw,
  )
  // Refuse early, in words, when there is no way to send it.
  const { account } = await withReader(async (db) => {
    const found = await ownedRecord<PublishPostRow>(
      db,
      actor,
      publishPosts,
      input.postId,
      'publish',
      'read',
      'Post',
    )
    return postParts(db, actor.userId, found.row.id)
  })
  if (!publishAdapter(account.platform))
    throw capabilityUnavailable(
      `HQ can’t post to ${PLATFORM_RULES[account.platform].label} by itself yet. Post it by hand and record it (publish_record_manual).`,
    )
  const outcome = await runOperation(
    actor,
    {
      operation: 'publish_dispatch',
      key: input.idempotencyKey,
      request: { postId: input.postId },
    },
    async () => {
      const started = await withTransaction(async (tx) => {
        const { post, project, policy } = await postForWrite(
          tx,
          actor,
          input.postId,
          'operate',
          'publish',
        )
        if (post.status !== 'scheduled')
          throw invalid(
            post.status === 'planned'
              ? 'The owner hasn’t cleared this post yet.'
              : `This post is ${post.status}.`,
          )
        const now = await dbNow(tx)
        if (post.scheduledFor && post.scheduledFor.getTime() > now.getTime())
          throw invalid(
            `It is scheduled for ${post.scheduledFor.toISOString()}; send it then.`,
          )
        const parts = await postParts(tx, actor.userId, post.id)
        assertAccountAllowed(policy, parts.account)
        const connection = await connectionFor(tx, actor.userId, parts.account)
        const clearance = (
          await liveClearances(tx, actor.userId, [post.id])
        ).get(post.id)
        if (!clearance)
          throw policyBlocked(
            'This post’s clearance expired or was taken back. Clear it again.',
            {
              blockers: [{ key: 'not_cleared', message: 'No live clearance.' }],
            },
          )
        const payload = payloadOf(parts.post, parts.account, parts.asset)
        const payloadHash = hashPayload(payload)
        await consumeAuthorization(tx, actor, {
          authorizationId: clearance.id,
          payloadHash,
          assetSha256: parts.asset ? assetBinding(parts.asset) : undefined,
          targetRef: parts.account.id,
        })
        const [row] = await tx
          .insert(publishIntents)
          .values({
            ownerId: actor.userId,
            createdBy: actor.userId,
            projectId: project.id,
            postId: post.id,
            accountId: parts.account.id,
            authorizationId: clearance.id,
            payloadHash,
            idempotencyKey: input.idempotencyKey,
            platform: parts.account.platform,
            attempts: 1,
            submittedAt: sql`now()`,
            actorType: actor.type,
            actorId: actor.id,
          })
          .returning()
        const intent = returned(row)
        await savePost(tx, post, { status: 'dispatched', statusReason: null })
        await audit(tx, actor, {
          projectId: project.id,
          action: 'publish.dispatch.submit',
          targetType: 'post',
          targetId: post.id,
          changes: { intent: intent.id, platform: intent.platform },
        })
        return { intent, payload, connection, assetId: parts.asset?.id ?? null }
      })
      const adapter = publishAdapter(started.payload.platform)
      if (!adapter)
        return settleSubmit(actor, started.intent.id, {
          kind: 'failed',
          error: 'The platform adapter went away before the call.',
        }).then((settled) => ({ ...settled, result: 'failed' as const }))
      let result: Parameters<typeof settleSubmit>[2]
      try {
        const submitted = await adapter.submit(
          started.payload,
          contextFor(
            actor,
            started.connection,
            started.assetId,
            input.idempotencyKey,
          ),
        )
        result = { kind: 'ok', submitted }
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'The platform didn’t answer.'
        result =
          error instanceof RemoteRejected || error instanceof RemoteReauth
            ? { kind: 'failed', error: message }
            : error instanceof RemoteUnknown
              ? { kind: 'unknown', error: message }
              : { kind: 'unknown', error: message }
      }
      const settled = await settleSubmit(actor, started.intent.id, result)
      return {
        ...settled,
        result: settled.intent.status as DispatchOutcome['result'],
      }
    },
  )
  if (outcome.kind === 'replay') {
    const detail = await getPost(actor, input.postId)
    const intent = detail.intents.find(
      (row) => row.idempotencyKey === input.idempotencyKey,
    )
    if (!intent) throw conflict()
    return {
      post: detail.post,
      intent,
      result: intent.status as DispatchOutcome['result'],
      message: 'Already sent with this key.',
    }
  }
  const value = outcome.value
  await outcome.complete({ post_id: value.post.id, intent_id: value.intent.id })
  const messages: Record<DispatchOutcome['result'], string> = {
    verified: 'It is live, and the platform read it back.',
    submitted:
      'The platform accepted it; HQ reads it back before calling it verified.',
    unknown:
      'The platform didn’t answer in time. HQ reads it back to see if it landed — it won’t send it again.',
    failed: `It didn’t go out: ${value.intent.error ?? 'refused'}.`,
  }
  return {
    post: value.post,
    intent: value.intent,
    result: value.result,
    message: messages[value.result],
  }
}

/**
 * The ops tick's share of Publish: read back dispatches that are submitted or
 * unknown and due, and return scheduled posts whose clearance lapsed to
 * planned. Small batches, so a tick stays inside its time.
 */
export async function reconcilePublishing(
  options: { ownerId?: string; limit?: number } = {},
): Promise<{
  checked: number
  verified: number
  failed: number
  lapsed: number
}> {
  const limit = options.limit ?? 20
  const tally = { checked: 0, verified: 0, failed: 0, lapsed: 0 }
  // Scheduled without a live clearance: back to planned, saying why.
  const lapsed = await withReader((db) =>
    db
      .select({ id: publishPosts.id, ownerId: publishPosts.ownerId })
      .from(publishPosts)
      .where(
        and(
          options.ownerId
            ? eq(publishPosts.ownerId, options.ownerId)
            : undefined,
          eq(publishPosts.status, 'scheduled'),
          sql`not exists (select 1 from ${opsReleaseAuthorizations} a where a.subject_id = ${publishPosts.id} and a.module = 'publish' and a.status = 'active' and a.expires_at > now())`,
        ),
      )
      .limit(limit),
  )
  for (const row of lapsed) {
    const actor = schedulerActor(row.ownerId)
    await withTransaction(async (tx) => {
      const [post] = await tx
        .select()
        .from(publishPosts)
        .where(
          and(
            eq(publishPosts.id, row.id),
            eq(publishPosts.status, 'scheduled'),
          ),
        )
        .for('update')
      if (!post) return
      const saved = await savePost(tx, post, {
        status: 'planned',
        statusReason:
          'Its clearance expired before it went out — clear it again.',
      })
      await audit(tx, actor, {
        projectId: post.projectId,
        action: 'publish.post.lapse',
        targetType: 'post',
        targetId: post.id,
        beforeRevision: post.revision,
        afterRevision: saved.revision,
      })
    })
    tally.lapsed++
  }
  const due = await withReader((db) =>
    db
      .select()
      .from(publishIntents)
      .where(
        and(
          options.ownerId
            ? eq(publishIntents.ownerId, options.ownerId)
            : undefined,
          inArray(publishIntents.status, ['submitted', 'unknown']),
          sql`coalesce(${publishIntents.nextAttemptAt}, now()) <= now()`,
        ),
      )
      .orderBy(asc(publishIntents.nextAttemptAt))
      .limit(limit),
  )
  for (const intent of due) {
    const adapter = publishAdapter(intent.platform)
    if (!adapter) continue
    const actor = schedulerActor(intent.ownerId)
    tally.checked++
    try {
      const parts = await withReader((db) =>
        postParts(db, intent.ownerId, intent.postId),
      )
      const connection = await withReader((db) =>
        connectionFor(db, intent.ownerId, parts.account),
      )
      const payload = payloadOf(parts.post, parts.account, parts.asset)
      const found = await adapter.lookup(
        {
          remotePostId: intent.remotePostId,
          idempotencyKey: intent.idempotencyKey,
        },
        payload,
        {
          connection: {
            id: connection.id,
            config: connection.config,
            secret: unseal(connection.secretSealed as string),
          },
          fetch: globalThis.fetch,
          idempotencyKey: intent.idempotencyKey,
          assetUrl: async () => null,
        },
      )
      if (found.state === 'found') {
        await settleSubmit(actor, intent.id, {
          kind: 'ok',
          submitted: {
            remotePostId: found.remotePostId,
            remoteUrl: found.remoteUrl,
            publishedAt: found.publishedAt,
            verified: true,
            fields: found.fields,
          },
        })
        tally.verified++
      } else if (found.state === 'missing') {
        await settleSubmit(actor, intent.id, {
          kind: 'failed',
          error: `The platform has no such post: ${found.reason}`,
        })
        tally.failed++
      } else {
        await withTransaction(async (tx) => {
          await tx
            .update(publishIntents)
            .set({
              attempts: sql`${publishIntents.attempts} + 1`,
              nextAttemptAt: sql`now() + least(interval '1 hour', interval '1 minute' * power(2, ${publishIntents.attempts}))`,
              updatedAt: sql`now()`,
            })
            .where(eq(publishIntents.id, intent.id))
        })
      }
    } catch (error) {
      console.error('[publish] reconcile', intent.id, error)
      await withTransaction(async (tx) => {
        await tx
          .update(publishIntents)
          .set({
            attempts: sql`${publishIntents.attempts} + 1`,
            nextAttemptAt: sql`now() + interval '15 minutes'`,
            error:
              error instanceof Error ? error.message.slice(0, 500) : 'failed',
            updatedAt: sql`now()`,
          })
          .where(eq(publishIntents.id, intent.id))
      })
    }
  }
  return tally
}

/* ── Home ───────────────────────────────────────────────────────────── */

export type PublishSummary = {
  projectId: string
  planned: number
  scheduled: number
  /** Dispatched and not read back yet. */
  inFlight: number
  /** Went out in the last 7 days. */
  posted7d: number
  /** Scheduled for today in the project's zone. */
  dueToday: number
}

/** One row per project with Publish records, for Home's cells. */
export async function publishSummaries(
  actor: Actor,
): Promise<PublishSummary[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'publish', 'read')
    const rows = await db
      .select({
        projectId: publishPosts.projectId,
        planned: sql<number>`count(*) filter (where ${publishPosts.status} = 'planned')::int`,
        scheduled: sql<number>`count(*) filter (where ${publishPosts.status} = 'scheduled')::int`,
        inFlight: sql<number>`count(*) filter (where ${publishPosts.status} = 'dispatched')::int`,
        posted7d: sql<number>`count(*) filter (where ${publishPosts.status} in ('posted', 'verified') and ${publishPosts.postedAt} >= now() - interval '7 days')::int`,
        dueToday: sql<number>`count(*) filter (where ${publishPosts.status} = 'scheduled' and (${publishPosts.scheduledFor} at time zone ${projects.timezone})::date = (now() at time zone ${projects.timezone})::date)::int`,
      })
      .from(publishPosts)
      .innerJoin(projects, eq(projects.id, publishPosts.projectId))
      .where(eq(publishPosts.ownerId, actor.userId))
      .groupBy(publishPosts.projectId)
    return rows
  })
}

/** Whether the actor may clear posts (for a page to draw its red button or not). */
export const mayClear = (actor: Actor): boolean =>
  actor.type === 'user' && can(actor, 'publish', 'decide')

export { POST_OUT }
