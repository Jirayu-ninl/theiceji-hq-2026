import type { ServerIdentity } from '@theiceji/mcp-kernel'

/**
 * What this server calls itself: the MCP handshake name, the paragraph every
 * session opens with, the name the owner sees while consenting, and what a
 * caller with no usable credentials is told to do.
 */
export const IDENTITY: ServerIdentity = {
  name: 'theiceji-hq',
  version: '0.1.0',
  preamble: [
    "TheIceJi HQ is the owner's personal command center: projects, each running the modules it needs (board, prompts, assets, story, calendar, quotes, publish, market, experiments, readings).",
    'Tools are named `<module>_<action>`, and a tool that works inside a project takes its `project_id`. Start every session with `hq_get_brief` (what is waiting, per project) and `hq_get_capabilities` (what this connection can actually do).',
    'Routine work comes from `agents_claim_task`: a routine’s run returns with its playbook, and what you find goes to the owner as proposals (`agents_propose`), never as a change they did not ask for.',
    'A connection only lists the tools its permissions allow. If a tool you need is missing, ask the owner to reconnect with wider permissions in HQ → Settings → Connections instead of working around it.',
  ].join(' '),
  resourceName: 'TheIceJi HQ',
  connectPrompt: 'Connect TheIceJi HQ to continue.',
}
