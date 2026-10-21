import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import {
  expDecisions,
  expItems,
  expVariants,
  refs,
} from '@theiceji/hq-db/schema'
import {
  allowAgent,
  closeTestDb,
  dbTestsEnabled,
  failure,
  makeProject,
  pgError,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import {
  planPost,
  recordManualPost,
  saveAccount,
} from '@theiceji/hq-publish/publish'
import { recordReading } from '@theiceji/hq-publish/readings'
import '@theiceji/hq-publish/register'
import { and, eq } from 'drizzle-orm'
import {
  addItem,
  createExperiment,
  deleteExperiment,
  experimentSummaries,
  listExperiments,
  readExperiment,
  recordDecision,
  recordLearning,
  removeItem,
  searchLearnings,
  transitionExperiment,
  updateExperiment,
} from '../src/experiments'

/**
 * Experiments against Postgres, with real posts from Publish read through the
 * hq-core subject registry. Destructive (truncates), so it runs only with
 * EXPERIMENTS_DB_TESTS=1 and a localhost DATABASE_URL.
 */

const suite = dbTestsEnabled('EXPERIMENTS_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'exp_learnings',
  'exp_decisions',
  'exp_items',
  'exp_variants',
  'exp_experiments',
  'publish_readings',
  'publish_intents',
  'publish_posts',
  'publish_accounts',
]

const HOUR = 3_600_000

suite('hq-experiments against Postgres', () => {
  let w: World

  beforeEach(async () => {
    w = await resetWorld(TABLES, { kind: 'channel' })
  })
  afterAll(() => closeTestDb(TABLES))

  async function post(hoursAgo: number, views72: number | null) {
    const accounts = await saveAccount(w.owner, {
      projectId: w.project.id,
      platform: 'manual',
      handle: `blog-${crypto.randomUUID().slice(0, 6)}`,
    })
    const planned = await planPost(w.owner, {
      projectId: w.project.id,
      accountId: accounts.id,
      caption: `post ${hoursAgo}h`,
    })
    const out = await recordManualPost(w.owner, {
      postId: planned.id,
      url: `https://blog.example/${planned.id}`,
      postedAt: new Date(Date.now() - hoursAgo * HOUR),
    })
    if (views72 !== null)
      await recordReading(w.owner, {
        postId: out.id,
        metric: 'views',
        value: views72,
        asOf: new Date((out.postedAt as Date).getTime() + 70 * HOUR),
      })
    return out
  }

  test('a draft’s design changes; a running one’s is frozen', async () => {
    const experiment = await createExperiment(w.owner, {
      projectId: w.project.id,
      question: 'Does a question hook beat a statement hook?',
      subjectType: 'post',
      metric: 'likes',
    })
    expect(experiment.status).toBe('draft')
    expect(experiment.readAtHours).toBe(72)
    const edited = await updateExperiment(w.owner, {
      experimentId: experiment.id,
      expectedRevision: experiment.revision,
      metric: 'views',
      variants: [{ label: 'Question' }, { label: 'Statement' }],
    })
    expect(edited.metric).toBe('views')
    const running = await transitionExperiment(w.owner, {
      experimentId: experiment.id,
      expectedRevision: edited.revision,
      to: 'running',
    })
    expect(running.status).toBe('running')
    expect(running.startedAt).not.toBeNull()
    const frozen = await failure(
      updateExperiment(w.owner, {
        experimentId: experiment.id,
        expectedRevision: running.revision,
        metric: 'likes',
      }),
    )
    expect(frozen.message).toContain('frozen')
    const hypothesis = await updateExperiment(w.owner, {
      experimentId: experiment.id,
      expectedRevision: running.revision,
      hypothesis: 'Questions invite a reply.',
    })
    expect(hypothesis.hypothesis).toBe('Questions invite a reply.')
    const [row] = await listExperiments(w.owner, { projectId: w.project.id })
    expect(row?.variants.map((variant) => variant.label)).toEqual([
      'Question',
      'Statement',
    ])
  })

  test('items read at the same age: observed middles, too young, and a leader in words', async () => {
    const experiment = await createExperiment(w.owner, {
      projectId: w.project.id,
      question: 'Hook A or hook B?',
      subjectType: 'post',
      metric: 'views',
      readAtHours: 72,
    })
    const read0 = await readExperiment(w.owner, experiment.id)
    const [a, b] = read0.variants
    if (!a || !b) throw new Error('no variants')
    const running = await transitionExperiment(w.owner, {
      experimentId: experiment.id,
      expectedRevision: experiment.revision,
      to: 'running',
    })
    const p1 = await post(100, 1000)
    const p2 = await post(90, 3000)
    const p3 = await post(80, 500)
    const young = await post(10, null)
    await allowAgent(w, ['draft'])
    for (const [variant, subject] of [
      [a, p1],
      [a, p2],
      [b, p3],
      [b, young],
    ] as const)
      await addItem(w.agent, {
        experimentId: experiment.id,
        variantId: variant.id,
        subjectId: subject.id,
      })
    const twice = await failure(
      addItem(w.owner, {
        experimentId: experiment.id,
        variantId: b.id,
        subjectId: p1.id,
      }),
    )
    expect(twice.message).toContain('already in this experiment')
    const read = await readExperiment(w.owner, experiment.id)
    const [ra, rb] = read.variants
    expect([
      ra?.covered,
      ra?.median,
      ra?.medianIsLower,
      ra?.min,
      ra?.max,
    ]).toEqual([2, '1000', true, '1000', '3000'])
    expect([rb?.covered, rb?.tooYoung, rb?.median]).toEqual([1, 1, '500'])
    expect(read.leader?.label).toBe('A')
    expect(read.leader?.note).toContain('anecdote')
    const edges = await w.db
      .select()
      .from(refs)
      .where(and(eq(refs.toType, 'experiment'), eq(refs.toId, experiment.id)))
    expect(edges).toHaveLength(4)
    expect(edges.every((edge) => edge.role === 'attached')).toBe(true)

    // Deciding is a decision: an agent without ops:decide in its policy can't.
    const agent = await failure(
      recordDecision(w.agent, {
        experimentId: experiment.id,
        expectedRevision: running.revision,
        verdict: 'winner',
        winnerVariantId: a.id,
        rationale: 'A read higher.',
      }),
    )
    expect(agent.code).toBe('policy_blocked')
    const current = (await readExperiment(w.owner, experiment.id)).experiment
    const { experiment: decided, decision } = await recordDecision(w.owner, {
      experimentId: experiment.id,
      expectedRevision: current.revision,
      verdict: 'winner',
      winnerVariantId: a.id,
      rationale: 'A’s middle is twice B’s, on two items; keep testing on more.',
    })
    expect(decided.status).toBe('decided')
    expect(
      (decision.snapshot as { variants: { median: string }[] }).variants.map(
        (variant) => variant.median,
      ),
    ).toEqual(['1000', '500'])
    const locked = await failure(
      w.db
        .update(expDecisions)
        .set({ rationale: 'changed' })
        .where(eq(expDecisions.id, decision.id)),
    )
    expect(pgError(locked).code).toBe('23001')
    const item = read.variants[0]?.items[0]
    const late = await failure(
      removeItem(w.owner, {
        experimentId: experiment.id,
        itemId: item?.id as string,
      }),
    )
    expect(late.message).toContain('stay')
  })

  test('items belong to the experiment’s project and owner', async () => {
    const experiment = await createExperiment(w.owner, {
      projectId: w.project.id,
      question: 'Q?',
      subjectType: 'post',
      metric: 'views',
    })
    const { variants } = await readExperiment(w.owner, experiment.id)
    const other = await makeProject(w.db, w.owner.userId, 'other', 'channel')
    const account = await saveAccount(w.owner, {
      projectId: other.id,
      platform: 'manual',
      handle: 'elsewhere',
    })
    const foreign = await planPost(w.owner, {
      projectId: other.id,
      accountId: account.id,
      caption: 'other project',
    })
    const error = await failure(
      addItem(w.owner, {
        experimentId: experiment.id,
        variantId: variants[0]?.id as string,
        subjectId: foreign.id,
      }),
    )
    expect(error.message).toContain('another project')
    const stranger = await failure(readExperiment(w.stranger, experiment.id))
    expect(stranger.code).toBe('not_found')
  })

  test('only an experiment that never started is deleted; one that ran is archived', async () => {
    await allowAgent(w, ['draft'])
    const draft = (question: string) =>
      createExperiment(w.owner, {
        projectId: w.project.id,
        question,
        subjectType: 'post',
        metric: 'views',
      })
    const a = await draft('Delete me?')
    const { variants } = await readExperiment(w.owner, a.id)
    const out = await post(100, 1000)
    await addItem(w.owner, {
      experimentId: a.id,
      variantId: variants[0]?.id as string,
      subjectId: out.id,
    })
    const agent = await failure(
      deleteExperiment(w.agent, { experimentId: a.id }),
    )
    expect(agent.code).toBe('forbidden')
    const current = (await readExperiment(w.owner, a.id)).experiment
    const stale = await failure(
      deleteExperiment(w.owner, {
        experimentId: a.id,
        expectedRevision: current.revision + 1,
      }),
    )
    expect(stale.code).toBe('conflict')
    await deleteExperiment(w.owner, {
      experimentId: a.id,
      expectedRevision: current.revision,
    })
    expect((await failure(readExperiment(w.owner, a.id))).code).toBe(
      'not_found',
    )
    expect(await w.db.select().from(expItems)).toHaveLength(0)
    expect(await w.db.select().from(expVariants)).toHaveLength(0)
    expect(
      await w.db
        .select()
        .from(refs)
        .where(and(eq(refs.toType, 'experiment'), eq(refs.toId, a.id))),
    ).toHaveLength(0)

    // A learning recorded on a draft outlives it, pointing at nothing.
    const learned = await draft('Taught something?')
    const learning = await recordLearning(w.owner, {
      experimentId: learned.id,
      statement: 'Even a draft can teach something.',
    })
    await deleteExperiment(w.owner, { experimentId: learned.id })
    const [kept] = await searchLearnings(w.owner, { ids: [learning.id] })
    expect(kept?.experimentId).toBeNull()
    expect(kept?.statement).toBe('Even a draft can teach something.')

    const ran = await draft('Ran?')
    const running = await transitionExperiment(w.owner, {
      experimentId: ran.id,
      expectedRevision: ran.revision,
      to: 'running',
    })
    const started = await failure(
      deleteExperiment(w.owner, { experimentId: ran.id }),
    )
    expect(started.message).toContain('archive it instead')
    const archived = await transitionExperiment(w.owner, {
      experimentId: ran.id,
      expectedRevision: running.revision,
      to: 'archived',
    })
    expect(archived.status).toBe('archived')
    const history = await failure(
      deleteExperiment(w.owner, { experimentId: ran.id }),
    )
    expect(history.message).toContain('stays as a record')

    // An archived experiment must have started: a draft is deleted instead.
    const shelved = await draft('Shelved before it started?')
    const shelve = await failure(
      transitionExperiment(w.owner, {
        experimentId: shelved.id,
        expectedRevision: shelved.revision,
        to: 'archived',
      }),
    )
    expect(shelve.message).toContain('delete it')
    await deleteExperiment(w.owner, { experimentId: shelved.id })
    const left = await listExperiments(w.owner, {
      projectId: w.project.id,
      status: ['draft', 'running', 'reading', 'decided', 'archived'],
    })
    expect(left.map((row) => row.question)).toEqual(['Ran?'])
  })

  test('learnings: recorded, searched by word and tag, across projects', async () => {
    await recordLearning(w.owner, {
      projectId: w.project.id,
      statement: 'Question hooks double views on desk-setup shorts.',
      evidence: 'Experiment 1, 72h reads.',
      tags: ['Hooks', 'shorts'],
    })
    await recordLearning(w.owner, {
      statement: 'Posting after 20:00 Bangkok time does better.',
      tags: ['timing'],
    })
    expect(
      (await searchLearnings(w.owner, { q: 'question views' })).map(
        (row) => row.tags,
      ),
    ).toEqual([['hooks', 'shorts']])
    expect(await searchLearnings(w.owner, { tags: ['timing'] })).toHaveLength(1)
    expect(await searchLearnings(w.owner, {})).toHaveLength(2)
    const [summary] = await experimentSummaries(w.owner)
    expect(summary).toBeUndefined()
  })
})
