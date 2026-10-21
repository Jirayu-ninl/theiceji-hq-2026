import {
  BaseConfigSchema,
  describeConfigLine,
  parseConfig,
  portSchema,
} from '@theiceji/mcp-kernel'
import { z } from 'zod'

/**
 * This server's configuration: everything in @theiceji/mcp-kernel's base
 * schema plus what only HQ's MCP server needs.
 *
 * Validated once at boot and never read from `process.env` again. Fails
 * loudly naming EVERY missing or malformed variable at once, so a
 * five-variable misconfiguration costs one deploy, not five.
 */
const ConfigSchema = BaseConfigSchema.extend({
  /**
   * Seconds between ops ticks run by this process (`@theiceji/hq-ops`
   * runtime: lapsed leases, expiries, stalled runs, every module's registered
   * steps, event delivery).
   * A lease row keeps it to one tick at a time across HQ's cron and every MCP
   * replica. 0 turns the loop off here. Read from `HQ_SCHEDULER_SECONDS`,
   * falling back to the legacy name `CREATOR_SCHEDULER_SECONDS` so an
   * existing deploy keeps its setting.
   */
  HQ_SCHEDULER_SECONDS: z.coerce.number().int().min(0).max(3600).default(60),

  /** Railway injects PORT; 8991 locally (web 8989 · hq 8990 · hq-mcp 8991). */
  PORT: portSchema(8991),
})

export type Config = z.infer<typeof ConfigSchema>

/** A blank `KEY=` counts as unset, the way `parseConfig` reads it. */
const setting = (value: string | undefined): string | undefined =>
  value?.trim() ? value : undefined

export function loadConfig(
  source: Record<string, string | undefined> = process.env,
): Config {
  return parseConfig('hq-mcp', ConfigSchema, {
    ...source,
    HQ_SCHEDULER_SECONDS:
      setting(source.HQ_SCHEDULER_SECONDS) ??
      setting(source.CREATOR_SCHEDULER_SECONDS),
  })
}

/** What this process will actually talk to. Logged at boot; carries no secret. */
export function describeConfig(config: Config): string {
  return describeConfigLine(config, [
    `ops tick ${config.HQ_SCHEDULER_SECONDS > 0 ? `every ${config.HQ_SCHEDULER_SECONDS}s` : 'off'}`,
  ])
}
