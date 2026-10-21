import { afterAll, beforeAll, expect, test } from 'bun:test'
import { storageFor } from '@theiceji/hq-storage'
import { isThumbnailKey, thumbnailPath } from '../src/assets'

/**
 * A video's still: the key the browser hands back to `setThumbnail` must be
 * the one R2 minted for `prepareThumbnail`. The key comes from the real R2
 * provider — presigning is local signing, and the env is made up, so nothing
 * reaches the network.
 */

const ENV = {
  R2_ACCOUNT_ID: '0123456789abcdef0123456789abcdef',
  R2_ACCESS_KEY_ID: 'test-access-key',
  R2_SECRET_ACCESS_KEY: 'test-secret-key',
  R2_BUCKET: 'hq-test-bucket',
}
const saved = new Map<string, string | undefined>()

beforeAll(() => {
  for (const [name, value] of Object.entries(ENV)) {
    saved.set(name, process.env[name])
    process.env[name] = value
  }
})

afterAll(() => {
  for (const [name, value] of saved) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
})

const OWNER = '0b8e7c1e-1111-4222-8333-944445555666'
const OTHER = '7d2f0a93-aaaa-4bbb-8ccc-0ddd1eee2fff'
const ASSET = '3c4d5e6f-0000-4111-8222-933344445555'

async function mintedKey(ownerId: string, assetId: string) {
  const upload = await storageFor('r2', { ownerId }).prepareUpload({
    path: thumbnailPath(assetId),
    mime: 'image/jpeg',
    bytes: 1024,
  })
  return upload.key
}

test('the key R2 mints for a still is the one setThumbnail takes', async () => {
  const key = await mintedKey(OWNER, ASSET)
  expect(key.startsWith(`${OWNER}/thumbs/`)).toBe(true)
  expect(isThumbnailKey(OWNER, ASSET, key)).toBe(true)
})

test('a still for another owner or another asset is refused', async () => {
  const key = await mintedKey(OWNER, ASSET)
  expect(isThumbnailKey(OTHER, ASSET, key)).toBe(false)
  expect(isThumbnailKey(OWNER, OTHER, key)).toBe(false)
  expect(isThumbnailKey(OTHER, ASSET, await mintedKey(OTHER, ASSET))).toBe(true)
})

test('a key that climbs out of the owner’s prefix is refused', () => {
  expect(
    isThumbnailKey(
      OWNER,
      ASSET,
      `${OWNER}/thumbs/../../${OTHER}/thumbs/2026/09/0123456789abcdef-${ASSET}.jpg`,
    ),
  ).toBe(false)
  // The old unprefixed shape is not a key HQ issues any more.
  expect(
    isThumbnailKey(
      OWNER,
      ASSET,
      `thumbs/2026/09/0123456789abcdef-${ASSET}.jpg`,
    ),
  ).toBe(false)
})
