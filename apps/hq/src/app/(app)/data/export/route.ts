import { requireApiUser } from '@theiceji/hq-auth'
import { getDb } from '@theiceji/hq-db'
import {
  buildBundle,
  exportFilename,
  exportSet,
  exportSets,
  findOwnProject,
  readSet,
  toCsv,
} from '@/lib/data-export'

/**
 * GET /data/export?set=<id>&format=csv|json[&project=<slug>] — one set of the
 * owner's records as a file; `set=all&format=json` is everything in one file.
 * Every read is the signed-in owner's own rows, and a
 * project is looked up among the owner's projects before it scopes anything.
 * Credentials and raw storage keys are never in the file (lib/data-export.ts).
 */
export const dynamic = 'force-dynamic'

const fail = (status: number, error: string, message: string) =>
  Response.json(
    { ok: false, error, message },
    { status, headers: { 'Cache-Control': 'no-store' } },
  )

export async function GET(request: Request) {
  const user = await requireApiUser()
  if (!user) return fail(401, 'unauthorized', 'Sign in to export your data.')
  const db = getDb()
  if (!db) return fail(503, 'not_configured', 'The database isn’t set up.')

  const params = new URL(request.url).searchParams
  const setId = params.get('set') ?? ''
  const format = params.get('format') ?? 'csv'
  const slug = params.get('project')
  if (format !== 'csv' && format !== 'json')
    return fail(400, 'bad_format', 'The format is csv or json.')
  const everything = setId === 'all'
  const set = everything ? null : exportSet(setId)
  if (!everything && !set)
    return fail(400, 'unknown_set', `There is no set called “${setId}”.`)
  if (everything && format !== 'json')
    return fail(400, 'everything_is_json', 'Everything comes as one JSON file.')

  const project = slug ? await findOwnProject(db, user.id, slug) : null
  if (slug && !project)
    return fail(404, 'unknown_project', `You have no project “${slug}”.`)
  if (set && project && !set.projectScoped)
    return fail(
      400,
      'not_by_project',
      `${set.label} belongs to no project — export it for all projects.`,
    )

  const now = new Date()
  const scope = project?.slug ?? 'all'
  let body: string
  let type: string
  let name: string
  if (set && format === 'csv') {
    const rows = await readSet(db, user.id, set.id, project?.id ?? null)
    body = toCsv(set.columns, rows)
    type = 'text/csv; charset=utf-8'
    name = exportFilename(set.id, scope, 'csv', now)
  } else {
    const ids = set ? [set.id] : exportSets().map((entry) => entry.id)
    const bundle = await buildBundle(
      db,
      user.id,
      ids,
      project
        ? { id: project.id, slug: project.slug, name: project.name }
        : null,
      now,
    )
    body = `${JSON.stringify(bundle, null, 2)}\n`
    type = 'application/json; charset=utf-8'
    name = exportFilename(set ? set.id : 'everything', scope, 'json', now)
  }
  return new Response(body, {
    headers: {
      'Content-Type': type,
      'Content-Disposition': `attachment; filename="${name}"; filename*=UTF-8''${encodeURIComponent(name)}`,
      'Cache-Control': 'private, no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
