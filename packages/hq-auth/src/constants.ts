/**
 * Auth constants with no imports at all — the proxy (edge runtime) and the
 * Node-only session code both read them, so this file must stay free of
 * `node:crypto`, `next/headers`, and the database.
 */

/**
 * HQ's session cookie. Cookies ignore the port, so on localhost every app on
 * the machine shares one jar — other apps use names of their own, never this
 * one.
 */
export const SESSION_COOKIE = 'horizon_session'

/** How long a fresh session lives. */
export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30 // 30 days

/**
 * Sliding window: once a session has less than this left, using it pushes the
 * expiry back out to a full TTL. An active admin is never logged out mid-edit;
 * an abandoned one still lapses.
 */
export const SESSION_REFRESH_MS = 1000 * 60 * 60 * 24 * 15 // 15 days

/** Enforced by the login form and the `user:create` CLI alike. */
export const MIN_PASSWORD_LENGTH = 10
