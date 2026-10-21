import { describe, expect, test } from 'bun:test'
import {
  isStorageProvider,
  STORAGE_PROVIDERS,
  type StorageProviderId,
  storageFor,
} from '../src/provider'
import { pathSegments, splitPath } from '../src/providers/shared'
import { StorageError } from '../src/r2'

/** Choosing a provider, and the path rules both share. */

function thrown(work: () => unknown): StorageError {
  try {
    work()
  } catch (error) {
    if (error instanceof StorageError) return error
    throw error
  }
  throw new Error('Expected a StorageError.')
}

const gdrive = {
  accessToken: async () => 'token',
  rootFolderId: 'root',
  accessUrl: async () => 'https://hq.example.test/x',
  fetch: async () => new Response('unexpected', { status: 599 }),
}

describe('storageFor', () => {
  test('gdrive without a Google connection explains it is not connected', () => {
    for (const ctx of [
      { ownerId: 'owner-1' },
      { ownerId: 'owner-1', gdrive: null },
      { ownerId: 'owner-1', gdrive: { ...gdrive, rootFolderId: '' } },
    ]) {
      const error = thrown(() => storageFor('gdrive', ctx))
      expect(error.status).toBe(503)
      expect(error.code).toBe('NotConnected')
      expect(error.message).toContain('Google Drive is not connected')
    }
  })

  test('refuses a missing owner and an unknown provider', () => {
    expect(thrown(() => storageFor('r2', { ownerId: '' })).code).toBe(
      'MissingOwner',
    )
    const unknown = thrown(() =>
      storageFor('s3' as StorageProviderId, { ownerId: 'owner-1' }),
    )
    expect(unknown.status).toBe(400)
    expect(unknown.code).toBe('UnknownProvider')
  })

  test('builds each provider without touching the network', () => {
    const drive = storageFor('gdrive', { ownerId: 'owner-1', gdrive })
    expect(drive.id).toBe('gdrive')
    expect(typeof drive.thumbnail).toBe('function')
    // R2 reads env lazily, so building it never fails.
    expect(storageFor('r2', { ownerId: 'owner-1' }).id).toBe('r2')
  })

  test('isStorageProvider matches STORAGE_PROVIDERS', () => {
    expect([...STORAGE_PROVIDERS]).toEqual(['r2', 'gdrive'])
    expect(isStorageProvider('gdrive')).toBe(true)
    expect(isStorageProvider('s3')).toBe(false)
    expect(isStorageProvider(undefined)).toBe(false)
  })
})

describe('paths', () => {
  test('drop empty segments and keep names as written', () => {
    expect(pathSegments('/acme//ภาพ ปก/ ')).toEqual(['acme', 'ภาพ ปก'])
    expect(splitPath('acme/boards/Hero Shot.png')).toEqual({
      folders: ['acme', 'boards'],
      name: 'Hero Shot.png',
    })
  })

  test('refuse dot segments, control characters and a missing name', () => {
    for (const path of ['a/../b.png', './b.png', 'a/b\u0000.png']) {
      expect(thrown(() => pathSegments(path)).code).toBe('InvalidPath')
    }
    expect(thrown(() => splitPath('///')).code).toBe('InvalidPath')
    expect(thrown(() => splitPath(undefined)).code).toBe('InvalidPath')
  })
})
