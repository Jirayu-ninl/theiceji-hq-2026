import { z } from 'zod'
import { invalid } from './errors'
import { isDay } from './time'

/**
 * Input building blocks shared by every kernel and module service. Services validate
 * their own input — a server action, a test and a future MCP tool all pass
 * through the same checks.
 *
 * Text is trimmed and an empty string means "cleared" (null). A key that is
 * absent means "unchanged", which is how partial updates stay partial.
 */

const clean = (value: unknown) => {
  if (typeof value !== 'string') return value
  const trimmed = value.trim()
  return trimmed === '' ? null : trimmed
}

export const text = {
  required: (label: string, max: number) =>
    z.preprocess(
      clean,
      z
        .string({ error: `${label} is required.` })
        .max(max, `${label} must be ${max} characters or fewer.`),
    ),
  optional: (label: string, max: number) =>
    z.preprocess(
      clean,
      z
        .string({ error: `${label} must be text.` })
        .max(max, `${label} must be ${max} characters or fewer.`)
        .nullable()
        .optional(),
    ),
}

export function optionalInt(label: string, min: number, max: number) {
  return z.preprocess(
    (value) => {
      const cleaned = clean(value)
      return typeof cleaned === 'string' ? Number(cleaned) : cleaned
    },
    z
      .number({ error: `${label} must be a number.` })
      .int(`${label} must be a whole number.`)
      .min(min, `${label} must be at least ${min}.`)
      .max(max, `${label} must be at most ${max}.`)
      .nullable()
      .optional(),
  )
}

export function choice<const T extends readonly [string, ...string[]]>(
  values: T,
  message: string,
) {
  return z.preprocess(clean, z.enum(values, { error: message }))
}

export function optionalChoice<const T extends readonly [string, ...string[]]>(
  values: T,
  message: string,
) {
  return z.preprocess(
    clean,
    z.enum(values, { error: message }).nullable().optional(),
  )
}

export function day(label: string) {
  return z.preprocess(
    clean,
    z
      .string({ error: `${label} must be a date.` })
      .refine(isDay, `${label} must be a date (YYYY-MM-DD).`)
      .nullable()
      .optional(),
  )
}

/** The revision a form was rendered from. */
export const revision = z.coerce
  .number({ error: 'Reload the page and try again.' })
  .int('Reload the page and try again.')
  .min(1, 'Reload the page and try again.')

export const recordId = (label: string) =>
  z.preprocess(clean, z.uuid({ error: `${label} not found.` }))

/** An optional record ID where an empty string means "none". */
export const optionalRecordId = (label: string) =>
  z.preprocess(
    clean,
    z
      .uuid({ error: `${label} not found.` })
      .nullable()
      .optional(),
  )

/** A list from an array, or from a comma- or newline-separated form field. */
function listFrom(value: unknown): unknown {
  if (value === undefined || value === null) return value
  if (Array.isArray(value)) return value
  if (typeof value === 'string')
    return value
      .split(/[\n,]/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  return value
}

export function stringList(label: string, maxItems: number, maxLength = 200) {
  return z.preprocess(
    listFrom,
    z
      .array(
        z
          .string()
          .trim()
          .min(1)
          .max(
            maxLength,
            `Each ${label} must be ${maxLength} characters or fewer.`,
          ),
      )
      .max(maxItems, `List at most ${maxItems} ${label}.`),
  )
}

export function idList(label: string, maxItems: number) {
  return z.preprocess(
    listFrom,
    z
      .array(z.uuid({ error: `${label} not found.` }))
      .max(maxItems, `List at most ${maxItems}.`),
  )
}

export function choiceList<const T extends readonly [string, ...string[]]>(
  values: T,
  message: string,
) {
  return z.preprocess(listFrom, z.array(z.enum(values, { error: message })))
}

/** A whole number from a form field or JSON; empty means "not set". */
export function int(label: string, min: number, max: number) {
  return optionalInt(label, min, max)
}

/** A stable machine key: lowercase letters, digits, `_`, `-`, `:` and `.`. */
export const machineKey = (label: string, max = 80) =>
  z.preprocess(
    clean,
    z
      .string({ error: `${label} is required.` })
      .max(max, `${label} must be ${max} characters or fewer.`)
      .regex(
        /^[a-z0-9][a-z0-9_.:-]*$/,
        `${label} must be lowercase letters, digits, and _ . : -`,
      ),
  )

/** A machine key where an empty string clears it and an absent key leaves it. */
export const optionalMachineKey = (label: string, max = 80) =>
  z.preprocess(
    clean,
    z
      .string({ error: `${label} must be text.` })
      .max(max, `${label} must be ${max} characters or fewer.`)
      .regex(
        /^[a-z0-9][a-z0-9_.:-]*$/,
        `${label} must be lowercase letters, digits, and _ . : -`,
      )
      .nullable()
      .optional(),
  )

export const idempotencyKey = z
  .string({ error: 'An idempotency key is required.' })
  .trim()
  .min(8, 'An idempotency key must be at least 8 characters.')
  .max(200, 'An idempotency key must be 200 characters or fewer.')

export function parseInput<T extends z.ZodType>(
  schema: T,
  raw: unknown,
): z.output<T> {
  const result = schema.safeParse(raw)
  if (result.success) return result.data
  const fields: Record<string, string> = {}
  for (const issue of result.error.issues) {
    const key = issue.path.map(String).join('.') || 'form'
    fields[key] ??= issue.message
  }
  const first = result.error.issues[0]
  throw invalid(first?.message ?? 'Check the form and try again.', fields)
}
