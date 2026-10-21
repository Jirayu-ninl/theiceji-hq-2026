import { registerTarget } from '@theiceji/hq-core/targets'
import { EXP_SUBJECT_TYPES } from '@theiceji/hq-db/enums'
import { choice, text } from '@theiceji/hq-ops/schemas'
import { z } from 'zod'
import { insertExperiment } from './experiments'

/**
 * What Experiments adds to HQ's registries when it loads (import once per
 * process that accepts proposals): the `experiment` target — an agent's
 * accepted proposal of a new draft experiment. It lands as a
 * draft; starting it, adding items and deciding stay the owner's.
 */

export const experimentHref = (slug: string, experimentId: string) =>
  `/p/${slug}/experiments?experiment=${experimentId}`

registerTarget({
  type: 'experiment',
  module: 'experiments',
  label: 'Experiments · experiment',
  schema: z.object({
    question: text.required('Question', 400),
    hypothesis: text.optional('Hypothesis', 4000),
    subjectType: choice(EXP_SUBJECT_TYPES, 'Compare posts or listings.'),
    metric: z.string().trim().toLowerCase().min(1).max(40),
    readAtHours: z.number().int().min(1).max(8760).optional(),
    variants: z
      .array(
        z.object({
          label: text.required('Variant label', 40),
          description: text.optional('Variant description', 2000),
        }),
      )
      .max(8)
      .optional(),
  }),
  async create(payload, { tx, actor, project }) {
    if (!project) throw new Error('An experiment belongs to a project.')
    const experiment = await insertExperiment(tx, actor, project, {
      question: payload.question as string,
      hypothesis: payload.hypothesis,
      subjectType: payload.subjectType,
      metric: payload.metric,
      readAtHours: payload.readAtHours,
      variants: payload.variants?.map((variant) => ({
        label: variant.label as string,
        description: variant.description,
      })),
    })
    return {
      type: 'experiment',
      id: experiment.id,
      href: experimentHref(project.slug, experiment.id),
    }
  },
})
