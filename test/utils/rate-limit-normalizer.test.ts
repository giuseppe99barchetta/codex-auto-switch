/** Tests for rate-limit-normalizer. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {
  clampPercent,
  formatRateLimitWindowLabel,
  normalizeRateLimitResponse,
} from '../../src/utils/rate-limit-normalizer'

test('clampPercent bounds and rounds values', () => {
  assert.equal(clampPercent(Number.POSITIVE_INFINITY), 0)
  assert.equal(clampPercent(-5), 0)
  assert.equal(clampPercent(12.2), 12)
  assert.equal(clampPercent(101), 100)
})

test('formatRateLimitWindowLabel renders a compact, language-neutral unit', () => {
  assert.equal(formatRateLimitWindowLabel(300), '5h')
  assert.equal(formatRateLimitWindowLabel(10080), '7d')
  assert.equal(formatRateLimitWindowLabel(43200), '30d')
  assert.equal(formatRateLimitWindowLabel(45), '45m')
  assert.equal(formatRateLimitWindowLabel(0), '')
  assert.equal(formatRateLimitWindowLabel(-5), '')
  assert.equal(formatRateLimitWindowLabel(Number.NaN), '')
})

test('normalizeRateLimitResponse prefers codex by-limit snapshots and supports camelCase and snake_case fields', () => {
  assert.equal(normalizeRateLimitResponse(null, 1_700_000_000), null)
  assert.equal(
    normalizeRateLimitResponse({ rateLimits: null }, 1_700_000_000),
    null,
  )
  assert.deepEqual(
    normalizeRateLimitResponse(
      {
        rateLimitsByLimitId: {
          other: {
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
            },
          },
        },
        rateLimits: {
          primary: {
            usedPercent: 11,
            windowDurationMins: 300,
          },
        },
      },
      1_700_000_000,
    ),
    {
      primary: {
        usedPercent: 11,
        remainingPercent: 89,
        resetsAt: null,
        windowDurationMins: 300,
      },
      secondary: null,
    },
  )

  assert.deepEqual(
    normalizeRateLimitResponse(
      {
        rateLimitsByLimitId: {
          codex: {
            primary: {
              used_percent: 12.2,
              window_minutes: 300,
              resets_in_seconds: 60,
            },
          },
        },
      },
      1_700_000_000,
    ),
    {
      primary: {
        usedPercent: 12,
        remainingPercent: 88,
        resetsAt: 1_700_000_060,
        windowDurationMins: 300,
      },
      secondary: null,
    },
  )
})

test('normalizeRateLimitResponse maps primary/secondary positionally regardless of their duration', () => {
  // Real payload captured from a live Codex CLI (0.125.0) account/rateLimits/read
  // response: a single 30-day primary window and no secondary window at all.
  // This is the regression case -- OpenAI stopped guaranteeing a fixed 5h/weekly
  // pair, and the normalizer must not silently drop windows it doesn't recognize.
  assert.deepEqual(
    normalizeRateLimitResponse(
      {
        rateLimits: {
          limitId: 'codex',
          primary: {
            usedPercent: 31,
            windowDurationMins: 43200,
            resetsAt: 1_788_524_905,
          },
          secondary: null,
          credits: { hasCredits: false, unlimited: false, balance: null },
          planType: 'plus',
        },
      },
      1_700_000_000,
    ),
    {
      primary: {
        usedPercent: 31,
        remainingPercent: 69,
        resetsAt: 1_788_524_905,
        windowDurationMins: 43200,
      },
      secondary: null,
    },
  )
})

test('normalizeRateLimitResponse falls back to rateLimits and rejects malformed windows', () => {
  assert.deepEqual(
    normalizeRateLimitResponse(
      {
        rateLimits: {
          primary: {
            usedPercent: 41.6,
            windowDurationMins: 300,
            resetsAt: 1_700_000_500,
          },
          secondary: {
            usedPercent: 7,
            window_minutes: 10080,
            resets_at: 1_700_001_000,
          },
        },
      },
      1_700_000_000,
    ),
    {
      primary: {
        usedPercent: 42,
        remainingPercent: 58,
        resetsAt: 1_700_000_500,
        windowDurationMins: 300,
      },
      secondary: {
        usedPercent: 7,
        remainingPercent: 93,
        resetsAt: 1_700_001_000,
        windowDurationMins: 10080,
      },
    },
  )

  assert.deepEqual(
    normalizeRateLimitResponse(
      {
        rateLimits: {
          secondary: {
            usedPercent: 7,
            window_minutes: 10080,
            resets_at: 1_700_001_000,
          },
        },
      },
      1_700_000_000,
    ),
    {
      primary: null,
      secondary: {
        usedPercent: 7,
        remainingPercent: 93,
        resetsAt: 1_700_001_000,
        windowDurationMins: 10080,
      },
    },
  )

  assert.deepEqual(
    normalizeRateLimitResponse(
      {
        rateLimits: {
          primary: {
            usedPercent: 22,
            windowDurationMins: 300,
          },
        },
      },
      1_700_000_000,
    ),
    {
      primary: {
        usedPercent: 22,
        remainingPercent: 78,
        resetsAt: null,
        windowDurationMins: 300,
      },
      secondary: null,
    },
  )

  assert.equal(
    normalizeRateLimitResponse(
      {
        rateLimits: {
          primary: {
            usedPercent: Infinity,
            windowDurationMins: 300,
            resetsAt: 1_700_000_500,
          },
        },
      },
      1_700_000_000,
    ),
    null,
  )

  assert.equal(
    normalizeRateLimitResponse(
      {
        rateLimits: {
          primary: 42,
        },
      },
      1_700_000_000,
    ),
    null,
  )

  assert.equal(
    normalizeRateLimitResponse(
      {
        rateLimitsByLimitId: {
          codex: {
            primary: 42,
          },
        },
      },
      1_700_000_000,
    ),
    null,
  )

  assert.equal(
    normalizeRateLimitResponse(
      {
        rateLimits: {
          primary: {
            usedPercent: 12,
            windowDurationMins: 0,
          },
        },
      },
      1_700_000_000,
    ),
    null,
  )

  // A duration that matches neither the old 5h nor weekly constant is no
  // longer rejected -- it's accepted and reported as-is (see the 30-day
  // regression case above).
  assert.deepEqual(
    normalizeRateLimitResponse(
      {
        rateLimits: {
          primary: {
            usedPercent: 12,
            windowDurationMins: 42,
          },
        },
      },
      1_700_000_000,
    ),
    {
      primary: {
        usedPercent: 12,
        remainingPercent: 88,
        resetsAt: null,
        windowDurationMins: 42,
      },
      secondary: null,
    },
  )

  assert.deepEqual(
    normalizeRateLimitResponse(
      {
        rateLimits: {
          primary: {
            usedPercent: 12,
            windowDurationMins: 300,
            resets_in_seconds: -1,
          },
        },
      },
      1_700_000_000,
    ),
    {
      primary: {
        usedPercent: 12,
        remainingPercent: 88,
        resetsAt: null,
        windowDurationMins: 300,
      },
      secondary: null,
    },
  )

  assert.deepEqual(
    normalizeRateLimitResponse(
      {
        rateLimits: {
          primary: {
            usedPercent: 18,
            windowDurationMins: 300,
            resets_in_seconds: 3_000_000_000,
          },
        },
      },
      1_700_000_000,
    ),
    {
      primary: {
        usedPercent: 18,
        remainingPercent: 82,
        resetsAt: null,
        windowDurationMins: 300,
      },
      secondary: null,
    },
  )
})
