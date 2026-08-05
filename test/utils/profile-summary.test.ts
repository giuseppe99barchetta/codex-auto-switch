/** Tests for profile-summary. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { parseProfileSummary } from '../../src/utils/profile-summary'

test('parseProfileSummary normalizes valid profile metadata', () => {
  assert.deepEqual(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: '  Alice  ',
      email: 'alice@example.com',
      planType: ' pro ',
      accountId: ' acc-1 ',
      defaultOrganizationId: ' org-1 ',
      defaultOrganizationTitle: ' Org ',
      chatgptUserId: ' user-1 ',
      userId: ' u-1 ',
      subject: ' sub-1 ',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: {
        primary: {
          usedPercent: 45.5,
          remainingPercent: 54.5,
          resetsAt: 1_700_000_000,
          windowDurationMins: 300,
        },
        secondary: null,
      },
    }),
    {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      accountId: 'acc-1',
      defaultOrganizationId: 'org-1',
      defaultOrganizationTitle: 'Org',
      chatgptUserId: 'user-1',
      userId: 'u-1',
      subject: 'sub-1',
      createdAt: '2026-06-12T10:00:00.000Z',
      updatedAt: '2026-06-12T11:00:00.000Z',
      rateLimits: {
        primary: {
          usedPercent: 45.5,
          remainingPercent: 54.5,
          resetsAt: 1_700_000_000,
          windowDurationMins: 300,
        },
        secondary: null,
      },
    },
  )
})

test('parseProfileSummary accepts rate limit windows without reset timestamps or duration', () => {
  assert.deepEqual(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: {
        primary: {
          usedPercent: 12.5,
          remainingPercent: 87.5,
        },
        secondary: {
          usedPercent: 10,
          remainingPercent: 90,
          resetsAt: null,
        },
      },
    }),
    {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      accountId: undefined,
      defaultOrganizationId: undefined,
      defaultOrganizationTitle: undefined,
      chatgptUserId: undefined,
      userId: undefined,
      subject: undefined,
      createdAt: '2026-06-12T10:00:00.000Z',
      updatedAt: '2026-06-12T11:00:00.000Z',
      rateLimits: {
        primary: {
          usedPercent: 12.5,
          remainingPercent: 87.5,
          resetsAt: undefined,
          windowDurationMins: 0,
        },
        secondary: {
          usedPercent: 10,
          remainingPercent: 90,
          resetsAt: undefined,
          windowDurationMins: 0,
        },
      },
    },
  )
})

test('parseProfileSummary falls back to legacy fiveHour/weekly keys written before this fix', () => {
  // profiles.json written by pre-fix versions used fiveHour/weekly keys with
  // no windowDurationMins at all. These must keep loading (not vanish from
  // the profile list) until the next refresh repopulates the new shape.
  assert.deepEqual(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: {
        fiveHour: {
          usedPercent: 45.5,
          remainingPercent: 54.5,
          resetsAt: 1_700_000_000,
        },
        weekly: null,
      },
    }),
    {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      accountId: undefined,
      defaultOrganizationId: undefined,
      defaultOrganizationTitle: undefined,
      chatgptUserId: undefined,
      userId: undefined,
      subject: undefined,
      createdAt: '2026-06-12T10:00:00.000Z',
      updatedAt: '2026-06-12T11:00:00.000Z',
      rateLimits: {
        primary: {
          usedPercent: 45.5,
          remainingPercent: 54.5,
          resetsAt: 1_700_000_000,
          windowDurationMins: 0,
        },
        secondary: null,
      },
    },
  )

  // An explicit new-shape key (including an explicit null) must win over the
  // legacy one rather than falling through to it.
  assert.deepEqual(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: {
        primary: null,
        fiveHour: {
          usedPercent: 45.5,
          remainingPercent: 54.5,
          resetsAt: 1_700_000_000,
        },
        secondary: null,
      },
    }),
    {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      accountId: undefined,
      defaultOrganizationId: undefined,
      defaultOrganizationTitle: undefined,
      chatgptUserId: undefined,
      userId: undefined,
      subject: undefined,
      createdAt: '2026-06-12T10:00:00.000Z',
      updatedAt: '2026-06-12T11:00:00.000Z',
      rateLimits: { primary: null, secondary: null },
    },
  )
})

test('parseProfileSummary rejects malformed ids and timestamps', () => {
  assert.equal(parseProfileSummary(null), null)

  assert.equal(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      accountId: 123,
      defaultOrganizationId: 456,
      defaultOrganizationTitle: 789,
      chatgptUserId: 321,
      userId: 654,
      subject: 987,
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: {
        primary: {
          usedPercent: 10,
          remainingPercent: 'invalid',
        },
        secondary: null,
      },
    }),
    null,
  )

  assert.equal(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: 'invalid',
    }),
    null,
  )

  assert.equal(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      accountId: 123,
      defaultOrganizationId: 456,
      defaultOrganizationTitle: 789,
      chatgptUserId: 321,
      userId: 654,
      subject: 987,
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: {
        primary: {
          usedPercent: 10,
          remainingPercent: 'invalid',
        },
        secondary: null,
      },
    }),
    null,
  )

  assert.deepEqual(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: null,
    }),
    {
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      accountId: undefined,
      defaultOrganizationId: undefined,
      defaultOrganizationTitle: undefined,
      chatgptUserId: undefined,
      userId: undefined,
      subject: undefined,
      createdAt: '2026-06-12T10:00:00.000Z',
      updatedAt: '2026-06-12T11:00:00.000Z',
      rateLimits: null,
    },
  )

  assert.equal(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: {
        primary: 0,
        secondary: null,
      },
    }),
    null,
  )

  assert.equal(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: {
        primary: {
          usedPercent: 10,
          remainingPercent: 90,
          resetsAt: 'invalid',
        },
        secondary: null,
      },
    }),
    null,
  )

  assert.equal(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: {
        primary: {
          usedPercent: 10,
          remainingPercent: 90,
          resetsAt: Number.POSITIVE_INFINITY,
        },
        secondary: null,
      },
    }),
    null,
  )

  assert.equal(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
      rateLimits: {
        primary: {
          usedPercent: 10,
          remainingPercent: 90,
          windowDurationMins: 'invalid',
        },
        secondary: null,
      },
    }),
    null,
  )

  assert.equal(
    parseProfileSummary({
      id: 'not-a-uuid',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
    }),
    null,
  )

  assert.equal(
    parseProfileSummary({
      id: '../../profiles.json',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '2026-06-12T10:00:00Z',
      updatedAt: '2026-06-12T11:00:00Z',
    }),
    null,
  )

  assert.equal(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: '   ',
      updatedAt: '2026-06-12T11:00:00Z',
    }),
    null,
  )

  assert.equal(
    parseProfileSummary({
      id: '123e4567-e89b-12d3-a456-426614174000',
      name: 'Alice',
      email: 'alice@example.com',
      planType: 'pro',
      createdAt: 'invalid',
      updatedAt: '2026-06-12T11:00:00Z',
    }),
    null,
  )
})
