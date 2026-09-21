'use strict';
/**
 * FinFolio — main process entry point.
 *
 * Responsibilities kept here: app lifecycle, the browser window, and handing
 * the renderer a narrow, typed IPC surface (see preload.js). All financial
 * calculation lives in the renderer; all persistence lives in store.js.
 *
 * Startup rule: the window is created and shown before anything touches the
 * disk. On a managed Windows account %APPDATA% is often redirected to a network
 * share, and a slow or unreachable share used to leave the app running with no
 * window at all. Storage now initialises alongside the window, and every IPC
 * call waits for it, so a storage problem shows up as a message in the app
 * rather than an invisible process.
 */

const { app, BrowserWindow, nativeTheme, shell, dialog, protocol, screen } = require('electron');
const path = require('node:path');

const { Store } = require('./store');
const windowState = require('./window-state');
const { registerIpc } = require('./ipc');
const { buildMenu } = require('./menu');
const updater = require('./updater');

const isDev = !app.isPackaged || process.argv.includes('--dev');

/* ------------------------------------------------------------------ */
/* Logging — the first thing set up, so startup problems are recorded  */
/* even when nothing appears on screen. The file lives next to the     */
/* data folder: %APPDATA%\FinFolio\logs\main.log                       */
/* ------------------------------------------------------------------ */

let log = null;
try {
  log = require('electron-log');
  log.transports.file.level = 'info';
  log.transports.console.level = isDev ? 'info' : 'warn';
  log.errorHandler?.startCatching?.({ showDialog: false });
} catch {
  log = null;
}

function note(message, detail) {
  const line = detail === undefined ? message : `${message} ${JSON.stringify(detail)}`;
  if (log) log.info(`[startup] ${line}`);
  else console.log(`[startup] ${line}`);
}

function warn(message, err) {
  const line = `${message}${err ? `: ${(err && err.stack) || err}` : ''}`;
  if (log) log.warn(`[startup] ${line}`);
  else console.warn(`[startup] ${line}`);
}

note('launching', { version: app.getVersion(), packaged: app.isPackaged, platform: process.platform });

// Chromium's cache occasionally trips over redirected folders on Windows; a
// dedicated cache path avoids a class of first-run permission noise. It is not
// worth failing to start over, so a problem here is only logged.
try {
  app.setPath('sessionData', path.join(app.getPath('userData'), 'session'));
} catch (err) {
  warn('could not set the session data path', err);
}

let mainWindow = null;
let store = null;
let storeError = null;

// Every data IPC call waits on this, so handlers can be registered before the
// disk has been touched.
let markStoreReady = () => {};
const storeReady = new Promise((resolve) => {
  markStoreReady = resolve;
});

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  note('another instance already holds the lock — handing over and exiting');
  app.quit();
} else {
  app.on('second-instance', () => {
    // Launching again must always produce a visible window, even if the running
    // instance somehow has none.
    note('second instance launched — surfacing the existing window');
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    } else {
      createWindow();
    }
  });
}

/* ------------------------------------------------------------------ */
/* Custom app:// scheme                                                */
/*                                                                     */
/* The renderer is written as native ES modules, and Chromium refuses  */
/* to load modules over file:// (cross-origin for "null" origins). A   */
/* privileged standard scheme gives the renderer a real origin, so     */
/* modules load and the Content-Security-Policy's 'self' is meaningful.*/
/* ------------------------------------------------------------------ */

const APP_SCHEME = 'app';
const APP_ORIGIN = `${APP_SCHEME}://finfolio`;
const RENDERER_ROOT = path.join(__dirname, '..', 'renderer');

protocol.registerSchemesAsPrivileged([
  {
    scheme: APP_SCHEME,
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.woff2': 'font/woff2',
  '.ico': 'image/x-icon',
};

function registerAppProtocol() {
  const fsp = require('node:fs/promises');
  protocol.handle(APP_SCHEME, async (request) => {
    let requested;
    try {
      requested = decodeURIComponent(new URL(request.url).pathname);
    } catch {
      return new Response('Bad request', { status: 400 });
    }
    const resolved = path.normalize(path.join(RENDERER_ROOT, requested));
    // Never serve anything outside the renderer folder.
    if (resolved !== RENDERER_ROOT && !resolved.startsWith(RENDERER_ROOT + path.sep)) {
      return new Response('Forbidden', { status: 403 });
    }
    try {
      // fs is asar-aware, so this works identically in development and inside
      // a packaged app.asar.
      const body = await fsp.readFile(resolved);
      return new Response(body, {
        status: 200,
        headers: { 'content-type': MIME[path.extname(resolved).toLowerCase()] || 'application/octet-stream' },
      });
    } catch (err) {
      warn(`could not serve ${requested}`, err);
      return new Response('Not found', { status: 404 });
    }
  });
  note('app:// protocol registered', { root: RENDERER_ROOT });
}

/* ------------------------------------------------------------------ */

const TITLEBAR = {
  light: { color: '#ffffff', symbolColor: '#3d3d46' },
  dark: { color: '#15161c', symbolColor: '#d7d7e0' },
};

function overlayFor(theme) {
  const dark = theme === 'dark' || (theme !== 'light' && nativeTheme.shouldUseDarkColors);
  return { ...(dark ? TITLEBAR.dark : TITLEBAR.light), height: 44 };
}

/** Keep saved bounds usable when monitors have been unplugged or rearranged. */
function sanitiseBounds(state) {
  if (!Number.isInteger(state.x) || !Number.isInteger(state.y)) return state;
  try {
    const visible = screen.getAllDisplays().some((display) => {
      const b = display.workArea;
      return (
        state.x < b.x + b.width - 80 &&
        state.x + state.width > b.x + 80 &&
        state.y < b.y + b.height - 40 &&
        state.y + state.height > b.y
      );
    });
    if (!visible) {
      note('saved window position is off-screen — centring instead');
      return { ...state, x: undefined, y: undefined };
    }
  } catch (err) {
    warn('could not check display layout', err);
    return { ...state, x: undefined, y: undefined };
  }
  return state;
}

function createWindow() {
  const state = sanitiseBounds(windowState.load(app.getPath('userData')));

  const options = {
    width: state.width,
    height: state.height,
    x: state.x,
    y: state.y,
    minWidth: 960,
    minHeight: 640,
    show: false,
    backgroundColor: nativeTheme.shouldUseDarkColors ? '#0f1014' : '#f5f6f8',
    title: 'FinFolio',
    icon: path.join(__dirname, '..', '..', 'build', 'icon.png'),
    autoHideMenuBar: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: overlayFor('system'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: true,
      devTools: true,
    },
  };

  try {
    mainWindow = new BrowserWindow(options);
  } catch (err) {
    // The custom title bar is the only exotic option here; without it the app
    // still works, so fall back rather than fail to start.
    warn('window creation failed — retrying with a standard title bar', err);
    delete options.titleBarStyle;
    delete options.titleBarOverlay;
    mainWindow = new BrowserWindow(options);
  }
  note('window created');

  if (state.maximized) mainWindow.maximize();

  /* ---- make sure the window actually becomes visible ---- */

  let shown = false;
  const reveal = (why) => {
    if (shown || !mainWindow || mainWindow.isDestroyed()) return;
    shown = true;
    note(`showing the window (${why})`);
    mainWindow.show();
    mainWindow.focus();
    if (isDev) mainWindow.webContents.openDevTools({ mode: 'detach' });
  };

  mainWindow.once('ready-to-show', () => reveal('ready-to-show'));
  mainWindow.webContents.once('did-finish-load', () => reveal('did-finish-load'));
  // Last resort: an app the user launched must never stay invisible.
  setTimeout(() => reveal('startup timeout'), 4000);

  /* ---- surface load and crash failures instead of hanging ---- */

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url, isMainFrame) => {
    warn(`page failed to load (${code} ${description}) ${url}`);
    if (!isMainFrame) return;
    reveal('load failure');
    dialog.showErrorBox(
      'FinFolio could not load its interface',
      `${description} (${code})\n\n${url}\n\nA log is at:\n${logPath()}`
    );
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    warn(`renderer gone: ${details.reason}`);
    dialog.showErrorBox(
      'FinFolio stopped unexpectedly',
      `The interface closed (${details.reason}).\n\nA log is at:\n${logPath()}`
    );
  });

  mainWindow.webContents.on('preload-error', (_event, preloadPath, error) => {
    warn(`preload failed at ${preloadPath}`, error);
  });

  mainWindow.webContents.on('console-message', (_event, level, message) => {
    if (level >= 2) warn(`renderer console: ${message}`);
  });

  /* ---- ordinary wiring ---- */

  const persist = () => windowState.save(app.getPath('userData'), mainWindow);
  mainWindow.on('resize', debounce(persist, 400));
  mainWindow.on('move', debounce(persist, 400));
  mainWindow.on('close', persist);

  const emitWindowState = () => {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('window:state', {
      maximized: mainWindow.isMaximized(),
      focused: mainWindow.isFocused(),
      fullScreen: mainWindow.isFullScreen(),
    });
  };
  for (const ev of ['maximize', 'unmaximize', 'focus', 'blur', 'enter-full-screen', 'leave-full-screen']) {
    mainWindow.on(ev, emitWindowState);
  }

  // External links always open in the system browser, never in-app.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(APP_ORIGIN)) {
      event.preventDefault();
      if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.loadURL(`${APP_ORIGIN}/index.html`);
  return mainWindow;
}

function logPath() {
  try {
    return log ? log.transports.file.getFile().path : path.join(app.getPath('userData'), 'logs');
  } catch {
    return path.join(app.getPath('userData'), 'logs');
  }
}

function debounce(fn, ms) {
  let t = null;
  return (...args) => {
    clearTimeout(t);
    t = setTimeout(() => fn(...args), ms);
  };
}

/* ------------------------------------------------------------------ */
/* Watching the data file                                              */
/*                                                                     */
/* When the document lives in a synced folder, another computer can    */
/* rewrite it while this one is open. Polling (rather than fs.watch) is */
/* deliberate: cloud-sync clients replace files in ways that native    */
/* watchers miss, and a five-second poll costs nothing.                */
/* ------------------------------------------------------------------ */

let watchedPath = null;
let watchTimer = null;

function watchDataFile() {
  if (watchTimer) {
    clearInterval(watchTimer);
    watchTimer = null;
  }
  if (!store) return;
  watchedPath = store.file;
  watchTimer = setInterval(async () => {
    if (!store || !store.doc || !mainWindow || mainWindow.isDestroyed()) return;
    if (store.file !== watchedPath) {
      watchDataFile();
      return;
    }
    try {
      if (await store.hasChangedElsewhere()) {
        mainWindow.webContents.send('data:external-change', {
          path: store.file,
          at: new Date().toISOString(),
        });
      }
    } catch {
      /* the folder may be briefly unavailable while the cloud client syncs */
    }
  }, 5000);
}

/* ------------------------------------------------------------------ */

app.whenReady().then(() => {
  note('electron ready');
  registerAppProtocol();

  // Constructing the store only joins paths; nothing touches the disk yet.
  store = new Store(app.getPath('userData'), app.getVersion());

  // The window comes first so the app is on screen no matter what storage does.
  createWindow();

  registerIpc({
    store,
    ready: storeReady,
    getStoreError: () => storeError,
    getWindow: () => mainWindow,
    isDev,
    restartWatcher: () => watchDataFile(),
    applyTitleBarTheme(theme) {
      if (mainWindow && !mainWindow.isDestroyed() && process.platform === 'win32') {
        try {
          mainWindow.setTitleBarOverlay(overlayFor(theme));
        } catch {
          /* older Windows builds, or a window without the custom title bar */
        }
      }
    },
  });

  buildMenu({ getWindow: () => mainWindow, isDev });

  // Now the slow part, with a time limit so a stalled network folder cannot
  // leave the interface waiting forever.
  const guard = setTimeout(() => {
    storeError = 'SLOW_STORAGE';
    warn(`storage is taking a long time (${app.getPath('userData')}) — releasing the interface`);
    markStoreReady();
  }, 12000);

  store
    .init()
    .then((info) => {
      note('storage ready', info);
      watchDataFile();
    })
    .catch((err) => {
      storeError = String((err && err.message) || err);
      warn('storage could not be initialised', err);
    })
    .finally(() => {
      clearTimeout(guard);
      markStoreReady();
    });

  updater.init({
    send: (payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('updates:event', payload);
      }
    },
    // Real preferences are applied by the renderer once settings are loaded.
    autoCheck: true,
    autoDownload: false,
  });

  nativeTheme.on('updated', () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('theme:system', {
        dark: nativeTheme.shouldUseDarkColors,
      });
    }
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  app.quit();
});

// A quit-time backup is a cheap insurance policy; failures must never block exit.
let quitBackupDone = false;
app.on('before-quit', async (event) => {
  if (quitBackupDone || !store || !store.doc) return;
  const settings = (store.doc && store.doc.settings) || {};
  if (!settings.backupOnQuit) {
    quitBackupDone = true;
    return;
  }
  event.preventDefault();
  quitBackupDone = true;
  try {
    await store.autoBackup(settings.backupKeep || 20);
  } catch (err) {
    warn('quit-time backup failed', err);
  }
  app.quit();
});

process.on('uncaughtException', (err) => {
  warn('uncaught exception in the main process', err);
  try {
    dialog.showErrorBox(
      'FinFolio encountered a problem',
      `${String((err && err.stack) || err)}\n\nA log is at:\n${logPath()}`
    );
  } catch {
    /* ignore */
  }
});
