import { afterAll, beforeAll, expect, test } from 'bun:test'
import { projects } from '@theiceji/hq-db/schema'
import { eq, sql } from 'drizzle-orm'
import { ownedProject, ownProject } from '../src/store'
import { failure, setupWorld, suite, teardown, type World } from './helpers'

/**
 * A project in the Trash (migration 0003_trash) is the
 * owner's alone: an agent that still holds its id reads "not found", as if it
 * never existed, while the owner can still reach it to restore it.
 */

suite('a project in the Trash (Postgres)', () => {
  let w: World

  beforeAll(async () => {
    w = await setupWorld('trash')
    await w.db
      .update(projects)
      .set({
        status: 'archived',
        archivedAt: sql`now()`,
        deletedAt: sql`now()`,
      })
      .where(eq(projects.id, w.projectId))
  })

  afterAll(teardown)

  test('reads as not found to an agent, and is still the owner’s', async () => {
    const byAgent = await failure(ownProject(w.db, w.agent, w.projectId))
    expect(byAgent.code).toBe('not_found')
    const scoped = await failure(
      ownedProject(w.db, w.agent, w.projectId, 'board', 'read'),
    )
    expect(scoped.code).toBe('not_found')
    const mine = await ownProject(w.db, w.owner, w.projectId)
    expect(mine.deletedAt).not.toBeNull()
  })
})
