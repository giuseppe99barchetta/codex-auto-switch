/** Tests for persistent automatic-switch state helpers. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProfileSummary } from '../../src/types'
import {
  describeThresholdReason,
  findNextResetAt,
  formatRateLimitWindowLabel,
  getTriggeredResetAt,
  isHysteresisBlocked,
} from '../../src/utils/auto-switch-state'

function profile(
  id: string,
  primaryUsed: number | null,
  secondaryUsed: number | null,
  primaryReset = 2000,
  secondaryReset = 3000,
): ProfileSummary {
  const window = (usedPercent: number, duration: number, resetsAt: number) => ({
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt,
    windowDurationMins: duration,
  })
  return {
    id,
    name: id,
    email: `${id}@example.com`,
    planType: 'plus',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rateLimits: {
      primary:
        primaryUsed === null ? null : window(primaryUsed, 300, primaryReset),
      secondary:
        secondaryUsed === null
          ? null
          : window(secondaryUsed, 10080, secondaryReset),
    },
  }
}

test('formatRateLimitWindowLabel formats common and custom windows', () => {
  const base = {
    usedPercent: 50,
    remainingPercent: 50,
    resetsAt: null,
  }
  assert.equal(formatRateLimitWindowLabel({ ...base, windowDurationMins: 300 }), '5h')
  assert.equal(
    formatRateLimitWindowLabel({ ...base, windowDurationMins: 10080 }),
    'weekly',
  )
  assert.equal(formatRateLimitWindowLabel({ ...base, windowDurationMins: 2880 }), '2d')
  assert.equal(formatRateLimitWindowLabel({ ...base, windowDurationMins: 120 }), '2h')
  assert.equal(formatRateLimitWindowLabel({ ...base, windowDurationMins: 45 }), '45m')
})

test('describeThresholdReason includes every triggering window', () => {
  assert.equal(describeThresholdReason(profile('a', 99, 100), 99), '5h 99% + weekly 100%')
  assert.equal(describeThresholdReason(profile('a', 98, 50), 99), '')
})

test('getTriggeredResetAt returns earliest triggering reset', () => {
  assert.equal(getTriggeredResetAt(profile('a', 99, 100), 99), 2000)
  assert.equal(getTriggeredResetAt(profile('a', 98, 50), 99), undefined)
})

test('isHysteresisBlocked releases after reset or recovery', () => {
  const state = { profileId: 'a', blockedUntilResetAt: 2000 }
  assert.equal(isHysteresisBlocked(profile('a', 95, 20), state, 90, 1000), true)
  assert.equal(isHysteresisBlocked(profile('a', 90, 20), state, 90, 1000), false)
  assert.equal(isHysteresisBlocked(profile('a', 95, 20), state, 90, 2000), false)
  assert.equal(isHysteresisBlocked(profile('b', 95, 20), state, 90, 1000), false)
  assert.equal(isHysteresisBlocked(profile('a', null, null), state, 90, 1000), true)
  assert.equal(isHysteresisBlocked(profile('a', 95, 20), undefined, 90, 1000), false)
})

test('findNextResetAt returns nearest future reset', () => {
  assert.equal(findNextResetAt([profile('a', 100, 100), profile('b', 100, 100, 1500, 4000)], 1000), 1500)
  assert.equal(findNextResetAt([profile('a', 100, 100, 500, 900)], 1000), undefined)
})
