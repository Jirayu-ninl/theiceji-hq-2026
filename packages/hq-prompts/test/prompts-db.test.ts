import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { createTarget } from '@theiceji/hq-core/targets'
import {
  assetAssets,
  promptExamplePicks,
  promptPrompts,
  promptVariants,
  refs,
} from '@theiceji/hq-db/schema'
import { withTransaction } from '@theiceji/hq-ops/store'
import {
  allowAgent,
  closeTestDb,
  dbTestsEnabled,
  failure,
  makeProject,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import { eq, sql } from 'drizzle-orm'
import {
  addExample,
  deleteLibrarySlot,
  editPromptDetails,
  fillPrompt,
  getPrompt,
  listLibrarySlots,
  listPrompts,
  type PromptView,
  promptCollections,
  promptSummaries,
  removeExample,
  saveLibrarySlot,
  savePrompt,
  setExamplePicks,
  setPromptArchived,
  setPromptDeleted,
} from '../src/prompts'
import '../src/register'

/**
 * Prompts against Postgres. Runs only with PROMPTS_DB_TESTS=1 and a
 * localhost DATABASE_URL — a throwaway database.
 */

const suite = dbTestsEnabled('PROMPTS_DB_TESTS') ? describe : describe.skip
const TABLES = [
  'prompt_example_picks',
  'prompt_slot_options',
  'prompt_slots',
  'prompt_examples',
  'prompt_variants',
  'prompt_prompts',
  'asset_collection_items',
  'asset_collections',
  'asset_assets',
]

/** A prompt's options for a variant, as `key:from`. */
const offered = (prompt: PromptView, name: string) =>
  prompt.slots
    .find((slot) => slot.name === name)
    ?.options.map((option) => `${option.key}:${option.from}`)

const optionId = (prompt: PromptView, name: string, key: string) =>
  prompt.slots
    .find((slot) => slot.name === name)
    ?.options.find((option) => option.key === key)?.id as string

suite('hq-prompts against Postgres', () => {
  let w: World

  beforeEach(async () => {
    w = await resetWorld(TABLES)
  })

  afterAll(() => closeTestDb(TABLES))

  async function readyAsset(projectId: string | null, name = 'ex.png') {
    const [row] = await w.db
      .insert(assetAssets)
      .values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        projectId,
        storageProvider: 'r2',
        storageKey: `k/${crypto.randomUUID()}`,
        path: `x/${name}`,
        name,
        kind: 'image',
        mime: 'image/png',
        bytes: 10,
        status: 'ready',
        readyAt: sql`now()`,
        actorType: 'user',
        actorId: w.owner.userId,
      })
      .returning()
    if (!row) throw new Error('no asset')
    return row
  }

  /** HAIR_COLOR in the library; a character prompt adds its own options. */
  async function character() {
    await saveLibrarySlot(w.owner, {
      name: 'HAIR_COLOR',
      options: [
        { key: 'red', value: 'red short' },
        { key: 'blue', value: 'blue long' },
        { key: 'punk', value: 'black punk style with red highlight' },
      ],
    })
    return savePrompt(w.owner, {
      projectId: w.project.id,
      title: 'Character',
      medium: 'image',
      text: 'Generate a character with <HAIR_COLOR> hair, and <SHIRT_COLOR> shirt.',
      slots: [
        { name: 'HAIR_COLOR', options: [{ key: 'Red', value: 'copper-red' }] },
        {
          name: 'SHIRT_COLOR',
          options: [
            { key: 'white', value: 'a plain white' },
            { key: 'denim', value: 'a faded denim' },
          ],
        },
      ],
    })
  }

  test('a prompt has one text: saving changes it in place; a second row is refused', async () => {
    const prompt = await savePrompt(w.owner, {
      projectId: w.project.id,
      title: 'Listing cover',
      medium: 'image',
      collection: 'Covers',
      tags: ['Cover', 'etsy'],
      text: 'A calm desk, soft light',
      style: 'calm',
    })
    expect(prompt.tags).toEqual(['cover', 'etsy'])
    expect([prompt.text?.text, prompt.text?.style]).toEqual([
      'A calm desk, soft light',
      'calm',
    ])
    const saved = await savePrompt(w.owner, {
      promptId: prompt.id,
      expectedRevision: prompt.revision,
      title: 'Listing cover',
      medium: 'image',
      text: 'A dark desk',
    })
    expect(saved.text?.id).toBe(prompt.text?.id as string)
    // A key left out stays.
    expect([saved.text?.text, saved.text?.style]).toEqual([
      'A dark desk',
      'calm',
    ])
    const stale = await failure(
      savePrompt(w.owner, {
        promptId: prompt.id,
        expectedRevision: prompt.revision,
        title: 'x',
        medium: 'image',
      }),
    )
    expect(stale.code).toBe('conflict')
    let refused: unknown = null
    try {
      await w.db.insert(promptVariants).values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        promptId: prompt.id,
        label: 'B',
        text: 'another',
      })
    } catch (error) {
      refused = error
    }
    expect(
      (refused as { cause?: { constraint_name?: string } } | null)?.cause
        ?.constraint_name,
    ).toBe('prompt_variants_one_key')
    // A prompt made without a text gets one on its first save with one.
    const empty = await savePrompt(w.owner, { title: 'Empty', medium: 'text' })
    expect(empty.text).toBeNull()
    const style = await failure(
      savePrompt(w.owner, {
        promptId: empty.id,
        expectedRevision: empty.revision,
        title: 'Empty',
        medium: 'text',
        style: 'x',
      }),
    )
    expect(style.message).toContain('text first')
  })

  test('a variant offers the library’s options and the prompt’s own; the prompt’s replaces a library key', async () => {
    const prompt = await character()
    expect(
      prompt.slots.map((slot) => [
        slot.name,
        slot.inText,
        Boolean(slot.librarySlotId),
      ]),
    ).toEqual([
      ['HAIR_COLOR', true, true],
      ['SHIRT_COLOR', true, false],
    ])
    expect(offered(prompt, 'HAIR_COLOR')).toEqual([
      'Red:prompt',
      'blue:library',
      'punk:library',
    ])
    const half = fillPrompt(prompt, { HAIR_COLOR: 'punk' })
    expect(half.missing).toEqual(['SHIRT_COLOR'])
    const whole = fillPrompt(prompt, {
      HAIR_COLOR: 'red',
      SHIRT_COLOR: optionId(prompt, 'SHIRT_COLOR', 'denim'),
    })
    expect(whole.missing).toEqual([])
    expect(whole.text).toBe(
      'Generate a character with copper-red hair, and a faded denim shirt.',
    )
    expect(
      fillPrompt(prompt, { NOPE: 'x', SHIRT_COLOR: 'green' }).unknown,
    ).toEqual(['NOPE', 'SHIRT_COLOR'])
    // A block variant swaps whole lines.
    const block = await savePrompt(w.owner, {
      title: 'Poster',
      medium: 'image',
      text: 'prompt header\n<STYLE>\nprompt ending',
      slots: [
        {
          name: 'STYLE',
          options: [{ key: 'noir', value: 'black plate\nhard light' }],
        },
      ],
    })
    expect(fillPrompt(block, { STYLE: 'noir' }).text).toBe(
      'prompt header\nblack plate\nhard light\nprompt ending',
    )
    const listed = await listPrompts(w.owner, { projectId: w.project.id })
    expect(listed.prompts[0]?.slotNames).toEqual(['HAIR_COLOR', 'SHIRT_COLOR'])
  })

  test('an example keeps its picks; saving variants by name keeps options and picks; one left out takes its picks', async () => {
    const prompt = await character()
    const asset = await readyAsset(w.project.id)
    const example = await addExample(w.owner, {
      promptId: prompt.id,
      assetId: asset.id,
      picks: { HAIR_COLOR: 'punk', SHIRT_COLOR: 'denim' },
    })
    const read = await getPrompt(w.owner, prompt.id)
    expect(read.text?.examples[0]?.picks).toEqual({
      HAIR_COLOR: optionId(read, 'HAIR_COLOR', 'punk'),
      SHIRT_COLOR: optionId(read, 'SHIRT_COLOR', 'denim'),
    })
    const denim = optionId(read, 'SHIRT_COLOR', 'denim')
    // An agent's save names things, no ids: denim is the same option.
    const renamed = await savePrompt(w.owner, {
      promptId: prompt.id,
      expectedRevision: read.revision,
      title: 'Character',
      medium: 'image',
      slots: [
        { name: 'HAIR_COLOR', options: [{ key: 'red', value: 'copper-red' }] },
        {
          name: 'SHIRT_COLOR',
          options: [
            { key: 'Denim', value: 'a washed denim' },
            { key: 'stripe', value: 'a breton-stripe' },
          ],
        },
      ],
    })
    expect(optionId(renamed, 'SHIRT_COLOR', 'Denim')).toBe(denim)
    expect(offered(renamed, 'SHIRT_COLOR')).toEqual([
      'Denim:prompt',
      'stripe:prompt',
    ])
    expect(Object.keys(renamed.text?.examples[0]?.picks ?? {})).toEqual([
      'HAIR_COLOR',
      'SHIRT_COLOR',
    ])
    // The text drops SHIRT_COLOR but the prompt keeps its options until they go.
    const dropped = await savePrompt(w.owner, {
      promptId: prompt.id,
      expectedRevision: renamed.revision,
      title: 'Character',
      medium: 'image',
      text: 'Generate a character with <HAIR_COLOR> hair.',
    })
    expect(dropped.slots.map((slot) => [slot.name, slot.inText])).toEqual([
      ['HAIR_COLOR', true],
      ['SHIRT_COLOR', false],
    ])
    expect(fillPrompt(dropped, { HAIR_COLOR: 'blue' }).missing).toEqual([])
    const gone = await savePrompt(w.owner, {
      promptId: prompt.id,
      expectedRevision: dropped.revision,
      title: 'Character',
      medium: 'image',
      slots: [
        { name: 'HAIR_COLOR', options: [{ key: 'red', value: 'copper-red' }] },
      ],
    })
    expect(gone.text?.examples[0]?.picks).toEqual({
      HAIR_COLOR: optionId(gone, 'HAIR_COLOR', 'punk'),
    })
    // Picks change as a whole set; an option the prompt doesn't offer is refused.
    await setExamplePicks(w.owner, {
      exampleId: example.id,
      picks: { HAIR_COLOR: 'blue' },
    })
    expect(
      (await getPrompt(w.owner, prompt.id)).text?.examples[0]?.picks,
    ).toEqual({ HAIR_COLOR: optionId(gone, 'HAIR_COLOR', 'blue') })
    const wrong = await failure(
      setExamplePicks(w.owner, {
        exampleId: example.id,
        picks: { HAIR_COLOR: 'green' },
      }),
    )
    expect(wrong.message).toContain('no option')
    const twice = await failure(
      savePrompt(w.owner, {
        promptId: prompt.id,
        expectedRevision: gone.revision,
        title: 'Character',
        medium: 'image',
        slots: [
          {
            name: 'HAIR_COLOR',
            options: [
              { key: 'a', value: '1' },
              { key: 'A', value: '2' },
            ],
          },
        ],
      }),
    )
    expect(twice.message).toContain('two options')
    const badName = await failure(
      savePrompt(w.owner, {
        promptId: prompt.id,
        expectedRevision: gone.revision,
        title: 'Character',
        medium: 'image',
        slots: [{ name: 'hair color', options: [] }],
      }),
    )
    expect(badName.code).toBe('invalid')
  })

  test('the library: names are unique, changes go by revision, a prompt that writes it counts, and taking it out takes its picks', async () => {
    const prompt = await character()
    await savePrompt(w.owner, {
      title: 'Floating portrait',
      medium: 'image',
      text: 'A portrait, <HAIR_COLOR>',
    })
    const [hair] = await listLibrarySlots(w.owner)
    expect([hair?.name, hair?.usedBy, hair?.options.length]).toEqual([
      'HAIR_COLOR',
      2,
      3,
    ])
    const dup = await failure(
      saveLibrarySlot(w.owner, { name: 'HAIR_COLOR', options: [] }),
    )
    expect(dup.message).toContain('library already has')
    const stale = await failure(
      saveLibrarySlot(w.owner, {
        id: hair?.id,
        expectedRevision: (hair?.revision ?? 0) + 5,
        name: 'HAIR_COLOR',
        options: [],
      }),
    )
    expect(stale.code).toBe('conflict')
    const asset = await readyAsset(w.project.id)
    await addExample(w.owner, {
      promptId: prompt.id,
      assetId: asset.id,
      picks: { HAIR_COLOR: 'punk', SHIRT_COLOR: 'white' },
    })
    await deleteLibrarySlot(w.owner, {
      slotId: hair?.id as string,
      expectedRevision: hair?.revision as number,
    })
    const after = await getPrompt(w.owner, prompt.id)
    expect(offered(after, 'HAIR_COLOR')).toEqual(['Red:prompt'])
    expect(Object.keys(after.text?.examples[0]?.picks ?? {})).toEqual([
      'SHIRT_COLOR',
    ])
    expect(await listLibrarySlots(w.owner)).toEqual([])
    expect(await listLibrarySlots(w.stranger)).toEqual([])
  })

  test('examples are ready assets of the same project, linked both ways', async () => {
    const prompt = await savePrompt(w.owner, {
      projectId: w.project.id,
      title: 'Cover',
      medium: 'image',
      text: 't',
    })
    const asset = await readyAsset(w.project.id)
    const example = await addExample(w.owner, {
      promptId: prompt.id,
      assetId: asset.id,
      rating: 4,
      caption: 'best one',
    })
    const dup = await failure(
      addExample(w.owner, { promptId: prompt.id, assetId: asset.id }),
    )
    expect(dup.message).toContain('already an example')
    const other = await makeProject(w.db, w.owner.userId, 'other')
    const foreign = await readyAsset(other.id, 'foreign.png')
    const wrong = await failure(
      addExample(w.owner, { promptId: prompt.id, assetId: foreign.id }),
    )
    expect(wrong.message).toContain('another project')
    const [pending] = await w.db
      .insert(assetAssets)
      .values({
        ownerId: w.owner.userId,
        createdBy: w.owner.userId,
        projectId: w.project.id,
        storageProvider: 'r2',
        storageKey: 'pending/1',
        path: 'p',
        name: 'p.png',
        kind: 'image',
        mime: 'image/png',
        bytes: 1,
        actorType: 'user',
        actorId: w.owner.userId,
      })
      .returning()
    const notReady = await failure(
      addExample(w.owner, {
        promptId: prompt.id,
        assetId: pending?.id as string,
      }),
    )
    expect(notReady.message).toContain('ready asset')
    const noVariant = await failure(
      addExample(w.owner, {
        promptId: prompt.id,
        assetId: (await readyAsset(w.project.id, 'b.png')).id,
        picks: { HAIR_COLOR: 'red' },
      }),
    )
    expect(noVariant.message).toContain('isn’t a variant')
    const edges = await w.db
      .select()
      .from(refs)
      .where(eq(refs.role, 'example_of'))
    expect(edges).toHaveLength(1)
    const listed = await listPrompts(w.owner, { projectId: w.project.id })
    expect(listed.prompts[0]?.previews.map((entry) => entry.id)).toEqual([
      asset.id,
    ])
    await removeExample(w.owner, example.id)
    expect(await w.db.select().from(refs)).toHaveLength(0)
    expect(await w.db.select().from(promptExamplePicks)).toHaveLength(0)
  })

  test('lists filter by scope, medium, collection, tag and words', async () => {
    await savePrompt(w.owner, {
      projectId: w.project.id,
      title: 'Desk still',
      medium: 'image',
      collection: 'Covers',
      tags: ['desk'],
      text: 'warm lamp',
    })
    await savePrompt(w.owner, {
      projectId: w.project.id,
      title: 'Teaser',
      medium: 'video',
      text: 'fog',
    })
    await savePrompt(w.owner, {
      title: 'Floating',
      medium: 'text',
      text: 'hooks',
    })
    expect((await listPrompts(w.owner)).total).toBe(3)
    expect(
      (await listPrompts(w.owner, { projectId: null })).prompts.map(
        (p) => p.title,
      ),
    ).toEqual(['Floating'])
    expect(
      (
        await listPrompts(w.owner, { projectId: w.project.id, medium: 'video' })
      ).prompts.map((p) => p.title),
    ).toEqual(['Teaser'])
    expect(
      (await listPrompts(w.owner, { collection: 'covers' })).prompts.map(
        (p) => p.title,
      ),
    ).toEqual(['Desk still'])
    expect((await listPrompts(w.owner, { tag: 'desk' })).total).toBe(1)
    expect(
      (await listPrompts(w.owner, { query: 'lamp' })).prompts.map(
        (p) => p.title,
      ),
    ).toEqual(['Desk still'])
    expect(await promptCollections(w.owner, w.project.id)).toEqual([
      { name: 'Covers', count: 1 },
    ])
    const summary = (await promptSummaries(w.owner)).find(
      (row) => row.projectId === w.project.id,
    )
    expect(summary).toEqual({
      projectId: w.project.id,
      prompts: 2,
      newThisWeek: 2,
    })
  })

  test('an agent drafts under the owner’s policy but never archives', async () => {
    const blocked = await failure(
      savePrompt(w.agent, {
        projectId: w.project.id,
        title: 'x',
        medium: 'image',
      }),
    )
    expect(blocked.code).toBe('policy_blocked')
    await allowAgent(w, ['draft'])
    const prompt = await savePrompt(w.agent, {
      projectId: w.project.id,
      title: 'x',
      medium: 'image',
      text: 't',
    })
    const archive = await failure(
      setPromptArchived(w.agent, {
        promptId: prompt.id,
        expectedRevision: prompt.revision,
        archived: true,
      }),
    )
    expect(archive.code).toBe('forbidden')
    const archived = await setPromptArchived(w.owner, {
      promptId: prompt.id,
      expectedRevision: prompt.revision,
      archived: true,
    })
    expect(archived.archivedAt).not.toBeNull()
    expect(
      (await listPrompts(w.owner, { projectId: w.project.id })).total,
    ).toBe(0)
  })

  test('delete sends a prompt to the Trash, off every list and out of an agent’s sight; restore brings it back whole', async () => {
    await allowAgent(w, ['draft'])
    const prompt = await savePrompt(w.owner, {
      projectId: w.project.id,
      title: 'Desk tour hook',
      medium: 'image',
      text: 'A slow push-in',
    })
    const agentDelete = await failure(
      setPromptDeleted(w.agent, {
        promptId: prompt.id,
        expectedRevision: prompt.revision,
        deleted: true,
      }),
    )
    expect(agentDelete.code).toBe('forbidden')
    const deleted = await setPromptDeleted(w.owner, {
      promptId: prompt.id,
      expectedRevision: prompt.revision,
      deleted: true,
    })
    expect(deleted.deletedAt).not.toBeNull()
    expect(deleted.archivedAt).not.toBeNull()
    // Off the library, the pickers, the counts and Archived; only the Trash has it.
    expect((await listPrompts(w.owner)).total).toBe(0)
    expect((await listPrompts(w.owner, { bucket: 'archived' })).total).toBe(0)
    expect(
      (await listPrompts(w.owner, { bucket: 'trash' })).prompts.map(
        (p) => p.title,
      ),
    ).toEqual(['Desk tour hook'])
    expect(await promptSummaries(w.owner)).toEqual([])
    // The owner reads it in the Trash; to an agent it isn't there.
    expect((await getPrompt(w.owner, prompt.id)).text?.text).toBe(
      'A slow push-in',
    )
    expect((await failure(getPrompt(w.agent, prompt.id))).code).toBe(
      'not_found',
    )
    expect(
      (await failure(listPrompts(w.agent, { bucket: 'trash' }))).code,
    ).toBe('forbidden')
    expect((await listPrompts(w.agent)).total).toBe(0)
    const agentSave = await failure(
      savePrompt(w.agent, {
        promptId: prompt.id,
        expectedRevision: deleted.revision,
        title: 'x',
        medium: 'image',
      }),
    )
    expect(agentSave.code).toBe('not_found')
    const asset = await readyAsset(w.project.id)
    expect(
      (
        await failure(
          addExample(w.agent, { promptId: prompt.id, assetId: asset.id }),
        )
      ).code,
    ).toBe('not_found')
    const ownerEdit = await failure(
      addExample(w.owner, { promptId: prompt.id, assetId: asset.id }),
    )
    expect(ownerEdit.message).toContain('in the Trash')
    // Un-archiving can't lift it out of the Trash; a stale revision is a conflict.
    const unarchive = await failure(
      setPromptArchived(w.owner, {
        promptId: prompt.id,
        expectedRevision: deleted.revision,
        archived: false,
      }),
    )
    expect(unarchive.message).toContain('Trash')
    const stale = await failure(
      setPromptDeleted(w.owner, {
        promptId: prompt.id,
        expectedRevision: prompt.revision,
        deleted: false,
      }),
    )
    expect(stale.code).toBe('conflict')
    const back = await setPromptDeleted(w.owner, {
      promptId: prompt.id,
      expectedRevision: deleted.revision,
      deleted: false,
    })
    expect(back.deletedAt).toBeNull()
    expect(back.archivedAt).toBeNull()
    const listed = await listPrompts(w.owner)
    expect(listed.prompts.map((p) => [p.title, p.text?.text])).toEqual([
      ['Desk tour hook', 'A slow push-in'],
    ])
    expect((await getPrompt(w.agent, prompt.id)).id).toBe(prompt.id)
  })

  test('a prompt deleted from Archived goes back there on Undo; Restore from Archived brings it to the library', async () => {
    const prompt = await savePrompt(w.owner, {
      title: 'Floating cover',
      medium: 'image',
      text: 't',
    })
    const archived = await setPromptArchived(w.owner, {
      promptId: prompt.id,
      expectedRevision: prompt.revision,
      archived: true,
    })
    expect(
      (await listPrompts(w.owner, { bucket: 'archived' })).prompts.map(
        (p) => p.id,
      ),
    ).toEqual([prompt.id])
    const deleted = await setPromptDeleted(w.owner, {
      promptId: prompt.id,
      expectedRevision: archived.revision,
      deleted: true,
    })
    // Deleting keeps when it was archived.
    expect(deleted.archivedAt?.getTime()).toBe(archived.archivedAt?.getTime())
    expect((await listPrompts(w.owner, { bucket: 'archived' })).total).toBe(0)
    const undone = await setPromptDeleted(w.owner, {
      promptId: prompt.id,
      expectedRevision: deleted.revision,
      deleted: false,
      archived: true,
    })
    expect(undone.deletedAt).toBeNull()
    expect(undone.archivedAt).not.toBeNull()
    expect((await listPrompts(w.owner, { bucket: 'archived' })).total).toBe(1)
    const restored = await setPromptArchived(w.owner, {
      promptId: prompt.id,
      expectedRevision: undone.revision,
      archived: false,
    })
    expect(restored.archivedAt).toBeNull()
    expect((await listPrompts(w.owner, { projectId: null })).total).toBe(1)
  })

  test('a deleted prompt takes no proposed variant', async () => {
    const made = await withTransaction((tx) =>
      createTarget(
        'prompt',
        { title: 'From a note', text: 'Soft light' },
        { tx, actor: w.owner, project: w.project },
      ),
    )
    const row = await getPrompt(w.owner, made.id)
    await setPromptDeleted(w.owner, {
      promptId: made.id,
      expectedRevision: row.revision,
      deleted: true,
    })
    const refused = await failure(
      withTransaction((tx) =>
        createTarget(
          'prompt_variant',
          { promptId: made.id, text: 'Hard light' },
          { tx, actor: w.owner, project: w.project },
        ),
      ),
    )
    expect(refused.message).toContain('Trash')
  })

  test('details change by revision; a key left out stays, an empty collection clears', async () => {
    const prompt = await savePrompt(w.owner, {
      projectId: w.project.id,
      title: 'Cover',
      intent: 'A still',
      medium: 'image',
      collection: 'Covers',
      tags: ['desk'],
      text: 't',
    })
    const edited = await editPromptDetails(w.owner, {
      promptId: prompt.id,
      expectedRevision: prompt.revision,
      title: '  Listing cover ',
      tags: ['Etsy', 'etsy', 'Cover'],
    })
    expect([
      edited.title,
      edited.intent,
      edited.collection,
      edited.tags,
      edited.medium,
    ]).toEqual([
      'Listing cover',
      'A still',
      'Covers',
      ['etsy', 'cover'],
      'image',
    ])
    expect(edited.revision).toBe(prompt.revision + 1)
    const same = await editPromptDetails(w.owner, {
      promptId: prompt.id,
      expectedRevision: edited.revision,
      title: 'Listing cover',
    })
    expect(same.revision).toBe(edited.revision)
    const cleared = await editPromptDetails(w.owner, {
      promptId: prompt.id,
      expectedRevision: edited.revision,
      collection: '',
      intent: 'The listing’s first image',
    })
    expect([cleared.collection, cleared.intent]).toEqual([
      null,
      'The listing’s first image',
    ])
    // The text is untouched.
    expect((await getPrompt(w.owner, prompt.id)).text?.text).toBe('t')
    const stale = await failure(
      editPromptDetails(w.owner, {
        promptId: prompt.id,
        expectedRevision: prompt.revision,
        title: 'x',
      }),
    )
    expect(stale.code).toBe('conflict')
    const blank = await failure(
      editPromptDetails(w.owner, {
        promptId: prompt.id,
        expectedRevision: cleared.revision,
        title: '   ',
      }),
    )
    expect(blank.code).toBe('invalid')
    const archived = await setPromptArchived(w.owner, {
      promptId: prompt.id,
      expectedRevision: cleared.revision,
      archived: true,
    })
    const closed = await failure(
      editPromptDetails(w.owner, {
        promptId: prompt.id,
        expectedRevision: archived.revision,
        title: 'y',
      }),
    )
    expect(closed.message).toContain('archived')
  })

  test('the same idempotency key replays the first prompt', async () => {
    const key = 'prompt-key-001'
    const first = await savePrompt(w.owner, {
      projectId: w.project.id,
      title: 'once',
      medium: 'image',
      idempotencyKey: key,
    })
    const second = await savePrompt(w.owner, {
      projectId: w.project.id,
      title: 'once',
      medium: 'image',
      idempotencyKey: key,
    })
    expect(second.id).toBe(first.id)
  })

  test('someone else’s prompt reads as not found', async () => {
    const prompt = await savePrompt(w.owner, {
      projectId: w.project.id,
      title: 'mine',
      medium: 'image',
    })
    const error = await failure(getPrompt(w.stranger, prompt.id))
    expect(error.code).toBe('not_found')
  })

  test('promote targets: a note becomes a prompt; another text for it becomes a prompt of its own beside it', async () => {
    const made = await withTransaction((tx) =>
      createTarget(
        'prompt',
        { title: 'From a note', text: 'Soft light, 35 mm', medium: 'image' },
        { tx, actor: w.owner, project: w.project },
      ),
    )
    expect(made.href).toBe(`/p/pilot/prompts?prompt=${made.id}`)
    const floating = await withTransaction((tx) =>
      createTarget(
        'prompt',
        { title: 'Floating note', text: 'x' },
        { tx, actor: w.owner, project: null },
      ),
    )
    expect(floating.href).toBe(`/prompts?prompt=${floating.id}`)
    const variant = await withTransaction((tx) =>
      createTarget(
        'prompt_variant',
        { promptId: made.id, text: 'Hard light', style: 'noir' },
        { tx, actor: w.owner, project: w.project },
      ),
    )
    const [row] = await w.db
      .select({ variant: promptVariants, prompt: promptPrompts })
      .from(promptVariants)
      .innerJoin(promptPrompts, eq(promptPrompts.id, promptVariants.promptId))
      .where(eq(promptVariants.id, variant.id))
    expect([
      row?.prompt.title,
      row?.prompt.projectId,
      row?.prompt.medium,
      row?.variant.text,
      row?.variant.style,
    ]).toEqual([
      'From a note · noir',
      w.project.id,
      'image',
      'Hard light',
      'noir',
    ])
    expect(row?.prompt.id).not.toBe(made.id)
    expect(variant.href).toBe(`/p/pilot/prompts?prompt=${row?.prompt.id}`)
    expect((await getPrompt(w.owner, made.id)).text?.text).toBe(
      'Soft light, 35 mm',
    )
  })
})
