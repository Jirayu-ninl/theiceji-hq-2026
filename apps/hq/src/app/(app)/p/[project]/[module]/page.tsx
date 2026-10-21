import { isModuleId } from '@theiceji/hq-core/modules'
import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { ModuleOff, ModulePending } from '@/components/ModulePending'
import { lite, projectForPage, projectsWith } from '@/lib/project-page'
import { MODULES } from '@/modules'

export const dynamic = 'force-dynamic'

type Params = Promise<{ project: string; module: string }>

export async function generateMetadata({
  params,
}: {
  params: Params
}): Promise<Metadata> {
  const { module } = await params
  return { title: isModuleId(module) ? `${MODULES[module].label} — HQ` : 'HQ' }
}

/**
 * `/p/<slug>/<module>` — one module inside one project. Each module's real
 * page replaces this as it is built; until then an enabled module says
 * when it lands, and a module that is off says so and offers projects that
 * have it.
 */
export default async function ProjectModulePage({
  params,
}: {
  params: Params
}) {
  const { project: slug, module } = await params
  if (!isModuleId(module) || MODULES[module].hqWide) notFound()
  const project = await projectForPage(slug)
  if (!project.modules.enabled.includes(module)) {
    const others = (await projectsWith(module)).filter(
      (other) => other.id !== project.id,
    )
    return <ModuleOff module={module} project={lite(project)} others={others} />
  }
  return <ModulePending module={module} scope={lite(project)} />
}
