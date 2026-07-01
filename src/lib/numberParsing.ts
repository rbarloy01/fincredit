export function parseFinancialNumber(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number') return Number.isFinite(value) ? value : fallback;

  let raw = String(value).trim();
  if (!raw) return fallback;

  const isNegative = /^\(.*\)$/.test(raw) || raw.startsWith('-');
  raw = raw
    .replace(/[()]/g, '')
    .replace(/[%$€£¥]|MXN|USD|EUR|mxn|usd|eur/g, '')
    .replace(/\s/g, '')
    .replace(/^\+|-/, '');

  const lastComma = raw.lastIndexOf(',');
  const lastDot = raw.lastIndexOf('.');
  let normalized = raw;

  if (lastComma >= 0 && lastDot >= 0) {
    const decimalSeparator = lastComma > lastDot ? ',' : '.';
    const thousandsSeparator = decimalSeparator === ',' ? '.' : ',';
    normalized = raw.split(thousandsSeparator).join('').replace(decimalSeparator, '.');
  } else if (lastComma >= 0) {
    const parts = raw.split(',');
    const last = parts.at(-1) || '';
    normalized = parts.length === 2 && last.length > 0 && last.length <= 2
      ? `${parts[0]}.${last}`
      : parts.join('');
  } else if (lastDot >= 0) {
    const parts = raw.split('.');
    const last = parts.at(-1) || '';
    normalized = parts.length === 2 && last.length > 0 && last.length <= 2
      ? raw
      : parts.join('');
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return fallback;
  return isNegative ? -parsed : parsed;
}

export function parseNullableFinancialNumber(value: unknown): number | null {
  if (value === null || value === undefined || String(value).trim() === '') return null;
  const parsed = parseFinancialNumber(value, Number.NaN);
  return Number.isFinite(parsed) ? parsed : null;
}

export function normalizeFinancialNumberString(value: unknown): string {
  const parsed = parseNullableFinancialNumber(value);
  return parsed === null ? '' : String(Object.is(parsed, -0) ? 0 : parsed);
}
