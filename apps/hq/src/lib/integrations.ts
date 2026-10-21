import { googleBlocker } from '@theiceji/hq-core/google'
import { isSealingConfigured } from '@theiceji/hq-ops/secrets'
import { isStorageConfigured } from '@theiceji/hq-storage/config'
import { isDbConfigured } from '@/db'
import { oauthReadiness } from '@/lib/oauth/config'

/**
 * Which optional integrations this deployment has — read by Settings and by
 * `/api/ready`, so the two can't disagree. Names of env vars only, never a
 * value.
 */
export type Integration = {
  id: string
  label: string
  /** What it powers, for the Settings row. */
  purpose: string
  env: string
  ok: boolean
  /** The capability `/api/ready` reports as blocked while it is missing. */
  blocked: string
}

export function integrations(): Integration[] {
  return [
    {
      id: 'database',
      label: 'Database',
      purpose: 'Accounts, workspaces and everything HQ records',
      env: 'DATABASE_URL',
      ok: isDbConfigured(),
      blocked: 'everything that reads or writes records (DATABASE_URL)',
    },
    {
      id: 'storage',
      label: 'R2 storage',
      purpose: 'Asset library, uploads and import archives',
      env: 'R2_*',
      ok: isStorageConfigured(),
      blocked: 'asset library and uploads (R2_*)',
    },
    {
      id: 'oauth',
      label: 'Connected apps',
      purpose: 'Claude, ChatGPT and agents over MCP',
      env: 'OAUTH_ISSUER · MCP_RESOURCE_URLS',
      ok: oauthReadiness().ok,
      blocked: 'connected apps (OAUTH_ISSUER / MCP_RESOURCE_URLS)',
    },
    {
      id: 'sealing',
      label: 'Sealing key',
      purpose: 'Google, provider credentials and runtime delivery',
      env: 'HQ_SEALING_KEY (or CREATOR_SEALING_KEY)',
      ok: isSealingConfigured(),
      blocked:
        'Google, provider connections and runtime delivery (HQ_SEALING_KEY)',
    },
    {
      id: 'google',
      label: 'Google',
      purpose: 'Drive storage and Calendar sync, on one connection',
      env: 'GOOGLE_OAUTH_CLIENT_ID · GOOGLE_OAUTH_CLIENT_SECRET',
      ok: googleBlocker() === null,
      blocked: 'Google Drive and Calendar (GOOGLE_OAUTH_CLIENT_*)',
    },
    {
      id: 'cron',
      label: 'Scheduled jobs',
      purpose:
        'The ops tick (routines, syncs, reconciles) and the database keep-alive',
      env: 'CRON_SECRET',
      ok: Boolean(process.env.CRON_SECRET),
      blocked: 'scheduled jobs (CRON_SECRET)',
    },
    {
      id: 'push',
      label: 'Web Push',
      purpose: 'Alerts on the devices registered here',
      env: 'VAPID_* · NEXT_PUBLIC_VAPID_PUBLIC_KEY',
      ok: Boolean(
        process.env.VAPID_PUBLIC_KEY &&
          process.env.VAPID_PRIVATE_KEY &&
          process.env.VAPID_SUBJECT &&
          process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY,
      ),
      blocked: 'push alerts (VAPID_*)',
    },
  ]
}
