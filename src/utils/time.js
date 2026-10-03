/**
 * UTC DATETIME helpers for attendance.
 *
 * The shared mysql2 pool does not set timezone (and must not be changed).
 * DATETIME columns are timezone-naive: we always write UTC 'YYYY-MM-DD HH:mm:ss'
 * strings, and always read them back with DATE_FORMAT so mysql2 never
 * interprets them as server-local times.
 *
 * Calendar "today" / late logic uses Asia/Kolkata (no DST).
 */

const IST = 'Asia/Kolkata';

const pad2 = (n) => String(n).padStart(2, '0');

/**
 * Format a Date as UTC DATETIME string for INSERT/UPDATE.
 * @param {Date} [date]
 * @returns {string} 'YYYY-MM-DD HH:mm:ss'
 */
function toUtcDateTime(date = new Date()) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) {
    throw new Error('Invalid date');
  }
  return (
    `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())} ` +
    `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}:${pad2(d.getUTCSeconds())}`
  );
}

/**
 * Parse a UTC DATETIME string (from DATE_FORMAT) into a Date.
 * @param {string|Date|null} value
 * @returns {Date|null}
 */
function fromUtcDateTime(value) {
  if (value == null || value === '') return null;
  if (value instanceof Date) {
    // Prefer DATE_FORMAT reads; if a Date slips through, treat its
    // UTC components as the stored wall-clock UTC (see sqlUtc).
    return value;
  }
  const str = String(value).trim().replace(' ', 'T');
  const iso = str.endsWith('Z') || /[+-]\d{2}:\d{2}$/.test(str) ? str : `${str}Z`;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * SQL fragment: read a DATETIME column as a UTC string (no pool timezone).
 * @param {string} column  — trusted identifier only (never user input)
 * @param {string} [alias]
 * @returns {string}
 */
function sqlUtc(column, alias) {
  const as = alias || column;
  return `DATE_FORMAT(${column}, '%Y-%m-%d %H:%i:%s') AS \`${as}\``;
}

/**
 * Calendar date in Asia/Kolkata as 'YYYY-MM-DD'.
 * @param {Date} [date]
 * @returns {string}
 */
function istCalendarDate(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: IST,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/**
 * Current time-of-day in IST as 'HH:mm:ss'.
 * @param {Date} [date]
 * @returns {string}
 */
function istTimeOfDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('hour')}:${get('minute')}:${get('second')}`;
}

/**
 * Instant when an IST calendar date + time-of-day occurs (as a Date).
 * @param {string} ymd  'YYYY-MM-DD'
 * @param {string} hms  'HH:mm:ss' or 'HH:mm'
 * @returns {Date}
 */
function istDateTimeToUtc(ymd, hms) {
  const time = hms.length === 5 ? `${hms}:00` : hms;
  return new Date(`${ymd}T${time}+05:30`);
}

/**
 * Format a Date in IST as 'HH:mm'.
 * @param {Date} date
 * @returns {string}
 */
function formatIstHm(date) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: IST,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type)?.value || '00';
  return `${get('hour')}:${get('minute')}`;
}

module.exports = {
  IST,
  toUtcDateTime,
  fromUtcDateTime,
  sqlUtc,
  istCalendarDate,
  istTimeOfDay,
  istDateTimeToUtc,
  formatIstHm,
};
