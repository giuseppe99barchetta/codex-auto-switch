import * as vscode from 'vscode'
import { ProfileSummary, ResolvedCodexHome } from '../types'
import { getProfilePlanDisplay } from './profile-display'
import { formatProfileResetTime } from '../utils/profile-reset-time'
import { formatProfileEmailLabel } from '../utils/profile-email'
import { formatRateLimitWindowLabel } from '../utils/rate-limit-normalizer'
import {
  buildProfileTooltipActionsFooter,
  buildProfileTooltipHomeSection,
  buildProfileTooltipRow,
  escapeTableCell,
  formatRateLimitCell,
  padTableCell,
} from '../utils/profile-tooltip-format'

/** Column info for a rate-limit slot (primary/secondary) across all profiles. */
interface RateLimitColumnInfo {
  /** Whether the column should be shown at all. */
  include: boolean
  /** Header label: the shared duration (e.g. "5h"), or a generic label if profiles disagree. */
  headerLabel: string
  /** Whether each cell must show its own duration because the header can't. */
  perCellDuration: boolean
}

/**
 * Resolves how a rate-limit column (primary/secondary) should be rendered
 * across all profiles. If every profile with a window in this slot reports
 * the same duration, the header can state it directly. Otherwise the header
 * falls back to a generic label and individual cells carry their own
 * duration, so no row is shown under a duration that isn't actually its own.
 */
function resolveRateLimitColumn(
  profiles: ProfileSummary[],
  slot: 'primary' | 'secondary',
): RateLimitColumnInfo {
  const durations = profiles
    .map((p) => p.rateLimits?.[slot]?.windowDurationMins)
    .filter((d): d is number => typeof d === 'number')

  if (durations.length === 0) {
    return { include: false, headerLabel: '', perCellDuration: false }
  }

  const allSame = durations.every((d) => d === durations[0])
  return allSame
    ? {
        include: true,
        headerLabel: formatRateLimitWindowLabel(durations[0]),
        perCellDuration: false,
      }
    : {
        include: true,
        headerLabel: vscode.l10n.t('Limit'),
        perCellDuration: true,
      }
}

/**
 * Creates a markdown tooltip for displaying profile information.
 * Shows a table of all profiles with their plan type, rate limits, and refresh status.
 * @param activeProfile - The currently active profile, or null if none is active.
 * @param profiles - All available profiles to display in the tooltip.
 * @param home - The currently active Codex home, if applicable.
 * @param getRefreshLabel - Optional function to get the refresh status label for each profile.
 * @returns A VS Code MarkdownString containing the formatted tooltip.
 */
export function createProfileTooltip(
  activeProfile: ProfileSummary | null,
  profiles: ProfileSummary[],
  home?: ResolvedCodexHome,
  getRefreshLabel?: (profileId: string) => string,
): vscode.MarkdownString {
  const tooltip = new vscode.MarkdownString()
  tooltip.supportThemeIcons = true
  tooltip.supportHtml = true
  tooltip.isTrusted = {
    enabledCommands: [
      'codex-switch.profile.manage',
      'codex-switch.profile.activate',
      'codex-switch.profile.refresh',
    ],
  }

  tooltip.appendMarkdown(`${vscode.l10n.t('Codex accounts')}\n\n`)

  if (!profiles || profiles.length === 0) {
    tooltip.appendMarkdown(`${vscode.l10n.t('No profiles yet.')}\n\n`)
  } else {
    const activeId = activeProfile?.id
    const includePlan = profiles.some((p) => {
      const planType = p.planType.trim()
      return planType && planType.toLowerCase() !== 'unknown'
    })
    const primaryColumn = resolveRateLimitColumn(profiles, 'primary')
    const secondaryColumn = resolveRateLimitColumn(profiles, 'secondary')
    const includePrimary = primaryColumn.include
    const includeSecondary = secondaryColumn.include

    const headers = [
      '',
      padTableCell(escapeTableCell(vscode.l10n.t('Profile'))),
    ]
    const separators = ['---', '---']
    if (includePlan) {
      headers.push(padTableCell(escapeTableCell(vscode.l10n.t('Plan'))))
      separators.push('---')
    }
    if (includePrimary) {
      headers.push(
        padTableCell(escapeTableCell(primaryColumn.headerLabel)),
        padTableCell(escapeTableCell(vscode.l10n.t('Reset'))),
      )
      separators.push('---:', '---')
    }
    if (includeSecondary) {
      headers.push(
        padTableCell(escapeTableCell(secondaryColumn.headerLabel)),
        padTableCell(escapeTableCell(vscode.l10n.t('Reset'))),
      )
      separators.push('---:', '---')
    }
    headers.push(padTableCell(escapeTableCell(vscode.l10n.t('Refresh'))))
    separators.push('---')

    tooltip.appendMarkdown(`| ${headers.join(' | ')} |\n`)
    tooltip.appendMarkdown(`|${separators.join('|')}|\n`)

    for (const p of profiles) {
      const plan = escapeTableCell(getProfilePlanDisplay(p.planType))
      const primary = escapeTableCell(
        formatRateLimitCell(
          p.rateLimits?.primary,
          primaryColumn.perCellDuration,
        ),
      )
      const primaryReset = escapeTableCell(
        formatProfileResetTime(p.rateLimits?.primary?.resetsAt) || '',
      )
      const secondary = escapeTableCell(
        formatRateLimitCell(
          p.rateLimits?.secondary,
          secondaryColumn.perCellDuration,
        ),
      )
      const secondaryReset = escapeTableCell(
        formatProfileResetTime(p.rateLimits?.secondary?.resetsAt) || '',
      )
      const emailDisplay = formatProfileEmailLabel(
        p.email,
        vscode.l10n.t('Unknown'),
      )
      const isActive = Boolean(activeId && p.id === activeId)
      const refresh = escapeTableCell(getRefreshLabel?.(p.id) ?? '')

      tooltip.appendMarkdown(
        buildProfileTooltipRow({
          profileId: p.id,
          name: p.name,
          plan,
          primary,
          primaryReset,
          secondary,
          secondaryReset,
          refresh,
          email: emailDisplay,
          isActive,
          includePlan,
          includePrimary,
          includeSecondary,
        }),
      )
    }
    tooltip.appendMarkdown('\n')
  }

  if (home) {
    tooltip.appendMarkdown(
      buildProfileTooltipHomeSection(home.name, home.fsPath),
    )
  }

  tooltip.appendMarkdown(
    buildProfileTooltipActionsFooter(
      vscode.l10n.t('Manage profiles'),
      vscode.l10n.t('Refresh limits'),
    ),
  )
  return tooltip
}
