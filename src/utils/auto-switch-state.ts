import type { ProfileRateLimitWindow, ProfileSummary } from '../types'

export interface PendingAutoSwitchState {
  sourceId: string
  targetId: string
  reason: string
  createdAt: number
}

export interface AutoSwitchHysteresisState {
  profileId: string
  blockedUntilResetAt?: number
}

export function formatRateLimitWindowLabel(
  window: ProfileRateLimitWindow,
): string {
  if (window.windowDurationMins === 300) {
    return '5h'
  }
  if (window.windowDurationMins === 10080) {
    return 'weekly'
  }
  if (window.windowDurationMins % 1440 === 0) {
    return `${window.windowDurationMins / 1440}d`
  }
  if (window.windowDurationMins % 60 === 0) {
    return `${window.windowDurationMins / 60}h`
  }
  return `${window.windowDurationMins}m`
}

export function describeThresholdReason(
  profile: ProfileSummary,
  thresholdPercent: number,
): string {
  const windows = [profile.rateLimits?.primary, profile.rateLimits?.secondary]
    .filter((window): window is ProfileRateLimitWindow => Boolean(window))
    .filter((window) => window.usedPercent >= thresholdPercent)

  return windows
    .map(
      (window) =>
        `${formatRateLimitWindowLabel(window)} ${Math.round(window.usedPercent)}%`,
    )
    .join(' + ')
}

export function getTriggeredResetAt(
  profile: ProfileSummary,
  thresholdPercent: number,
): number | undefined {
  const resetTimes = [profile.rateLimits?.primary, profile.rateLimits?.secondary]
    .filter((window): window is ProfileRateLimitWindow => Boolean(window))
    .filter((window) => window.usedPercent >= thresholdPercent)
    .map((window) => window.resetsAt)
    .filter((value): value is number => typeof value === 'number')

  return resetTimes.length > 0 ? Math.min(...resetTimes) : undefined
}

export function isHysteresisBlocked(
  profile: ProfileSummary,
  state: AutoSwitchHysteresisState | null | undefined,
  recoveryPercent: number,
  now: number,
): boolean {
  if (!state || state.profileId !== profile.id) {
    return false
  }
  if (
    state.blockedUntilResetAt !== undefined &&
    now >= state.blockedUntilResetAt
  ) {
    return false
  }

  const windows = [
    profile.rateLimits?.primary,
    profile.rateLimits?.secondary,
  ].filter((window): window is ProfileRateLimitWindow => Boolean(window))
  if (windows.length === 0) {
    return true
  }
  return windows.some((window) => window.usedPercent > recoveryPercent)
}

export function findNextResetAt(
  profiles: readonly ProfileSummary[],
  now: number,
): number | undefined {
  const resetTimes = profiles
    .flatMap((profile) => [
      profile.rateLimits?.primary,
      profile.rateLimits?.secondary,
    ])
    .filter((window): window is ProfileRateLimitWindow => Boolean(window))
    .map((window) => window.resetsAt)
    .filter((value): value is number => typeof value === 'number' && value > now)

  return resetTimes.length > 0 ? Math.min(...resetTimes) : undefined
}
