import { ProfileRateLimitWindow, ProfileRateLimits } from '../types'

/** Key used to identify Codex-specific rate limits in the API response. */
export const CODEX_LIMIT_ID = 'codex'

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value)
}

/** Clamps and rounds a percentage value to the 0–100 range, treating non-finite numbers as 0. */
export function clampPercent(value: number): number {
  if (!Number.isFinite(value)) {
    return 0
  }
  return Math.max(0, Math.min(100, Math.round(value)))
}

function isPlausibleUnixTimestampSeconds(value: number): boolean {
  return Number.isFinite(value) && value >= 946684800 && value <= 4102444800
}

function readWindowUsedPercent(window: Record<string, unknown>): number | null {
  const usedPercent = window.usedPercent ?? window.used_percent
  return typeof usedPercent === 'number' && Number.isFinite(usedPercent)
    ? clampPercent(usedPercent)
    : null
}

function readWindowDurationMins(
  window: Record<string, unknown>,
): number | null {
  const durationMins = window.windowDurationMins ?? window.window_minutes
  return typeof durationMins === 'number' &&
    Number.isFinite(durationMins) &&
    Number.isInteger(durationMins) &&
    durationMins > 0
    ? durationMins
    : null
}

function readWindowResetTimestamp(
  window: Record<string, unknown>,
  nowSeconds: number,
): number | null {
  const resetsAt = window.resetsAt ?? window.resets_at
  if (
    typeof resetsAt === 'number' &&
    isPlausibleUnixTimestampSeconds(resetsAt)
  ) {
    return resetsAt
  }

  const resetsInSeconds = window.resets_in_seconds
  if (
    typeof resetsInSeconds === 'number' &&
    Number.isFinite(resetsInSeconds) &&
    resetsInSeconds >= 0
  ) {
    const resetTimestamp = nowSeconds + Math.floor(resetsInSeconds)
    return isPlausibleUnixTimestampSeconds(resetTimestamp)
      ? resetTimestamp
      : null
  }

  return null
}

function normalizeRateLimitWindow(
  window: unknown,
  nowSeconds: number,
): ProfileRateLimitWindow | null {
  if (!isRecord(window)) {
    return null
  }

  const usedPercent = readWindowUsedPercent(window)
  if (usedPercent === null) {
    return null
  }

  const windowDurationMins = readWindowDurationMins(window)
  if (windowDurationMins === null) {
    return null
  }

  const resetsAt = readWindowResetTimestamp(window, nowSeconds)

  return {
    usedPercent,
    remainingPercent: clampPercent(100 - usedPercent),
    resetsAt,
    windowDurationMins,
  }
}

/**
 * Maps `primary`/`secondary` positionally, as the API itself names them,
 * instead of matching against fixed duration constants -- OpenAI does not
 * guarantee primary is 5h and secondary is weekly, and has changed window
 * lengths before without renaming these fields.
 */
function normalizeRateLimitSnapshot(
  snapshot: unknown,
  nowSeconds: number,
): ProfileRateLimits | null {
  if (!isRecord(snapshot)) {
    return null
  }

  const primary = normalizeRateLimitWindow(snapshot.primary, nowSeconds)
  const secondary = normalizeRateLimitWindow(snapshot.secondary, nowSeconds)

  if (!primary && !secondary) {
    return null
  }

  return { primary, secondary }
}

/** Compact, language-neutral window-length label (e.g. "5h", "7d", "30d"). Avoids a
 *  translated "5h"/"Weekly" that may now be wrong, and avoids new per-duration strings. */
export function formatRateLimitWindowLabel(durationMins: number): string {
  if (!Number.isFinite(durationMins) || durationMins <= 0) {
    return ''
  }
  if (durationMins < 60) {
    return `${Math.round(durationMins)}m`
  }
  const hours = durationMins / 60
  if (hours < 24) {
    return `${Math.round(hours)}h`
  }
  return `${Math.round(hours / 24)}d`
}

function readRateLimitSnapshots(response: unknown): unknown[] {
  if (!isRecord(response)) {
    return []
  }

  const snapshots: unknown[] = []
  const byLimitId = response.rateLimitsByLimitId
  if (isRecord(byLimitId) && CODEX_LIMIT_ID in byLimitId) {
    snapshots.push(byLimitId[CODEX_LIMIT_ID])
  }
  snapshots.push(response.rateLimits)
  return snapshots
}

/** Parses and normalizes raw rate-limit API response into a structured ProfileRateLimits object. */
export function normalizeRateLimitResponse(
  response: unknown,
  nowSeconds: number,
): ProfileRateLimits | null {
  const snapshots = readRateLimitSnapshots(response)

  for (const snapshot of snapshots) {
    const normalized = normalizeRateLimitSnapshot(snapshot, nowSeconds)
    if (normalized) {
      return normalized
    }
  }

  return null
}
