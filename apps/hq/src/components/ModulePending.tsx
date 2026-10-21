import { PROJECT_COLORS, type ProjectColor } from '@theiceji/hq-db/enums'
import Link from 'next/link'
import { MODULE_UI, type ModuleId, type ProjectLite } from '@/modules'

const hex = (color: string) =>
  PROJECT_COLORS[color as ProjectColor] ?? PROJECT_COLORS.grey

/**
 * A module page before it is built: the rail row exists as
 * soon as a project has the module on, so the page says plainly what it is
 * and that it isn't built yet — never a 404, never sample data.
 */
export function ModulePending({
  module,
  scope,
}: {
  module: ModuleId
  /** The project it would show, or "all projects" on a global route. */
  scope: ProjectLite | null
}) {
  const ui = MODULE_UI[module]
  return (
    <div className='page'>
      <section className='pane' aria-label={ui.meta.label}>
        <header className='pane-head'>
          <span className='hud-label'>
            {ui.meta.glyph} {ui.meta.label}
          </span>
          <span className='dim'>{scope ? scope.name : 'all projects'}</span>
        </header>
        <div className='pane-body'>
          <div className='off-state'>
            <h2>{ui.meta.label} isn’t built yet</h2>
            <p>
              It is on{' '}
              {scope ? `for ${scope.name}` : 'for the projects that use it'},
              and its records will live here. Nothing is stored for it yet.
            </p>
            {scope ? (
              <div className='picks'>
                <Link className='btn' href={`/p/${scope.slug}`}>
                  Back to {scope.name}
                </Link>
              </div>
            ) : null}
          </div>
        </div>
      </section>
    </div>
  )
}

/**
 * The module is off for this project: say so, and offer the
 * projects that have it on.
 */
export function ModuleOff({
  module,
  project,
  others,
}: {
  module: ModuleId
  project: ProjectLite
  others: ProjectLite[]
}) {
  const label = MODULE_UI[module].meta.label
  return (
    <div className='page'>
      <section className='pane' aria-label={label}>
        <div className='off-state'>
          <h2>
            {label} is off for {project.name}
          </h2>
          <p>
            Turn it on in{' '}
            <Link href={`/projects?id=${project.id}`}>Projects</Link>, or open a
            project that has it.
          </p>
          <div className='picks'>
            {others.length === 0 ? (
              <span className='muted'>No project has {label} on.</span>
            ) : (
              others.map((other) => (
                <a
                  key={other.id}
                  className='btn'
                  href={`/p/${other.slug}/${module}`}
                >
                  <i
                    className='dot'
                    style={{ ['--project' as string]: hex(other.color) }}
                    aria-hidden='true'
                  />
                  {other.name}
                </a>
              ))
            )}
          </div>
        </div>
      </section>
    </div>
  )
}
