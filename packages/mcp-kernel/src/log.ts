/**
 * A logger that knows which stream is safe.
 *
 * Over stdio, stdout IS the MCP protocol channel, so every line goes to
 * stderr. Over HTTP, info goes to stdout so a platform log view (Railway)
 * doesn't paint every request as an error.
 */
export type Logger = {
  info: (message: string) => void
  warn: (message: string) => void
  error: (message: string) => void
}

export function createLogger(
  scope: string,
  options: { stdio?: boolean } = {},
): Logger {
  const tag = `[${scope}]`
  const info = options.stdio ? console.error : console.log
  return {
    info: (message) => info(`${tag} ${message}`),
    warn: (message) => console.warn(`${tag} ${message}`),
    error: (message) => console.error(`${tag} ${message}`),
  }
}
