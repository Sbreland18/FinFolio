/**
 * Formatting and date arithmetic.
 *
 * Dates are stored as plain `YYYY-MM-DD` strings and always treated as local
 * calendar days — never as UTC instants — so a bill due on the 1st never drifts
 * to the 31st because of a timezone offset.
 */

let CURRENCY = 'USD';
let LOCALE = 'en-US';
let DATE_FORMAT = 'MM/DD/YYYY';

export function configureFormat({ currency, locale, dateFormat } = {}) {
  if (currency) CURRENCY = currency;
  if (locale) LOCALE = locale;
  if (dateFormat) DATE_FORMAT = dateFormat;
  cache.clear();
}

const cache = new Map();
function nf(key, options) {
  if (!cache.has(key)) cache.set(key, new Intl.NumberFormat(LOCALE, options));
  return cache.get(key);
}

/* ------------------------------- money ---------------------------- */

export function money(value, { sign = false, cents = true, compact = false } = {}) {
  const n = Number(value) || 0;
  const key = `m:${CURRENCY}:${LOCALE}:${sign}:${cents}:${compact}`;
  const out = nf(key, {
    style: 'currency',
    currency: CURRENCY,
    minimumFractionDigits: cents ? 2 : 0,
    maximumFractionDigits: cents ? 2 : 0,
    notation: compact ? 'compact' : 'standard',
    signDisplay: sign ? 'exceptZero' : 'auto',
  }).format(n);
  return out;
}

/** Absolute value, formatted — for tables where the sign is shown by color. */
export function moneyAbs(value, opts) {
  return money(Math.abs(Number(value) || 0), opts);
}

export function currencySymbol() {
  try {
    return (
      new Intl.NumberFormat(LOCALE, { style: 'currency', currency: CURRENCY })
        .formatToParts(0)
        .find((p) => p.type === 'currency')?.value || '$'
    );
  } catch {
    return '$';
  }
}

export function num(value, digits = 0) {
  return nf(`n:${digits}`, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  }).format(Number(value) || 0);
}

export function pct(value, digits = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return `${nf(`p:${digits}`, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(n)}%`;
}

/** Parse loose user input: "1,234.50", "$40", "(25)" → -25, "12+3" → 15 */
export function parseAmount(input) {
  if (typeof input === 'number') return input;
  let s = String(input ?? '').trim();
  if (!s) return 0;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[^0-9+\-*/.()]/g, '');
  if (!s) return 0;
  let value;
  if (/[+\-*/]/.test(s.slice(1)) && /^[0-9+\-*/.()]+$/.test(s)) {
    try {
      // Arithmetic entry ("45.20+12") is a genuine convenience in a ledger.
      // The string is stripped to digits and operators above, so nothing else
      // can reach the evaluator.
      value = Function(`"use strict";return (${s})`)();
    } catch {
      value = Number(s.replace(/[^0-9.\-]/g, ''));
    }
  } else {
    value = Number(s);
  }
  if (!Number.isFinite(value)) value = 0;
  return round2(negative ? -Math.abs(value) : value);
}

export function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/* ------------------------------- dates ---------------------------- */

const MS_DAY = 86400000;

export function today() {
  return iso(new Date());
}

/** `YYYY-MM-DD` for a Date, in local time. */
export function iso(date) {
  const d = date instanceof Date ? date : new Date(date);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** Local midnight Date for a `YYYY-MM-DD` string. */
export function dt(value) {
  if (value instanceof Date) return new Date(value.getFullYear(), value.getMonth(), value.getDate());
  const m = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return new Date(NaN);
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

export function isValidDate(value) {
  return !Number.isNaN(dt(value).getTime());
}

export function addDays(value, days) {
  const d = dt(value);
  d.setDate(d.getDate() + Number(days || 0));
  return iso(d);
}

export function addMonths(value, months) {
  const d = dt(value);
  const day = d.getDate();
  d.setDate(1);
  d.setMonth(d.getMonth() + Number(months || 0));
  d.setDate(Math.min(day, daysInMonth(d.getFullYear(), d.getMonth())));
  return iso(d);
}

export function addYears(value, years) {
  return addMonths(value, Math.round(Number(years || 0) * 12));
}

export function daysInMonth(year, monthIndex) {
  return new Date(year, monthIndex + 1, 0).getDate();
}

export function diffDays(a, b) {
  return Math.round((dt(b).getTime() - dt(a).getTime()) / MS_DAY);
}

export function startOfMonth(value) {
  const d = dt(value);
  return iso(new Date(d.getFullYear(), d.getMonth(), 1));
}

export function endOfMonth(value) {
  const d = dt(value);
  return iso(new Date(d.getFullYear(), d.getMonth() + 1, 0));
}

export function startOfWeek(value, weekStart = 0) {
  const d = dt(value);
  const shift = (d.getDay() - weekStart + 7) % 7;
  d.setDate(d.getDate() - shift);
  return iso(d);
}

export function startOfYear(value) {
  return `${dt(value).getFullYear()}-01-01`;
}

export function monthKey(value) {
  return String(value || '').slice(0, 7);
}

export function monthLabel(key, { long = false } = {}) {
  const [y, m] = String(key).split('-').map(Number);
  if (!y || !m) return String(key);
  return new Date(y, m - 1, 1).toLocaleDateString(LOCALE, {
    month: long ? 'long' : 'short',
    year: 'numeric',
  });
}

export function monthName(monthIndex, long = true) {
  return new Date(2024, monthIndex, 1).toLocaleDateString(LOCALE, { month: long ? 'long' : 'short' });
}

export function weekdayNames(weekStart = 0, style = 'short') {
  const out = [];
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(2024, 0, 7 + ((i + weekStart) % 7)); // 2024-01-07 is a Sunday
    out.push(d.toLocaleDateString(LOCALE, { weekday: style }));
  }
  return out;
}

export function fmtDate(value, style = 'short') {
  if (!value) return '—';
  const d = dt(value);
  if (Number.isNaN(d.getTime())) return String(value);
  if (style === 'iso') return iso(d);
  if (style === 'long') return d.toLocaleDateString(LOCALE, { dateStyle: 'long' });
  if (style === 'medium') return d.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric', year: 'numeric' });
  if (style === 'day') return d.toLocaleDateString(LOCALE, { month: 'short', day: 'numeric' });
  if (style === 'weekday') return d.toLocaleDateString(LOCALE, { weekday: 'short', month: 'short', day: 'numeric' });
  switch (DATE_FORMAT) {
    case 'DD/MM/YYYY':
      return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
    case 'YYYY-MM-DD':
      return iso(d);
    default:
      return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()}`;
  }
}

function pad(n) {
  return String(n).padStart(2, '0');
}

export function fmtDateTime(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(LOCALE, { dateStyle: 'medium', timeStyle: 'short' });
}

/** "Today", "Tomorrow", "in 4 days", "3 days ago", else a date. */
export function relativeDay(value, from = today()) {
  const d = diffDays(from, value);
  if (!Number.isFinite(d)) return '—';
  if (d === 0) return 'Today';
  if (d === 1) return 'Tomorrow';
  if (d === -1) return 'Yesterday';
  if (d > 1 && d <= 30) return `in ${d} days`;
  if (d < -1 && d >= -30) return `${Math.abs(d)} days ago`;
  return fmtDate(value, 'day');
}

export function bytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

export function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}

export function titleCase(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/\b[a-z]/g, (c) => c.toUpperCase());
}
