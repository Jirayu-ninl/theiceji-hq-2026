import { dashboard, readingsQuery } from '@theiceji/hq-readings/readings'
import { z } from 'zod'
import { defineTool, defineWorkspace } from '../../kernel'
import { defined, idArg, projectIdArg, READ, readTool } from '../support'

/**
 * `readings` — numbers, compared fairly: posts or listings read
 * at the same age, and — with `money_days` — what money happened. Readings
 * owns nothing; it reads Publish, Market and Board through HQ's registry.
 */

export const readingsQueryTool = defineTool({
  name: 'query',
  title: 'Read posts or listings at an age',
  description:
    'Posts or listings — named by id, or a project’s newest — with each metric at age_hours after it went out (or to date without it). A missing number is a word: too_young (with ready_at), not_read, or not_out — never 0. With money_days: also the money of the last N days per currency (sales, refunds, fees, earnings, paid cards, net) and the N days before.',
  scope: 'readings:read',
  input: z.object({
    subject_type: z.enum(['post', 'listing']),
    ids: z.array(idArg('Item')).max(100).optional(),
    project_id: projectIdArg.optional(),
    metrics: z
      .array(z.string().max(40))
      .min(1)
      .max(8)
      .describe(
        'post: views, likes, comments, shares, saves, watch_seconds, earnings … · listing: sales, gross, net.',
      ),
    age_hours: z.number().int().min(1).max(8760).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    money_days: z.number().int().min(1).max(365).optional(),
  }),
  annotations: READ,
  run: (args, context) =>
    readTool(
      context,
      async (actor) => {
        const [rows, money] = await Promise.all([
          readingsQuery(
            actor,
            defined({
              subjectType: args.subject_type,
              ids: args.ids,
              projectId: args.project_id,
              metrics: args.metrics,
              ageHours: args.age_hours,
              limit: args.limit,
            }) as Parameters<typeof readingsQuery>[1],
          ),
          args.money_days
            ? dashboard(
                actor,
                defined({
                  projectId: args.project_id,
                  days: args.money_days,
                  subjectsPerProject: 0,
                }),
              )
            : Promise.resolve(null),
        ])
        return { rows, money }
      },
      ({ rows, money }) => ({
        text: `${rows.rows.length} item(s)${rows.ageHours ? ` at ${rows.ageHours}h` : ' to date'}${money ? `; money over ${money.days} days: ${money.total.map((line) => `${line.net} ${line.currency}`).join(' + ') || 'none recorded'}` : ''}.`,
        data: {
          age_hours: rows.ageHours,
          read_at: rows.readAt,
          items: rows.rows.map((row) => ({
            type: row.type,
            id: row.id,
            project_id: row.projectId,
            title: row.title,
            where: row.where,
            status: row.status,
            went_out_at: row.wentOutAt,
            readings: row.readings,
          })),
          money: money
            ? {
                days: money.days,
                total: money.total,
                previous: money.previousTotal,
                cost: money.cost,
                cost_unknown: money.costUnknown,
              }
            : null,
        },
      }),
    ),
})

export const readings = defineWorkspace({
  id: 'readings',
  label: 'Readings',
  description:
    'Posts and listings compared at the same age, and the money that happened.',
  instructions:
    'Compare like with like: pass age_hours. A missing number is a word, never 0.',
  tools: [readingsQueryTool],
})
