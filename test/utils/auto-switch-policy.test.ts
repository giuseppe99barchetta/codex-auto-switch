/** Tests for automatic profile switching policy. */
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ProfileSummary } from '../../src/types'
import {
  chooseAutoSwitchTarget,
  isProfileRateLimited,
  normalizeAutoSwitchThreshold,
} from '../../src/utils/auto-switch-policy'

function profile(
  id: string,
  primaryUsed: number | null,
  secondaryUsed: number | null,
): ProfileSummary {
  const window = (usedPercent: number) => ({
    usedPercent,
    remainingPercent: 100 - usedPercent,
    resetsAt: null,
    windowDurationMins: 300,
  })

  return {
    id,
    name: id,
    email: `${id}@example.com`,
    planType: 'plus',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    rateLimits: {
      primary: primaryUsed === null ? null : window(primaryUsed),
      secondary: secondaryUsed === null ? null : window(secondaryUsed),
    },
  }
}

test('normalizeAutoSwitchThreshold clamps invalid and out-of-range values', () => {
  assert.equal(normalizeAutoSwitchThreshold(Number.NaN), 100)
  assert.equal(normalizeAutoSwitchThreshold(20), 50)
  assert.equal(normalizeAutoSwitchThreshold(95), 95)
  assert.equal(normalizeAutoSwitchThreshold(120), 100)
})

test('isProfileRateLimited triggers when either known window reaches threshold', () => {
  assert.equal(isProfileRateLimited(profile('a', 100, 20).rateLimits), true)
  assert.equal(isProfileRateLimited(profile('a', 20, 100).rateLimits), true)
  assert.equal(isProfileRateLimited(profile('a', 99, 99).rateLimits), false)
  assert.equal(isProfileRateLimited(undefined), false)
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

test('chooseAutoSwitchTarget skips exhausted and unknown candidates', () => {
  const unknown = profile('c', null, null)
  const profiles = [profile('a', 100, 40), profile('b', 100, 10), unknown]
  assert.equal(chooseAutoSwitchTarget(profiles, 'a'), undefined)
})

test('chooseAutoSwitchTarget honors a lower configured threshold', () => {
  const profiles = [profile('a', 95, 20), profile('b', 20, 20)]
  assert.equal(chooseAutoSwitchTarget(profiles, 'a', 95)?.id, 'b')
})
