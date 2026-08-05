/** Tests for profile-display. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildProfileMetaDisplay,
  formatProfilePlanDisplay,
  formatProfileRateLimitsDisplay,
} from '../../src/utils/profile-display'
import type { ProfileRateLimits } from '../../src/types'

test('formatProfilePlanDisplay returns uppercase plan or unknown label', () => {
  assert.equal(formatProfilePlanDisplay('pro'), 'PRO')
  assert.equal(formatProfilePlanDisplay('', 'Unknown'), 'Unknown')
  assert.equal(formatProfilePlanDisplay('unknown', 'unknown'), 'unknown')
})

test('formatProfileRateLimitsDisplay renders remaining percentages with duration-derived labels', () => {
  const rateLimits: ProfileRateLimits = {
    primary: {
      usedPercent: 42.2,
      remainingPercent: 57.8,
      resetsAt: null,
      windowDurationMins: 300,
    },
    secondary: {
      usedPercent: 99.4,
      remainingPercent: 0.6,
      resetsAt: null,
      windowDurationMins: 10080,
    },
  }

  assert.equal(formatProfileRateLimitsDisplay(rateLimits), '5h 58% • 7d 1%')
  assert.equal(formatProfileRateLimitsDisplay(null), null)
})

test('buildProfileMetaDisplay combines plan and limits labels', () => {
  assert.equal(
    buildProfileMetaDisplay('pro', {
      primary: {
        usedPercent: 42.2,
        remainingPercent: 57.8,
        resetsAt: null,
        windowDurationMins: 300,
      },
      secondary: null,
    }),
    'PRO • 5h 58%',
  )
})
