'use strict';

/**
 * Neutralizes spreadsheet formula injection and safely escapes CSV cells.
 * Formula triggers: =, +, -, @, \t, \r
 */
function sanitizeCsvCell(value) {
  if (value == null) return '';
  let str = String(value);

  // If first character is an injection trigger, prefix with an apostrophe
  if (/^[=+\-@\t\r]/.test(str)) {
    str = `'${str}`;
  }

  // If string contains quotes, commas, or newlines, quote the entire field and escape inner quotes
  if (/[",\n\r]/.test(str)) {
    str = `"${str.replace(/"/g, '""')}"`;
  }

  return str;
}

/**
 * Builds a compliant CSV string from an array of objects.
 * @param {Array<Object>} rows
 * @param {Array<string|{key: string, label: string}>} columns
 * @returns {string}
 */
function toCsv(rows, columns) {
  const headerLabels = columns.map((c) => (typeof c === 'string' ? c : c.label));
  const headerKeys = columns.map((c) => (typeof c === 'string' ? c : c.key));

  const lines = [headerLabels.map(sanitizeCsvCell).join(',')];
  for (const row of rows) {
    const line = headerKeys.map((k) => sanitizeCsvCell(row[k])).join(',');
    lines.push(line);
  }
  return lines.join('\r\n');
}

module.exports = {
  sanitizeCsvCell,
  toCsv,
};
