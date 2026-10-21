import { type AssetSummary, assetSummaries } from '@theiceji/hq-assets/assets'
import { getGoogleConnection } from '@theiceji/hq-core/google'
import { listProjects } from '@theiceji/hq-core/projects'
import { getOwnerSettings } from '@theiceji/hq-core/settings'
import type { StorageProviderId } from '@theiceji/hq-db/enums'
import { storageReadiness } from '@theiceji/hq-storage/config'
import { normalizePrefix } from '@theiceji/hq-storage/keys'
import type { Metadata } from 'next'
import Link from 'next/link'
import { Dot, Name } from '@/components/bridge/parts'
import { currentActor } from '@/lib/actions'
import { TabKeys } from '../forms'
import { Bar, bytesText, Group } from '../parts'
import { driveUnavailable } from './drive'
import { StorageForm } from './StorageForm'

export const metadata: Metadata = { title: 'Storage — Settings — HQ' }
export const dynamic = 'force-dynamic'

const SHORT: Record<StorageProviderId, string> = {
  r2: 'R2',
  gdrive: 'Google Drive',
}

/**
 * Where a project's files land, as a path: R2 keys start with the owner's
 * prefix, then the root, slugged as the keys are; Drive folders sit in HQ's.
 */
function place(
  provider: StorageProviderId,
  root: string | null,
  slug: string,
  ownerId: string,
) {
  const base = root?.replace(/^\/+|\/+$/g, '') ?? ''
  if (provider === 'gdrive')
    return `${base ? `folder ${base.slice(0, 8)}…` : 'TheIceJi HQ'}/${slug}/…`
  return `${ownerId.slice(0, 8)}…/${normalizePrefix([base, slug].filter(Boolean).join('/'))}/…`
}

/**
 * Settings › Storage: the owner's default
 * provider and root for new files (hq-core settings), then every project
 * with the provider it resolves to and what it stores. Sizes come from
 * `ready` assets only (hq-assets `assetSummaries`); when they can't be read
 * the column says "not known", and a project with nothing stored reads 0. A
 * project's own provider is changed on Projects, which owns that editor.
 */
export default async function StorageSettingsPage() {
  const actor = await currentActor()
  const [settings, projects, summaries, google] = await Promise.all([
    getOwnerSettings(actor),
    listProjects(actor, { includeArchived: true }),
    assetSummaries(actor).catch((): AssetSummary[] | null => null),
    getGoogleConnection(actor).catch(() => undefined),
  ])
  const driveWhy = driveUnavailable(google)
  const r2 = storageReadiness()
  const r2Why = r2.ok
    ? null
    : `R2 isn’t set up on this server. Set ${r2.missing.join(', ')}.`
  const summary = (projectId: string | null) =>
    summaries
      ? (summaries.find((entry) => entry.projectId === projectId) ?? null)
      : undefined
  const loose = summary(null)
  const ready = summaries?.reduce((sum, entry) => sum + entry.bytes, 0) ?? null
  const readyCount =
    summaries?.reduce((sum, entry) => sum + entry.ready, 0) ?? null
  const pending =
    summaries?.reduce((sum, entry) => sum + entry.pending, 0) ?? null

  const rows = projects.map((project) => {
    const own = project.storageProvider
    const provider = own ?? settings.storageProvider
    const root = own ? project.storageRoot : settings.storageRoot
    return { project, own, provider, root, stored: summary(project.id) }
  })

  const readyCell = (stored: AssetSummary | null | undefined) =>
    stored === undefined
      ? 'not known'
      : stored === null
        ? '0'
        : `${stored.ready} · ${bytesText(stored.bytes)}${stored.pending ? ` · ${stored.pending} pending` : ''}`

  return (
    <>
      <TabKeys keys={[['s', 'save the default']]} />
      <Bar
        items={[
          ['storage', 'owner'],
          [
            'default',
            SHORT[settings.storageProvider],
            settings.storageProvider === 'gdrive' && driveWhy ? 'wait' : '',
          ],
          ['root', settings.storageRoot ?? '—'],
          [
            'ready',
            ready === null
              ? 'not known'
              : `${readyCount} · ${bytesText(ready)}`,
            ready === null ? 'accent' : '',
          ],
          ['pending', pending ?? 'not known'],
          ['projects', projects.length],
        ]}
      />
      {settings.storageProvider === 'gdrive' && driveWhy ? (
        <p className='why' role='alert'>
          <b>Why uploads to Google Drive wait:</b> {driveWhy}
        </p>
      ) : null}
      <StorageForm
        initial={{
          provider: settings.storageProvider,
          root: settings.storageRoot,
          revision: settings.revision,
        }}
        driveWhy={driveWhy}
        r2Why={r2Why}
      />
      <Group
        id='projects'
        title='Per project'
        description='The provider each project resolves to, where its files land and what is stored there. Sizes count ready files only.'
        foot={
          <>
            <Link className='btn' href='/projects'>
              Change a project’s storage on Projects
            </Link>
            <span className='st'>
              a project without its own choice follows the default
            </span>
          </>
        }
      >
        {rows.length === 0 && !loose ? (
          <div className='empty'>○ no projects yet</div>
        ) : (
          <div className='tbl store-tbl'>
            <div className='tbl-head' aria-hidden='true'>
              <span className='hud-label'>Project</span>
              <span className='hud-label'>Provider</span>
              <span className='hud-label c-hide'>Files land in</span>
              <span className='hud-label num'>Ready</span>
            </div>
            {rows.map(({ project, own, provider, root, stored }) => (
              <div
                key={project.id}
                className={`tbl-row${project.status === 'archived' ? ' dim' : ''}`}
              >
                <span className='tag'>
                  <Dot color={project.color} />
                  <Link
                    href={`/projects?${project.status === 'archived' ? 'view=archived&' : ''}id=${project.id}`}
                    title={`Open ${project.name} on Projects`}
                  >
                    <Name text={project.name} />
                  </Link>
                  {project.status === 'archived' ? (
                    <span className='state-word'>archived</span>
                  ) : null}
                </span>
                <span className='mono'>
                  {own ? SHORT[provider] : `default · ${SHORT[provider]}`}
                </span>
                <span className='mono c-hide'>
                  {place(provider, root, project.slug, actor.userId)}
                </span>
                <span
                  className={`num${stored === undefined ? ' unknown' : ''}`}
                >
                  {readyCell(stored)}
                </span>
              </div>
            ))}
            {loose ? (
              <div className='tbl-row'>
                <span>No project</span>
                <span className='mono'>
                  default · {SHORT[settings.storageProvider]}
                </span>
                <span className='mono c-hide'>
                  {place(
                    settings.storageProvider,
                    settings.storageRoot,
                    '_hq',
                    actor.userId,
                  )}
                </span>
                <span className='num'>{readyCell(loose)}</span>
              </div>
            ) : null}
          </div>
        )}
      </Group>
      <Group id='rules' title='Rules'>
        <div className='dev-rows'>
          <div className='dev-row'>
            <span className='t'>
              Every file goes upload → pending → ready or rejected. A ready file
              never changes.
            </span>
          </div>
          <div className='dev-row'>
            <span className='t'>
              Each file remembers the provider it was written to; changing a
              default never moves it.
            </span>
          </div>
          <div className='dev-row'>
            <span className='t'>
              Downloads use a short-lived link, never the bucket path or a Drive
              share.
            </span>
          </div>
        </div>
      </Group>
    </>
  )
}
