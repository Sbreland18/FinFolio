'use strict';
/**
 * Application menu. Hidden behind Alt on Windows (autoHideMenuBar), but it
 * gives every action a real keyboard accelerator, which is what makes the app
 * fast to use once you know it.
 */

const { Menu, app, shell } = require('electron');

function buildMenu({ getWindow, isDev }) {
  const send = (command, payload) => {
    const win = getWindow();
    if (win && !win.isDestroyed()) win.webContents.send('menu:command', { command, payload });
  };

  const template = [
    {
      label: '&File',
      submenu: [
        { label: 'New Transaction…', accelerator: 'CmdOrCtrl+N', click: () => send('new-transaction') },
        { label: 'New Account…', accelerator: 'CmdOrCtrl+Shift+A', click: () => send('new-account') },
        { label: 'New Bill / Recurring…', accelerator: 'CmdOrCtrl+Shift+B', click: () => send('new-recurring') },
        { type: 'separator' },
        { label: 'Import Statement…', accelerator: 'CmdOrCtrl+I', click: () => send('import') },
        { label: 'Export Transactions (CSV)…', accelerator: 'CmdOrCtrl+E', click: () => send('export-csv') },
        { type: 'separator' },
        { label: 'Back Up Now', accelerator: 'CmdOrCtrl+B', click: () => send('backup-now') },
        { label: 'Export Backup File…', click: () => send('backup-export') },
        { label: 'Restore From Backup…', click: () => send('backup-restore') },
        { type: 'separator' },
        { label: 'Lock App', accelerator: 'CmdOrCtrl+L', click: () => send('lock') },
        { role: 'quit', label: 'Exit' },
      ],
    },
    {
      label: '&Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find / Search', accelerator: 'CmdOrCtrl+F', click: () => send('focus-search') },
      ],
    },
    {
      label: '&View',
      submenu: [
        { label: 'Dashboard', accelerator: 'CmdOrCtrl+1', click: () => send('navigate', 'dashboard') },
        { label: 'Accounts', accelerator: 'CmdOrCtrl+2', click: () => send('navigate', 'accounts') },
        { label: 'Transactions', accelerator: 'CmdOrCtrl+3', click: () => send('navigate', 'transactions') },
        { label: 'Bills & Recurring', accelerator: 'CmdOrCtrl+4', click: () => send('navigate', 'recurring') },
        { label: 'Calendar & Forecast', accelerator: 'CmdOrCtrl+5', click: () => send('navigate', 'calendar') },
        { label: 'Budgets', accelerator: 'CmdOrCtrl+6', click: () => send('navigate', 'budgets') },
        { label: 'Debt Payoff', accelerator: 'CmdOrCtrl+7', click: () => send('navigate', 'debt') },
        { label: 'Goals & Net Worth', accelerator: 'CmdOrCtrl+8', click: () => send('navigate', 'goals') },
        { label: 'Reports', accelerator: 'CmdOrCtrl+9', click: () => send('navigate', 'reports') },
        { label: 'Settings', accelerator: 'CmdOrCtrl+,', click: () => send('navigate', 'settings') },
        { type: 'separator' },
        { label: 'Toggle Privacy Mode', accelerator: 'CmdOrCtrl+H', click: () => send('toggle-privacy') },
        { label: 'Toggle Theme', accelerator: 'CmdOrCtrl+D', click: () => send('toggle-theme') },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { role: 'togglefullscreen' },
        ...(isDev ? [{ type: 'separator' }, { role: 'reload' }, { role: 'toggleDevTools' }] : []),
      ],
    },
    {
      label: '&Help',
      submenu: [
        { label: 'Check for Updates…', click: () => send('check-updates') },
        { label: 'Keyboard Shortcuts', accelerator: 'F1', click: () => send('shortcuts') },
        { type: 'separator' },
        {
          label: 'Project on GitHub',
          click: () => shell.openExternal('https://github.com/Sbreland18/finfolio'),
        },
        {
          label: 'Report an Issue',
          click: () => shell.openExternal('https://github.com/Sbreland18/finfolio/issues/new'),
        },
        { type: 'separator' },
        { label: `About FinFolio ${app.getVersion()}`, click: () => send('about') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

module.exports = { buildMenu };
