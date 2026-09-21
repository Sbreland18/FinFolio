'use strict';
/**
 * The complete IPC surface. Every channel is request/response via
 * `ipcMain.handle`, except a few push events sent from main -> renderer.
 * Nothing here trusts the renderer with a file path it did not obtain from a
 * dialog or from the store itself.
 */

const { ipcMain, app, dialog, shell, nativeTheme, clipboard } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const os = require('node:os');

const updater = require('./updater');
const { scorePassword } = require('./crypto');
const { mergeDocuments, compareDocuments } = require('./merge');
const { detectCloudFolders } = require('./cloud-folders');

function registerIpc({
  store,
  getWindow,
  isDev,
  applyTitleBarTheme,
  restartWatcher = () => {},
  ready = Promise.resolve(),
  getStoreError = () => null,
}) {
  const win = () => getWindow();

  // Handlers are registered before storage has finished starting, so the window
  // can appear immediately. Anything that touches the document waits here;
  // window, theme and app calls stay instant.
  const needsStorage = (channel) => /^(data|backup|file):/.test(channel);

  const handle = (channel, fn) => {
    ipcMain.removeHandler(channel);
    ipcMain.handle(channel, async (_event, payload) => {
      try {
        if (needsStorage(channel)) await ready;
        return await fn(payload || {});
      } catch (err) {
        return { ok: false, error: String((err && err.message) || err) };
      }
    });
  };

  /* ------------------------------------------------------ app ------ */

  handle('app:info', async () => ({
    ok: true,
    version: app.getVersion(),
    name: 'FinFolio',
    platform: process.platform,
    arch: process.arch,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    isDev,
    isPackaged: app.isPackaged,
    userData: app.getPath('userData'),
    documents: app.getPath('documents'),
    hostname: os.hostname(),
    repo: 'https://github.com/Sbreland18/finfolio',
  }));

  /* ----------------------------------------------------- data ------ */

  handle('data:status', async () => ({ ...(await store.status()), storeError: getStoreError() }));

  handle('data:load', ({ password }) => store.load(password ?? null));

  handle('data:save', ({ doc, force }) => store.save(doc, { force: !!force }));

  /* --------------------------------------------- sync / merging ---- */

  handle('data:peek', () => store.peek());

  /** Re-read from disk using the password already held in memory. */
  handle('data:reload', () => store.load(store.password));

  handle('data:changedElsewhere', async () => ({
    ok: true,
    changed: await store.hasChangedElsewhere(),
  }));

  /** Merge the in-memory document with whatever is on disk right now. */
  handle('data:mergeWithDisk', async ({ doc }) => {
    const remote = await store.peek();
    if (!remote.ok) return remote;
    const merged = mergeDocuments(doc, remote.doc);
    if (!merged.ok) return merged;
    return { ok: true, doc: merged.doc, stats: merged.stats };
  });

  /** Merge the in-memory document with one supplied by the renderer. */
  handle('data:mergeWith', ({ doc, other }) => mergeDocuments(doc, other));

  handle('data:compare', ({ doc, other }) => compareDocuments(doc, other));

  /* -------------------------------------------- data location ----- */

  handle('data:pickFolder', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win(), {
      title: 'Choose a folder for your FinFolio data',
      buttonLabel: 'Use this folder',
      defaultPath: app.getPath('home'),
      properties: ['openDirectory', 'createDirectory'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, error: 'CANCELED' };
    return { ok: true, dir: filePaths[0] };
  });

  handle('data:inspectLocation', ({ dir, create }) => store.inspectLocation(dir, { create: !!create }));

  handle('data:setLocation', async ({ dir, mode }) => {
    const res = await store.setLocation(dir, mode === 'adopt' ? 'adopt' : 'move');
    if (res.ok) restartWatcher();
    return res;
  });

  handle('data:resetLocation', async () => {
    const res = await store.resetLocation();
    if (res.ok) restartWatcher();
    return res;
  });

  /** Cloud folders that really exist on this computer, detected not guessed. */
  handle('data:suggestFolders', async () => {
    const folders = await detectCloudFolders({ home: app.getPath('home') });
    return {
      ok: true,
      // `dir` is the folder FinFolio would use; it is created on demand, so it
      // does not have to exist yet.
      folders: folders.map((f) => ({ label: f.label, dir: f.suggested, root: f.root })),
    };
  });

  handle('data:lock', () => {
    store.lock();
    return { ok: true };
  });

  handle('data:setPassword', async ({ password }) => {
    const res = await store.setPassword(password || null);
    return res;
  });

  handle('data:verifyPassword', ({ password }) => store.verifyPassword(password ?? null));

  handle('data:scorePassword', ({ password }) => ({ ok: true, ...scorePassword(password) }));

  handle('data:reveal', async () => {
    const st = await store.status();
    shell.showItemInFolder(st.path);
    return { ok: true };
  });

  /* --------------------------------------------------- backups ----- */

  handle('backup:now', async ({ keep } = {}) => store.autoBackup(keep || 20));

  /* ------------------------ cloud backup copies -------------------- */

  handle('backup:testFolder', ({ dir, create }) =>
    store.ensureWritableFolder(dir, { create: !!create })
  );

  handle('backup:mirrorStatus', () => store.mirrorStatus());

  handle('backup:syncMirror', ({ keep } = {}) => store.syncMirror(keep || 20));

  handle('backup:openMirror', async () => {
    const dir = store.mirrorDir;
    if (!dir) return { ok: false, error: 'NOT_CONFIGURED' };
    await fsp.mkdir(dir, { recursive: true }).catch(() => {});
    shell.openPath(dir);
    return { ok: true };
  });

  /** Cloud folders offered for the backup copy — same detection as for syncing. */
  handle('backup:suggestFolders', async () => {
    const folders = await detectCloudFolders({ home: app.getPath('home') });
    return {
      ok: true,
      folders: folders.map((f) => ({
        label: f.label,
        dir: path.join(f.root, 'FinFolio Backups'),
        root: f.root,
      })),
    };
  });

  handle('backup:list', async () => ({ ok: true, items: await store.listBackups() }));

  handle('backup:openFolder', async () => {
    const st = await store.status();
    await fsp.mkdir(st.backupDir, { recursive: true });
    shell.openPath(st.backupDir);
    return { ok: true };
  });

  handle('backup:delete', async ({ file }) => {
    const st = await store.status();
    const resolved = path.resolve(file || '');
    if (!resolved.startsWith(path.resolve(st.backupDir))) {
      return { ok: false, error: 'OUTSIDE_BACKUP_FOLDER' };
    }
    await fsp.unlink(resolved);
    return { ok: true };
  });

  handle('backup:export', async ({ password, defaultName } = {}) => {
    const stamp = new Date().toISOString().slice(0, 10);
    const suggested = defaultName || `FinFolio-Backup-${stamp}.finbak`;
    const { canceled, filePath } = await dialog.showSaveDialog(win(), {
      title: 'Export FinFolio backup',
      defaultPath: path.join(app.getPath('documents'), suggested),
      filters: [
        { name: 'FinFolio backup', extensions: ['finbak'] },
        { name: 'JSON', extensions: ['json'] },
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (canceled || !filePath) return { ok: false, error: 'CANCELED' };
    const env = await store.makeBackupEnvelope({ password });
    await fsp.writeFile(filePath, JSON.stringify(env, null, env.encrypted ? 0 : 2), 'utf8');
    return { ok: true, file: filePath, encrypted: env.encrypted };
  });

  handle('backup:pick', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win(), {
      title: 'Choose a FinFolio backup',
      defaultPath: app.getPath('documents'),
      filters: [
        { name: 'FinFolio backup', extensions: ['finbak', 'json'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, error: 'CANCELED' };
    return { ok: true, file: filePaths[0] };
  });

  handle('backup:read', async ({ file, password }) =>
    store.readBackupFile(file, password ?? null)
  );

  handle('backup:restore', async ({ doc }) => store.restoreDocument(doc));

  /* ------------------------------------------------------ files ---- */

  handle('file:openText', async ({ filters, title } = {}) => {
    const { canceled, filePaths } = await dialog.showOpenDialog(win(), {
      title: title || 'Open file',
      filters: filters || [
        { name: 'Statements', extensions: ['csv', 'ofx', 'qfx', 'qif', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['openFile'],
    });
    if (canceled || !filePaths || !filePaths[0]) return { ok: false, error: 'CANCELED' };
    const file = filePaths[0];
    const stat = await fsp.stat(file);
    if (stat.size > 64 * 1024 * 1024) return { ok: false, error: 'FILE_TOO_LARGE' };
    const content = await fsp.readFile(file, 'utf8');
    return { ok: true, file, name: path.basename(file), content, size: stat.size };
  });

  handle('file:saveText', async ({ content, defaultName, filters, title } = {}) => {
    const { canceled, filePath } = await dialog.showSaveDialog(win(), {
      title: title || 'Save file',
      defaultPath: path.join(app.getPath('documents'), defaultName || 'export.csv'),
      filters: filters || [
        { name: 'CSV', extensions: ['csv'] },
        { name: 'All files', extensions: ['*'] },
      ],
      properties: ['createDirectory', 'showOverwriteConfirmation'],
    });
    if (canceled || !filePath) return { ok: false, error: 'CANCELED' };
    await fsp.writeFile(filePath, String(content ?? ''), 'utf8');
    return { ok: true, file: filePath };
  });

  handle('file:openPath', async ({ file }) => {
    await shell.openPath(file);
    return { ok: true };
  });

  handle('clipboard:write', ({ text }) => {
    clipboard.writeText(String(text ?? ''));
    return { ok: true };
  });

  /* ------------------------------------------------------ shell ---- */

  handle('shell:openExternal', async ({ url }) => {
    if (!/^https?:\/\//i.test(String(url || ''))) return { ok: false, error: 'BLOCKED' };
    await shell.openExternal(url);
    return { ok: true };
  });

  /* ----------------------------------------------------- window ---- */

  handle('window:minimize', () => {
    win()?.minimize();
    return { ok: true };
  });

  handle('window:toggleMaximize', () => {
    const w = win();
    if (!w) return { ok: false };
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    return { ok: true, maximized: w.isMaximized() };
  });

  handle('window:close', () => {
    win()?.close();
    return { ok: true };
  });

  handle('window:state', () => {
    const w = win();
    return {
      ok: true,
      maximized: !!w && w.isMaximized(),
      focused: !!w && w.isFocused(),
    };
  });

  /* ------------------------------------------------------ theme ---- */

  handle('theme:apply', ({ theme }) => {
    const value = ['light', 'dark', 'system'].includes(theme) ? theme : 'system';
    nativeTheme.themeSource = value;
    applyTitleBarTheme(value);
    return { ok: true, dark: nativeTheme.shouldUseDarkColors };
  });

  /* ---------------------------------------------------- updates ---- */

  handle('updates:state', () => ({ ok: true, ...updater.getState() }));
  handle('updates:check', async () => ({ ok: true, ...(await updater.check()) }));
  handle('updates:download', async () => ({ ok: true, ...(await updater.download()) }));
  handle('updates:install', () => ({ ok: updater.install() }));
  handle('updates:prefs', ({ autoDownload }) => {
    updater.setAutoDownload(!!autoDownload);
    return { ok: true };
  });

  /* ------------------------------------------------------ misc ----- */

  handle('log:error', ({ message, stack }) => {
    // Renderer-side crashes surface in the terminal during development and in
    // electron-log's file transport in production.
    try {
      require('electron-log').error(`[renderer] ${message}\n${stack || ''}`);
    } catch {
      console.error('[renderer]', message, stack);
    }
    return { ok: true };
  });
}

module.exports = { registerIpc };
