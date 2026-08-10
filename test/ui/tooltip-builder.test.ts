/** Tests for tooltip-builder. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProfileSummary, ResolvedCodexHome } from '../../src/types'
import { createProfileTooltip } from '../../src/ui/tooltip-builder'
import { escapeTableCell } from '../../src/utils/profile-tooltip-format'
import { escapeMarkdown } from '../../src/utils/markdown'

function makeProfile(overrides: Partial<ProfileSummary> = {}): ProfileSummary {
  return {
    id: '123e4567-e89b-12d3-a456-426614174000',
    name: 'Alice * [x] | <tag>',
    email: 'evil"quote\\slash@example.com',
    planType: 'pro',
    createdAt: '2026-06-19T10:00:00.000Z',
    updatedAt: '2026-06-19T10:00:00.000Z',
    rateLimits: {
      primary: {
        usedPercent: 42.2,
        remainingPercent: 57.8,
        resetsAt: 1_700_000_000,
        windowDurationMins: 300,
      },
      secondary: {
        usedPercent: 99.4,
        remainingPercent: 0.6,
        resetsAt: null,
        windowDurationMins: 10080,
      },
    },
    ...overrides,
  }
}

function makeHome(
  overrides: Partial<ResolvedCodexHome> = {},
): ResolvedCodexHome {
  return {
    id: 'home-1',
    name: 'Home * [A] | <B>',
    fsPath: 'C:\\tmp\\home_[1]\\<x>',
    envValue: 'C:\\tmp\\home_[1]',
    authPath: 'C:\\tmp\\home_[1]\\auth.json',
    source: 'default',
    isDefault: true,
    usesPerHomeState: false,
    ...overrides,
  }
}

test('createProfileTooltip restricts commands and escapes profile markup', () => {
  const profile = makeProfile()
  const tooltip = createProfileTooltip(profile, [profile], makeHome())

  assert.equal(tooltip.supportThemeIcons, true)
  assert.equal(tooltip.supportHtml, true)
  assert.deepEqual(tooltip.isTrusted, {
    enabledCommands: [
      'codex-switch.profile.manage',
      'codex-switch.profile.activate',
      'codex-switch.profile.refresh',
    ],
  })
  assert.match(tooltip.value, /Codex accounts/)
  assert.match(tooltip.value, /Manage profiles/)
  assert.match(tooltip.value, /Refresh limits/)
  assert.ok(
    tooltip.value.includes(
      `${escapeMarkdown(profile.name).replace(/\|/g, '\\|')}`,
    ),
  )
  assert.ok(tooltip.value.includes('evil\\"quote\\\\slash@example.com'))
  assert.ok(tooltip.value.includes(escapeMarkdown('Home * [A] | <B>')))
  assert.ok(tooltip.value.includes(escapeMarkdown('C:\\tmp\\home_[1]\\<x>')))
  assert.match(tooltip.value, /\$\(check\)/)
  assert.match(tooltip.value, /58%/)
  assert.ok(tooltip.value.includes('&nbsp;1%&nbsp;'))
})

test('createProfileTooltip renders the empty-state copy', () => {
  const tooltip = createProfileTooltip(null, [])

  assert.match(tooltip.value, /Codex accounts/)
  assert.match(tooltip.value, /No profiles yet\./)
  assert.match(tooltip.value, /Manage profiles/)
  assert.match(tooltip.value, /Refresh limits/)
})

test('createProfileTooltip omits primary columns when all profiles lack a primary window', () => {
  const profile = makeProfile({
    rateLimits: {
      primary: null,
      secondary: {
        usedPercent: 7,
        remainingPercent: 93,
        resetsAt: 1_784_495_529,
        windowDurationMins: 10080,
      },
    },
  })
  const tooltip = createProfileTooltip(profile, [profile])

  assert.ok(!tooltip.value.includes('&nbsp;5h&nbsp;'))
  assert.ok(tooltip.value.includes('&nbsp;7d&nbsp;'))
  assert.ok(tooltip.value.includes('&nbsp;93%&nbsp;'))
  assert.match(tooltip.value, /\|---\|---\|---\|---:\|---\|---\|/)
})

test('createProfileTooltip derives the column header from the actual window duration', () => {
  // A 30-day window is not "5h" or "Weekly" -- the header must reflect the
  // real duration reported by the API instead of a stale hardcoded label.
  const profile = makeProfile({
    rateLimits: {
      primary: {
        usedPercent: 31,
        remainingPercent: 69,
        resetsAt: 1_788_524_905,
        windowDurationMins: 43_200,
      },
      secondary: null,
    },
  })
  const tooltip = createProfileTooltip(profile, [profile])

  assert.ok(tooltip.value.includes('&nbsp;30d&nbsp;'))
  assert.ok(!tooltip.value.includes('&nbsp;5h&nbsp;'))
  assert.ok(!tooltip.value.includes('&nbsp;Weekly&nbsp;'))
})

test('createProfileTooltip falls back to a generic header when profiles disagree on primary window duration', () => {
  // Account A has a 5h primary window, account B has a 30d primary window --
  // showing either duration as the shared header would misrepresent the other.
  const profileA = makeProfile({
    id: '123e4567-e89b-12d3-a456-426614174001',
    name: 'Account A',
    rateLimits: {
      primary: {
        usedPercent: 42,
        remainingPercent: 58,
        resetsAt: null,
        windowDurationMins: 300,
      },
      secondary: null,
    },
  })
  const profileB = makeProfile({
    id: '123e4567-e89b-12d3-a456-426614174002',
    name: 'Account B',
    rateLimits: {
      primary: {
        usedPercent: 30,
        remainingPercent: 70,
        resetsAt: null,
        windowDurationMins: 43_200,
      },
      secondary: null,
    },
  })
  const tooltip = createProfileTooltip(null, [profileA, profileB])

  assert.ok(tooltip.value.includes('&nbsp;Limit&nbsp;'))
  assert.ok(!tooltip.value.includes('&nbsp;5h&nbsp;'))
  assert.ok(!tooltip.value.includes('&nbsp;30d&nbsp;'))
  assert.ok(tooltip.value.includes(escapeTableCell('58% (5h)')))
  assert.ok(tooltip.value.includes(escapeTableCell('70% (30d)')))
})

test('createProfileTooltip resolves primary and secondary columns independently', () => {
  // Both profiles agree on the primary duration, so that column keeps a
  // plain duration header; they disagree on secondary, so that one falls
  // back to the generic label with per-cell durations.
  const profileA = makeProfile({
    id: '123e4567-e89b-12d3-a456-426614174003',
    name: 'Account A',
    rateLimits: {
      primary: {
        usedPercent: 42,
        remainingPercent: 58,
        resetsAt: null,
        windowDurationMins: 300,
      },
      secondary: {
        usedPercent: 7,
        remainingPercent: 93,
        resetsAt: null,
        windowDurationMins: 10_080,
      },
    },
  })
  const profileB = makeProfile({
    id: '123e4567-e89b-12d3-a456-426614174004',
    name: 'Account B',
    rateLimits: {
      primary: {
        usedPercent: 10,
        remainingPercent: 90,
        resetsAt: null,
        windowDurationMins: 300,
      },
      secondary: {
        usedPercent: 20,
        remainingPercent: 80,
        resetsAt: null,
        windowDurationMins: 43_200,
      },
    },
  })
  const tooltip = createProfileTooltip(null, [profileA, profileB])

  assert.ok(tooltip.value.includes('&nbsp;5h&nbsp;'))
  assert.ok(tooltip.value.includes('&nbsp;Limit&nbsp;'))
  assert.ok(!tooltip.value.includes('&nbsp;7d&nbsp;'))
  assert.ok(!tooltip.value.includes('&nbsp;30d&nbsp;'))
  assert.ok(tooltip.value.includes(escapeTableCell('93% (7d)')))
  assert.ok(tooltip.value.includes(escapeTableCell('80% (30d)')))
})

test('createProfileTooltip omits plan and secondary columns when all profiles lack them', () => {
  const profile = makeProfile({
    planType: 'Unknown',
    rateLimits: {
      primary: null,
      secondary: null,
    },
  })
  const tooltip = createProfileTooltip(profile, [profile])

  assert.ok(!tooltip.value.includes('&nbsp;Plan&nbsp;'))
  assert.ok(!tooltip.value.includes('&nbsp;5h&nbsp;'))
  assert.ok(!tooltip.value.includes('&nbsp;7d&nbsp;'))
  assert.ok(tooltip.value.includes('&nbsp;Profile&nbsp;'))
  assert.ok(tooltip.value.includes('&nbsp;Refresh&nbsp;'))
  assert.match(tooltip.value, /\|---\|---\|---\|/)
})

test('createProfileTooltip escapes multiline and command-like content', () => {
  const profile = makeProfile({
    name: 'Alpha\n$(zap) [open](command:evil)',
    email: 'line1\r\nline2@example.com',
  })
  const home = makeHome({
    name: 'Home\n$(alert) [go](command:evil)',
    fsPath: 'C:\\tmp\\home\n$(beep)\\[1]',
  })
  const tooltip = createProfileTooltip(profile, [profile], home)

  assert.ok(
    tooltip.value.includes('Alpha $(zap) [open](command:evil)') === false,
  )
  assert.ok(tooltip.value.includes('line1'))
  assert.ok(tooltip.value.includes('line2@example.com'))
  assert.ok(
    tooltip.value.includes('Home $(alert) [go](command:evil)') === false,
  )
  assert.ok(
    tooltip.value.includes('C:\\\\tmp\\\\home $(beep)\\\\[1]') === false,
  )
  assert.ok(
    tooltip.value.includes(
      escapeTableCell('Alpha\n$(zap) [open](command:evil)'),
    ),
  )
  assert.ok(
    tooltip.value.includes(escapeMarkdown('Home\n$(alert) [go](command:evil)')),
  )
  assert.ok(
    tooltip.value.includes(escapeMarkdown('C:\\tmp\\home\n$(beep)\\[1]')),
  )
})
