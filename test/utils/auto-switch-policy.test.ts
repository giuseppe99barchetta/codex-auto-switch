/** Tests for automatic profile switching policy. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProfileSummary } from '../../src/types'
import {
  chooseAutoSwitchTarget,
  getAutoSwitchThresholdForWindow,
  isProfileRateLimited,
  minimumAutoSwitchThreshold,
  normalizeAutoSwitchThreshold,
  normalizeAutoSwitchThresholds,
} from '../../src/utils/auto-switch-policy'

const thresholds = {
  fallbackPercent: 99,
  fiveHourPercent: 95,
  weeklyPercent: 98,
}

function profile(
  id: string,
  primaryUsed: number | null,
  secondaryUsed: number | null,
  options: {
    primaryDuration?: number
    secondaryDuration?: number
    primaryReset?: number | null
    secondaryReset?: number | null
  } = {},
): ProfileSummary {
  const window = (
    usedPercent: number,
    duration: number,
    resetsAt: number | null,
  ) => ({
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
        primaryUsed === null
          ? null
          : window(
              primaryUsed,
              options.primaryDuration ?? 300,
              options.primaryReset ?? null,
            ),
      secondary:
        secondaryUsed === null
          ? null
          : window(
              secondaryUsed,
              options.secondaryDuration ?? 10080,
              options.secondaryReset ?? null,
            ),
    },
  }
}

test('normalizeAutoSwitchThreshold clamps invalid and out-of-range values', () => {
  assert.equal(normalizeAutoSwitchThreshold(Number.NaN), 100)
  assert.equal(normalizeAutoSwitchThreshold(20), 50)
  assert.equal(normalizeAutoSwitchThreshold(95), 95)
  assert.equal(normalizeAutoSwitchThreshold(120), 100)
})

test('normalizes and resolves dedicated thresholds by rate-limit window', () => {
  const normalized = normalizeAutoSwitchThresholds({
    fallbackPercent: 120,
    fiveHourPercent: 20,
    weeklyPercent: 98,
  })
  assert.deepEqual(normalized, {
    fallbackPercent: 100,
    fiveHourPercent: 50,
    weeklyPercent: 98,
  })
  assert.equal(minimumAutoSwitchThreshold(thresholds), 95)

  const fiveHour = profile('a', 1, null).rateLimits!.primary!
  const weekly = profile('a', null, 1).rateLimits!.secondary!
  const custom = {
    ...fiveHour,
    windowDurationMins: 120,
  }
  assert.equal(getAutoSwitchThresholdForWindow(fiveHour, thresholds), 95)
  assert.equal(getAutoSwitchThresholdForWindow(weekly, thresholds), 98)
  assert.equal(getAutoSwitchThresholdForWindow(custom, thresholds), 99)
})

test('isProfileRateLimited uses separate 5h and weekly thresholds', () => {
  assert.equal(
    isProfileRateLimited(profile('a', 95, 20).rateLimits, thresholds),
    true,
  )
  assert.equal(
    isProfileRateLimited(profile('a', 20, 98).rateLimits, thresholds),
    true,
  )
  assert.equal(
    isProfileRateLimited(profile('a', 94, 97).rateLimits, thresholds),
    false,
  )
  assert.equal(isProfileRateLimited(undefined, thresholds), false)
})

test('isProfileRateLimited keeps numeric threshold compatibility', () => {
  assert.equal(isProfileRateLimited(profile('a', 100, 20).rateLimits), true)
  assert.equal(isProfileRateLimited(profile('a', 20, 100).rateLimits), true)
  assert.equal(isProfileRateLimited(profile('a', 99, 99).rateLimits), false)
})

test('chooseAutoSwitchTarget requires an active profile id', () => {
  const profiles = [profile('a', 100, 20), profile('b', 20, 20)]
  assert.equal(chooseAutoSwitchTarget(profiles, undefined), undefined)
})

test('chooseAutoSwitchTarget returns undefined when active profile is missing', () => {
  const profiles = [profile('a', 100, 20), profile('b', 20, 20)]
  assert.equal(chooseAutoSwitchTarget(profiles, 'missing'), undefined)
})

test('chooseAutoSwitchTarget does nothing while active profile still has quota', () => {
  const profiles = [profile('a', 90, 80), profile('b', 10, 10)]
  assert.equal(chooseAutoSwitchTarget(profiles, 'a'), undefined)
})

test('chooseAutoSwitchTarget selects account with best bottleneck availability', () => {
  const profiles = [
    profile('a', 100, 40),
    profile('b', 10, 80),
    profile('c', 30, 40),
  ]
  assert.equal(chooseAutoSwitchTarget(profiles, 'a')?.id, 'c')
})

test('chooseAutoSwitchTarget supports candidates with only one known window', () => {
  const profiles = [
    profile('a', 100, 40),
    profile('b', 10, null),
    profile('c', 20, 20),
  ]
  assert.equal(chooseAutoSwitchTarget(profiles, 'a')?.id, 'b')
})

test('chooseAutoSwitchTarget supports secondary-only candidates', () => {
  const profiles = [
    profile('a', 100, 40),
    profile('b', null, 10),
    profile('c', 20, 20),
  ]
  assert.equal(chooseAutoSwitchTarget(profiles, 'a')?.id, 'b')
})

test('chooseAutoSwitchTarget skips exhausted and unknown candidates', () => {
  const unknown = profile('c', null, null)
  const profiles = [profile('a', 100, 40), profile('b', 100, 10), unknown]
  assert.equal(chooseAutoSwitchTarget(profiles, 'a'), undefined)
})

test('chooseAutoSwitchTarget skips candidates with entirely missing rate-limit data', () => {
  const unknown = { ...profile('c', null, null), rateLimits: undefined }
  const profiles = [profile('a', 100, 40), unknown]
  assert.equal(chooseAutoSwitchTarget(profiles, 'a'), undefined)
})

test('chooseAutoSwitchTarget honors a lower configured numeric threshold', () => {
  const profiles = [profile('a', 95, 20), profile('b', 20, 20)]
  assert.equal(chooseAutoSwitchTarget(profiles, 'a', 95)?.id, 'b')
})

test('chooseAutoSwitchTarget favors an almost-reset account when the reset bonus outweighs quota', () => {
  const now = 1_000_000
  const profiles = [
    profile('a', 95, null),
    profile('b', 94, null, { primaryReset: now + 2 * 60 * 1000 }),
    profile('c', 75, null, { primaryReset: now + 5 * 60 * 60 * 1000 }),
  ]

  assert.equal(chooseAutoSwitchTarget(profiles, 'a', thresholds, now)?.id, 'b')
})

test('chooseAutoSwitchTarget gives the full reset bonus once a reset timestamp has passed', () => {
  const now = 1_000_000
  const profiles = [
    profile('a', 95, null),
    profile('b', 94, null, { primaryReset: now - 1 }),
    profile('c', 75, null, { primaryReset: now + 5 * 60 * 60 * 1000 }),
  ]

  assert.equal(chooseAutoSwitchTarget(profiles, 'a', thresholds, now)?.id, 'b')
})

test('chooseAutoSwitchTarget does not reward a distant reset', () => {
  const now = 1_000_000
  const profiles = [
    profile('a', 95, null),
    profile('b', 94, null, { primaryReset: now + 3 * 60 * 60 * 1000 }),
    profile('c', 75, null, { primaryReset: now + 5 * 24 * 60 * 60 * 1000 }),
  ]

  assert.equal(chooseAutoSwitchTarget(profiles, 'a', thresholds, now)?.id, 'c')
})
