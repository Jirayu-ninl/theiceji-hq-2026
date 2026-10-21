import {
  PUBLISH_EVIDENCE_LEVELS,
  PUBLISH_POST_STATUSES,
} from '@theiceji/hq-db/enums'
import type { PublishPostRow } from '@theiceji/hq-db/schema'
import { invalid, policyBlocked } from '@theiceji/hq-ops/errors'
import {
  authorizePost,
  dispatchPost,
  getPost,
  listAccounts,
  listPosts,
  type PostListItem,
  planPost,
  recordManualPost,
  unschedulePost,
  updatePost,
} from '@theiceji/hq-publish/publish'
import { recordReading } from '@theiceji/hq-publish/readings'
import '@theiceji/hq-publish/register'
import { z } from 'zod'
import { defineTool, defineWorkspace } from '../../kernel'
import {
  defined,
  expectedRevisionArg,
  idArg,
  idempotencyKeyArg,
  projectIdArg,
  READ,
  readTool,
  WRITE,
  writeTool,
} from '../support'

/**
 * `publish` — a channel's posts: read them, plan and change
 * them, send a cleared one through its platform, record one posted by hand,
 * record readings, take a clearance back. Clearing a post is the owner's —
 * unless the owner's policy releases by itself (`release_by_policy`).
 * Nothing leaves HQ without a clearance of exactly that payload.
 */

function postOut(post: PublishPostRow | PostListItem) {
  return {
    id: post.id,
    project_id: post.projectId,
    account_id: post.accountId,
    ...('account' in post
      ? { platform: post.account.platform, handle: post.account.handle }
      : {}),
    asset_id: post.assetId,
    title: post.title,
    caption: post.caption,
    disclosure: post.disclosure,
    status: post.status,
    status_reason: post.statusReason,
    scheduled_for: post.scheduledFor,
    posted_at: post.postedAt,
    url: post.url,
    external_id: post.externalId,
    evidence_level: post.evidenceLevel,
    ...('clearance' in post
      ? {
          cleared: Boolean(post.clearance),
          clearance_expires_at: post.clearance?.expiresAt ?? null,
          readings: Object.fromEntries(
            Object.entries(post.latest).map(([metric, reading]) => [
              metric,
              { value: reading.value, as_of: reading.asOf },
            ]),
          ),
        }
      : {}),
    revision: post.revision,
    updated_at: post.updatedAt,
  }
}

export const listPostsTool = defineTool({
  name: 'list_posts',
  title: 'List posts',
  description:
    'Posts newest first — one project’s (with its accounts and how each gets posts out), or every project with Publish on — with status, clearance and current readings. With post_id: that post in full (what blocks it, its dispatches, every reading).',
  scope: 'publish:read',
  input: z.object({
    project_id: projectIdArg.optional(),
    post_id: idArg('Post').optional(),
    account_id: idArg('Account').optional(),
    status: z.array(z.enum(PUBLISH_POST_STATUSES)).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      async (actor) => {
        if (args.post_id)
          return {
            kind: 'detail' as const,
            detail: await getPost(actor, args.post_id),
          }
        const [accounts, posts] = await Promise.all([
          args.project_id
            ? listAccounts(actor, { projectId: args.project_id })
            : Promise.resolve(null),
          listPosts(actor, {
            projectId: args.project_id,
            accountId: args.account_id,
            status: args.status,
            limit: args.limit,
          }),
        ])
        return { kind: 'list' as const, accounts, posts }
      },
      (value) => {
        if (value.kind === 'detail') {
          const { detail } = value
          return {
            text: `“${detail.post.title ?? detail.post.caption.slice(0, 60)}” is ${detail.post.status}${detail.clearance ? ', cleared' : ''}${detail.blockers.length ? `; blocked by: ${detail.blockers.map((entry) => entry.message).join(' ')}` : ''}.`,
            data: {
              post: postOut(detail.post),
              account: {
                id: detail.account.id,
                platform: detail.account.platform,
                handle: detail.account.handle,
                readiness: detail.account.readiness,
              },
              cleared: Boolean(detail.clearance),
              clearance_expires_at: detail.clearance?.expiresAt ?? null,
              payload_hash: detail.payloadHash,
              blockers: detail.blockers,
              dispatches: detail.intents.map((intent) => ({
                id: intent.id,
                status: intent.status,
                remote_post_id: intent.remotePostId,
                error: intent.error,
                submitted_at: intent.submittedAt,
              })),
              readings: detail.readings.map((reading) => ({
                id: reading.id,
                metric: reading.metric,
                value: reading.value,
                currency: reading.currency,
                window: reading.window,
                as_of: reading.asOf,
                window_start: reading.windowStart,
                window_end: reading.windowEnd,
                source: reading.source,
                superseded_by: reading.supersededBy,
              })),
            },
          }
        }
        return {
          text: `${value.posts.length} post(s)${value.accounts ? ` on ${value.accounts.length} account(s)` : ''}.`,
          data: {
            accounts:
              value.accounts?.map((account) => ({
                id: account.id,
                platform: account.platform,
                handle: account.handle,
                readiness: account.readiness,
                archived: Boolean(account.archivedAt),
              })) ?? null,
            posts: value.posts.map(postOut),
          },
        }
      },
    ),
})

const disclosureArg = z
  .object({
    ai_generated: z.boolean().optional(),
    affiliate: z.boolean().optional(),
    text: z.string().max(300).optional(),
  })
  .optional()
  .describe(
    'What the post discloses. A generated file carries the AI disclosure unless you turn it off.',
  )

export const preparePostTool = defineTool({
  name: 'prepare',
  title: 'Plan or change a post',
  description:
    'Without post_id: plan a new post on one of the project’s accounts (a file from Assets, a title where the platform has one, the caption, the disclosure, when it should go out). With post_id: change a post that hasn’t gone out — a change to what it sends takes its clearance back. Needs your policy to allow drafting. Nothing is posted.',
  scope: 'publish:write',
  input: z.object({
    project_id: projectIdArg.optional(),
    post_id: idArg('Post').optional(),
    expected_revision: expectedRevisionArg.optional(),
    account_id: idArg('Account').optional(),
    asset_id: idArg('Asset').nullable().optional(),
    title: z.string().max(200).nullable().optional(),
    caption: z.string().max(5000).optional(),
    disclosure: disclosureArg,
    scheduled_for: z
      .string()
      .max(40)
      .nullable()
      .optional()
      .describe('ISO time, or YYYY-MM-DDTHH:mm in the project’s timezone.'),
    from_card_id: idArg('Card')
      .optional()
      .describe(
        'The board card it comes from; linked card —published_as→ post.',
      ),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        const disclosure = args.disclosure
          ? defined({
              aiGenerated: args.disclosure.ai_generated,
              affiliate: args.disclosure.affiliate,
              text: args.disclosure.text,
            })
          : undefined
        if (args.post_id) {
          if (!args.expected_revision)
            throw invalid('Pass expected_revision to change a post.')
          return updatePost(
            actor,
            defined({
              postId: args.post_id,
              expectedRevision: args.expected_revision,
              accountId: args.account_id,
              assetId: args.asset_id,
              title: args.title,
              caption: args.caption,
              disclosure,
              scheduledFor: args.scheduled_for,
              idempotencyKey: args.idempotency_key,
            }) as Parameters<typeof updatePost>[1],
          )
        }
        return planPost(
          actor,
          defined({
            projectId: args.project_id,
            accountId: args.account_id,
            assetId: args.asset_id,
            title: args.title,
            caption: args.caption,
            disclosure,
            scheduledFor: args.scheduled_for,
            fromCardId: args.from_card_id,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof planPost>[1],
        )
      },
      (post) => ({
        text: `“${post.title ?? post.caption.slice(0, 60)}” is ${post.status} (revision ${post.revision}).${post.statusReason ? ` ${post.statusReason}` : ''}`,
        data: {
          target: { type: 'post', id: post.id, revision: post.revision },
          post: postOut(post),
        },
      }),
    ),
})

/** A clearance by the owner's policy, when asked — or its blockers as a refusal. */
async function clearByPolicy(
  actor: Parameters<typeof authorizePost>[0],
  postId: string,
): Promise<void> {
  const detail = await getPost(actor, postId)
  if (detail.clearance) return
  const outcome = await authorizePost(actor, {
    postId,
    mode: 'policy_gated',
  })
  if (!outcome.authorization)
    throw policyBlocked(
      `The policy can’t clear this post: ${outcome.blockers.map((entry) => entry.message).join(' ')}`,
      { blockers: outcome.blockers },
    )
}

const releaseArg = z
  .boolean()
  .optional()
  .describe(
    'If the post isn’t cleared yet, ask the owner’s policy to clear it (it must release by itself and allow authorize_release; needs ops:decide). Otherwise the owner clears it in HQ.',
  )

export const dispatchPostTool = defineTool({
  name: 'dispatch',
  title: 'Send a cleared post',
  description:
    'Send a cleared post through its platform’s API now, using the clearance up. Only where HQ has an adapter and the account a connection — otherwise capability_unavailable: post it by hand and use publish_record_manual. A send whose answer never came back is unknown and is read back later — never send twice.',
  scope: 'publish:operate',
  input: z.object({
    post_id: idArg('Post'),
    release_by_policy: releaseArg,
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: { ...WRITE, openWorldHint: true },
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        if (args.release_by_policy) await clearByPolicy(actor, args.post_id)
        return dispatchPost(actor, {
          postId: args.post_id,
          idempotencyKey: args.idempotency_key,
        })
      },
      (outcome) => ({
        text: outcome.message,
        data: {
          result: outcome.result,
          target: {
            type: 'post',
            id: outcome.post.id,
            revision: outcome.post.revision,
          },
          post: postOut(outcome.post),
          dispatch: {
            id: outcome.intent.id,
            status: outcome.intent.status,
            remote_post_id: outcome.intent.remotePostId,
            error: outcome.intent.error,
          },
        },
      }),
    ),
})

export const recordManualTool = defineTool({
  name: 'record_manual',
  title: 'Record a post made by hand',
  description:
    'A post that went out by hand, on the record: its URL or post ID, when, and how you know. You may record one only under a live clearance of exactly this payload, which you use up — your evidence is agent_attested unless you have a screenshot or export.',
  scope: 'publish:operate',
  input: z.object({
    post_id: idArg('Post'),
    expected_revision: expectedRevisionArg.optional(),
    url: z.string().url().max(600).optional(),
    external_id: z.string().max(200).optional(),
    posted_at: z
      .string()
      .max(40)
      .optional()
      .describe('When it went out; now when absent.'),
    evidence_level: z.enum(PUBLISH_EVIDENCE_LEVELS).optional(),
    evidence_note: z.string().max(1000).optional(),
    release_by_policy: releaseArg,
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      async (actor) => {
        if (args.release_by_policy) await clearByPolicy(actor, args.post_id)
        return recordManualPost(
          actor,
          defined({
            postId: args.post_id,
            expectedRevision: args.expected_revision,
            url: args.url,
            externalId: args.external_id,
            postedAt: args.posted_at,
            evidenceLevel: args.evidence_level,
            evidenceNote: args.evidence_note,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof recordManualPost>[1],
        )
      },
      (post) => ({
        text: `On the record: posted ${post.postedAt?.toISOString()} (${post.evidenceLevel}).`,
        data: {
          target: { type: 'post', id: post.id, revision: post.revision },
          post: postOut(post),
        },
      }),
    ),
})

export const recordReadingTool = defineTool({
  name: 'record_reading',
  title: 'Record a reading',
  description:
    'One number about a post (or an account): a lifetime counter as of a moment (views, likes, watch_seconds …), or a span — money is always a span with a currency. Readings are append-only: to fix one, pass supersedes_id and correction_reason. Needs your policy to allow importing.',
  scope: 'publish:write',
  input: z.object({
    post_id: idArg('Post').optional(),
    account_id: idArg('Account').optional(),
    metric: z
      .string()
      .max(40)
      .describe(
        'lowercase_snake: views, likes, comments, shares, saves, watch_seconds, followers, clicks, earnings.',
      ),
    value: z.union([z.string().max(40), z.number()]),
    currency: z.string().length(3).optional(),
    as_of: z.string().max(40).optional(),
    window_start: z.string().max(40).optional(),
    window_end: z.string().max(40).optional(),
    source: z.enum(['manual', 'agent', 'provider', 'import']).optional(),
    note: z.string().max(1000).optional(),
    supersedes_id: idArg('Reading').optional(),
    correction_reason: z.string().max(1000).optional(),
    idempotency_key: idempotencyKeyArg,
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        recordReading(
          actor,
          defined({
            postId: args.post_id,
            accountId: args.account_id,
            metric: args.metric,
            value: args.value,
            currency: args.currency,
            asOf: args.as_of,
            windowStart: args.window_start,
            windowEnd: args.window_end,
            source: args.source,
            note: args.note,
            supersedesId: args.supersedes_id,
            correctionReason: args.correction_reason,
            idempotencyKey: args.idempotency_key,
          }) as Parameters<typeof recordReading>[1],
        ),
      (reading) => ({
        text: `Recorded ${reading.metric} = ${reading.value}${reading.currency ? ` ${reading.currency}` : ''}${reading.supersedesId ? ' (a correction)' : ''}.`,
        data: {
          target: { type: 'reading', id: reading.id },
          reading: {
            id: reading.id,
            metric: reading.metric,
            value: reading.value,
            currency: reading.currency,
            window: reading.window,
            as_of: reading.asOf,
            window_start: reading.windowStart,
            window_end: reading.windowEnd,
            supersedes_id: reading.supersedesId,
          },
        },
      }),
    ),
})

export const cancelPostTool = defineTool({
  name: 'cancel',
  title: 'Take a clearance back',
  description:
    'Take a scheduled post’s clearance back before it goes out; it returns to planned, saying why. A post that is out stays on the record.',
  scope: 'publish:write',
  input: z.object({
    post_id: idArg('Post'),
    expected_revision: expectedRevisionArg,
    reason: z.string().max(500).optional(),
  }),
  annotations: WRITE,
  run: (args, context) =>
    writeTool(
      context,
      (actor) =>
        unschedulePost(
          actor,
          defined({
            postId: args.post_id,
            expectedRevision: args.expected_revision,
            reason: args.reason,
          }) as Parameters<typeof unschedulePost>[1],
        ),
      (post) => ({
        text: `Back to planned (revision ${post.revision}).`,
        data: {
          target: { type: 'post', id: post.id, revision: post.revision },
          post: postOut(post),
        },
      }),
    ),
})

export const publish = defineWorkspace({
  id: 'publish',
  label: 'Publish',
  description:
    'A channel’s posts from a plan to a post that is out, with evidence and readings.',
  instructions:
    'Read with publish_list_posts. Plan with publish_prepare; the owner clears a post in HQ (or their policy does, with release_by_policy). A cleared post goes out through publish_dispatch where HQ has an adapter, or by hand and then publish_record_manual. Record numbers with publish_record_reading; compare posts at the same age with readings_query.',
  tools: [
    listPostsTool,
    preparePostTool,
    dispatchPostTool,
    recordManualTool,
    recordReadingTool,
    cancelPostTool,
  ],
})
