'use strict';
/**
 * Auto-update against GitHub Releases (Sbreland18/finfolio).
 *
 * electron-updater reads the `publish` block in electron-builder.yml, so no
 * feed URL is hard-coded here. Every state change is forwarded to the renderer
 * on the `updates:event` channel and surfaced in the UI.
 */

const { app } = require('electron');

let autoUpdater = null;
let log = null;
try {
  ({ autoUpdater } = require('electron-updater'));
  log = require('electron-log');
} catch {
  /* dependencies missing (e.g. running from source without npm install) */
}

let sendToUI = () => {};
let state = { status: 'idle', info: null, progress: null, error: null };
let wired = false;

function setState(patch) {
  state = { ...state, ...patch };
  sendToUI({ ...state, currentVersion: app.getVersion() });
}

function available() {
  return !!autoUpdater && app.isPackaged;
}

function init({ send, autoCheck = true, autoDownload = false }) {
  sendToUI = typeof send === 'function' ? send : () => {};

  if (!available()) {
    setState({
      status: app.isPackaged ? 'unsupported' : 'dev',
      error: null,
    });
    return;
  }

  if (!wired) {
    wired = true;
    if (log) {
      log.transports.file.level = 'info';
      autoUpdater.logger = log;
    }
    autoUpdater.autoDownload = !!autoDownload;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;

    autoUpdater.on('checking-for-update', () => setState({ status: 'checking', error: null }));
    autoUpdater.on('update-available', (info) =>
      setState({ status: 'available', info: pick(info), error: null })
    );
    autoUpdater.on('update-not-available', (info) =>
      setState({ status: 'current', info: pick(info), error: null })
    );
    autoUpdater.on('download-progress', (p) =>
      setState({
        status: 'downloading',
        progress: {
          percent: Math.round(p.percent || 0),
          transferred: p.transferred,
          total: p.total,
          bytesPerSecond: p.bytesPerSecond,
        },
      })
    );
    autoUpdater.on('update-downloaded', (info) =>
      setState({ status: 'downloaded', info: pick(info), progress: null, error: null })
    );
    autoUpdater.on('error', (err) =>
      setState({ status: 'error', error: String((err && err.message) || err) })
    );
  }

  autoUpdater.autoDownload = !!autoDownload;

  if (autoCheck) {
    // Give the window a moment to finish loading before the first check.
    setTimeout(() => {
      check().catch(() => {});
    }, 4000);
    // And re-check every 6 hours for long-running sessions.
    setInterval(() => {
      check().catch(() => {});
    }, 6 * 60 * 60 * 1000);
  }
}

function pick(info) {
  if (!info) return null;
  return {
    version: info.version,
    releaseDate: info.releaseDate,
    releaseName: info.releaseName || null,
    releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
  };
}

async function check() {
  if (!available()) {
    setState({ status: app.isPackaged ? 'unsupported' : 'dev' });
    return getState();
  }
  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    setState({ status: 'error', error: String((err && err.message) || err) });
  }
  return getState();
}

async function download() {
  if (!available()) return getState();
  try {
    setState({ status: 'downloading', progress: { percent: 0 } });
    await autoUpdater.downloadUpdate();
  } catch (err) {
    setState({ status: 'error', error: String((err && err.message) || err) });
  }
  return getState();
}

function install() {
  if (!available()) return false;
  try {
    // isSilent = false so the user sees the installer; isForceRunAfter = true
    setImmediate(() => autoUpdater.quitAndInstall(false, true));
    return true;
  } catch {
    return false;
  }
}

function setAutoDownload(v) {
  if (autoUpdater) autoUpdater.autoDownload = !!v;
}

function getState() {
  return { ...state, currentVersion: app.getVersion() };
}

module.exports = { init, check, download, install, getState, setAutoDownload };
