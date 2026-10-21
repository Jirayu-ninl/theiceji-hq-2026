import { GLOBAL_MODULES, isModuleId } from '@theiceji/hq-core/modules'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ModulePending } from '@/components/ModulePending'
import { MODULES } from '@/modules'

export const dynamic = 'force-dynamic'

type Params = Promise<{ module: string }>

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { module } = await params
  return { title: isModuleId(module) ? `${MODULES[module].label} — HQ` : 'HQ' }
}

/**
 * `/<module>` — a global module across every project (`/board`, `/prompts`,
 * `/assets`, `/calendar`, `/quotes`). Only those five have a
 * global route; anything else here is not a page. Static routes (`/notes`,
 * `/inbox`, `/projects` …) win over this segment, so it never shadows them.
 */
export default async function GlobalModulePage({ params }: { params: Params }) {
  const { module } = await params
  if (!isModuleId(module) || !GLOBAL_MODULES.includes(module)) notFound()
  return <ModulePending module={module} scope={null} />
}
