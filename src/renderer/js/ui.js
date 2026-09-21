/**
 * Shared UI primitives: toasts, modals, menus, and the form controls that every
 * view builds its dialogs from.
 */

import { h, mount, $ } from './dom.js';
import { icon } from './icons.js';
import { money, parseAmount, currencySymbol, today } from './format.js';

/* ------------------------------ toasts ---------------------------- */

export function toast(message, { title = null, tone = '', timeout = 3800, action = null } = {}) {
  const host = $('#toasts');
  if (!host) return () => {};
  const el = h(
    `div.toast${tone ? `.${tone}` : ''}`,
    { role: 'status' },
    h(
      'div.grow',
      null,
      title ? h('div.toast-title', null, title) : null,
      h(title ? 'div.toast-msg' : 'div.toast-title', null, message)
    ),
    action
      ? h('button.linkbtn.tiny', { onclick: () => { action.onClick(); close(); } }, action.label)
      : null,
    h('button.toast-x', { 'aria-label': 'Dismiss', onclick: () => close() }, icon('x', { size: 14 }))
  );
  host.appendChild(el);
  let timer = timeout ? setTimeout(close, timeout) : null;
  function close() {
    clearTimeout(timer);
    el.style.opacity = '0';
    el.style.transform = 'translateY(6px)';
    el.style.transition = 'all 160ms ease';
    setTimeout(() => el.remove(), 170);
  }
  return close;
}

export const toastOk = (m, o) => toast(m, { tone: 'good', ...o });
export const toastErr = (m, o) => toast(m, { tone: 'bad', timeout: 6000, ...o });

/* ------------------------------ modals ---------------------------- */

const openModals = [];

/**
 * @param {{title:string, body:Node|Node[], footer?:Node[], size?:string,
 *          onClose?:Function, dismissable?:boolean}} o
 */
export function modal(o) {
  const layers = $('#layers');
  const body = h('div.modal-body');
  mount(body, o.body);

  const card = h(
    `div.modal${o.size ? `.${o.size}` : ''}`,
    { role: 'dialog', 'aria-modal': 'true', 'aria-label': o.title || 'Dialog' },
    h(
      'div.modal-head',
      null,
      h('div', null, h('div.h2', null, o.title || ''), o.subtitle ? h('div.small.muted', null, o.subtitle) : null),
      o.dismissable === false
        ? null
        : h('button.btn.ghost.icon.sm', { 'aria-label': 'Close', onclick: () => close() }, icon('x', { size: 16 }))
    ),
    body,
    o.footer ? h('div.modal-foot', null, ...[].concat(o.footer)) : null
  );

  const scrim = h('div.scrim', {
    onmousedown: (e) => {
      if (e.target === scrim && o.dismissable !== false) close();
    },
  }, card);

  layers.appendChild(scrim);
  openModals.push({ scrim, close });
  document.body.style.setProperty('overflow', 'hidden');

  // Focus the first sensible control.
  setTimeout(() => {
    const first = card.querySelector('[autofocus], input:not([type=hidden]), select, textarea, button.primary');
    if (first) first.focus();
  }, 30);

  function close(result) {
    const idx = openModals.findIndex((m) => m.scrim === scrim);
    if (idx >= 0) openModals.splice(idx, 1);
    scrim.style.animation = 'none';
    scrim.style.opacity = '0';
    scrim.style.transition = 'opacity 130ms ease';
    setTimeout(() => scrim.remove(), 140);
    if (!openModals.length) document.body.style.removeProperty('overflow');
    if (o.onClose) o.onClose(result);
  }

  return { el: card, body, close, scrim };
}

export function closeTopModal() {
  const top = openModals[openModals.length - 1];
  if (top) top.close();
  return !!top;
}

export function confirm({
  title = 'Are you sure?',
  message = '',
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  tone = 'primary',
  detail = null,
} = {}) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (v) => {
      if (settled) return;
      settled = true;
      resolve(v);
    };
    const m = modal({
      title,
      size: 'sm',
      body: [
        message ? h('p.muted', null, message) : null,
        detail ? h('div.card.pad.mt-12.small', null, detail) : null,
      ],
      footer: [
        h('button.btn', { onclick: () => { done(false); m.close(); } }, cancelLabel),
        h(
          `button.btn.${tone === 'danger' ? 'danger' : 'primary'}`,
          { autofocus: true, onclick: () => { done(true); m.close(); } },
          confirmLabel
        ),
      ],
      onClose: () => done(false),
    });
  });
}

export function alertDialog({ title, message, body = null, size = 'sm', okLabel = 'Got it' }) {
  return new Promise((resolve) => {
    const m = modal({
      title,
      size,
      body: [message ? h('p.muted', null, message) : null, body],
      footer: [h('button.btn.primary', { autofocus: true, onclick: () => m.close() }, okLabel)],
      onClose: () => resolve(),
    });
  });
}

/* ------------------------------ menus ----------------------------- */

/**
 * @param {MouseEvent} event
 * @param {{label?:string, icon?:string, onClick?:Function, danger?:boolean,
 *          separator?:boolean, header?:string}[]} items
 */
const menuTeardown = [];

export function contextMenu(event, items) {
  event.preventDefault();
  event.stopPropagation();
  closeMenus();
  const menu = h(
    'div.menu',
    { role: 'menu' },
    ...items.map((it) => {
      if (it.separator) return h('div.sep');
      if (it.header) return h('div.menu-label', null, it.header);
      return h(
        `button${it.danger ? '.danger' : ''}`,
        {
          role: 'menuitem',
          disabled: it.disabled || false,
          onclick: () => {
            closeMenus();
            if (it.onClick) it.onClick();
          },
        },
        it.icon ? icon(it.icon, { size: 15 }) : null,
        it.label
      );
    })
  );
  document.body.appendChild(menu);
  const r = menu.getBoundingClientRect();
  const x = Math.min(event.clientX, window.innerWidth - r.width - 10);
  const y = Math.min(event.clientY, window.innerHeight - r.height - 10);
  menu.style.left = `${Math.max(8, x)}px`;
  menu.style.top = `${Math.max(8, y)}px`;

  // Close on a press *outside* the menu. Closing on any press at all looks
  // right until you use it: mousedown fires before mouseup, so the menu was
  // torn out of the page while the button was still going down and no click
  // event ever reached the item. Every menu in the app silently did nothing.
  const awayPress = (e) => {
    const target = e.target;
    if (target && target.closest && target.closest('.menu')) return;
    closeMenus();
  };
  const escapePress = (e) => {
    if (e.key === 'Escape') closeMenus();
  };
  setTimeout(() => {
    document.addEventListener('mousedown', awayPress);
    document.addEventListener('keydown', escapePress);
    menuTeardown.push(() => {
      document.removeEventListener('mousedown', awayPress);
      document.removeEventListener('keydown', escapePress);
    });
  }, 0);
  return menu;
}

export function closeMenus() {
  for (const off of menuTeardown.splice(0)) off();
  document.querySelectorAll('.menu').forEach((m) => m.remove());
}

/* --------------------------- form fields -------------------------- */

export function field(label, control, { hint, error, id } = {}) {
  if (id) control.id = id;
  return h(
    'div.field',
    null,
    label ? h('label.label', { for: id || null }, label) : null,
    control,
    hint ? h('div.hint', null, hint) : null,
    error ? h('div.err', null, error) : null
  );
}

export function textInput(props = {}) {
  return h('input.input', { type: 'text', ...props });
}

export function textArea(props = {}) {
  return h('textarea.textarea', props);
}

export function select(options, props = {}) {
  const el = h('select.select', props);
  for (const opt of options) {
    if (opt === null || opt === undefined) continue;
    const o = typeof opt === 'object' ? opt : { value: opt, label: String(opt) };
    el.appendChild(
      h('option', { value: o.value, selected: o.selected || false, disabled: o.disabled || false }, o.label)
    );
  }
  if (props.value !== undefined) el.value = props.value;
  return el;
}

export function moneyInput(props = {}) {
  const input = h('input.input.amount', {
    type: 'text',
    inputMode: 'decimal',
    placeholder: '0.00',
    ...props,
    onblur: (e) => {
      const v = parseAmount(e.target.value);
      e.target.value = v ? v.toFixed(2) : '';
      if (props.onblur) props.onblur(e);
    },
  });
  return h('div.input-group', null, h('span.prefix', null, currencySymbol()), input);
}

/** Read the numeric value back out of a moneyInput wrapper (or a raw input). */
export function readMoney(node) {
  const input = node.tagName === 'INPUT' ? node : node.querySelector('input');
  return parseAmount(input ? input.value : 0);
}

export function dateInput(props = {}) {
  return h('input.input', { type: 'date', value: props.value || today(), ...props });
}

export function checkbox(label, props = {}) {
  return h(
    'label.check',
    null,
    h('input', { type: 'checkbox', ...props }),
    h('span.box', null, icon('check', { size: 12, stroke: 3 })),
    h('span', null, label)
  );
}

export function switchRow(label, description, props = {}) {
  return h(
    'div.setting-row',
    null,
    h('div.s-main', null, h('div.s-title', null, label), description ? h('div.s-desc', null, description) : null),
    h(
      'div.s-control',
      null,
      h('label.switch', null, h('input', { type: 'checkbox', ...props }), h('span.track'))
    )
  );
}

export function segmented(options, value, onChange) {
  const el = h('div.segmented', { role: 'tablist' });
  for (const opt of options) {
    const o = typeof opt === 'object' ? opt : { value: opt, label: String(opt) };
    el.appendChild(
      h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': String(o.value === value),
          onclick: () => {
            for (const b of el.children) b.setAttribute('aria-selected', 'false');
            const target = [...el.children].find((b) => b.dataset.value === String(o.value));
            if (target) target.setAttribute('aria-selected', 'true');
            onChange(o.value);
          },
          dataset: { value: String(o.value) },
        },
        o.label
      )
    );
  }
  return el;
}

/* ------------------------ common selectors ------------------------ */

export function accountSelect(
  doc,
  { value, includeArchived = false, allowEmpty = false, emptyLabel = '— none —', filter = null, ...props } = {}
) {
  const list = (doc.accounts || [])
    .filter((a) => (includeArchived || !a.archived) && (!filter || filter(a)))
    .map((a) => ({ value: a.id, label: a.name, selected: a.id === value }));
  return select(allowEmpty ? [{ value: '', label: emptyLabel }, ...list] : list, { value: value || '', ...props });
}

/**
 * Emoji chooser for category icons.
 *
 * A bare text box with an emoji placeholder reads as "here is your one icon" —
 * people click it, nothing happens, and the category ends up with a bullet. A
 * visible grid makes the choice obvious, and the box beside it still accepts
 * any emoji at all for anything the grid has missed.
 */
export const EMOJI_SETS = [
  ['Money', ['💵', '💰', '💳', '🏦', '🪙', '💸', '📈', '📉', '🧾', '🏧', '🐖', '🤑']],
  ['Home', ['🏠', '🏡', '🛋️', '🔧', '🧹', '🪴', '💡', '🚰', '🔥', '🗑️', '🛠️', '🧺']],
  ['Food', ['🛒', '🍽️', '☕', '🍕', '🍔', '🥗', '🍎', '🍺', '🥡', '🍰', '🧁', '🥑']],
  ['Getting around', ['🚗', '⛽', '🚌', '🚕', '✈️', '🚲', '🅿️', '🛣️', '🚊', '🛻', '🔩', '🚦']],
  ['Life', ['🏥', '💊', '🩺', '🏋️', '👕', '💈', '🎁', '❤️', '🎓', '🧸', '🐾', '👶']],
  ['Fun', ['📺', '🎬', '🎮', '🎨', '🎵', '📚', '🏖️', '🎟️', '🎪', '⚽', '🎳', '🎸']],
  ['Work & admin', ['💼', '🖥️', '📱', '🌐', '📦', '🖨️', '📮', '🗂️', '🔒', '⚖️', '🏛️', '✉️']],
];

export function emojiPicker({ value = '', onChange = null } = {}) {
  let current = value || '';
  const buttons = [];

  const input = h('input.input', {
    type: 'text',
    value: current,
    maxLength: 6,
    'aria-label': 'Icon',
    placeholder: '•',
    style: { width: '64px', textAlign: 'center', fontSize: '19px' },
  });

  function apply(next, { silent = false } = {}) {
    current = next || '';
    if (input.value !== current) input.value = current;
    for (const b of buttons) b.classList.toggle('on', b.dataset.emoji === current);
    if (!silent && onChange) onChange(current);
  }

  const grid = h('div.emoji-grid');
  for (const [label, list] of EMOJI_SETS) {
    grid.appendChild(h('div.emoji-group', null, label));
    const row = h('div.emoji-row');
    for (const glyph of list) {
      const b = h(
        'button.emoji-btn',
        { type: 'button', title: glyph, 'aria-label': glyph, onclick: () => apply(glyph) },
        glyph
      );
      b.dataset.emoji = glyph;
      buttons.push(b);
      row.appendChild(b);
    }
    grid.appendChild(row);
  }

  input.addEventListener('input', () => apply(input.value.trim(), { silent: true }));

  const wrap = h(
    'div.emoji-picker',
    null,
    h('div.row.gap-8', null, input, h('span.tiny.dim', null, 'Pick one below, or type any emoji here')),
    grid
  );
  Object.defineProperty(wrap, 'value', {
    get: () => current,
    set: (v) => apply(v, { silent: true }),
  });
  apply(current, { silent: true });
  return wrap;
}

export function categorySelect(doc, { value, kind = null, allowEmpty = true, ...props } = {}) {
  const live = (doc.categories || []).filter(
    (c) => !c.archived && (!kind || c.kind === kind)
  );
  const bySort = (a, b) => (a.sort || 0) - (b.sort || 0) || String(a.name).localeCompare(String(b.name));

  // Group headings first, then each parent with its children indented under
  // it, so "Pet food" reads as part of "Pets" rather than as its own thing.
  const groups = new Map();
  for (const c of live) {
    if (c.parentId) continue;
    if (!groups.has(c.group)) groups.set(c.group, []);
    groups.get(c.group).push(c);
  }

  const el = h('select.select', props);
  if (allowEmpty) el.appendChild(h('option', { value: '' }, '— uncategorised —'));
  const option = (c, depth) =>
    h(
      'option',
      { value: c.id, selected: c.id === value },
      `${depth ? '    ↳ ' : ''}${c.icon || ''} ${c.name}`.trim()
    );

  for (const [group, parents] of groups) {
    const og = h('optgroup', { label: group });
    for (const parent of parents.sort(bySort)) {
      og.appendChild(option(parent, 0));
      for (const child of live.filter((c) => c.parentId === parent.id).sort(bySort)) {
        og.appendChild(option(child, 1));
      }
    }
    el.appendChild(og);
  }

  // Children whose parent is archived would otherwise be unreachable.
  const shown = new Set([...el.querySelectorAll('option')].map((o) => o.value));
  const orphans = live.filter((c) => c.parentId && !shown.has(c.id)).sort(bySort);
  if (orphans.length) {
    const og = h('optgroup', { label: 'Other' });
    for (const c of orphans) og.appendChild(option(c, 0));
    el.appendChild(og);
  }

  if (value) el.value = value;
  return el;
}

/* --------------------------- empty state -------------------------- */

export function emptyState({ icon: iconName = 'sparkle', title, message, action }) {
  return h(
    'div.empty',
    null,
    h('div.icon', null, icon(iconName, { size: 24 })),
    h('div.empty-title', null, title),
    message ? h('div.empty-msg', null, message) : null,
    action ? h('button.btn.primary.mt-8', { onclick: action.onClick }, icon('plus', { size: 15 }), action.label) : null
  );
}

/* ---------------------------- fragments --------------------------- */

export function statTile({ label, value, sub, delta, tone, sparkValues }) {
  return h(
    'div.card.pad.stat',
    null,
    h('div.stat-label', null, label),
    h('div.stat-value.money-mask', { class: tone || '' }, value),
    h(
      'div.row',
      { style: { justifyContent: 'space-between' } },
      sub ? h('div.stat-sub', null, sub) : h('div'),
      delta || null
    ),
    sparkValues && sparkValues.length > 1 ? h('div.mt-8', null, sparkValues) : null
  );
}

/**
 * Direction is carried by the arrow, so the number itself is unsigned —
 * "↑ $1,507" rather than a contradictory "↓ +$1,507".
 */
export function deltaBadge(value, { format = (v) => money(v), invert = false } = {}) {
  if (!Number.isFinite(value) || value === 0) return h('span.delta.dim', null, '—');
  const positive = value >= 0;
  const good = invert ? !positive : positive;
  return h(
    `span.delta.${good ? 'pos' : 'neg'}`,
    null,
    icon(positive ? 'arrowUp' : 'arrowDown', { size: 13, stroke: 2.4 }),
    format(Math.abs(value))
  );
}

export function badge(text, tone = '') {
  return h(`span.badge${tone ? `.${tone}` : ''}`, null, text);
}

export function moneyCell(value, { colorize = true, sign = false } = {}) {
  const n = Number(value) || 0;
  const cls = colorize ? (n > 0 ? '.pos' : n < 0 ? '.neg' : '') : '';
  return h(`span.money-mask${cls}`, null, money(n, { sign }));
}

/** Keyboard-friendly, debounced search box. */
export function searchBox({ placeholder = 'Search…', value = '', onInput, delay = 160 }) {
  let t = null;
  const input = h('input.input', {
    type: 'search',
    placeholder,
    value,
    oninput: (e) => {
      clearTimeout(t);
      const v = e.target.value;
      t = setTimeout(() => onInput(v), delay);
    },
  });
  const box = h('div.search', null, icon('search', { size: 15 }), input);
  box.focusInput = () => input.focus();
  return box;
}
