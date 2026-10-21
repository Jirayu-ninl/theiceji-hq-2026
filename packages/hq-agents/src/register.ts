import '@theiceji/hq-core/notes'
import { registerTickStep } from '@theiceji/hq-ops/runtime'
import { expireProposals } from './proposals'
import { queueDueRoutines } from './routines'

/**
 * What Agents adds to HQ's shared registries when it loads — import this once
 * in every process that runs module services (apps/hq, apps/hq-mcp,
 * apps/agent-runner):
 *
 * · the ops tick's `agents.routines` pass — due routines queue one run each;
 * · the `agents.proposals` pass — undecided proposals past their expiry lapse;
 * · the `note` target (hq-core), which no module owns. Every other proposal
 *   kind comes with its module's register — card (board), prompt and
 *   prompt_variant (prompts), shot (story), event (calendar), experiment
 *   (experiments) — which each process loads beside this one.
 */

registerTickStep('agents.routines', () => queueDueRoutines({ limit: 25 }))
registerTickStep('agents.proposals', () => expireProposals(100))
