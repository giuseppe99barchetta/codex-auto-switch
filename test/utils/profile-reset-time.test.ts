/** Tests for profile-reset-time. */
import assert from 'node:assert/strict'
import test from 'node:test'
import { formatProfileResetTime } from '../../src/utils/profile-reset-time'

function expectedTime(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date)
}

function expectedDay(date: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: 'short',
  }).format(date)
}

function expectedDate(date: Date, now: Date): string {
  return new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: date.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  }).format(date)
}

test('formatProfileResetTime returns the time for the same local day', () => {
  const now = new Date(2026, 5, 19, 12, 0, 0)
  const reset = new Date(2026, 5, 19, 10, 30, 0)

  assert.equal(
    formatProfileResetTime(reset.getTime() / 1000, now),
    expectedTime(reset),
  )
})

test('formatProfileResetTime prefixes the weekday for a different local day', () => {
  const now = new Date(2026, 5, 19, 12, 0, 0)
  const reset = new Date(2026, 5, 20, 10, 30, 0)

  assert.equal(
    formatProfileResetTime(reset.getTime() / 1000, now),
    `${expectedDay(reset)} ${expectedTime(reset)}`,
  )
})

test('formatProfileResetTime keeps the weekday at the edge of the unambiguous window', () => {
  const now = new Date(2026, 5, 19, 12, 0, 0)
  const reset = new Date(2026, 5, 25, 10, 30, 0)

  assert.equal(
    formatProfileResetTime(reset.getTime() / 1000, now),
    `${expectedDay(reset)} ${expectedTime(reset)}`,
  )
})

test('formatProfileResetTime switches to a short date past the unambiguous window', () => {
  const now = new Date(2026, 5, 19, 12, 0, 0)
  const reset = new Date(2026, 5, 26, 10, 30, 0)

  assert.equal(
    formatProfileResetTime(reset.getTime() / 1000, now),
    `${expectedDate(reset, now)} ${expectedTime(reset)}`,
  )
})

test('formatProfileResetTime shows a date far in the future, e.g. a 30-day window', () => {
  const now = new Date(2026, 5, 19, 12, 0, 0)
  const reset = new Date(2026, 6, 19, 10, 30, 0)

  const formatted = formatProfileResetTime(reset.getTime() / 1000, now)

  assert.equal(formatted, `${expectedDate(reset, now)} ${expectedTime(reset)}`)
  assert.doesNotMatch(formatted ?? '', /\d{4}/)
})

test('formatProfileResetTime includes the year when the reset crosses into a different year', () => {
  const now = new Date(2026, 11, 20, 12, 0, 0)
  const reset = new Date(2027, 0, 19, 10, 30, 0)

  const formatted = formatProfileResetTime(reset.getTime() / 1000, now)

  assert.equal(formatted, `${expectedDate(reset, now)} ${expectedTime(reset)}`)
  assert.match(formatted ?? '', /2027/)
})

test('formatProfileResetTime rejects invalid timestamps', () => {
  assert.equal(formatProfileResetTime(null), null)
  assert.equal(formatProfileResetTime(undefined), null)
  assert.equal(formatProfileResetTime(Number.NaN), null)
  assert.equal(formatProfileResetTime(Number.POSITIVE_INFINITY), null)
  assert.equal(formatProfileResetTime(Number.MAX_SAFE_INTEGER), null)
})
