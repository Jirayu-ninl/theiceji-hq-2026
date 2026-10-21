import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * Load a server's own `.env` (KEY=VALUE) into process.env for its stdio entry,
 * without overwriting anything the MCP client already injected via its config
 * `env` block. Callers pass the file, usually
 * `new URL('../.env', import.meta.url)` from their `src/stdio.ts`.
 *
 * Only stdio needs this: Claude Code / Desktop launch the server from whatever
 * cwd they like, so Bun's own cwd-relative `.env` loading can't be relied on.
 * An HTTP entry never calls it — in a container the platform's environment is
 * the only configuration, and nothing copies a `.env` into the image.
 *
 * stderr-only logging — stdout is the MCP protocol channel and must stay clean.
 */
export function loadLocalEnv(envFile: string | URL): void {
  const file =
    envFile instanceof URL
      ? fileURLToPath(envFile)
      : resolve(process.cwd(), envFile)
  if (!existsSync(file)) return
  try {
    const text = readFileSync(file, 'utf8')
    for (const line of text.split(/\r?\n/)) {
      const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/)
      if (!match) continue // skips blanks and `# comments`
      const [, key, rawValue] = match
      if (key === undefined || rawValue === undefined) continue
      if (process.env[key] !== undefined) continue
      const quoted =
        (rawValue.startsWith('"') && rawValue.endsWith('"')) ||
        (rawValue.startsWith("'") && rawValue.endsWith("'"))
      process.env[key] = quoted ? rawValue.slice(1, -1) : rawValue
    }
  } catch (error) {
    console.error('[mcp] failed to read', file, error)
  }
}
