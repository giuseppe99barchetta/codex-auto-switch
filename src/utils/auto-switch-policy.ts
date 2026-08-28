import type { ProfileRateLimits, ProfileSummary } from '../types'

/** Clamp the configured exhaustion threshold to a sensible percentage range. */
export function normalizeAutoSwitchThreshold(value: number): number {
  if (!Number.isFinite(value)) {
    return 100
  }
  return Math.min(100, Math.max(50, value))
}

/** Returns true when at least one reported rate-limit window reached the threshold. */
export function isProfileRateLimited(
  rateLimits: ProfileRateLimits | null | undefined,
  thresholdPercent = 100,
): boolean {
  if (!rateLimits) {
    return false
  }

  const threshold = normalizeAutoSwitchThreshold(thresholdPercent)
  return [rateLimits.primary, rateLimits.secondary].some(
    (window) => window !== null && window.usedPercent >= threshold,
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
  thresholdPercent = 100,
): ProfileSummary | undefined {
  if (!activeProfileId) {
    return undefined
  }

  const threshold = normalizeAutoSwitchThreshold(thresholdPercent)
  const active = profiles.find((profile) => profile.id === activeProfileId)
  if (!active || !isProfileRateLimited(active.rateLimits, threshold)) {
    return undefined
  }

  return profiles
    .filter((profile) => profile.id !== activeProfileId)
    .filter((profile) => hasKnownRateLimitWindow(profile.rateLimits))
    .filter((profile) => !isProfileRateLimited(profile.rateLimits, threshold))
    .map((profile) => ({
      profile,
      score: availabilityScore(profile.rateLimits),
    }))
    .sort((a, b) => b.score - a.score)[0]?.profile
}

function hasKnownRateLimitWindow(
  rateLimits: ProfileRateLimits | null | undefined,
): boolean {
  return Boolean(rateLimits?.primary || rateLimits?.secondary)
}

/**
 * Rank by the tightest known remaining window. This avoids selecting an
 * account with a healthy short window but an almost exhausted long window.
 */
function availabilityScore(
  rateLimits: ProfileRateLimits | null | undefined,
): number {
  const remaining = [rateLimits?.primary, rateLimits?.secondary]
    .filter((window) => window !== null && window !== undefined)
    .map((window) => window.remainingPercent)

  return remaining.length > 0 ? Math.min(...remaining) : -1
}
