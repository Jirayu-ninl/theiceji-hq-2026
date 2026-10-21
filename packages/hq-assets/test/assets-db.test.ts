import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test'
import { createHash, randomBytes } from 'node:crypto'
import { link } from '@theiceji/hq-core/refs'
import { setStorageDefault } from '@theiceji/hq-core/settings'
import { assetAssets, refs } from '@theiceji/hq-db/schema'
import { withTransaction } from '@theiceji/hq-ops/store'
import {
  allowAgent,
  closeTestDb,
  dbTestsEnabled,
  failure,
  pgError,
  resetWorld,
  type World,
} from '@theiceji/hq-ops/testing'
import { eq, sql } from 'drizzle-orm'
import {
  assetAccess,
  assetPath,
  assetSummaries,
  assetTitle,
  cleanName,
  collectionHeld,
  createCollection,
  deleteAsset,
  deleteCollection,
  finalizeUpload,
  getAsset,
  insertStoredAsset,
  kindOf,
  listAssets,
  listCollections,
  prepareUpload,
  rejectAsset,
  renameCollection,
  setAssetTags,
  setAssetTitle,
  setCollectionMember,
  storeGenerated,
} from '../src/assets'
import {
  configureAssetStorage,
  contentUrl,
  readContentToken,
} from '../src/storage'
import { buckets, memory, send } from './memory-storage'

/**
 * Assets against Postgres, with an in-memory storage standing in for R2 and
 * Drive (the real providers have their own suites in hq-storage). Runs only
 * with ASSETS_DB_TESTS=1 and a localhost DATABASE_URL — a throwaway database.
 */

const suite = dbTestsEnabled('ASSETS_DB_TESTS') ? describe : describe.skip
const TABLES = ['asset_collection_items', 'asset_collections', 'asset_assets']

test('kinds, names and paths', () => {
  expect(kindOf('image/png')).toBe('image')
  expect(kindOf('video/mp4')).toBe('video')
  expect(kindOf('application/pdf')).toBe('doc')
  expect(kindOf('application/octet-stream', 'brief.docx')).toBe('doc')
  expect(kindOf('application/zip', 'kit.zip')).toBe('other')
  expect(cleanName('../../etc/passwd')).toBe('passwd')
  expect(cleanName('  ปกหน้า   งาน.png ')).toBe('ปกหน้า งาน.png')
  expect(cleanName('..')).toBe('file')
  expect(assetPath({ slug: 'fog-line' }, 'Characters', 'mara.png')).toBe(
    'fog-line/Characters/mara.png',
  )
  expect(assetPath(null, null, 'x.png', '/root/')).toBe(
    'root/_hq/uploads/x.png',
  )
})

suite('hq-assets against Postgres', () => {
  let w: World

  beforeAll(() => {
    process.env.HQ_SEALING_KEY = randomBytes(32).toString('base64')
    configureAssetStorage({ providerOverride: (_owner, id) => memory(id) })
  })

  beforeEach(async () => {
    buckets.clear()
    w = await resetWorld(TABLES)
  })

  afterAll(async () => {
    configureAssetStorage({ providerOverride: null })
    await closeTestDb(TABLES)
  })

  async function upload(name: string, mime: string, body = randomBytes(64)) {
    const prepared = await prepareUpload(w.owner, {
      projectId: w.project.id,
      name,
      mime,
      bytes: body.byteLength,
    })
    send(prepared.asset.storageProvider, prepared.upload.key, body, mime)
    return { prepared, body }
  }

  test('prepare → send → finalize makes a ready asset with its hash', async () => {
    const { prepared, body } = await upload('cover.png', 'image/png')
    expect(prepared.asset.status).toBe('pending')
    expect(prepared.asset.storageProvider).toBe('r2')
    expect(prepared.asset.path).toBe('pilot/uploads/cover.png')
    const ready = await finalizeUpload(w.owner, {
      assetId: prepared.asset.id,
      width: 1080,
      height: 1920,
    })
    expect(ready.status).toBe('ready')
    expect(ready.readyAt).not.toBeNull()
    expect(ready.sha256).toBe(createHash('sha256').update(body).digest('hex'))
    expect(ready.width).toBe(1080)
    const again = await finalizeUpload(w.owner, { assetId: prepared.asset.id })
    expect(again.revision).toBe(ready.revision)
  })

  test('finalize without the bytes says so and leaves it pending', async () => {
    const prepared = await prepareUpload(w.owner, {
      projectId: w.project.id,
      name: 'lost.mov',
      mime: 'video/quicktime',
      bytes: 10,
    })
    const error = await failure(
      finalizeUpload(w.owner, { assetId: prepared.asset.id }),
    )
    expect(error.message).toContain('never arrived')
    const [row] = await w.db
      .select()
      .from(assetAssets)
      .where(eq(assetAssets.id, prepared.asset.id))
    expect(row?.status).toBe('pending')
  })

  test('the project’s storage choice wins over the owner’s default, and each asset keeps its own', async () => {
    await setStorageDefault(w.owner, {
      expectedRevision: 0,
      provider: 'gdrive',
    })
    const first = await prepareUpload(w.owner, {
      projectId: w.project.id,
      name: 'a.png',
      mime: 'image/png',
      bytes: 1,
    })
    expect(first.asset.storageProvider).toBe('gdrive')
    await w.db.execute(
      sql`update projects set storage_provider = 'r2' where id = ${w.project.id}`,
    )
    const second = await prepareUpload(w.owner, {
      projectId: w.project.id,
      name: 'b.png',
      mime: 'image/png',
      bytes: 1,
    })
    expect(second.asset.storageProvider).toBe('r2')
    const [kept] = await w.db
      .select()
      .from(assetAssets)
      .where(eq(assetAssets.id, first.asset.id))
    expect(kept?.storageProvider).toBe('gdrive')
  })

  test('a ready asset’s identity is frozen by the database; tags still change', async () => {
    const { prepared } = await upload('frozen.png', 'image/png')
    const ready = await finalizeUpload(w.owner, { assetId: prepared.asset.id })
    const error = await failure(
      w.db.execute(
        sql`update asset_assets set bytes = 1 where id = ${ready.id}`,
      ),
    )
    expect(pgError(error).message).toContain('immutable')
    const tagged = await setAssetTags(w.owner, {
      assetId: ready.id,
      expectedRevision: ready.revision,
      tags: ['Hero', 'hero', 'cover'],
    })
    expect(tagged.tags).toEqual(['hero', 'cover'])
  })

  test('a ready asset takes a title; the file keeps its name, and empty puts it back', async () => {
    const { prepared } = await upload('IMG_2231.png', 'image/png')
    const ready = await finalizeUpload(w.owner, { assetId: prepared.asset.id })
    const titled = await setAssetTitle(w.owner, {
      assetId: ready.id,
      expectedRevision: ready.revision,
      title: '  ฉากหมอก   take 2 ',
    })
    expect(titled.title).toBe('ฉากหมอก take 2')
    expect(titled.name).toBe('IMG_2231.png')
    expect(titled.storageKey).toBe(ready.storageKey)
    expect(titled.status).toBe('ready')
    expect(assetTitle(titled)).toBe('ฉากหมอก take 2')
    // Search finds it by the new title, and by the file name still.
    const byTitle = await listAssets(w.owner, { query: 'หมอก' })
    expect(byTitle.assets.map((asset) => asset.id)).toEqual([ready.id])
    const byName = await listAssets(w.owner, { query: 'IMG_2231' })
    expect(byName.assets.map((asset) => asset.id)).toEqual([ready.id])
    // An old revision is a conflict; the same title again changes nothing.
    const stale = await failure(
      setAssetTitle(w.owner, {
        assetId: ready.id,
        expectedRevision: ready.revision,
        title: 'Other',
      }),
    )
    expect(stale.code).toBe('conflict')
    const same = await setAssetTitle(w.owner, {
      assetId: ready.id,
      expectedRevision: titled.revision,
      title: 'ฉากหมอก take 2',
    })
    expect(same.revision).toBe(titled.revision)
    // Empty — or the file name itself — shows the file name again.
    const cleared = await setAssetTitle(w.owner, {
      assetId: ready.id,
      expectedRevision: titled.revision,
      title: '',
    })
    expect(cleared.title).toBeNull()
    expect(assetTitle(cleared)).toBe('IMG_2231.png')
    const asName = await setAssetTitle(w.owner, {
      assetId: ready.id,
      expectedRevision: cleared.revision,
      title: 'IMG_2231.png',
    })
    expect(asName.title).toBeNull()
    // A download still saves under the file name.
    const access = await assetAccess(w.owner, {
      assetId: ready.id,
      download: true,
    })
    expect(access.asset.name).toBe('IMG_2231.png')
    // A reader can't rename; someone else's asset reads as not found.
    const readerTry = await failure(
      setAssetTitle(w.reader, {
        assetId: ready.id,
        expectedRevision: cleared.revision,
        title: 'Mine',
      }),
    )
    expect(readerTry.code).not.toBe('conflict')
    const strangerTry = await failure(
      setAssetTitle(w.stranger, {
        assetId: ready.id,
        expectedRevision: cleared.revision,
        title: 'Mine',
      }),
    )
    expect(strangerTry.code).toBe('not_found')
    // The database refuses a blank title written around the service.
    const blank = await failure(
      w.db.execute(
        sql`update asset_assets set title = '   ' where id = ${ready.id}`,
      ),
    )
    expect(pgError(blank).message).toContain('asset_assets_title_check')
  })

  test('reject is for pending uploads only, and deletes what arrived', async () => {
    const { prepared } = await upload('draft.png', 'image/png')
    const rejected = await rejectAsset(w.owner, {
      assetId: prepared.asset.id,
      reason: 'wrong file',
    })
    expect(rejected.status).toBe('rejected')
    expect(buckets.get('r2')?.has(prepared.upload.key)).toBe(false)
    const { prepared: other } = await upload('keep.png', 'image/png')
    const ready = await finalizeUpload(w.owner, { assetId: other.asset.id })
    const refused = await failure(rejectAsset(w.owner, { assetId: ready.id }))
    expect(refused.message).toContain('frozen')
  })

  test('only the owner deletes, and the links go with it', async () => {
    await allowAgent(w, ['draft'])
    const { prepared } = await upload('gone.png', 'image/png')
    const ready = await finalizeUpload(w.owner, { assetId: prepared.asset.id })
    await withTransaction((tx) =>
      link(
        tx,
        w.owner,
        { type: 'note', id: crypto.randomUUID() },
        { type: 'asset', id: ready.id },
        'attached',
      ),
    )
    const agentTry = await failure(deleteAsset(w.agent, ready.id))
    expect(agentTry.code).toBe('forbidden')
    await deleteAsset(w.owner, ready.id)
    expect(await w.db.select().from(assetAssets)).toHaveLength(0)
    expect(await w.db.select().from(refs)).toHaveLength(0)
    expect(buckets.get('r2')?.size).toBe(0)
  })

  test('an agent uploads under the owner’s policy; a reader only reads', async () => {
    const blocked = await failure(
      prepareUpload(w.agent, {
        projectId: w.project.id,
        name: 'x.png',
        mime: 'image/png',
        bytes: 1,
      }),
    )
    expect(blocked.code).toBe('policy_blocked')
    await allowAgent(w, ['draft'])
    const prepared = await prepareUpload(w.agent, {
      projectId: w.project.id,
      name: 'x.png',
      mime: 'image/png',
      bytes: 1,
    })
    expect(prepared.asset.actorType).toBe('agent')
    const readerTry = await failure(
      prepareUpload(w.reader, {
        projectId: w.project.id,
        name: 'y.png',
        mime: 'image/png',
        bytes: 1,
      }),
    )
    expect(readerTry.code).toBe('forbidden')
    expect(
      (
        await listAssets(w.reader, {
          projectId: w.project.id,
          status: 'pending',
        })
      ).total,
    ).toBe(1)
  })

  test('someone else’s asset reads as not found', async () => {
    const { prepared } = await upload('mine.png', 'image/png')
    const error = await failure(getAsset(w.stranger, prepared.asset.id))
    expect(error.code).toBe('not_found')
  })

  test('collections file assets of their own project; lists filter by them', async () => {
    const characters = await createCollection(w.owner, {
      projectId: w.project.id,
      name: 'Characters',
      kind: 'characters',
    })
    const dup = await failure(
      createCollection(w.owner, {
        projectId: w.project.id,
        name: 'characters',
      }),
    )
    expect(dup.message).toContain('already exists')
    const { prepared } = await upload('mara.png', 'image/png')
    const ready = await finalizeUpload(w.owner, { assetId: prepared.asset.id })
    await upload('other.png', 'image/png')
    await setCollectionMember(w.owner, {
      collectionId: characters.id,
      assetId: ready.id,
      member: true,
    })
    const listed = await listAssets(w.owner, {
      projectId: w.project.id,
      collectionId: characters.id,
    })
    expect(listed.assets.map((asset) => asset.id)).toEqual([ready.id])
    expect(listed.assets[0]?.collectionIds).toEqual([characters.id])
    const [counted] = await listCollections(w.owner, w.project.id)
    expect(counted?.count).toBe(1)
  })

  test('the owner renames and deletes a collection; its files stay', async () => {
    await allowAgent(w, ['draft'])
    const shelf = await createCollection(w.owner, {
      projectId: w.project.id,
      name: 'Refs',
      kind: 'refs',
    })
    await createCollection(w.owner, { projectId: w.project.id, name: 'Moods' })
    const { prepared } = await upload('ref.png', 'image/png')
    const ready = await finalizeUpload(w.owner, { assetId: prepared.asset.id })
    await setCollectionMember(w.owner, {
      collectionId: shelf.id,
      assetId: ready.id,
      member: true,
    })

    const agentRename = await failure(
      renameCollection(w.agent, {
        collectionId: shelf.id,
        expectedRevision: shelf.revision,
        name: 'References',
      }),
    )
    expect(agentRename.code).toBe('forbidden')
    const taken = await failure(
      renameCollection(w.owner, {
        collectionId: shelf.id,
        expectedRevision: shelf.revision,
        name: 'moods',
      }),
    )
    expect(taken.message).toContain('already exists')
    const renamed = await renameCollection(w.owner, {
      collectionId: shelf.id,
      expectedRevision: shelf.revision,
      name: 'References',
    })
    expect(renamed.name).toBe('References')
    expect(renamed.revision).toBe(shelf.revision + 1)
    const stale = await failure(
      renameCollection(w.owner, {
        collectionId: shelf.id,
        expectedRevision: shelf.revision,
        name: 'Refs again',
      }),
    )
    expect(stale.code).toBe('conflict')

    const agentDelete = await failure(deleteCollection(w.agent, shelf.id))
    expect(agentDelete.code).toBe('forbidden')
    expect(await deleteCollection(w.owner, shelf.id)).toEqual({ files: 1 })
    expect(
      (await listCollections(w.owner, w.project.id)).map((c) => c.name),
    ).toEqual(['Moods'])
    const kept = await getAsset(w.owner, ready.id)
    expect(kept.asset.status).toBe('ready')
    expect(kept.collections).toHaveLength(0)
    const gone = await failure(deleteCollection(w.owner, shelf.id))
    expect(gone.code).toBe('not_found')
  })

  test('a collection HQ files into keeps its name and stays', async () => {
    const stored = await storeGenerated(w.owner, w.project, {
      name: 'Q-2026-002.pdf',
      mime: 'application/pdf',
      body: new TextEncoder().encode('%PDF-1.7') as Uint8Array<ArrayBuffer>,
      collection: 'Quotes',
    })
    await withTransaction((tx) =>
      insertStoredAsset(tx, w.owner, w.project, stored, {
        collection: 'Quotes',
      }),
    )
    const [quotes] = await listCollections(w.owner, w.project.id)
    if (!quotes) throw new Error('no Quotes collection')
    expect(collectionHeld(quotes)).toContain('keeps its name')
    const rename = await failure(
      renameCollection(w.owner, {
        collectionId: quotes.id,
        expectedRevision: quotes.revision,
        name: 'Invoices',
      }),
    )
    expect(rename.message).toContain('keeps its name')
    const remove = await failure(deleteCollection(w.owner, quotes.id))
    expect(remove.message).toContain('stays')
    expect(await listCollections(w.owner, w.project.id)).toHaveLength(1)
  })

  test('a server-made file is stored, then recorded ready inside the caller’s transaction', async () => {
    const pdf = new TextEncoder().encode(
      '%PDF-1.7 test',
    ) as Uint8Array<ArrayBuffer>
    const stored = await storeGenerated(w.owner, w.project, {
      name: 'Q-2026-001.pdf',
      mime: 'application/pdf',
      body: pdf,
      collection: 'Quotes',
    })
    expect(stored.path).toBe('pilot/Quotes/Q-2026-001.pdf')
    const asset = await withTransaction((tx) =>
      insertStoredAsset(tx, w.owner, w.project, stored, {
        collection: 'Quotes',
        tags: ['quote'],
      }),
    )
    expect(asset.status).toBe('ready')
    expect(asset.kind).toBe('doc')
    expect(asset.origin).toBe('generated')
    const [collection] = await listCollections(w.owner, w.project.id)
    expect(collection?.name).toBe('Quotes')
    const summary = (await assetSummaries(w.owner)).find(
      (row) => row.projectId === w.project.id,
    )
    expect(summary?.ready).toBe(1)
  })

  test('access links need a ready file', async () => {
    const { prepared } = await upload('link.png', 'image/png')
    const pending = await failure(
      assetAccess(w.owner, { assetId: prepared.asset.id }),
    )
    expect(pending.message).toContain('finished uploading')
    await finalizeUpload(w.owner, { assetId: prepared.asset.id })
    const access = await assetAccess(w.owner, {
      assetId: prepared.asset.id,
      ttlSeconds: 120,
    })
    expect(access.url).toStartWith('memory://')
  })

  test('content tokens are sealed, owner-bound and expire', () => {
    const url = contentUrl(
      { o: w.owner.userId, p: 'gdrive', k: 'file-id-1', f: 'ปก.png' },
      60,
    )
    const token = decodeURIComponent(url.split('?t=')[1] ?? '')
    const claim = readContentToken(token)
    expect(claim?.o).toBe(w.owner.userId)
    expect(claim?.k).toBe('file-id-1')
    expect(claim?.f).toBe('ปก.png')
    expect(readContentToken(`${token.slice(0, -2)}xx`)).toBeNull()
    const expired = contentUrl({ o: w.owner.userId, p: 'gdrive', k: 'k' }, -5)
    expect(
      readContentToken(decodeURIComponent(expired.split('?t=')[1] ?? '')),
    ).toBeNull()
  })
})
