import {
  PROJECT_COLOR_NAMES,
  PROJECT_KINDS,
  type ProjectStatus,
  STORAGE_PROVIDERS,
} from '@theiceji/hq-db/enums'
import { type ProjectRow, projects } from '@theiceji/hq-db/schema'
import type { Actor } from '@theiceji/hq-ops/access'
import {
  conflict,
  invalid,
  notFound,
  registerConstraintMessages,
} from '@theiceji/hq-ops/errors'
import {
  choice,
  idempotencyKey,
  optionalChoice,
  parseInput,
  recordId,
  revision,
  text,
} from '@theiceji/hq-ops/schemas'
import {
  audit,
  authorize,
  isUuid,
  ownedProject,
  type Reader,
  returned,
  runOperation,
  type Tx,
  withReader,
  withTransaction,
} from '@theiceji/hq-ops/store'
import { isValidTimeZone } from '@theiceji/hq-ops/time'
import { and, asc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { z } from 'zod'
import { nextColor } from './colors'
import {
  canDisable,
  canEnable,
  DEFAULT_MODULES,
  isModuleId,
  orderedModules,
} from './modules'

/**
 * Projects — the unit HQ is organised by. Creating, pausing,
 * archiving, turning modules on and off and choosing storage are the owner's:
 * every write here needs `manage`, which no connection can hold, so an agent
 * reads projects (`hq:read`) and never shapes them.
 *
 * A project is addressed by its slug (`/p/<slug>`), unique per owner. Its
 * `position` is the owner's order — Home gives each project a fixed angle
 * from it — so a new project goes last and nothing reorders by itself.
 *
 * Delete puts a project in the Trash: archived and marked
 * `deleted_at` in one write. Every read here but Projects › Trash leaves it
 * out — the rail, Home, pickers, `/p/<slug>`, MCP — while its records stay
 * exactly as they were, and its slug stays taken until it is restored.
 */

registerConstraintMessages({
  projects_deleted_check:
    'A project in the Trash stays archived until it is restored.',
})

/** A URL segment from a name: ASCII, lowercase, dashes. Thai names fall back to `project`. */
export function slugify(name: string): string {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48)
    .replace(/-+$/g, '')
  return base || 'project'
}

const SLUG = /^[a-z0-9]+(-[a-z0-9]+)*$/

async function freeSlug(
  reader: Reader,
  ownerId: string,
  wanted: string,
): Promise<string> {
  const taken = new Set(
    (
      await reader
        .select({ slug: projects.slug })
        .from(projects)
        .where(
          and(
            eq(projects.ownerId, ownerId),
            sql`${projects.slug} like ${`${wanted}%`}`,
          ),
        )
    ).map((row) => row.slug),
  )
  if (!taken.has(wanted)) return wanted
  for (let n = 2; n < 1000; n++) {
    const candidate = `${wanted}-${n}`
    if (!taken.has(candidate)) return candidate
  }
  throw conflict('Too many projects share that name. Choose another.')
}

const timeZone = z
  .string()
  .trim()
  .refine(isValidTimeZone, 'That isn’t a timezone HQ knows.')
  .optional()

const currency = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3}$/, 'Use a three-letter currency code, like THB.')
  .optional()

/* ── Reads ─────────────────────────────────────────────────────────── */

/**
 * The owner's projects in their order. Archived ones only when asked, and
 * the Trash only when asked as well (`includeArchived` + `includeTrash`) —
 * Projects › Trash is the one place a deleted project is listed, so the
 * rail, Home, pickers and MCP (even with archived projects) never see one.
 */
export async function listProjects(
  actor: Actor,
  options: { includeArchived?: boolean; includeTrash?: boolean } = {},
): Promise<ProjectRow[]> {
  return withReader(async (db) => {
    await authorize(db, actor, null, 'hq', 'read')
    return db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.ownerId, actor.userId),
          options.includeArchived ? undefined : ne(projects.status, 'archived'),
          options.includeTrash ? undefined : isNull(projects.deletedAt),
        ),
      )
      .orderBy(asc(projects.position), asc(projects.createdAt))
  })
}

/** One project; one in the Trash reads as not found, like `/p/<slug>`. */
export async function getProject(
  actor: Actor,
  projectId: string,
): Promise<ProjectRow> {
  return withReader(async (db) => {
    const project = await ownedProject(db, actor, projectId, 'hq', 'read')
    if (project.deletedAt) throw notFound('Project')
    return project
  })
}

/** A project by its URL segment, or `not_found` — for `/p/<slug>`. A project in the Trash isn't found. */
export async function getProjectBySlug(
  actor: Actor,
  slug: string,
): Promise<ProjectRow> {
  if (!SLUG.test(slug)) throw notFound('Project')
  return withReader(async (db) => {
    await authorize(db, actor, null, 'hq', 'read')
    const [project] = await db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.ownerId, actor.userId),
          eq(projects.slug, slug),
          isNull(projects.deletedAt),
        ),
      )
      .limit(1)
    if (!project) throw notFound('Project')
    return project
  })
}

/* ── Create ────────────────────────────────────────────────────────── */

const createSchema = z.object({
  name: text.required('Name', 120),
  kind: choice(PROJECT_KINDS, 'Choose what kind of project this is.'),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(SLUG, 'Use lowercase letters, digits and dashes.')
    .max(64)
    .optional(),
  color: optionalChoice(
    PROJECT_COLOR_NAMES as unknown as [string, ...string[]],
    'Choose one of the swatches.',
  ),
  timezone: timeZone,
  currency,
  idempotencyKey: idempotencyKey.optional(),
})

export type CreateProjectInput = z.input<typeof createSchema>

export async function createProject(
  actor: Actor,
  raw: CreateProjectInput,
): Promise<ProjectRow> {
  const input = parseInput(createSchema, raw)
  const outcome = await runOperation(
    actor,
    {
      operation: 'hq_create_project',
      key: input.idempotencyKey,
      request: { ...input, idempotencyKey: undefined },
    },
    () =>
      withTransaction(async (tx) => {
        await authorize(tx, actor, null, 'hq', 'manage')
        // One owner creates one project at a time: the slug and position
        // are read and written under the same lock.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`projects:${actor.userId}`}, 0))`,
        )
        const siblings = await tx
          .select({ color: projects.color, position: projects.position })
          .from(projects)
          .where(
            and(
              eq(projects.ownerId, actor.userId),
              ne(projects.status, 'archived'),
            ),
          )
        const [last] = await tx
          .select({
            position: sql<number>`coalesce(max(${projects.position}), -1)`,
          })
          .from(projects)
          .where(eq(projects.ownerId, actor.userId))
        const wanted = input.slug ?? slugify(input.name as string)
        // A project in the Trash keeps its address until it is restored, so
        // a new one that wants it says where the address went instead of
        // quietly taking `-2` beside a project the owner can't see.
        const [trashed] = await tx
          .select({ id: projects.id })
          .from(projects)
          .where(
            and(
              eq(projects.ownerId, actor.userId),
              eq(projects.slug, wanted),
              isNotNull(projects.deletedAt),
            ),
          )
          .limit(1)
        if (trashed)
          throw invalid(
            `A project in the Trash uses /p/${wanted}. Restore it from Projects › Trash, or give this one another name.`,
            { name: `/p/${wanted} belongs to a project in the Trash.` },
          )
        const slug = await freeSlug(tx, actor.userId, wanted)
        const [row] = await tx
          .insert(projects)
          .values({
            ownerId: actor.userId,
            createdBy: actor.userId,
            slug,
            name: input.name as string,
            kind: input.kind,
            color:
              (input.color as ProjectRow['color'] | null | undefined) ??
              nextColor(siblings.map((entry) => entry.color)),
            timezone: input.timezone ?? 'Asia/Bangkok',
            currency: input.currency ?? 'THB',
            modules: {
              enabled: [...DEFAULT_MODULES[input.kind]],
              settings: {},
            },
            position: (last?.position ?? -1) + 1,
          })
          .returning()
        const project = returned(row)
        await audit(tx, actor, {
          projectId: project.id,
          action: 'project.create',
          targetType: 'project',
          targetId: project.id,
          afterRevision: project.revision,
          changes: { name: project.name, kind: project.kind, slug },
        })
        return project
      }),
  )
  if (outcome.kind === 'replay') {
    if (!outcome.target) throw conflict()
    return getProject(actor, outcome.target.id)
  }
  await outcome.complete({ project_id: outcome.value.id })
  return outcome.value
}

/* ── Update ────────────────────────────────────────────────────────── */

/** One optimistic write: the row at `expectedRevision`, or a conflict. */
async function writeProject(
  actor: Actor,
  projectId: string,
  expectedRevision: number,
  action: string,
  change: (project: ProjectRow) => Partial<typeof projects.$inferInsert> | null,
): Promise<ProjectRow> {
  if (!isUuid(projectId)) throw notFound('Project')
  return withTransaction(async (tx) => {
    const project = await ownedProject(tx, actor, projectId, 'hq', 'manage')
    if (project.revision !== expectedRevision) throw conflict()
    const patch = change(project)
    if (!patch) return project
    const [row] = await tx
      .update(projects)
      .set({
        ...patch,
        revision: sql`${projects.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(projects.id, projectId),
          eq(projects.ownerId, actor.userId),
          eq(projects.revision, expectedRevision),
        ),
      )
      .returning()
    if (!row) throw conflict()
    await audit(tx, actor, {
      projectId,
      action,
      targetType: 'project',
      targetId: projectId,
      beforeRevision: expectedRevision,
      afterRevision: row.revision,
      changes: Object.fromEntries(
        Object.entries(patch).filter(
          ([key]) => key !== 'updatedAt' && key !== 'revision',
        ),
      ),
    })
    return row
  })
}

const updateSchema = z.object({
  projectId: recordId('Project'),
  expectedRevision: revision,
  name: text.required('Name', 120).optional(),
  color: optionalChoice(
    PROJECT_COLOR_NAMES as unknown as [string, ...string[]],
    'Choose one of the swatches.',
  ),
  timezone: timeZone,
  currency,
  storageProvider: optionalChoice(
    STORAGE_PROVIDERS,
    'Choose R2 or Google Drive.',
  ),
  storageRoot: text.optional('Folder', 300),
})

export type UpdateProjectInput = z.input<typeof updateSchema>

/** Name, colour, timezone, currency and storage. Absent fields stay as they are. */
export async function updateProject(
  actor: Actor,
  raw: UpdateProjectInput,
): Promise<ProjectRow> {
  const input = parseInput(updateSchema, raw)
  return writeProject(
    actor,
    input.projectId,
    input.expectedRevision,
    'project.update',
    () => {
      const patch: Partial<typeof projects.$inferInsert> = {}
      if (input.name) patch.name = input.name
      if (input.color) patch.color = input.color as ProjectRow['color']
      if (input.timezone) patch.timezone = input.timezone
      if (input.currency) patch.currency = input.currency
      if (input.storageProvider !== undefined)
        patch.storageProvider = input.storageProvider ?? null
      if (input.storageRoot !== undefined)
        patch.storageRoot = input.storageRoot ?? null
      return Object.keys(patch).length > 0 ? patch : null
    },
  )
}

const statusSchema = z.object({
  projectId: recordId('Project'),
  expectedRevision: revision,
  status: choice(['active', 'paused', 'archived'] as const, 'Choose a status.'),
})

/**
 * Pause, archive or restore. A paused project keeps working for the owner
 * and dims on Home; an archived one takes no changes until it is restored.
 */
export async function setProjectStatus(
  actor: Actor,
  raw: z.input<typeof statusSchema>,
): Promise<ProjectRow> {
  const input = parseInput(statusSchema, raw)
  const status = input.status as ProjectStatus
  return withTransaction(async (tx) => {
    // Restoring an archived project is the one write an archived project
    // takes, so it can't go through `ownedProject(…, 'manage')`, which
    // refuses archived projects.
    await authorize(tx, actor, null, 'hq', 'manage')
    const [project] = await tx
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.id, input.projectId),
          eq(projects.ownerId, actor.userId),
        ),
      )
      .limit(1)
    if (!project) throw notFound('Project')
    if (project.revision !== input.expectedRevision) throw conflict()
    if (project.deletedAt)
      throw invalid(
        'This project is in the Trash. Restore it first, from Projects › Trash.',
      )
    if (project.status === status) return project
    const [row] = await tx
      .update(projects)
      .set({
        status,
        archivedAt: status === 'archived' ? sql`now()` : null,
        revision: sql`${projects.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(projects.id, project.id),
          eq(projects.revision, input.expectedRevision),
        ),
      )
      .returning()
    if (!row) throw conflict()
    await audit(tx, actor, {
      projectId: project.id,
      action: `project.${status === 'active' ? 'restore' : status === 'paused' ? 'pause' : 'archive'}`,
      targetType: 'project',
      targetId: project.id,
      beforeRevision: project.revision,
      afterRevision: row.revision,
      changes: { status: [project.status, status] },
    })
    return row
  })
}

const trashSchema = z.object({
  projectId: recordId('Project'),
  expectedRevision: revision,
})

/** The owner's project for a Trash write, at the revision the page read — archived or deleted too. */
async function projectForTrash(
  tx: Tx,
  actor: Actor,
  projectId: string,
  expectedRevision: number,
): Promise<ProjectRow> {
  // Owner-only: taking a project out of everything (or bringing it back)
  // is the owner's, never an agent's.
  await authorize(tx, actor, null, 'hq', 'manage', 'owner_only')
  const [project] = await tx
    .select()
    .from(projects)
    .where(and(eq(projects.id, projectId), eq(projects.ownerId, actor.userId)))
    .limit(1)
    .for('update')
  if (!project) throw notFound('Project')
  if (project.revision !== expectedRevision) throw conflict()
  return project
}

/**
 * Delete: to the Trash. The project is archived and marked deleted in one
 * write, from any status, so it leaves the rail, Home, pickers, `/p/<slug>`
 * and MCP at once. Nothing it holds is removed — cards, files, money and
 * history stay as they were — and Restore brings it back.
 */
export async function deleteProject(
  actor: Actor,
  raw: z.input<typeof trashSchema>,
): Promise<ProjectRow> {
  const input = parseInput(trashSchema, raw)
  return withTransaction(async (tx) => {
    const project = await projectForTrash(
      tx,
      actor,
      input.projectId,
      input.expectedRevision,
    )
    if (project.deletedAt) return project
    const [row] = await tx
      .update(projects)
      .set({
        status: 'archived',
        archivedAt: project.archivedAt ?? sql`now()`,
        deletedAt: sql`now()`,
        revision: sql`${projects.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(projects.id, project.id),
          eq(projects.revision, input.expectedRevision),
        ),
      )
      .returning()
    if (!row) throw conflict()
    await audit(tx, actor, {
      projectId: project.id,
      action: 'project.delete',
      targetType: 'project',
      targetId: project.id,
      beforeRevision: project.revision,
      afterRevision: row.revision,
      changes: { status: [project.status, 'archived'], deleted: true },
    })
    return row
  })
}

const restoreSchema = trashSchema.extend({
  /** Where it comes back: archived from the Trash, or what it was for Delete's Undo. */
  status: optionalChoice(
    ['active', 'paused', 'archived'] as const,
    'Choose a status.',
  ),
})

/**
 * Out of the Trash. Restore brings a project back archived — the owner
 * decides from there — and Delete's Undo brings it back as it was.
 */
export async function restoreProject(
  actor: Actor,
  raw: z.input<typeof restoreSchema>,
): Promise<ProjectRow> {
  const input = parseInput(restoreSchema, raw)
  const status = (input.status ?? 'archived') as ProjectStatus
  return withTransaction(async (tx) => {
    const project = await projectForTrash(
      tx,
      actor,
      input.projectId,
      input.expectedRevision,
    )
    if (!project.deletedAt) return project
    const [row] = await tx
      .update(projects)
      .set({
        status,
        archivedAt: status === 'archived' ? project.archivedAt : null,
        deletedAt: null,
        revision: sql`${projects.revision} + 1`,
        updatedAt: sql`now()`,
      })
      .where(
        and(
          eq(projects.id, project.id),
          eq(projects.revision, input.expectedRevision),
        ),
      )
      .returning()
    if (!row) throw conflict()
    await audit(tx, actor, {
      projectId: project.id,
      action: 'project.undelete',
      targetType: 'project',
      targetId: project.id,
      beforeRevision: project.revision,
      afterRevision: row.revision,
      changes: { status: [project.status, status], deleted: false },
    })
    return row
  })
}

const moduleSchema = z.object({
  projectId: recordId('Project'),
  expectedRevision: revision,
  module: z.string().refine(isModuleId, 'That module doesn’t exist.'),
  on: z.boolean(),
})

/**
 * Turn a module on or off for one project. Off keeps every record — the
 * module just stops showing and stops taking new ones — and a module another
 * enabled module needs can't be turned off first.
 */
export async function setModule(
  actor: Actor,
  raw: z.input<typeof moduleSchema>,
): Promise<ProjectRow> {
  const input = parseInput(moduleSchema, raw)
  const module = input.module
  if (!isModuleId(module)) throw invalid('That module doesn’t exist.')
  return writeProject(
    actor,
    input.projectId,
    input.expectedRevision,
    input.on ? 'project.module_on' : 'project.module_off',
    (project) => {
      const enabled = project.modules.enabled
      const has = enabled.includes(module)
      if (has === input.on) return null
      const check = input.on
        ? canEnable(project.kind, enabled, module)
        : canDisable(enabled, module)
      if (!check.ok) throw invalid(check.reason)
      const next = input.on
        ? orderedModules(project.kind, [...enabled, module])
        : enabled.filter((id) => id !== module)
      return { modules: { ...project.modules, enabled: next } }
    },
  )
}

/** The owner's new order, as a list of project IDs; projects not listed keep their place after it. */
export async function reorderProjects(
  actor: Actor,
  projectIds: string[],
): Promise<void> {
  const ids = z.array(z.uuid()).max(200).parse(projectIds)
  await withTransaction(async (tx) => {
    await authorize(tx, actor, null, 'hq', 'manage')
    const owned = await tx
      .select({ id: projects.id })
      .from(projects)
      .where(and(eq(projects.ownerId, actor.userId), inArray(projects.id, ids)))
    const mine = new Set(owned.map((row) => row.id))
    let position = 0
    for (const id of ids) {
      if (!mine.has(id)) continue
      await tx
        .update(projects)
        .set({ position: position++, updatedAt: sql`now()` })
        .where(eq(projects.id, id))
    }
    await audit(tx, actor, {
      projectId: null,
      action: 'project.reorder',
      targetType: 'project',
      targetId: null,
      changes: { order: ids.filter((id) => mine.has(id)) },
    })
  })
}
