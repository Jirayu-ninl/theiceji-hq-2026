import type { Blocker } from '@theiceji/hq-ops/release'
import type {
  AccountView,
  PostDetail,
  PostListItem,
} from '@theiceji/hq-publish/publish'
import type { LatestReading } from '@theiceji/hq-publish/readings'

/** Publish as it crosses to the page: plain JSON, dates as ISO strings. */

export type PublishProject = {
  id: string
  slug: string
  name: string
  color: string
  status: string
  timezone: string
}

export type AccountData = {
  id: string
  platform: 'facebook' | 'youtube' | 'tiktok' | 'manual'
  handle: string
  profileUrl: string | null
  externalAccountId: string | null
  connectionId: string | null
  connection: { id: string; label: string; status: string } | null
  readiness: { mode: 'api' | 'manual' | 'reconnect'; note: string }
  notes: string
  posts: number
  archived: boolean
  revision: number
}

export type ReadingValue = { value: string; asOf: string }

export type PostRowData = {
  id: string
  projectId: string
  accountId: string
  platform: AccountData['platform']
  handle: string
  title: string | null
  caption: string
  disclosure: { aiGenerated: boolean; affiliate: boolean; text?: string }
  status:
    | 'planned'
    | 'scheduled'
    | 'dispatched'
    | 'posted'
    | 'verified'
    | 'removed'
    | 'failed'
  statusReason: string | null
  scheduledFor: string | null
  postedAt: string | null
  url: string | null
  externalId: string | null
  evidenceLevel: string | null
  /** `name` is the file's (what goes out); `title` is what HQ calls it — the owner's title, else the file name. */
  asset: {
    id: string
    name: string
    title: string
    kind: string
    status: string
  } | null
  clearance: { expiresAt: string; mode: string } | null
  latest: Record<string, ReadingValue>
  revision: number
  updatedAt: string
}

export type ReadingRowData = {
  id: string
  metric: string
  value: string
  currency: string | null
  window: 'lifetime' | 'interval'
  asOf: string | null
  windowStart: string | null
  windowEnd: string | null
  source: string
  note: string | null
  supersedesId: string | null
  supersededBy: string | null
  correctionReason: string | null
}

export type PostDetailData = PostRowData & {
  blockers: Blocker[]
  intents: {
    id: string
    status: string
    remotePostId: string | null
    error: string | null
    submittedAt: string | null
  }[]
  readings: ReadingRowData[]
  links: { type: string; id: string; role: string; direction: 'from' | 'to' }[]
}

export type AssetOption = {
  id: string
  name: string
  kind: string
  origin: string
}

export type ConnectionOption = {
  id: string
  provider: string
  label: string
  status: string
}

const latestOut = (latest: Record<string, LatestReading>) =>
  Object.fromEntries(
    Object.entries(latest).map(([metric, reading]) => [
      metric,
      { value: reading.value, asOf: reading.asOf.toISOString() },
    ]),
  )

export function accountData(account: AccountView): AccountData {
  return {
    id: account.id,
    platform: account.platform,
    handle: account.handle,
    profileUrl: account.profileUrl,
    externalAccountId: account.externalAccountId,
    connectionId: account.connectionId,
    connection: account.connection,
    readiness: account.readiness,
    notes: account.notes,
    posts: account.posts,
    archived: Boolean(account.archivedAt),
    revision: account.revision,
  }
}

export function postRowData(post: PostListItem): PostRowData {
  return {
    id: post.id,
    projectId: post.projectId,
    accountId: post.accountId,
    platform: post.account.platform,
    handle: post.account.handle,
    title: post.title,
    caption: post.caption,
    disclosure: post.disclosure,
    status: post.status,
    statusReason: post.statusReason,
    scheduledFor: post.scheduledFor?.toISOString() ?? null,
    postedAt: post.postedAt?.toISOString() ?? null,
    url: post.url,
    externalId: post.externalId,
    evidenceLevel: post.evidenceLevel,
    asset: post.asset
      ? {
          id: post.asset.id,
          name: post.asset.name,
          title: post.asset.title ?? post.asset.name,
          kind: post.asset.kind,
          status: post.asset.status,
        }
      : null,
    clearance: post.clearance
      ? {
          expiresAt: post.clearance.expiresAt.toISOString(),
          mode: post.clearance.mode,
        }
      : null,
    latest: latestOut(post.latest),
    revision: post.revision,
    updatedAt: post.updatedAt.toISOString(),
  }
}

export function postDetailData(detail: PostDetail): PostDetailData {
  const { post, account } = detail
  return {
    id: post.id,
    projectId: post.projectId,
    accountId: post.accountId,
    platform: account.platform,
    handle: account.handle,
    title: post.title,
    caption: post.caption,
    disclosure: post.disclosure,
    status: post.status,
    statusReason: post.statusReason,
    scheduledFor: post.scheduledFor?.toISOString() ?? null,
    postedAt: post.postedAt?.toISOString() ?? null,
    url: post.url,
    externalId: post.externalId,
    evidenceLevel: post.evidenceLevel,
    asset: detail.asset
      ? {
          id: detail.asset.id,
          name: detail.asset.name,
          title: detail.asset.title ?? detail.asset.name,
          kind: detail.asset.kind,
          status: detail.asset.status,
        }
      : null,
    clearance: detail.clearance
      ? {
          expiresAt: detail.clearance.expiresAt.toISOString(),
          mode: detail.clearance.mode,
        }
      : null,
    latest: latestOut(detail.latest),
    revision: post.revision,
    updatedAt: post.updatedAt.toISOString(),
    blockers: detail.blockers,
    intents: detail.intents.map((intent) => ({
      id: intent.id,
      status: intent.status,
      remotePostId: intent.remotePostId,
      error: intent.error,
      submittedAt: intent.submittedAt?.toISOString() ?? null,
    })),
    readings: detail.readings.map((reading) => ({
      id: reading.id,
      metric: reading.metric,
      value: reading.value,
      currency: reading.currency,
      window: reading.window,
      asOf: reading.asOf?.toISOString() ?? null,
      windowStart: reading.windowStart?.toISOString() ?? null,
      windowEnd: reading.windowEnd?.toISOString() ?? null,
      source: reading.source,
      note: reading.note,
      supersedesId: reading.supersedesId,
      supersededBy: reading.supersededBy,
      correctionReason: reading.correctionReason,
    })),
    links: detail.refs.map((ref) =>
      ref.fromType === 'post' && ref.fromId === post.id
        ? {
            type: ref.toType,
            id: ref.toId,
            role: ref.role,
            direction: 'to' as const,
          }
        : {
            type: ref.fromType,
            id: ref.fromId,
            role: ref.role,
            direction: 'from' as const,
          },
    ),
  }
}
