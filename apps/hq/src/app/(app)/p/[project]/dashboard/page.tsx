import { permanentRedirect } from 'next/navigation'

/** `/p/<slug>/dashboard` is the Readings page (the route keeps its old name). */
export default async function ProjectDashboardRedirect({
  params,
}: {
  params: Promise<{ project: string }>
}) {
  const { project } = await params
  permanentRedirect(`/p/${project}/readings`)
}
