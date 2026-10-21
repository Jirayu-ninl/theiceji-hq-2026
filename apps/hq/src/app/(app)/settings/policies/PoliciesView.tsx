'use client'

import type { OpsAgentAction, OpsKillSwitchScope } from '@theiceji/hq-db/enums'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import {
  type FormEvent,
  type ReactNode,
  useEffect,
  useRef,
  useState,
  useTransition,
} from 'react'
import { isThai } from '@/components/bridge/parts'
import { useToast } from '@/components/Toast'
import { Fld, Group, StateWord } from '../parts'
import {
  engageKillSwitchAction,
  releaseKillSwitchAction,
  savePolicyAction,
} from './actions'
import type { EditablePolicy } from './policy-view'

/**
 * Settings › Policies, the client half.
 * A switch or a segmented choice applies at once: it saves
 * the policy as its next revision (hq-ops, audited) and offers Undo, which
 * saves the previous value back as one more revision. Budgets are typed, so
 * they save with a button. Kill switches ask for a reason first, because the
 * kernel keeps one with every switch.
 *
 * Only what the kernel supports is a control. What this tab doesn't change
 * is shown as kept, and what the kernel never lets anyone change is shown
 * locked, with the rule in words. A switch that can't turn on says why.
 */

export type ScopeOption = { slug: string | null; name: string }

export type EngagedSwitch = {
  id: string
  scope: OpsKillSwitchScope
  target: string | null
  /** The project it belongs to; null for HQ-wide. */
  projectId: string | null
  reason: string
  since: string
}

export type BudgetView = {
  lines: { unit: string; today: string; month: string }[]
  openReservations: number
  unknownCosts: number
} | null

export type PoliciesProps = {
  scope: { projectId: string | null; slug: string | null; name: string }
  scopes: ScopeOption[]
  policy: EditablePolicy
  inForce: boolean
  reason: string | null
  actions: [action: OpsAgentAction, label: string][]
  stops: [condition: EditablePolicy['stopConditions'][number], label: string][]
  connections: { id: string; label: string; kind: 'oauth' | 'personal' }[]
  switches: EngagedSwitch[]
  budget: BudgetView
  /** What the tab doesn't edit, read from the revision in force. */
  kept: {
    accounts: number
    providers: string[]
    unitLimits: string[]
    postsPerDay: number
    cooldownMinutes: number
  }
}

/** A segmented control: a group of toggle buttons, one pressed. */
function Seg<T extends string>({
  label,
  value,
  options,
  disabled,
  onPick,
}: {
  label: string
  value: T | null
  options: [T, string][]
  disabled?: boolean
  onPick: (value: T) => void
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a segmented control is a group of toggle buttons, not a fieldset
    <span className='seg' role='group' aria-label={label}>
      {options.map(([option, text]) => (
        <button
          key={option}
          type='button'
          aria-pressed={value === option}
          disabled={disabled}
          onClick={() => value !== option && onPick(option)}
        >
          {text}
        </button>
      ))}
    </span>
  )
}

function Switch({
  on,
  label,
  disabled,
  onFlip,
}: {
  on: boolean
  label: string
  disabled?: boolean
  onFlip: () => void
}) {
  return (
    <>
      <button
        type='button'
        className='switch'
        aria-pressed={on}
        aria-label={label}
        disabled={disabled}
        onClick={onFlip}
      />
      <StateWord tone={on ? 'live' : ''}>{on ? 'on' : 'off'}</StateWord>
    </>
  )
}

const sentence = (text: string) => text.charAt(0).toUpperCase() + text.slice(1)

type SwitchRowDef = {
  key: string
  scope: OpsKillSwitchScope
  target: string | null
  label: ReactNode
  plain: string
  sub: string
}

/** One kill switch: flipping it asks why, then engages or releases it. */
function KillRow({
  row,
  engaged,
  busy,
  onEngage,
  onRelease,
}: {
  row: SwitchRowDef
  engaged: EngagedSwitch | null
  busy: boolean
  onEngage: (reason: string) => Promise<boolean>
  onRelease: (reason: string) => Promise<boolean>
}) {
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const on = Boolean(engaged)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    if (!reason.trim()) return
    const done = on
      ? await onRelease(reason.trim())
      : await onEngage(reason.trim())
    if (done) {
      setAsking(false)
      setReason('')
    }
  }
  return (
    <Fld
      label={row.label}
      sub={engaged ? `On since ${engaged.since}: ${engaged.reason}` : row.sub}
    >
      <span className='kill'>
        <button
          type='button'
          className='switch'
          aria-pressed={on}
          aria-label={`Kill switch: ${row.plain}`}
          disabled={busy || asking}
          onClick={() => setAsking(true)}
        />
        <StateWord tone={on ? 'wait' : ''}>{on ? '◆ on' : 'off'}</StateWord>
      </span>
      {asking ? (
        <form className='reason' onSubmit={submit}>
          <input
            type='text'
            value={reason}
            maxLength={1000}
            onChange={(event) => setReason(event.target.value)}
            placeholder={on ? 'Why it may run again' : 'Why it stops'}
            aria-label={
              on ? `Why ${row.plain} may run again` : `Why ${row.plain} stops`
            }
            // biome-ignore lint/a11y/noAutofocus: the field opens because the switch was just pressed
            autoFocus
          />
          <button
            type='submit'
            className='btn btn-sm'
            disabled={busy || !reason.trim()}
          >
            {on ? 'Let it run' : 'Stop it'}
          </button>
          <button
            type='button'
            className='btn btn-sm'
            disabled={busy}
            onClick={() => setAsking(false)}
          >
            Keep it {on ? 'stopped' : 'running'}
          </button>
        </form>
      ) : null}
    </Fld>
  )
}

export function PoliciesView(props: PoliciesProps) {
  const router = useRouter()
  const toast = useToast()
  const [pending, start] = useTransition()
  const [policy, setPolicy] = useState(props.policy)
  const latest = useRef(props.policy)
  const [choosing, setChoosing] = useState(false)
  const [budgetError, setBudgetError] = useState<string | null>(null)
  const projectId = props.scope.projectId

  // A refresh brings the revision in force; adopt it unless this tab already holds a newer one.
  useEffect(() => {
    if (props.policy.revision >= latest.current.revision) {
      latest.current = props.policy
      setPolicy(props.policy)
    }
  }, [props.policy])

  const save = (
    next: EditablePolicy,
    after: (saved: EditablePolicy) => void,
    onError?: (error: string) => void,
  ) =>
    start(async () => {
      const result = await savePolicyAction({ projectId, policy: next })
      if (!result.ok) {
        if (onError) onError(result.error)
        else toast(result.error)
        return
      }
      latest.current = result.data
      setPolicy(result.data)
      after(result.data)
    })

  /** Apply one change at once, as the next revision, with Undo. */
  const change = (patch: Partial<EditablePolicy>, message: string) => {
    const before = latest.current
    const restore = Object.fromEntries(
      Object.keys(patch).map((key) => [
        key,
        before[key as keyof EditablePolicy],
      ]),
    ) as Partial<EditablePolicy>
    save({ ...before, ...patch }, (saved) =>
      toast(`${message} · revision ${saved.revision}`, {
        undo: () =>
          save({ ...latest.current, ...restore }, (back) =>
            toast(`Put back · revision ${back.revision}`),
          ),
      }),
    )
  }

  const busy = pending
  const covered = policy.coverage === 'selected' || choosing
  const scopeSwitches = props.switches.filter(
    (entry) => entry.projectId === projectId,
  )
  const inherited = props.switches.filter(
    (entry) => entry.projectId !== projectId,
  )
  const connectionName = (id: string | null) =>
    props.connections.find((connection) => connection.id === id)?.label ?? null

  const rows: SwitchRowDef[] = [
    projectId
      ? {
          key: 'project',
          scope: 'project',
          target: null,
          label: 'This project',
          plain: props.scope.name,
          sub: `Every agent and worker, in ${props.scope.name} only.`,
        }
      : {
          key: 'all',
          scope: 'all',
          target: null,
          label: 'All agents',
          plain: 'all agents',
          sub: 'Every agent and worker, in every project and in no project.',
        },
    ...props.connections.map((connection) => ({
      key: `connection:${connection.id}`,
      scope: 'connection' as const,
      target: connection.id,
      label: (
        <span lang={isThai(connection.label) ? 'th' : undefined}>
          {connection.label}
        </span>
      ),
      plain: connection.label,
      sub: projectId
        ? `This ${connection.kind === 'personal' ? 'token' : 'app'}, in ${props.scope.name} only.`
        : `This ${connection.kind === 'personal' ? 'token' : 'app'}, everywhere.`,
    })),
  ]
  const engagedFor = (row: SwitchRowDef) =>
    scopeSwitches.find(
      (entry) => entry.scope === row.scope && entry.target === row.target,
    ) ?? null
  const others = scopeSwitches.filter(
    (entry) => !rows.some((row) => engagedFor(row)?.id === entry.id),
  )

  const engage = async (
    row: { scope: OpsKillSwitchScope; target: string | null; plain: string },
    reason: string,
  ) => {
    const result = await engageKillSwitchAction({
      projectId,
      scope: row.scope,
      target: row.target,
      reason,
    })
    if (!result.ok) {
      toast(result.error)
      return false
    }
    const { revoked, inFlight } = result.data
    toast(
      `Stopped: ${row.plain}${revoked ? ` · ${revoked} release authorization${revoked === 1 ? '' : 's'} voided` : ''}${inFlight ? ` · ${inFlight} already with a provider` : ''}`,
    )
    return true
  }
  const release = async (switchId: string, plain: string, reason: string) => {
    const result = await releaseKillSwitchAction({ switchId, reason })
    if (!result.ok) {
      toast(result.error)
      return false
    }
    toast(`${sentence(plain)} may run again`)
    return true
  }

  const submitBudget = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const data = new FormData(event.currentTarget)
    const field = (name: string) => String(data.get(name) ?? '')
    setBudgetError(null)
    save(
      {
        ...latest.current,
        cashLimitPerJob: field('cashLimitPerJob'),
        cashLimitPerDay: field('cashLimitPerDay'),
        cashLimitPerMonth: field('cashLimitPerMonth'),
        maxConcurrentJobs: field('maxConcurrentJobs'),
      },
      (saved) => toast(`Budgets saved · revision ${saved.revision}`),
      setBudgetError,
    )
  }
  const submitEnd = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault()
    const value = String(
      new FormData(event.currentTarget).get('expiresAt') ?? '',
    )
    change(
      { expiresAt: value },
      value ? `Policy ends ${value.replace('T', ' ')}` : 'Policy has no end',
    )
  }

  const none = policy.revision === 0
  return (
    <>
      <Group
        id='scope'
        title='Scope'
        description='A policy is per project, or HQ-wide for work in no project. Neither inherits from the other.'
      >
        <Fld label='Applies to' htmlFor='policy-scope'>
          <select
            id='policy-scope'
            value={props.scope.slug ?? ''}
            onChange={(event) =>
              router.push(
                `/settings/policies${event.target.value ? `?project=${event.target.value}` : ''}`,
              )
            }
          >
            {props.scopes.map((option) => (
              <option key={option.slug ?? ''} value={option.slug ?? ''}>
                {option.name}
              </option>
            ))}
          </select>
        </Fld>
      </Group>

      <Group
        id='policy'
        title={
          <>
            Operating policy{' '}
            <StateWord tone={props.inForce ? 'live' : 'wait'}>
              {props.inForce
                ? `in force · revision ${policy.revision}`
                : none
                  ? '◆ none yet'
                  : '◆ not in force'}
            </StateWord>
          </>
        }
        description='Agents act only under a policy you set. Without one in force they can only read.'
        problem={!props.inForce}
        foot={
          <span className='st'>
            {busy
              ? 'saving…'
              : 'applies at once · each change is a new revision · audited'}
          </span>
        }
      >
        {!props.inForce && props.reason ? (
          <p className='why'>
            <b>Why agents can only read:</b> {props.reason}
          </p>
        ) : null}
        <Fld
          label='Status'
          sub={
            none
              ? 'Nothing is saved yet; the first change creates revision 1.'
              : 'Suspended stops every agent here at its next call.'
          }
        >
          <Seg
            label='Status'
            value={policy.status}
            disabled={busy}
            options={[
              ['active', 'Active'],
              ['suspended', 'Suspended'],
            ]}
            onPick={(status) =>
              change(
                { status },
                status === 'active' ? 'Policy active' : 'Policy suspended',
              )
            }
          />
        </Fld>
        <Fld label='Covers' sub='Which connections may act under it.'>
          <Seg
            label='Covers'
            value={covered ? 'selected' : 'all_connections'}
            disabled={busy}
            options={[
              ['all_connections', 'All connections'],
              ['selected', 'Selected'],
            ]}
            onPick={(coverage) => {
              if (coverage === 'selected') {
                setChoosing(true)
                return
              }
              setChoosing(false)
              change(
                { coverage: 'all_connections', grantIds: [] },
                'Policy covers every connection',
              )
            }}
          />
          {covered && policy.coverage !== 'selected' ? (
            <p className='hint'>
              Switch on the connections it covers; the first one saves the
              choice.
            </p>
          ) : null}
        </Fld>
        {covered ? (
          props.connections.length === 0 ? (
            <Fld label='Connections'>
              <span className='muted'>
                ○ no connections yet — connect one under Connections
              </span>
            </Fld>
          ) : (
            props.connections.map((connection) => {
              const on =
                policy.coverage === 'selected' &&
                policy.grantIds.includes(connection.id)
              return (
                <Fld
                  key={connection.id}
                  label={
                    <span lang={isThai(connection.label) ? 'th' : undefined}>
                      {connection.label}
                    </span>
                  }
                  sub={
                    connection.kind === 'personal'
                      ? 'personal access token'
                      : 'app over MCP'
                  }
                >
                  <Switch
                    on={on}
                    label={`Covers ${connection.label}`}
                    disabled={busy}
                    onFlip={() =>
                      change(
                        {
                          coverage: 'selected',
                          grantIds: on
                            ? policy.grantIds.filter(
                                (id) => id !== connection.id,
                              )
                            : [
                                ...policy.grantIds.filter(
                                  (id) => id !== connection.id,
                                ),
                                connection.id,
                              ],
                        },
                        `${on ? 'No longer covers' : 'Covers'} ${connection.label}`,
                      )
                    }
                  />
                </Fld>
              )
            })
          )
        ) : null}
        <Fld
          label='Ends'
          sub={`${policy.timeZone} time. After it, agents can only read until you renew it.`}
        >
          <form
            className='reason'
            onSubmit={submitEnd}
            key={`${policy.revision}:${policy.expiresAt}`}
          >
            <input
              type='datetime-local'
              name='expiresAt'
              defaultValue={policy.expiresAt}
              aria-label='Policy ends'
            />
            <button type='submit' className='btn btn-sm' disabled={busy}>
              Set end
            </button>
            {policy.expiresAt ? (
              <button
                type='button'
                className='btn btn-sm'
                disabled={busy}
                onClick={() => change({ expiresAt: '' }, 'Policy has no end')}
              >
                No end
              </button>
            ) : (
              <StateWord>no end</StateWord>
            )}
          </form>
        </Fld>
      </Group>

      <Group
        id='may'
        title='Agents may'
        description='Each authority on its own. Anything an agent does outside these is refused before anything is written.'
        foot={<span className='st'>applies at once · audited</span>}
      >
        {props.actions.map(([action, label]) => {
          const on = policy.allowedActions.includes(action)
          // The kernel refuses publish or list without the accounts they may
          // use, and this tab doesn't name accounts — so the switch says so.
          const needs =
            !on && props.kept.accounts === 0
              ? action === 'publish'
                ? 'Off: an agent may post only to accounts this policy names, and none are named. Posting stays yours — Clear to post in Publish.'
                : action === 'list'
                  ? 'Off: an agent may list only on shops this policy names, and none are named. Listing stays yours — Approve in Market.'
                  : null
              : null
          return (
            <Fld
              key={action}
              label={sentence(label)}
              sub={needs ?? <span className='mono'>{action}</span>}
            >
              <Switch
                on={on}
                label={`Agents may ${label}`}
                disabled={busy || Boolean(needs)}
                onFlip={() =>
                  change(
                    {
                      allowedActions: on
                        ? policy.allowedActions.filter(
                            (entry) => entry !== action,
                          )
                        : [...policy.allowedActions, action],
                    },
                    `Agents ${on ? 'may no longer' : 'may'} ${label}`,
                  )
                }
              />
            </Fld>
          )
        })}
        <Fld
          label='Providers they may use'
          sub='Kept as they are; this tab doesn’t change them. Generators and models are connected under Connections.'
          locked
        >
          <span className='mono muted'>
            {props.kept.providers.length
              ? props.kept.providers.join(' · ')
              : 'none'}
          </span>
        </Fld>
      </Group>

      <Group
        id='stops'
        title='Stop when'
        description={
          none
            ? 'Conditions that stop agent work outright the moment they occur. Nothing is saved yet: these are what revision 1 starts with.'
            : 'Conditions that stop agent work outright the moment they occur.'
        }
        foot={<span className='st'>applies at once · audited</span>}
      >
        {props.stops.map(([condition, label]) => {
          const on = policy.stopConditions.includes(condition)
          return (
            <Fld
              key={condition}
              label={label}
              sub={<span className='mono'>{condition}</span>}
            >
              <Switch
                on={on}
                label={`Stop when ${label.toLowerCase()}`}
                disabled={busy}
                onFlip={() =>
                  change(
                    {
                      stopConditions: on
                        ? policy.stopConditions.filter(
                            (entry) => entry !== condition,
                          )
                        : [...policy.stopConditions, condition],
                    },
                    `${on ? 'No longer stops' : 'Stops'} when ${label.toLowerCase()}`,
                  )
                }
              />
            </Fld>
          )
        })}
      </Group>

      <form
        className='group'
        id='budgets'
        aria-labelledby='budgets-h'
        onSubmit={submitBudget}
        noValidate
      >
        <header className='group-head'>
          <h2 id='budgets-h'>Budgets</h2>
          <p>
            A run reserves budget before it starts and stops when the
            reservation runs out. Costs are read back from the provider, never
            estimated. An empty limit means agents may not spend any.
          </p>
        </header>
        {/* Keyed by the saved limits: a switch saved elsewhere on the page leaves typed limits alone. */}
        <div
          className='group-body'
          key={[
            policy.cashLimitPerJob,
            policy.cashLimitPerDay,
            policy.cashLimitPerMonth,
            policy.maxConcurrentJobs,
          ].join('|')}
        >
          {(
            [
              ['cashLimitPerJob', 'Cash per job'],
              ['cashLimitPerDay', 'Cash per day'],
              ['cashLimitPerMonth', 'Cash per month'],
            ] as const
          ).map(([name, label]) => (
            <Fld key={name} label={label} htmlFor={`budget-${name}`}>
              <input
                id={`budget-${name}`}
                name={name}
                type='text'
                inputMode='decimal'
                className='num'
                defaultValue={policy[name]}
                placeholder='none'
              />
              <span className='mono muted'>{policy.currency}</span>
            </Fld>
          ))}
          <Fld
            label='Concurrent jobs'
            sub='At once, in this scope.'
            htmlFor='budget-concurrent'
          >
            <input
              id='budget-concurrent'
              name='maxConcurrentJobs'
              type='text'
              inputMode='numeric'
              className='num'
              defaultValue={policy.maxConcurrentJobs}
            />
          </Fld>
          {props.budget === null ? (
            <Fld label='Spent'>
              <span className='unknown'>— not read back</span>
            </Fld>
          ) : (
            <>
              {props.budget.lines.map((line) => (
                <Fld key={line.unit} label={`Spent · ${line.unit}`} locked>
                  <span className='mono'>today {line.today}</span>
                  <span className='mono'>this month {line.month}</span>
                </Fld>
              ))}
              <Fld label='Reservations open' locked>
                <span className='mono'>{props.budget.openReservations}</span>
              </Fld>
              <Fld
                label='Costs not read back'
                sub='This month. Each one counts until the provider reports it.'
                locked
              >
                <span
                  className={`mono${props.budget.unknownCosts ? '' : ' muted'}`}
                >
                  {props.budget.unknownCosts}
                </span>
              </Fld>
            </>
          )}
          {props.kept.unitLimits.length ? (
            <Fld
              label='Credit and quota limits'
              sub='Kept as they are; this tab doesn’t change them.'
              locked
            >
              <span className='mono muted'>
                {props.kept.unitLimits.join(' · ')}
              </span>
            </Fld>
          ) : null}
        </div>
        <footer className='group-foot'>
          <button
            type='submit'
            className='btn btn-pri'
            disabled={busy}
            data-key='s'
          >
            {busy ? 'Saving…' : 'Save budgets'}
            <kbd>s</kbd>
          </button>
          <span
            className={`st${budgetError ? ' wait' : ''}`}
            role={budgetError ? 'alert' : 'status'}
          >
            {budgetError ?? `saves revision ${policy.revision + 1} · audited`}
          </span>
        </footer>
      </form>

      <Group
        id='releases'
        title='Releases'
        description='What may leave HQ, and who says so.'
        foot={<span className='st'>applies at once · audited</span>}
      >
        <Fld
          label='Who authorizes a release'
          sub={
            policy.releaseMode === 'policy_gated'
              ? 'The server authorizes when every gate passes — never recorded as your approval. Needs “authorize releases” under Agents may.'
              : 'You approve the exact thing that will be sent, every time.'
          }
        >
          <Seg
            label='Who authorizes a release'
            value={policy.releaseMode}
            disabled={busy}
            options={[
              ['human_required', 'You, every time'],
              ['policy_gated', 'The policy, when every gate passes'],
            ]}
            onPick={(releaseMode) =>
              change(
                { releaseMode },
                releaseMode === 'human_required'
                  ? 'Every release waits for you'
                  : 'The policy may authorize releases',
              )
            }
          />
        </Fld>
        <Fld
          label='An authorization before anything leaves HQ'
          sub='A kernel rule, not a setting: bound to the exact payload, used once, voided by a kill switch.'
          locked
        >
          <button
            type='button'
            className='switch'
            aria-pressed
            aria-label='Release authorization, always'
            disabled
          />
          <StateWord tone='live'>always</StateWord>
        </Fld>
        <Fld
          label='Policy, budgets and kill switches are yours'
          sub='A kernel rule: no connection can hold the capability to change them.'
          locked
        >
          <button
            type='button'
            className='switch'
            aria-pressed
            aria-label='Owner only, always'
            disabled
          />
          <StateWord tone='live'>always</StateWord>
        </Fld>
        <Fld
          label='Posting limits'
          sub='Kept as they are; this tab doesn’t change them.'
          locked
        >
          <span className='mono muted'>
            {props.kept.postsPerDay} per account a day ·{' '}
            {props.kept.cooldownMinutes} min apart
          </span>
        </Fld>
      </Group>

      <Group
        id='kill'
        title='Kill switches'
        description='Stop a class of agent work at once. New work is refused from its next call and release authorizations in scope are voided; work a provider already has is reported as in flight.'
        foot={
          <span className='st'>
            applies at once · audited · a reason is kept with each
          </span>
        }
      >
        {rows.map((row) => {
          const engaged = engagedFor(row)
          return (
            <KillRow
              key={row.key}
              row={row}
              engaged={engaged}
              busy={busy}
              onEngage={(reason) => engage(row, reason)}
              onRelease={(reason) =>
                engaged
                  ? release(engaged.id, row.plain, reason)
                  : Promise.resolve(false)
              }
            />
          )
        })}
        {others.map((entry) => {
          const name =
            entry.scope === 'connection'
              ? (connectionName(entry.target) ?? 'a revoked connection')
              : entry.target
          const plain = `${entry.scope} ${name ?? ''}`.trim()
          return (
            <KillRow
              key={entry.id}
              row={{
                key: entry.id,
                scope: entry.scope,
                target: entry.target,
                label: sentence(plain),
                plain,
                sub: '',
              }}
              engaged={entry}
              busy={busy}
              onEngage={() => Promise.resolve(false)}
              onRelease={(reason) => release(entry.id, plain, reason)}
            />
          )
        })}
        {inherited.map((entry) => (
          <Fld
            key={entry.id}
            label={
              entry.scope === 'all'
                ? 'All agents (HQ-wide)'
                : `${sentence(entry.scope)} ${connectionName(entry.target) ?? entry.target ?? ''} (HQ-wide)`
            }
            sub={`On since ${entry.since}: ${entry.reason}. Released under HQ-wide.`}
            locked
          >
            <StateWord tone='wait'>◆ on</StateWord>
            <Link className='btn btn-sm' href='/settings/policies'>
              Open HQ-wide
            </Link>
          </Fld>
        ))}
      </Group>

      <Group id='agents' title='Agents'>
        <div className='dev-rows'>
          <div className='dev-row'>
            <span className='t'>
              Auto-accept is set on each routine, in{' '}
              <Link className='lnk' href='/agents'>
                Agents
              </Link>
              . Only notes and prompt variants can land without you — the
              database refuses anything else; cards, shots, events and
              experiments always wait in the Inbox. A routine still needs this
              policy to allow <b>propose</b> (and <b>draft</b> for what it
              accepts on its own).
            </span>
          </div>
          <div className='dev-row'>
            <span className='t'>
              When agents run is each routine’s schedule, in its own timezone —
              HQ queues a run only when one falls due. Pause a routine, or
              engage a kill switch above, to stop them.
            </span>
          </div>
        </div>
      </Group>
    </>
  )
}
