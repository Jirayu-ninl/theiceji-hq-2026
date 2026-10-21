import 'server-only'
import { listProjects } from '@theiceji/hq-core/projects'
import type { Actor } from '@theiceji/hq-ops/access'
import { promoteTargets } from '@/lib/notes/promote'
import { listNotes, purgeExpired } from '@/lib/notes/store'
import type { NoteView } from '@/lib/notes/types'
import type { NotesPageProps } from './components/NotesPage'

/**
 * What `/notes` reads on the server: the notes in the view's bucket (Board
 * and List show the parked ones; Archive and Trash keep what the legacy board
 * put there, restorable), the owner's projects to file them under, and what
 * each project can take when a note is promoted, straight from the target
 * registry.
 */
export async function loadNotes(
  actor: Actor,
  params: { view?: string; note?: string; open?: string; new?: string },
): Promise<NotesPageProps> {
  // The 30-day sweep runs on the board's own load rather than a cron: a
  // note only expires with someone here to see the trash empty out.
  await purgeExpired(actor.userId)
  const view =
    params.view === 'list' ||
    params.view === 'archive' ||
    params.view === 'trash'
      ? params.view
      : 'board'
  const bucket: NoteView =
    view === 'archive' || view === 'trash' ? view : 'active'
  const [notes, projects] = await Promise.all([
    listNotes(actor.userId, { view: bucket }),
    listProjects(actor),
  ])
  return {
    notes,
    projects: projects.map((project) => ({
      id: project.id,
      slug: project.slug,
      name: project.name,
      color: project.color,
      kind: project.kind,
    })),
    targets: [
      { projectId: null, targets: promoteTargets(null) },
      // An archived project keeps its notes but takes no new work.
      ...projects.map((project) => ({
        projectId: project.id,
        targets: project.status === 'archived' ? [] : promoteTargets(project),
      })),
    ],
    view,
    selectedId: params.note?.trim() || params.open?.trim() || null,
    // `?new=1` — the "Jot a note" shortcut (NOTE_CAPTURE_HREF) — opens the
    // New note form, as `c` does.
    startNew: params.new === '1',
  }
}
