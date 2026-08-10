const MS_PER_DAY = 86_400_000
/** Beyond this many days, a weekday alone (e.g. "Mon") is ambiguous -- it repeats every week. */
const MAX_WEEKDAY_DISTANCE_DAYS = 6

/** Checks if two dates represent the same local calendar date. */
function isSameLocalDate(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  )
}

/** Number of calendar days between two local dates, ignoring time of day. */
function daysBetweenLocalDates(a: Date, b: Date): number {
  const utcA = Date.UTC(a.getFullYear(), a.getMonth(), a.getDate())
  const utcB = Date.UTC(b.getFullYear(), b.getMonth(), b.getDate())
  return Math.round((utcB - utcA) / MS_PER_DAY)
}

/**
 * Formats a Unix timestamp as a readable reset time: time only if today,
 * weekday + time if within the next week (unambiguous), or a short date +
 * time beyond that -- a bare weekday isn't informative for long windows
 * like a 30-day reset.
 */
export function formatProfileResetTime(
  resetsAt: number | null | undefined,
  now = new Date(),
): string | null {
  if (typeof resetsAt !== 'number' || !Number.isFinite(resetsAt)) {
    return null
  }

  const resetDate = new Date(resetsAt * 1000)
  if (Number.isNaN(resetDate.getTime())) {
    return null
  }

  const time = new Intl.DateTimeFormat(undefined, {
    hour: '2-digit',
    minute: '2-digit',
  }).format(resetDate)

  if (isSameLocalDate(resetDate, now)) {
    return time
  }

  if (
    Math.abs(daysBetweenLocalDates(now, resetDate)) <= MAX_WEEKDAY_DISTANCE_DAYS
  ) {
    const day = new Intl.DateTimeFormat(undefined, {
      weekday: 'short',
    }).format(resetDate)
    return `${day} ${time}`
  }

  const date = new Intl.DateTimeFormat(undefined, {
    day: 'numeric',
    month: 'short',
    year: resetDate.getFullYear() === now.getFullYear() ? undefined : 'numeric',
  }).format(resetDate)
  return `${date} ${time}`
}
