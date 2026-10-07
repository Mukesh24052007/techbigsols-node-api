'use strict';

/**
 * Computes net worked minutes according to attendance policy:
 * - Total span = checkInAt to closeTime (in minutes).
 * - For each non-INSIDE interval (OUTSIDE or UNKNOWN):
 *   - An interval still open when record is closed ends at closeTime.
 *   - Intervals outside [checkInAt, closeTime] are clipped or ignored.
 *   - If duration > toleranceMinutes: deduct FULL duration.
 *   - If duration <= toleranceMinutes: free, but combined total of short outings
 *     is capped by allowanceMinutes (short_outing_allowance_minutes).
 *     Any short-outing time beyond the allowance is deducted.
 *
 * @param {Object} params
 * @param {string|Date} params.checkInAt
 * @param {string|Date} params.closeTime
 * @param {Array<Object>} [params.intervals=[]]
 * @param {number} [params.toleranceMinutes=10]
 * @param {number} [params.allowanceMinutes=30]
 * @returns {number}
 */
function computeWorkedMinutes({
  checkInAt,
  closeTime,
  intervals = [],
  toleranceMinutes = 10,
  allowanceMinutes = 30,
}) {
  const checkInMs = new Date(checkInAt).getTime();
  const closeMs = new Date(closeTime).getTime();

  if (isNaN(checkInMs) || isNaN(closeMs) || closeMs <= checkInMs) {
    return 0;
  }

  const totalSpanMinutes = Math.floor((closeMs - checkInMs) / 60000);
  let totalDeductions = 0;
  let totalShortOutingMinutes = 0;

  for (const interval of intervals) {
    const state = interval.state;
    if (state === 'INSIDE') continue;

    const startedAt = interval.started_at || interval.startedAt;
    const endedAt = interval.ended_at || interval.endedAt;

    const startMs = new Date(startedAt).getTime();
    if (isNaN(startMs)) continue;

    // An interval still open when the record is closed ends at closeTime
    const endMs = endedAt ? new Date(endedAt).getTime() : closeMs;
    if (isNaN(endMs)) continue;

    // Clip to [checkInAt, closeTime]
    const effectiveStart = Math.max(startMs, checkInMs);
    const effectiveEnd = Math.min(endMs, closeMs);

    if (effectiveEnd <= effectiveStart) continue;

    const durationMinutes = Math.floor((effectiveEnd - effectiveStart) / 60000);
    if (durationMinutes <= 0) continue;

    if (durationMinutes > toleranceMinutes) {
      // Long outing: deduct full duration
      totalDeductions += durationMinutes;
    } else {
      // Short outing: accumulate
      totalShortOutingMinutes += durationMinutes;
    }
  }

  // Combined short outings beyond daily allowance are deducted
  if (totalShortOutingMinutes > allowanceMinutes) {
    totalDeductions += (totalShortOutingMinutes - allowanceMinutes);
  }

  return Math.max(0, totalSpanMinutes - totalDeductions);
}

module.exports = {
  computeWorkedMinutes,
};
