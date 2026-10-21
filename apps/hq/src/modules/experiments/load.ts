import 'server-only'
import { subjectProviders } from '@theiceji/hq-core/readings'
import type { ProjectRow } from '@theiceji/hq-db/schema'
import {
  listExperiments,
  readExperiment,
  searchLearnings,
} from '@theiceji/hq-experiments/experiments'
import type { Actor } from '@theiceji/hq-ops/access'
import { withReader } from '@theiceji/hq-ops/store'
import type { ExperimentsPageProps } from './components/ExperimentsPage'
import {
  type ExperimentData,
  experimentData,
  experimentRowData,
  learningData,
} from './data'
// The subject providers Experiments reads posts and listings through.
import '@/modules/register'

/**
 * What the Experiments page reads on the server: the project's experiments,
 * the selected one read at its age now, learnings, and the posts and
 * listings that went out — the "add an item" picker.
 */
export async function loadExperiments(
  actor: Actor,
  project: ProjectRow,
  params: { view?: string; experiment?: string; q?: string },
): Promise<ExperimentsPageProps> {
  const [rows, learnings, subjects] = await Promise.all([
    listExperiments(actor, {
      projectId: project.id,
      status: ['draft', 'running', 'reading', 'decided', 'archived'],
    }),
    searchLearnings(actor, {
      q: params.q,
      includeRetired: true,
      limit: 200,
    }),
    withReader(async (db) =>
      Promise.all(
        subjectProviders().map(async (provider) =>
          (
            await provider.list(db, actor.userId, {
              projectId: project.id,
              limit: 100,
            })
          )
            .filter((subject) => subject.wentOutAt)
            .map((subject) => ({
              type: subject.type,
              id: subject.id,
              title: subject.title,
              where: subject.where,
              wentOutAt: subject.wentOutAt?.toISOString() ?? null,
            })),
        ),
      ).then((lists) => lists.flat()),
    ),
  ])
  const selected =
    params.experiment ??
    rows.find((row) => row.status === 'reading')?.id ??
    rows.find((row) => row.status === 'running')?.id ??
    rows[0]?.id ??
    null
  let detail: ExperimentData | null = null
  if (selected) {
    try {
      detail = experimentData(await readExperiment(actor, selected))
    } catch {
      detail = null
    }
  }
  return {
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      color: project.color,
      status: project.status,
    },
    experiments: rows.map(experimentRowData),
    detail,
    learnings: learnings.map(learningData),
    subjects,
    view: params.view === 'learnings' ? 'learnings' : 'experiments',
    query: params.q ?? '',
  }
}
