import { createHash } from 'node:crypto'
import { type Hq, type HqRecord, HqRefusal, type Transfer } from './hq'
import { isSafeEntryName, writeZip } from './zip'

/**
 * One job, start to finish:
 *
 *   agents_claim_task (generation · assets — lease + fencing token)
 *   → agents_heartbeat every third of the lease
 *   → assets_get_job (the operation and its inputs — IDs only)
 *   → assets_get_access per input → download → SHA-256 checked
 *   → make the file (a scene's ZIP today)
 *   → assets_prepare_upload with job_id → PUT → assets_finalize
 *   → assets_record_generated (the fencing token) → agents_finish
 *
 * The job kinds come from the modules' manifests (`assets.zip` from Story);
 * what this worker can't make yet it answers with a failed job and a reason,
 * never a silent retry. A lease that moved to another worker stops this one
 * before it writes anything; any other failure finishes the run `failed`, so
 * the task can be tried again (HQ fails the job once the attempts are spent).
 */

export type Plan13Options = {
  hq: Hq
  transfer: Transfer
  leaseSeconds?: number
  /** Only this project's queue; every project's when absent. */
  projectId?: string
  log?: (line: string) => void
}

export type Plan13Outcome = {
  jobId: string
  operation: string
  status: 'succeeded' | 'failed' | 'lease_lost'
  outputs: string[]
  detail: string
}

type Claim = {
  task: {
    id: string
    project_id: string | null
    payload: { job_id?: string; operation?: string }
    fencing_token: number
  } | null
  run: { id: string; fencing_token: number } | null
  skipped: { project_id: string | null; reason: string }[]
}

type Job = {
  id: string
  project_id: string | null
  operation: string
  title: string
  input: Record<string, unknown>
}

type Access = {
  url: string
  asset: { id: string; name: string; sha256: string | null; bytes: number }
}

type Prepared = {
  asset: { id: string }
  upload:
    | { mode: 'presigned_put'; url: string; headers: Record<string, string> }
    | { mode: 'resumable'; session_url: string }
    | { mode: string }
}

/** What this worker makes, by job operation. */
export const PLAN13_OPERATIONS = ['zip'] as const

const sha256 = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex')

/** A flat, portable ZIP entry name: `01 · shot name.mp4`, never a path. */
export function entryName(
  index: number,
  name: string,
  used: Set<string>,
): string {
  const base = name
    .replace(/[\\/:*?"<>|\p{Cc}]/gu, '-')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 180)
  let candidate = `${String(index + 1).padStart(2, '0')}-${base || 'file'}`
  for (let n = 2; used.has(candidate) || !isSafeEntryName(candidate); n++)
    candidate = `${String(index + 1).padStart(2, '0')}-${n}-${base || 'file'}`
  used.add(candidate)
  return candidate
}

export async function runPlan13Once(
  options: Plan13Options,
): Promise<Plan13Outcome | null> {
  const { hq, transfer } = options
  const leaseSeconds = options.leaseSeconds ?? 600
  const log = options.log ?? (() => {})
  const claim = (await hq.call('agents_claim_task', {
    kinds: ['generation'],
    modules: ['assets'],
    lease_seconds: leaseSeconds,
    ...(options.projectId ? { project_id: options.projectId } : {}),
  })) as HqRecord & Claim
  for (const skip of claim.skipped ?? [])
    log(`skipped ${skip.project_id ?? 'no-project'}: ${skip.reason}`)
  const task = claim.task
  const run = claim.run
  if (!task || !run) return null
  const token = run.fencing_token
  const jobId = task.payload.job_id
  log(`claimed task ${task.id} (token ${token})`)

  let leaseLost = false
  const beat = setInterval(
    () => {
      hq.call('agents_heartbeat', {
        run_id: run.id,
        fencing_token: token,
        lease_seconds: leaseSeconds,
      }).catch((error: unknown) => {
        if (error instanceof HqRefusal && error.code === 'lease_lost')
          leaseLost = true
        log(`heartbeat failed: ${(error as Error).message}`)
      })
    },
    Math.max(5_000, (leaseSeconds * 1000) / 3),
  )
  const guard = () => {
    if (leaseLost)
      throw new HqRefusal(
        'lease_lost',
        'The lease moved to another worker.',
        'no',
      )
  }
  const finish = (
    outcome: 'done' | 'failed',
    summary: string,
    error?: string,
  ) =>
    hq.call('agents_finish', {
      run_id: run.id,
      fencing_token: token,
      outcome,
      summary,
      ...(error ? { error } : {}),
    })

  try {
    if (!jobId) {
      await finish(
        'failed',
        'The task names no job.',
        'No job_id in its payload.',
      )
      return {
        jobId: '',
        operation: 'unknown',
        status: 'failed',
        outputs: [],
        detail: 'no job_id',
      }
    }
    const { job } = (await hq.call('assets_get_job', {
      job_id: jobId,
    })) as HqRecord & { job: Job }
    log(`job ${job.id}: ${job.operation} — ${job.title}`)

    if (job.operation !== 'zip') {
      const reason = `This worker can’t make “${job.operation}” jobs yet.`
      await hq.call('assets_record_generated', {
        job_id: job.id,
        fencing_token: token,
        error: reason,
      })
      await finish('done', reason)
      return {
        jobId: job.id,
        operation: job.operation,
        status: 'failed',
        outputs: [],
        detail: reason,
      }
    }

    const input = job.input as { assetIds?: string[]; name?: string }
    const ids = input.assetIds ?? []
    if (ids.length === 0) throw new Error('The ZIP job lists no files.')
    const used = new Set<string>()
    const files: { name: string; bytes: Uint8Array }[] = []
    for (const [index, id] of ids.entries()) {
      guard()
      const access = (await hq.call('assets_get_access', {
        asset_id: id,
      })) as HqRecord & Access
      const bytes = await transfer.download(access.url)
      if (access.asset.sha256 && sha256(bytes) !== access.asset.sha256)
        throw new Error(
          `${access.asset.name} downloaded with a different SHA-256 than HQ recorded.`,
        )
      files.push({ name: entryName(index, access.asset.name, used), bytes })
    }
    const zip = writeZip(files)
    guard()
    const name = `${(input.name ?? 'files').replace(/[\\/:*?"<>|]/g, '-')}.zip`
    const prepared = (await hq.call('assets_prepare_upload', {
      ...(job.project_id ? { project_id: job.project_id } : {}),
      name,
      mime: 'application/zip',
      bytes: zip.byteLength,
      job_id: job.id,
      idempotency_key: `job:${job.id}:${token}:prepare`,
    })) as HqRecord & Prepared
    const upload = prepared.upload
    if (upload.mode === 'presigned_put' && 'url' in upload)
      await transfer.upload(
        { url: upload.url, method: 'PUT', headers: upload.headers },
        zip,
      )
    else if (upload.mode === 'resumable' && 'session_url' in upload)
      await transfer.upload(
        { url: upload.session_url, method: 'PUT', headers: {} },
        zip,
      )
    else
      throw new Error(
        `HQ asked for an upload mode this worker can’t do (${upload.mode}).`,
      )
    await hq.call('assets_finalize', { asset_id: prepared.asset.id })
    guard()
    await hq.call('assets_record_generated', {
      job_id: job.id,
      fencing_token: token,
      asset_ids: [prepared.asset.id],
    })
    const summary = `Zipped ${files.length} file(s) into ${name} (${zip.byteLength} bytes).`
    await finish('done', summary)
    log(summary)
    return {
      jobId: job.id,
      operation: job.operation,
      status: 'succeeded',
      outputs: [prepared.asset.id],
      detail: summary,
    }
  } catch (error) {
    if (
      leaseLost ||
      (error instanceof HqRefusal && error.code === 'lease_lost')
    ) {
      log('lease lost — stopping without writing')
      return {
        jobId: jobId ?? '',
        operation: 'unknown',
        status: 'lease_lost',
        outputs: [],
        detail: 'lease lost',
      }
    }
    const message = error instanceof Error ? error.message : String(error)
    log(`failed: ${message}`)
    // The run fails and the task opens for another attempt; the job itself
    // fails only when the attempts are spent (HQ's tick settles it then).
    await finish('failed', 'The job failed.', message.slice(0, 2000)).catch(
      (failure: unknown) =>
        log(`couldn’t finish the run: ${(failure as Error).message}`),
    )
    return {
      jobId: jobId ?? '',
      operation: 'unknown',
      status: 'failed',
      outputs: [],
      detail: message,
    }
  } finally {
    clearInterval(beat)
  }
}
