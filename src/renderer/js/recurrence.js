/**
 * Recurrence engine for bills, paydays, subscriptions and transfers.
 *
 * Occurrences are computed as `base + n × period` rather than by repeatedly
 * stepping a cursor, so a monthly bill anchored to the 31st lands on the 28th
 * in February and returns to the 31st in March instead of drifting earlier
 * every month.
 */

import { dt, iso, addDays, addMonths, daysInMonth, diffDays, today } from './format.js';

export const FREQUENCIES = [
  { id: 'daily', label: 'Daily', perYear: 365 },
  { id: 'weekly', label: 'Weekly', perYear: 52 },
  { id: 'biweekly', label: 'Every 2 weeks', perYear: 26 },
  { id: 'fourweekly', label: 'Every 4 weeks', perYear: 13 },
  { id: 'semimonthly', label: 'Twice a month', perYear: 24 },
  { id: 'monthly', label: 'Monthly', perYear: 12 },
  { id: 'bimonthly', label: 'Every 2 months', perYear: 6 },
  { id: 'quarterly', label: 'Quarterly', perYear: 4 },
  { id: 'semiannual', label: 'Every 6 months', perYear: 2 },
  { id: 'annual', label: 'Yearly', perYear: 1 },
  { id: 'once', label: 'One time', perYear: 0 },
];

export function frequencyLabel(id) {
  return (FREQUENCIES.find((f) => f.id === id) || {}).label || 'Monthly';
}

export function perYear(id) {
  const f = FREQUENCIES.find((x) => x.id === id);
  return f ? f.perYear : 12;
}

/** Annualised amount for any frequency — used for budget and cash-flow math. */
export function annualAmount(rule) {
  return (Number(rule.amount) || 0) * perYear(rule.frequency);
}

export function monthlyEquivalent(rule) {
  return annualAmount(rule) / 12;
}

const MONTH_STEP = {
  monthly: 1,
  bimonthly: 2,
  quarterly: 3,
  semiannual: 6,
  annual: 12,
};

function setDay(isoDate, day) {
  const d = dt(isoDate);
  const max = daysInMonth(d.getFullYear(), d.getMonth());
  // `day >= 31` means "last day of the month".
  d.setDate(Math.min(day >= 31 ? max : day, max));
  return iso(d);
}

/** The nth occurrence (n = 0, 1, 2 …) of a rule, ignoring end conditions. */
export function nth(rule, n) {
  const base = rule.startDate || today();
  const interval = Math.max(1, Number(rule.interval) || 1);

  switch (rule.frequency) {
    case 'once':
      return n === 0 ? base : null;
    case 'daily':
      return addDays(base, n * interval);
    case 'weekly':
      return addDays(base, n * 7 * interval);
    case 'biweekly':
      return addDays(base, n * 14);
    case 'fourweekly':
      return addDays(base, n * 28);
    case 'semimonthly': {
      const d1 = Number(rule.dayOfMonth) || dt(base).getDate();
      const d2 = Number(rule.dayOfMonth2) || Math.min(d1 + 15, 31);
      const [lo, hi] = d1 <= d2 ? [d1, d2] : [d2, d1];
      const startsOnSecond = dt(base).getDate() > lo;
      const idx = n + (startsOnSecond ? 1 : 0);
      const monthOffset = Math.floor(idx / 2);
      const which = idx % 2 === 0 ? lo : hi;
      return setDay(addMonths(base, monthOffset), which);
    }
    default: {
      const step = (MONTH_STEP[rule.frequency] || 1) * (rule.frequency === 'monthly' ? interval : 1);
      const anchor = Number(rule.dayOfMonth) || dt(base).getDate();
      return setDay(addMonths(base, n * step), anchor);
    }
  }
}

/** Push off weekends when the rule asks for it (utilities, mortgages, payroll). */
function adjust(isoDate, rule) {
  const mode = rule.weekendShift || 'none';
  if (mode === 'none' || !isoDate) return isoDate;
  const day = dt(isoDate).getDay();
  if (day !== 0 && day !== 6) return isoDate;
  if (mode === 'before') return addDays(isoDate, day === 0 ? -2 : -1);
  return addDays(isoDate, day === 0 ? 1 : 2);
}

/**
 * All occurrences of a rule within [from, to] inclusive.
 * @returns {string[]} ISO dates, ascending
 */
export function occurrences(rule, from, to, { max = 1000 } = {}) {
  const out = [];
  if (!rule || rule.active === false) return out;
  const base = rule.startDate || today();
  if (!base) return out;

  // Jump close to `from` instead of iterating from the start date.
  let n = estimateIndex(rule, base, from);
  if (n < 0) n = 0;

  let guard = 0;
  // Step back a little in case the estimate overshot.
  n = Math.max(0, n - 3);
  while (guard < max + 64) {
    guard += 1;
    const raw = nth(rule, n);
    if (raw === null) break;
    n += 1;
    const date = adjust(raw, rule);
    if (rule.endDate && raw > rule.endDate) break;
    if (Number.isFinite(rule.occurrenceLimit) && n > rule.occurrenceLimit) break;
    if (date < from) continue;
    if (date > to) break;
    out.push(date);
    if (out.length >= max) break;
  }
  return out.sort();
}

function estimateIndex(rule, base, from) {
  const days = diffDays(base, from);
  if (days <= 0) return 0;
  switch (rule.frequency) {
    case 'once':
      return 0;
    case 'daily':
      return Math.floor(days / Math.max(1, Number(rule.interval) || 1));
    case 'weekly':
      return Math.floor(days / (7 * Math.max(1, Number(rule.interval) || 1)));
    case 'biweekly':
      return Math.floor(days / 14);
    case 'fourweekly':
      return Math.floor(days / 28);
    case 'semimonthly':
      return Math.floor(days / 15);
    default: {
      const step = MONTH_STEP[rule.frequency] || 1;
      return Math.floor(days / (30.44 * step));
    }
  }
}

/** First occurrence strictly on or after `after` (default: today). */
export function nextDue(rule, after = today()) {
  if (!rule) return null;
  if (rule.active === false) return null;
  const horizon = addMonths(after, 26);
  const list = occurrences(rule, after, horizon, { max: 1 });
  return list[0] || null;
}

/** Occurrence before `before` — used to show "last paid" expectations. */
export function previousDue(rule, before = today()) {
  const start = addMonths(before, -26);
  const list = occurrences(rule, start, addDays(before, -1), { max: 400 });
  return list.length ? list[list.length - 1] : null;
}

/**
 * Human summary: "Monthly on the 15th", "Every 2 weeks", "Yearly on Apr 15".
 */
export function describe(rule) {
  if (!rule) return '';
  const base = rule.startDate || today();
  const d = dt(base);
  const ord = (n) => {
    const s = ['th', 'st', 'nd', 'rd'];
    const v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
  };
  switch (rule.frequency) {
    case 'once':
      return 'One time';
    case 'daily':
      return (rule.interval || 1) > 1 ? `Every ${rule.interval} days` : 'Every day';
    case 'weekly': {
      const wd = d.toLocaleDateString(undefined, { weekday: 'long' });
      return (rule.interval || 1) > 1 ? `Every ${rule.interval} weeks on ${wd}` : `Every ${wd}`;
    }
    case 'biweekly':
      return `Every 2 weeks on ${d.toLocaleDateString(undefined, { weekday: 'long' })}`;
    case 'fourweekly':
      return `Every 4 weeks on ${d.toLocaleDateString(undefined, { weekday: 'long' })}`;
    case 'semimonthly': {
      const a = Number(rule.dayOfMonth) || d.getDate();
      const b = Number(rule.dayOfMonth2) || Math.min(a + 15, 31);
      const f = (n) => (n >= 31 ? 'last day' : ord(n));
      return `Twice a month — ${f(Math.min(a, b))} and ${f(Math.max(a, b))}`;
    }
    case 'annual':
      return `Yearly on ${d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })}`;
    default: {
      const day = Number(rule.dayOfMonth) || d.getDate();
      const anchor = day >= 31 ? 'the last day' : `the ${ord(day)}`;
      const every =
        rule.frequency === 'monthly'
          ? (rule.interval || 1) > 1
            ? `Every ${rule.interval} months`
            : 'Monthly'
          : { bimonthly: 'Every 2 months', quarterly: 'Quarterly', semiannual: 'Every 6 months' }[
              rule.frequency
            ] || 'Monthly';
      return `${every} on ${anchor}`;
    }
  }
}

/** Status of a scheduled item relative to today. */
export function dueStatus(dueDate, { graceDays = 0 } = {}) {
  if (!dueDate) return { key: 'none', label: '—', tone: '' };
  const d = diffDays(today(), dueDate);
  if (d < -graceDays) return { key: 'overdue', label: `${Math.abs(d)}d overdue`, tone: 'bad', days: d };
  if (d === 0) return { key: 'today', label: 'Due today', tone: 'warn', days: d };
  if (d === 1) return { key: 'soon', label: 'Due tomorrow', tone: 'warn', days: d };
  if (d <= 7) return { key: 'soon', label: `Due in ${d} days`, tone: 'warn', days: d };
  return { key: 'later', label: `Due in ${d} days`, tone: '', days: d };
}
