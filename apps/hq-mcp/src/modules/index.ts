import type { Workspace } from '../kernel'
import { agents } from './agents'
import { assets } from './assets'
import { board } from './board'
import { calendar } from './calendar'
import { experiments } from './experiments'
import { hq } from './hq'
import { market } from './market'
import { prompts } from './prompts'
import { publish } from './publish'
import { quotes } from './quotes'
import { readings } from './readings'
import { story } from './story'

/**
 * The workspaces — one per module, plus `hq` for what belongs to no
 * module. A module adds `src/modules/<id>/index.ts` with its
 * `defineWorkspace` (the workspace id is the module id, so its tools are
 * `<module>_<action>`) and is appended here, in the one module order.
 */
export const MODULE_WORKSPACES: readonly Workspace[] = [
  hq,
  board,
  prompts,
  assets,
  story,
  calendar,
  quotes,
  publish,
  market,
  experiments,
  readings,
  agents,
]
