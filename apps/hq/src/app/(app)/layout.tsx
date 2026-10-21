import { requireUser } from '@theiceji/hq-auth'
import { type ReactNode, Suspense } from 'react'
import { Shell } from '@/components/shell/Shell'
import { loadShell } from '@/lib/shell'

/**
 * The real auth gate for every HQ screen — `proxy.ts` bounces cookie-less
 * traffic first, but this is the check that reaches the database — and the
 * Bridge shell around every page.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser()
  const data = await loadShell({ id: user.id, role: user.role })
  return (
    // The shell reads the query string (the current view); Suspense keeps
    // that from opting the whole tree out of streaming.
    <Suspense>
      <Shell
        user={{ email: user.email, name: user.name, image: user.image }}
        data={data}
      >
        {children}
      </Shell>
    </Suspense>
  )
}
