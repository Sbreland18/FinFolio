/**
 * The application chrome: title bar, sidebar navigation and the view router.
 */

import { h, mount, $ } from './dom.js';
import { icon } from './icons.js';
import { money } from './format.js';
import { state, subscribe, navigate, saveNow, undo, canUndo } from './state.js';
import { netWorth, upcomingItems } from './finance.js';
import { toast, contextMenu, closeMenus } from './ui.js';

import dashboard from './views/dashboard.js';
import accounts from './views/accounts.js';
import transactions from './views/transactions.js';
import recurring from './views/recurring.js';
import calendar from './views/calendar.js';
import budgets from './views/budgets.js';
import debt from './views/debt.js';
import goals from './views/goals.js';
import reports from './views/reports.js';
import settings from './views/settings.js';

const api = window.finfolio;

export const VIEWS = {
  dashboard, accounts, transactions, recurring, calendar, budgets, debt, goals, reports, settings,
};

const NAV = [
  {
    section: 'Overview',
    items: [
      { id: 'dashboard', label: 'Dashboard', icon: 'dashboard' },
      { id: 'accounts', label: 'Accounts', icon: 'wallet' },
      { id: 'transactions', label: 'Transactions', icon: 'receipt' },
    ],
  },
  {
    section: 'Planning',
    items: [
      { id: 'recurring', label: 'Bills & Income', icon: 'repeat', badge: 'due' },
      { id: 'calendar', label: 'Calendar & Forecast', icon: 'calendar' },
      { id: 'budgets', label: 'Budgets', icon: 'pie' },
    ],
  },
  {
    section: 'Debt & Savings',
    items: [
      { id: 'debt', label: 'Debt Payoff', icon: 'card' },
      { id: 'goals', label: 'Goals & Net Worth', icon: 'target' },
    ],
  },
  {
    section: 'Insights',
    items: [{ id: 'reports', label: 'Reports', icon: 'trending' }],
  },
];

let viewHost = null;
let navHost = null;
let netWorthTile = null;
let currentView = null;

export function buildShell() {
  const app = $('#app');

  const titlebar = h(
    'div.titlebar',
    null,
    h(
      'div.brand',
      null,
      h('div.mark', null, icon('trending', { size: 13, stroke: 2.4 })),
      h('div.name', null, 'FinFolio')
    ),
    h('div.spacer'),
    h(
      'div.tb-actions',
      null,
      h(
        'button.tb-btn',
        { title: 'Quick add  (Ctrl+N)', onclick: () => openQuickAdd() },
        icon('plus', { size: 15 }),
        'Add'
      ),
      h(
        'button.tb-btn',
        { id: 'privacy-toggle', title: 'Privacy mode  (Ctrl+H)', onclick: togglePrivacy },
        icon('eye', { size: 15 })
      ),
      h('button.tb-btn', { id: 'save-indicator', title: 'All changes saved' }, icon('check', { size: 15 })),
      h(
        'button.tb-btn',
        { title: 'More', onclick: (e) => shellMenu(e) },
        icon('more', { size: 15 })
      )
    ),
    h('div.controls-gap')
  );

  navHost = h('nav.nav', { 'aria-label': 'Main' });
  netWorthTile = h('div.net-worth-tile');

  const sidebar = h(
    'aside.sidebar',
    null,
    navHost,
    h('div.sidebar-foot', null, netWorthTile)
  );

  viewHost = h('div.main');

  mount(app, titlebar, h('div.shell', null, sidebar, viewHost));

  renderNav();
  renderNetWorth();
  subscribe((reason) => {
    if (reason === 'route') {
      renderNav();
      renderView();
    } else if (reason === 'saving' || reason === 'saved') {
      renderSaveIndicator();
    } else {
      renderNav();
      renderNetWorth();
      renderView();
    }
  });
  renderView();
  wireShortcuts();
  wireMenuCommands();
}

/* ------------------------------ nav ------------------------------- */

function renderNav() {
  if (!navHost) return;
  const doc = state.doc;
  const due = doc
    ? upcomingItems(doc, { days: Number((doc.settings || {}).upcomingWindowDays) || 14 }).length
    : 0;

  const sections = NAV.map((sec) =>
    h(
      'div',
      null,
      h('div.nav-section', null, sec.section),
      ...sec.items.map((item) =>
        h(
          'button.nav-item',
          {
            'aria-current': state.route === item.id ? 'page' : null,
            onclick: () => navigate(item.id),
            title: item.label,
          },
          icon(item.icon, { size: 17 }),
          h('span.nav-label', null, item.label),
          item.badge === 'due' && due
            ? h('span.nav-badge.due', null, String(due))
            : null
        )
      )
    )
  );

  mount(
    navHost,
    ...sections,
    h('div.nav-section', null, 'App'),
    h(
      'button.nav-item',
      {
        'aria-current': state.route === 'settings' ? 'page' : null,
        onclick: () => navigate('settings'),
      },
      icon('settings', { size: 17 }),
      h('span.nav-label', null, 'Settings')
    )
  );
}

function renderNetWorth() {
  if (!netWorthTile || !state.doc) return;
  const nw = netWorth(state.doc);
  mount(
    netWorthTile,
    h('div.net-worth-label', null, 'Net worth'),
    h(
      'div.net-worth-value.money-mask',
      { class: nw.net < 0 ? 'neg' : '' },
      money(nw.net, { cents: false })
    )
  );
}

function renderSaveIndicator() {
  const el = document.getElementById('save-indicator');
  if (!el) return;
  if (state.saving) {
    mount(el, h('span.spinner'));
    el.title = 'Saving…';
  } else if (state.dirty) {
    mount(el, icon('save', { size: 15 }));
    el.title = 'Unsaved changes';
  } else {
    mount(el, icon('check', { size: 15 }));
    el.title = 'All changes saved';
  }
}

/* ----------------------------- router ----------------------------- */

export function renderView() {
  if (!viewHost || !state.doc) return;
  const view = VIEWS[state.route] || VIEWS.dashboard;
  const scrollTop = currentView === state.route ? viewHost.querySelector('.view')?.scrollTop || 0 : 0;
  try {
    const node = view(state.doc, state.params);
    mount(viewHost, node);
  } catch (err) {
    console.error(err);
    if (api) api.log.error(`view ${state.route}: ${err.message}`, err.stack);
    mount(
      viewHost,
      h(
        'div.view',
        null,
        h(
          'div.card.pad',
          null,
          h('div.h2', null, 'Something went wrong rendering this screen'),
          h('p.muted.mt-8', null, String(err.message || err)),
          h('pre.mono.mt-12.small.selectable', { style: { whiteSpace: 'pre-wrap' } }, String(err.stack || ''))
        )
      )
    );
  }
  const scroller = viewHost.querySelector('.view');
  if (scroller && scrollTop) scroller.scrollTop = scrollTop;
  currentView = state.route;
}

/** Standard page scaffold used by every view. */
export function page({ title, subtitle, actions = [], children = [] }) {
  return h(
    'div',
    { style: { display: 'contents' } },
    h(
      'header.topbar',
      null,
      h(
        'div.titles.grow',
        null,
        h('div.page-title', null, title),
        subtitle ? h('div.page-sub', null, subtitle) : null
      ),
      h('div.actions', null, ...actions)
    ),
    h('div.view.scroll', null, ...[].concat(children))
  );
}

/* --------------------------- shell actions ------------------------ */

function togglePrivacy() {
  const root = document.documentElement;
  const on = root.getAttribute('data-privacy') === 'on';
  root.setAttribute('data-privacy', on ? 'off' : 'on');
  const btn = document.getElementById('privacy-toggle');
  if (btn) mount(btn, icon(on ? 'eye' : 'eyeOff', { size: 15 }));
  if (state.doc) {
    state.doc.settings.hideAmounts = !on;
    saveNow();
  }
}

export function applyPrivacyFromSettings() {
  const on = !!(state.doc && state.doc.settings && state.doc.settings.hideAmounts);
  document.documentElement.setAttribute('data-privacy', on ? 'on' : 'off');
  const btn = document.getElementById('privacy-toggle');
  if (btn) mount(btn, icon(on ? 'eyeOff' : 'eye', { size: 15 }));
}

async function openQuickAdd() {
  const { openTransactionEditor } = await import('./editors.js');
  openTransactionEditor();
}

function shellMenu(e) {
  contextMenu(e, [
    { header: 'Data' },
    { label: 'Back up now', icon: 'save', onClick: () => import('./backup.js').then((m) => m.backupNow()) },
    { label: 'Backup & restore…', icon: 'database', onClick: () => navigate('settings', { tab: 'backup' }) },
    { label: 'Import statement…', icon: 'upload', onClick: () => import('./importer.js').then((m) => m.openImporter()) },
    { separator: true },
    { label: 'Undo last change', icon: 'undo', disabled: !canUndo(), onClick: () => undo() },
    { separator: true },
    { label: 'Lock app', icon: 'lock', onClick: () => lockApp() },
    { label: 'Check for updates', icon: 'refresh', onClick: () => navigate('settings', { tab: 'updates' }) },
    { label: 'Keyboard shortcuts', icon: 'help', onClick: showShortcuts },
    { separator: true },
    { label: 'About FinFolio', icon: 'info', onClick: showAbout },
  ]);
}

export async function lockApp() {
  await saveNow();
  const status = await api.data.status();
  if (!status.encrypted) {
    toast('Set a password in Settings → Security to lock the app.');
    return;
  }
  await api.data.lock();
  location.reload();
}

export async function showAbout() {
  const { alertDialog } = await import('./ui.js');
  const info = state.appInfo || {};
  alertDialog({
    title: 'About FinFolio',
    body: h(
      'div.col',
      null,
      h('p.muted', null, 'A private, offline-first personal finance manager. Your data never leaves this computer.'),
      h(
        'dl.kv.mt-12',
        null,
        h('dt', null, 'Version'), h('dd', null, info.version || '—'),
        h('dt', null, 'Electron'), h('dd', null, info.electron || '—'),
        h('dt', null, 'Platform'), h('dd', null, `${info.platform || ''} ${info.arch || ''}`),
        h('dt', null, 'Data folder'), h('dd.mono.tiny.selectable', null, info.userData || '—')
      ),
      h(
        'div.mt-16',
        null,
        h(
          'button.btn.sm',
          { onclick: () => api.shell.openExternal('https://github.com/Sbreland18/finfolio') },
          icon('external', { size: 14 }),
          'Project on GitHub'
        )
      )
    ),
  });
}

export async function showShortcuts() {
  const { alertDialog } = await import('./ui.js');
  const rows = [
    ['Ctrl + N', 'New transaction'],
    ['Ctrl + Shift + A', 'New account'],
    ['Ctrl + Shift + B', 'New bill or income'],
    ['Ctrl + F', 'Search transactions'],
    ['Ctrl + I', 'Import a statement'],
    ['Ctrl + E', 'Export transactions to CSV'],
    ['Ctrl + B', 'Back up now'],
    ['Ctrl + Z', 'Undo last change'],
    ['Ctrl + H', 'Privacy mode (blur amounts)'],
    ['Ctrl + D', 'Toggle light / dark theme'],
    ['Ctrl + L', 'Lock the app'],
    ['Ctrl + 1 … 9', 'Jump between screens'],
    ['Esc', 'Close dialog'],
  ];
  alertDialog({
    title: 'Keyboard shortcuts',
    body: h(
      'dl.kv',
      null,
      ...rows.flatMap(([k, v]) => [h('dt.mono', null, k), h('dd', { style: { textAlign: 'left' } }, v)])
    ),
  });
}

/* --------------------------- shortcuts ---------------------------- */

const ROUTE_KEYS = ['dashboard', 'accounts', 'transactions', 'recurring', 'calendar', 'budgets', 'debt', 'goals', 'reports'];

function wireShortcuts() {
  document.addEventListener('keydown', async (e) => {
    const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) || e.target.isContentEditable;
    if (e.key === 'Escape') {
      closeMenus();
      const { closeTopModal } = await import('./ui.js');
      closeTopModal();
      return;
    }
    if (!(e.ctrlKey || e.metaKey)) return;

    const k = e.key.toLowerCase();
    if (k >= '1' && k <= '9') {
      const route = ROUTE_KEYS[Number(k) - 1];
      if (route) {
        e.preventDefault();
        navigate(route);
      }
      return;
    }
    switch (k) {
      case 'n':
        if (!e.shiftKey) { e.preventDefault(); openQuickAdd(); }
        break;
      case 'a':
        if (e.shiftKey) { e.preventDefault(); import('./editors.js').then((m) => m.openAccountEditor()); }
        break;
      case 'b':
        e.preventDefault();
        if (e.shiftKey) import('./editors.js').then((m) => m.openRecurringEditor());
        else import('./backup.js').then((m) => m.backupNow());
        break;
      case 'f':
        e.preventDefault();
        navigate('transactions', { focusSearch: Date.now() });
        break;
      case 'i':
        e.preventDefault();
        import('./importer.js').then((m) => m.openImporter());
        break;
      case 'e':
        e.preventDefault();
        import('./exporter.js').then((m) => m.exportTransactionsCsv());
        break;
      case 'z':
        if (!inField) { e.preventDefault(); undo(); }
        break;
      case 'h':
        e.preventDefault();
        togglePrivacy();
        break;
      case 'd':
        e.preventDefault();
        cycleTheme();
        break;
      case 'l':
        e.preventDefault();
        lockApp();
        break;
      case ',':
        e.preventDefault();
        navigate('settings');
        break;
      default:
        break;
    }
  });
}

export function cycleTheme() {
  const cur = (state.doc && state.doc.settings.theme) || 'system';
  const next = cur === 'dark' ? 'light' : 'dark';
  state.doc.settings.theme = next;
  applyTheme(next);
  saveNow();
  toast(`${next === 'dark' ? 'Dark' : 'Light'} theme`);
}

export function applyTheme(theme) {
  const root = document.documentElement;
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches
        ? 'dark'
        : 'light'
      : theme;
  root.setAttribute('data-theme', resolved);
  if (api) api.theme.apply(theme);
}

export function applyAppearance(settings = {}) {
  const root = document.documentElement;
  applyTheme(settings.theme || 'system');
  root.setAttribute('data-accent', settings.accent || 'indigo');
  root.setAttribute('data-density', settings.density || 'comfortable');
  applyPrivacyFromSettings();
}

/* ------------------------- native menu bridge --------------------- */

function wireMenuCommands() {
  if (!api) return;
  api.menu.onCommand(async ({ command, payload }) => {
    switch (command) {
      case 'navigate':
        navigate(payload);
        break;
      case 'new-transaction':
        openQuickAdd();
        break;
      case 'new-account':
        (await import('./editors.js')).openAccountEditor();
        break;
      case 'new-recurring':
        (await import('./editors.js')).openRecurringEditor();
        break;
      case 'import':
        (await import('./importer.js')).openImporter();
        break;
      case 'export-csv':
        (await import('./exporter.js')).exportTransactionsCsv();
        break;
      case 'backup-now':
        (await import('./backup.js')).backupNow();
        break;
      case 'backup-export':
        (await import('./backup.js')).exportBackup();
        break;
      case 'backup-restore':
        (await import('./backup.js')).restoreFromFile();
        break;
      case 'lock':
        lockApp();
        break;
      case 'focus-search':
        navigate('transactions', { focusSearch: Date.now() });
        break;
      case 'toggle-privacy':
        togglePrivacy();
        break;
      case 'toggle-theme':
        cycleTheme();
        break;
      case 'check-updates':
        navigate('settings', { tab: 'updates' });
        break;
      case 'shortcuts':
        showShortcuts();
        break;
      case 'about':
        showAbout();
        break;
      default:
        break;
    }
  });
}
