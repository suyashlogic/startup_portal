/**
 * toCSV: minimal, dependency-free CSV writer. RFC 4180 quoting — a field is
 * wrapped in quotes (with internal quotes doubled) whenever it contains a
 * comma, quote, or newline. No library needed for output this simple.
 *
 * @param {Array<[header, keyOrFn]>} columns
 * @param {Array<object>} rows
 */
export function toCSV(columns, rows) {
  const esc = (v) => {
    if (v == null) return '';
    const s = v instanceof Date ? v.toISOString() : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const header = columns.map(([label]) => esc(label)).join(',');
  const lines = rows.map((row) =>
    columns.map(([, key]) => esc(typeof key === 'function' ? key(row) : row[key])).join(','));
  return [header, ...lines].join('\r\n') + '\r\n';
}
