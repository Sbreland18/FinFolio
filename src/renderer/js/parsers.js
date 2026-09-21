/**
 * Statement parsers: CSV (any delimiter), OFX/QFX and QIF.
 * All of them return rows of `{date, amount, payee, notes, fitid, type}`.
 */

import { iso, round2 } from './format.js';

/* ------------------------------- CSV ------------------------------ */

export function detectDelimiter(text) {
  const line = text.split(/\r?\n/).find((l) => l.trim().length) || '';
  const counts = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQuotes = false;
  for (const ch of line) {
    if (ch === '"') inQuotes = !inQuotes;
    else if (!inQuotes && ch in counts) counts[ch] += 1;
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0] || ',';
}

/** RFC-4180-ish parser that tolerates ragged rows and embedded newlines. */
export function parseCSV(text, delimiter) {
  const src = String(text).replace(/^﻿/, '');
  const d = delimiter || detectDelimiter(src);
  const rows = [];
  let row = [];
  let value = '';
  let inQuotes = false;

  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          value += '"';
          i += 1;
        } else inQuotes = false;
      } else value += ch;
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
    } else if (ch === d) {
      row.push(value);
      value = '';
    } else if (ch === '\n') {
      row.push(value);
      rows.push(row);
      row = [];
      value = '';
    } else if (ch !== '\r') {
      value += ch;
    }
  }
  if (value.length || row.length) {
    row.push(value);
    rows.push(row);
  }
  return rows.filter((r) => r.some((c) => String(c).trim() !== '')).map((r) => r.map((c) => c.trim()));
}

export function toCSV(rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return rows.map((r) => r.map(esc).join(',')).join('\r\n');
}

/* ------------------------- value coercion ------------------------- */

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/**
 * Parse the date formats banks actually export.
 * @param {string} value
 * @param {'MDY'|'DMY'|'YMD'|'auto'} order
 */
export function parseDate(value, order = 'auto') {
  const s = String(value || '').trim();
  if (!s) return null;

  // 2024-03-07 / 2024/03/07
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) return fmt(m[1], m[2], m[3]);

  // 20240307
  m = s.match(/^(\d{4})(\d{2})(\d{2})/);
  if (m) return fmt(m[1], m[2], m[3]);

  // 07-Mar-2024 / 7 March 2024
  m = s.match(/^(\d{1,2})[-\s/]([A-Za-z]{3,})[-\s/](\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mon) return fmt(fullYear(m[3]), mon, m[1]);
  }
  // Mar 7, 2024
  m = s.match(/^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{2,4})/);
  if (m) {
    const mon = MONTHS[m[1].slice(0, 3).toLowerCase()];
    if (mon) return fmt(fullYear(m[3]), mon, m[2]);
  }

  // 03/07/2024 — ambiguous, resolved by `order`
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2,4})/);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = fullYear(m[3]);
    let month = a;
    let day = b;
    if (order === 'DMY' || (order === 'auto' && a > 12 && b <= 12)) {
      month = b;
      day = a;
    }
    if (month > 12) return null;
    return fmt(y, month, day);
  }

  const parsed = new Date(s);
  return Number.isNaN(parsed.getTime()) ? null : iso(parsed);

  function fmt(y, mo, d) {
    const yy = String(y).padStart(4, '0');
    const mm = String(Number(mo)).padStart(2, '0');
    const dd = String(Number(d)).padStart(2, '0');
    if (Number(mm) < 1 || Number(mm) > 12 || Number(dd) < 1 || Number(dd) > 31) return null;
    return `${yy}-${mm}-${dd}`;
  }
  function fullYear(y) {
    const n = Number(y);
    if (String(y).length <= 2) return n > 60 ? 1900 + n : 2000 + n;
    return n;
  }
}

/** Parse "1.234,56", "(45.00)", "$1,200.00 CR", "-12.5". */
export function parseNumber(value) {
  let s = String(value ?? '').trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  if (/(^|\s)(DR|debit)(\s|$)/i.test(s)) negative = true;
  s = s.replace(/[^\d.,\-+]/g, '');
  if (!s) return null;
  if (s.includes(',') && s.includes('.')) {
    // Whichever separator comes last is the decimal point.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (s.includes(',')) {
    const parts = s.split(',');
    s = parts[parts.length - 1].length === 3 && parts.length > 1 && !s.startsWith('-,')
      ? s.replace(/,/g, '')
      : s.replace(',', '.');
  }
  if (s.startsWith('-')) {
    negative = true;
    s = s.slice(1);
  }
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return round2(negative ? -n : n);
}

/* ------------------------------- OFX ------------------------------ */

export function parseOFX(text) {
  const out = [];
  const blocks = String(text).match(/<STMTTRN>[\s\S]*?<\/STMTTRN>/gi) || [];
  for (const block of blocks) {
    const get = (tag) => {
      const m = block.match(new RegExp(`<${tag}>([^<\\r\\n]*)`, 'i'));
      return m ? m[1].trim() : '';
    };
    const amount = parseNumber(get('TRNAMT'));
    const date = parseDate(get('DTPOSTED'));
    if (amount === null || !date) continue;
    const name = get('NAME') || get('PAYEE');
    const memo = get('MEMO');
    out.push({
      date,
      amount,
      payee: decodeEntities(name || memo),
      notes: decodeEntities(name && memo && name !== memo ? memo : ''),
      fitid: get('FITID'),
      type: get('TRNTYPE'),
    });
  }
  return out;
}

export function ofxAccountHint(text) {
  const m = String(text).match(/<ACCTID>([^<\r\n]*)/i);
  return m ? m[1].trim() : '';
}

/* ------------------------------- QIF ------------------------------ */

export function parseQIF(text) {
  const out = [];
  let cur = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const code = line[0];
    const value = line.slice(1).trim();
    if (code === '^') {
      if (cur.date && cur.amount !== null && cur.amount !== undefined) out.push(cur);
      cur = {};
      continue;
    }
    switch (code) {
      case 'D': cur.date = parseDate(value); break;
      case 'T':
      case 'U': cur.amount = parseNumber(value); break;
      case 'P': cur.payee = value; break;
      case 'M': cur.notes = value; break;
      case 'L': cur.categoryHint = value; break;
      case 'N': cur.checkNumber = value; break;
      default: break;
    }
  }
  if (cur.date && cur.amount != null) out.push(cur);
  return out;
}

/* ----------------------------- shared ----------------------------- */

function decodeEntities(s) {
  return String(s || '')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .trim();
}

/** Guess which CSV column holds what, from the header text. */
export function guessMapping(headers) {
  const norm = headers.map((hh) => String(hh).toLowerCase().replace(/[^a-z0-9]/g, ''));
  const find = (...patterns) => {
    for (const p of patterns) {
      const i = norm.findIndex((hh) => hh === p);
      if (i >= 0) return i;
    }
    for (const p of patterns) {
      const i = norm.findIndex((hh) => hh.includes(p));
      if (i >= 0) return i;
    }
    return -1;
  };
  return {
    date: find('date', 'transactiondate', 'posteddate', 'postingdate', 'datposted'),
    amount: find('amount', 'transactionamount', 'value', 'amt'),
    debit: find('debit', 'withdrawal', 'withdrawals', 'moneyout', 'paidout'),
    credit: find('credit', 'deposit', 'deposits', 'moneyin', 'paidin'),
    payee: find('description', 'payee', 'name', 'merchant', 'transactiondescription', 'details'),
    notes: find('memo', 'notes', 'reference', 'originaldescription'),
    category: find('category', 'categoryname'),
    balance: find('balance', 'runningbalance'),
  };
}
