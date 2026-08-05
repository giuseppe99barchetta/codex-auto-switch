import { ProfileRateLimits } from '../types'
import { formatRateLimitWindowLabel } from './rate-limit-normalizer'

const DISPLAY_SEPARATOR = ' • '

/** Customizable labels for profile display strings. */
export interface ProfileDisplayLabels {
  /** Label for unknown/missing values. */
  unknown: string
}

/** Default labels for profile display in the VS Code UI. */
export const DEFAULT_PROFILE_DISPLAY_LABELS: ProfileDisplayLabels = {
  unknown: 'Unknown',
}

function formatPercent(value: number): string {
  return `${Math.round(value)}%`
}

/** Formats a plan type for display, converting to uppercase unless it's the unknown label. */
export function formatProfilePlanDisplay(
  planType: string,
  unknownLabel = DEFAULT_PROFILE_DISPLAY_LABELS.unknown,
): string {
  const rawPlan = planType || unknownLabel
  return rawPlan === unknownLabel ? unknownLabel : rawPlan.toUpperCase()
}

/** Formats rate limits for display as a readable string (e.g., "5h 75% • 7d 50%"), or null if none available. */
export function formatProfileRateLimitsDisplay(
  rateLimits?: ProfileRateLimits | null,
): string | null {
  const parts: string[] = []

  if (rateLimits?.primary) {
    parts.push(
      `${formatRateLimitWindowLabel(rateLimits.primary.windowDurationMins)} ${formatPercent(rateLimits.primary.remainingPercent)}`.trim(),
    )
  }

  if (rateLimits?.secondary) {
    parts.push(
      `${formatRateLimitWindowLabel(rateLimits.secondary.windowDurationMins)} ${formatPercent(rateLimits.secondary.remainingPercent)}`.trim(),
    )
  }

  return parts.length > 0 ? parts.join(DISPLAY_SEPARATOR) : null
}

/** Builds a complete profile metadata display string combining plan type and rate limits. */
export function buildProfileMetaDisplay(
  planType: string,
  rateLimits?: ProfileRateLimits | null,
  labels: ProfileDisplayLabels = DEFAULT_PROFILE_DISPLAY_LABELS,
): string {
  const parts = [formatProfilePlanDisplay(planType, labels.unknown)]
  const limitsDisplay = formatProfileRateLimitsDisplay(rateLimits)

  if (limitsDisplay) {
    parts.push(limitsDisplay)
  }

  return parts.join(DISPLAY_SEPARATOR)
}
