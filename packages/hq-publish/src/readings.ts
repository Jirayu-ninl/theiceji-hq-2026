import { READING_SOURCES, type ReadingSource } from '@theiceji/hq-db/enums'
import {
  type PublishAccountRow,
  type PublishPostRow,
  type PublishReadingRow,
  publishAccounts,
  publishPosts,
  publishReadings,
} from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import { dbNow, type Reader } from '@theiceji/hq-ops/db'
import { conflict, invalid, notFound } from '@theiceji/hq-ops/errors'
import {
  idempotencyKey,
  optionalChoice,
  optionalRecordId,
  parseInput,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  assertModuleOn,
  audit,
  ownedRecord,
  returned,
  runOperation,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { parseInstant } from '@theiceji/hq-ops/time'
import { and, desc, eq, gt, inArray, lt, sql } from 'drizzle-orm'
import { z } from 'zod'

/**
 * Readings (`publish_readings`): numbers about a post or an
 * account, append-only.
 *
 * · A **lifetime** reading is a counter as of a moment — views at 72 hours.
 *   It is never added to another one.
 * · An **interval** reading is what happened over a span — earnings for a
 *   week. Money is always an interval, with a currency; two current spans of
 *   the same money on the same post may not overlap, so a week is counted
 *   once.
 * · **A correction is a new row** naming the one it supersedes and why. The
 *   current reading is the one nothing supersedes.
 * · A post's readings start when it went out: a reading of a plan, or from
 *   before the post existed, is refused.
 */

export type LatestReading = {
  readingId: string
  value: string
  asOf: Date
  source: ReadingSource
}

/** Metric names a dashboard knows to draw; any lowercase snake name is accepted. */
export const KNOWN_METRICS = [
  'views',
  'likes',
  'comments',
  'shares',
  'saves',
  'watch_seconds',
  'followers',
  'clicks',
  'earnings',
] as const

const METRIC = /^[a-z][a-z0-9_]{0,39}$/
const DECIMAL = /^-?\d{1,15}(\.\d{1,4})?$/

/** A reading that nothing corrected. */
export function isCurrent() {
  return sql`not exists (select 1 from publish_readings successor where successor.supersedes_id = ${publishReadings.id})`
}

/**
 * Current lifetime readings of some posts (or accounts), the newest per
 * metric: `Map<subjectId, { metric: reading }>`.
 */
export async function currentReadings(
  reader: Reader,
  ownerId: string,
  subjects: { postIds?: readonly string[]; accountIds?: readonly string[] },
): Promise<Map<string, Record<string, LatestReading>>> {
  const out = new Map<string, Record<string, LatestReading>>()
  const postIds = [...(subjects.postIds ?? [])]
  const accountIds = [...(subjects.accountIds ?? [])]
  if (postIds.length === 0 && accountIds.length === 0) return out
  const rows = await reader
    .selectDistinctOn(
      [
        sql`coalesce(${publishReadings.postId}, ${publishReadings.accountId})`,
        publishReadings.metric,
      ],
      {
        id: publishReadings.id,
        postId: publishReadings.postId,
        accountId: publishReadings.accountId,
        metric: publishReadings.metric,
        value: publishReadings.value,
        asOf: publishReadings.asOf,
        source: publishReadings.source,
      },
    )
    .from(publishReadings)
    .where(
      and(
        eq(publishReadings.ownerId, ownerId),
        eq(publishReadings.window, 'lifetime'),
        postIds.length && accountIds.length
          ? sql`(${inArray(publishReadings.postId, postIds)} or ${inArray(publishReadings.accountId, accountIds)})`
          : postIds.length
            ? inArray(publishReadings.postId, postIds)
            : inArray(publishReadings.accountId, accountIds),
        isCurrent(),
      ),
    )
    .orderBy(
      sql`coalesce(${publishReadings.postId}, ${publishReadings.accountId})`,
      publishReadings.metric,
      desc(publishReadings.asOf),
      desc(publishReadings.observedAt),
    )
  for (const row of rows) {
    const key = (row.postId ?? row.accountId) as string
    const entry = out.get(key) ?? {}
    entry[row.metric] = {
      readingId: row.id,
      value: row.value,
      asOf: row.asOf as Date,
      source: row.source,
    }
    out.set(key, entry)
  }
  return out
}

const recordSchema = z.object({
  postId: optionalRecordId('Post'),
  accountId: optionalRecordId('Account'),
  metric: z
    .string({ error: 'Name the metric.' })
    .trim()
    .toLowerCase()
    .regex(METRIC, 'A metric is a lowercase name like views or watch_seconds.'),
  value: z.union([z.string().max(40), z.number()]),
  currency: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like THB.')
    .optional(),
  /** A lifetime counter's moment (defaults to now). */
  asOf: z.union([z.string().max(40), z.date()]).optional(),
  /** An interval's span; both or neither. */
  windowStart: z.union([z.string().max(40), z.date()]).optional(),
  windowEnd: z.union([z.string().max(40), z.date()]).optional(),
  source: optionalChoice(READING_SOURCES, 'Say where the number came from.'),
  note: text.optional('Note', 1000),
  supersedesId: optionalRecordId('Reading'),
  correctionReason: text.optional('Correction reason', 1000),
  idempotencyKey: idempotencyKey.optional(),
})

export type RecordReadingInput = z.input<typeof recordSchema>

function instantOf(
  raw: string | Date | undefined,
  timeZone: string,
  label: string,
): Date | undefined {
  if (raw === undefined) return undefined
  if (raw instanceof Date) return raw
  const parsed = parseInstant(raw, timeZone)
  if (!parsed) throw invalid(`${label} must be a date and time.`)
  return parsed
}

/**
 * Put one number on the record. An agent needs the owner's policy to allow
 * importing; a correction must name the reading it replaces and why.
 */
export async function recordReading(
  actor: Actor,
  raw: RecordReadingInput,
): Promise<PublishReadingRow> {
  const input = parseInput(recordSchema, raw)
  if (Boolean(input.postId) === Boolean(input.accountId))
    throw invalid('A reading is about one post or one account.', {
      postId: 'Choose the post (or the account) it is about.',
    })
  const value = String(input.value).replace(/[,\s]/g, '')
  if (!DECIMAL.test(value))
    throw invalid('The value must be a number, like 1250 or 3.75.', {
      value: 'Enter a number.',
    })
  if (!input.currency && value.startsWith('-'))
    throw invalid('A count can’t be negative.', { value: 'Enter 0 or more.' })
  if (input.supersedesId && !input.correctionReason)
    throw invalid('Say why the reading is corrected.', {
      correctionReason: 'Why is the old number wrong?',
    })
  const outcome = await runOperation(
    actor,
    {
      operation: 'publish_record_reading',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        let post: PublishPostRow | null = null
        let account: PublishAccountRow | null = null
        const found = input.postId
          ? await ownedRecord<PublishPostRow>(
              tx,
              actor,
              publishPosts,
              input.postId,
              'publish',
              'write',
              'Post',
              'import',
            )
          : await ownedRecord<PublishAccountRow>(
              tx,
              actor,
              publishAccounts,
              input.accountId as string,
              'publish',
              'write',
              'Account',
              'import',
            )
        const project = found.project
        if (!project) throw notFound(input.postId ? 'Post' : 'Account')
        assertModuleOn(project, 'publish')
        if (input.postId) post = found.row as PublishPostRow
        else account = found.row as PublishAccountRow
        if (post && !post.postedAt)
          throw invalid(
            'This post hasn’t gone out, so it has no readings yet. Record it as posted first.',
          )
        const now = await dbNow(tx)
        const start = instantOf(input.windowStart, project.timezone, 'Start')
        const end = instantOf(input.windowEnd, project.timezone, 'End')
        const interval = Boolean(start || end)
        if (interval && !(start && end))
          throw invalid('An interval needs a start and an end.')
        if (input.currency && !interval)
          throw invalid(
            'Money is a span — give the start and end it was earned in.',
            { windowStart: 'When does the span start?' },
          )
        const asOf = interval
          ? null
          : (instantOf(input.asOf, project.timezone, 'As of') ?? now)
        const latest = end ?? asOf ?? now
        if (latest.getTime() > now.getTime() + 60_000)
          throw invalid('A reading can’t be from the future.')
        if (start && end && end.getTime() <= start.getTime())
          throw invalid('The span must end after it starts.')
        if (post?.postedAt) {
          const opened = post.postedAt.getTime() - 5 * 60_000
          if ((start ?? asOf ?? now).getTime() < opened)
            throw invalid('The reading is from before the post went out.')
        }
        let supersedes: PublishReadingRow | null = null
        if (input.supersedesId) {
          const [old] = await tx
            .select()
            .from(publishReadings)
            .where(
              and(
                eq(publishReadings.id, input.supersedesId),
                eq(publishReadings.ownerId, actor.userId),
              ),
            )
            .limit(1)
          if (!old) throw notFound('Reading')
          if (
            old.postId !== (post?.id ?? null) ||
            old.accountId !== (account?.id ?? null) ||
            old.metric !== input.metric
          )
            throw invalid(
              'A correction is of the same metric on the same subject.',
            )
          supersedes = old
        }
        if (interval && start && end) {
          const [overlap] = await tx
            .select({ id: publishReadings.id })
            .from(publishReadings)
            .where(
              and(
                eq(publishReadings.ownerId, actor.userId),
                post
                  ? eq(publishReadings.postId, post.id)
                  : eq(publishReadings.accountId, account?.id as string),
                eq(publishReadings.metric, input.metric),
                eq(publishReadings.window, 'interval'),
                lt(publishReadings.windowStart, end),
                gt(publishReadings.windowEnd, start),
                supersedes
                  ? sql`${publishReadings.id} <> ${supersedes.id}`
                  : undefined,
                isCurrent(),
              ),
            )
            .limit(1)
          if (overlap)
            throw conflict(
              'That span overlaps a reading already on the record — correct that one instead, so nothing is counted twice.',
            )
        }
        const [row] = await tx
          .insert(publishReadings)
          .values({
            ownerId: actor.userId,
            projectId: project.id,
            postId: post?.id ?? null,
            accountId: account?.id ?? null,
            metric: input.metric,
            value,
            currency: input.currency ?? null,
            window: interval ? 'interval' : 'lifetime',
            asOf,
            windowStart: start ?? null,
            windowEnd: end ?? null,
            source:
              input.source ?? (actor.type === 'user' ? 'manual' : 'agent'),
            note: input.note ?? null,
            supersedesId: supersedes?.id ?? null,
            correctionReason: input.correctionReason ?? null,
            actorType: actor.type,
            actorId: actor.id,
          })
          .returning()
        const reading = returned(row)
        await audit(tx, actor, {
          projectId: project.id,
          action: supersedes
            ? 'publish.reading.correct'
            : 'publish.reading.record',
          targetType: post ? 'post' : 'publish_account',
          targetId: post?.id ?? account?.id ?? null,
          reason: input.correctionReason ?? null,
          changes: {
            reading: reading.id,
            metric: reading.metric,
            value: reading.value,
            currency: reading.currency,
            window: reading.window,
            supersedes: supersedes?.id ?? null,
          },
        })
        return reading
      }),
  )
  if (outcome.kind === 'replay') {
    const id = outcome.response?.reading_id
    if (typeof id !== 'string') throw conflict()
    const row = await withReader(async (db) => {
      const [found] = await db
        .select()
        .from(publishReadings)
        .where(
          and(
            eq(publishReadings.id, id),
            eq(publishReadings.ownerId, actor.userId),
          ),
        )
      return found
    })
    if (!row) throw conflict()
    return row
  }
  await outcome.complete({ reading_id: outcome.value.id })
  return outcome.value
}
