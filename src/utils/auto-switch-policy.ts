import type {
  ProfileRateLimitWindow,
  ProfileRateLimits,
  ProfileSummary,
} from '../types'

export interface AutoSwitchThresholds {
  fallbackPercent: number
  fiveHourPercent: number
  weeklyPercent: number
}

export type AutoSwitchThresholdInput = number | AutoSwitchThresholds

const FIVE_HOUR_MINUTES = 300
const WEEKLY_MINUTES = 10080
const RESET_BONUS_WINDOW_MS = 60 * 60 * 1000
const RESET_BONUS_MAX_POINTS = 30

/** Clamp the configured exhaustion threshold to a sensible percentage range. */
export function normalizeAutoSwitchThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 100
  }
  return Math.min(100, Math.max(50, value))
}

export function normalizeAutoSwitchThresholds(
  thresholds: AutoSwitchThresholds,
): AutoSwitchThresholds {
  return {
    fallbackPercent: normalizeAutoSwitchThreshold(thresholds.fallbackPercent),
    fiveHourPercent: normalizeAutoSwitchThreshold(thresholds.fiveHourPercent),
    weeklyPercent: normalizeAutoSwitchThreshold(thresholds.weeklyPercent),
  }
}

export function minimumAutoSwitchThreshold(
  thresholds: AutoSwitchThresholdInput,
): number {
  const normalized = normalizeThresholdInput(thresholds)
  return Math.min(
    normalized.fallbackPercent,
    normalized.fiveHourPercent,
    normalized.weeklyPercent,
  )
}

export function getAutoSwitchThresholdForWindow(
  window: ProfileRateLimitWindow,
  thresholds: AutoSwitchThresholdInput,
): number {
  const normalized = normalizeThresholdInput(thresholds)
  if (window.windowDurationMins === FIVE_HOUR_MINUTES) {
    return normalized.fiveHourPercent
  }
  if (window.windowDurationMins === WEEKLY_MINUTES) {
    return normalized.weeklyPercent
  }
  return normalized.fallbackPercent
}

/** Returns true when at least one reported rate-limit window reached its threshold. */
export function isProfileRateLimited(
  rateLimits: ProfileRateLimits | null | undefined,
  thresholds: AutoSwitchThresholdInput = 100,
): boolean {
  if (!rateLimits) {
    return false
  }

  return [rateLimits.primary, rateLimits.secondary].some(
    (window) =>
      window !== null &&
      window.usedPercent >= getAutoSwitchThresholdForWindow(window, thresholds),
  )
}

/**
 * Pick the best replacement account after the active profile is exhausted.
 * Candidates with unknown usage are intentionally ignored: automatically
 * switching to an account whose quota is unknown can cause a switch loop.
 */
export function chooseAutoSwitchTarget(
  profiles: readonly ProfileSummary[],
  activeProfileId: string | undefined,
  thresholds: AutoSwitchThresholdInput = 100,
  now = Date.now(),
): ProfileSummary | undefined {
  if (!activeProfileId) {
    return undefined
  }

  const active = profiles.find((profile) => profile.id === activeProfileId)
  if (!active || !isProfileRateLimited(active.rateLimits, thresholds)) {
    return undefined
  }

  return profiles
    .filter((profile) => profile.id !== activeProfileId)
    .filter((profile) => hasKnownRateLimitWindow(profile.rateLimits))
    .filter((profile) => !isProfileRateLimited(profile.rateLimits, thresholds))
    .map((profile) => ({
      profile,
      score: availabilityScore(profile.rateLimits, now),
    }))
    .sort((a, b) => b.score - a.score)[0]?.profile
}

function normalizeThresholdInput(
  thresholds: AutoSwitchThresholdInput,
): AutoSwitchThresholds {
  if (typeof thresholds === 'number') {
    const value = normalizeAutoSwitchThreshold(thresholds)
    return {
      fallbackPercent: value,
      fiveHourPercent: value,
      weeklyPercent: value,
    }
  }
  return normalizeAutoSwitchThresholds(thresholds)
}

function hasKnownRateLimitWindow(
  rateLimits: ProfileRateLimits | null | undefined,
): boolean {
  return Boolean(rateLimits?.primary || rateLimits?.secondary)
}

/**
 * Rank by the tightest effective remaining window. A reset that is less than
 * one hour away adds a gradually increasing bonus to that specific window,
 * while a distant reset does not affect the score.
 */
function availabilityScore(
  rateLimits: ProfileRateLimits | null | undefined,
  now: number,
): number {
  const windows = [rateLimits?.primary, rateLimits?.secondary].filter(
    (window): window is ProfileRateLimitWindow => Boolean(window),
  )

  const effectiveRemaining = windows.map(
    (window) => window.remainingPercent + resetSoonBonus(window, now),
  )

  return Math.min(...effectiveRemaining)
}

function resetSoonBonus(window: ProfileRateLimitWindow, now: number): number {
  if (typeof window.resetsAt !== 'number') {
    return 0
  }
  const remainingMs = window.resetsAt - now
  if (remainingMs >= RESET_BONUS_WINDOW_MS) {
    return 0
  }
  if (remainingMs <= 0) {
    return RESET_BONUS_MAX_POINTS
  }
  return (1 - remainingMs / RESET_BONUS_WINDOW_MS) * RESET_BONUS_MAX_POINTS
}
