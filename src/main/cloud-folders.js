'use strict';
/**
 * Finding the cloud-sync folders that actually exist on this computer.
 *
 * Guessing `%USERPROFILE%\OneDrive` is not good enough in practice:
 *
 *  - A work or school OneDrive is named after the organisation
 *    (`OneDrive - Hancock County Schools`), and Windows publishes the real path
 *    in the `OneDrive`, `OneDriveCommercial` and `OneDriveConsumer` variables.
 *  - Google Drive for Desktop mounts a *virtual drive letter* — `G:\My Drive` —
 *    not a folder in the user profile. The old "Backup and Sync" layout
 *    (`~\Google Drive`) still exists on older machines.
 *  - Dropbox records its real locations in `%LOCALAPPDATA%\Dropbox\info.json`,
 *    which is authoritative when someone has moved the folder.
 *  - macOS puts all of them under `~/Library/CloudStorage`.
 *
 * Every dependency is injected so this can be tested against a fake layout.
 */

const fsp = require('node:fs/promises');
const path = require('node:path');

const SUBFOLDER = 'FinFolio';

async function directoryExists(dir) {
  try {
    const stat = await fsp.stat(dir);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * @param {object} deps
 * @param {string} deps.home
 * @param {NodeJS.ProcessEnv} [deps.env]
 * @param {string} [deps.platform]
 * @param {(dir:string)=>Promise<boolean>} [deps.exists]
 * @param {(file:string)=>Promise<object|null>} [deps.readJsonFile]
 * @param {string[]} [deps.driveLetters]
 * @returns {Promise<{id:string,label:string,root:string,suggested:string}[]>}
 */
async function detectCloudFolders({
  home,
  env = process.env,
  platform = process.platform,
  exists = directoryExists,
  readJsonFile = readJson,
  driveLetters = 'DEFGHIJKLMNOPQRSTUVWXYZ'.split(''),
} = {}) {
  // Parse paths with the rules of the target platform, not the running one, so
  // Windows layouts can be exercised from a test on any machine.
  const P = platform === 'win32' ? path.win32 : path.posix;

  const found = [];
  const seen = new Set();

  const add = (id, label, root) => {
    if (!root) return;
    const key = P.resolve(root).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ id, label, root, suggested: P.join(root, SUBFOLDER) });
  };

  const addIfExists = async (id, label, root) => {
    if (!root) return;
    if (seen.has(P.resolve(root).toLowerCase())) return;
    if (await exists(root)) add(id, label, root);
  };

  /* ------------------------------ OneDrive ------------------------ */
  // The environment variables are what Windows itself uses, so they are
  // correct even when the folder has been renamed or relocated.
  await addIfExists('onedrive-business', labelFor(env.OneDriveCommercial, 'OneDrive for work or school', P), env.OneDriveCommercial);
  await addIfExists('onedrive-personal', labelFor(env.OneDriveConsumer, 'OneDrive', P), env.OneDriveConsumer);
  await addIfExists('onedrive', labelFor(env.OneDrive, 'OneDrive', P), env.OneDrive);

  /* ------------------------------ Dropbox ------------------------- */
  const dropboxInfo =
    (await readJsonFile(P.join(env.LOCALAPPDATA || P.join(home, 'AppData', 'Local'), 'Dropbox', 'info.json'))) ||
    (await readJsonFile(P.join(env.APPDATA || P.join(home, 'AppData', 'Roaming'), 'Dropbox', 'info.json')));
  if (dropboxInfo && typeof dropboxInfo === 'object') {
    for (const [account, details] of Object.entries(dropboxInfo)) {
      if (details && typeof details.path === 'string') {
        await addIfExists(`dropbox-${account}`, account === 'business' ? 'Dropbox (Business)' : 'Dropbox', details.path);
      }
    }
  }

  /* ---------------------------- home folders ---------------------- */
  const homeCandidates = [
    ['dropbox', 'Dropbox', P.join(home, 'Dropbox')],
    ['google-drive', 'Google Drive', P.join(home, 'Google Drive')],
    ['google-mydrive', 'Google Drive', P.join(home, 'My Drive')],
    ['icloud', 'iCloud Drive', P.join(home, 'iCloudDrive')],
    ['icloud-mac', 'iCloud Drive', P.join(home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs')],
    ['onedrive-home', 'OneDrive', P.join(home, 'OneDrive')],
  ];
  for (const [id, label, dir] of homeCandidates) await addIfExists(id, label, dir);

  // Work OneDrive and macOS CloudStorage folders are named per organisation.
  for (const [parent, matcher] of [
    [home, (name) => /^OneDrive\s*-\s*.+/i.test(name)],
    [P.join(home, 'Library', 'CloudStorage'), () => true],
  ]) {
    let entries = [];
    try {
      entries = await fsp.readdir(parent);
    } catch {
      entries = [];
    }
    for (const name of entries) {
      if (!matcher(name)) continue;
      await addIfExists(`named-${name}`, prettyCloudName(name), P.join(parent, name));
    }
  }

  /* --------------------- Google Drive virtual drive --------------- */
  // Google Drive for Desktop streams files from a drive letter; the folder the
  // user thinks of as "Google Drive" is <letter>:\My Drive.
  if (platform === 'win32') {
    for (const letter of driveLetters) {
      const myDrive = P.join(`${letter}:${P.sep}`, 'My Drive');
      if (await exists(myDrive)) add(`google-${letter}`, `Google Drive (${letter}:)`, myDrive);
    }
  }

  return found;
}

function labelFor(dir, fallback, P = path) {
  if (!dir) return fallback;
  const base = P.basename(dir);
  return /^OneDrive\s*-\s*.+/i.test(base) ? base : fallback;
}

/** "OneDrive-HancockCountySchools" → "OneDrive - Hancock County Schools" */
function prettyCloudName(name) {
  const parts = name.split('-');
  if (parts.length < 2) return name;
  const provider = parts[0].trim();
  const account = parts.slice(1).join('-').trim();
  const spaced = account.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return `${provider} - ${spaced}`;
}

module.exports = { detectCloudFolders, directoryExists, SUBFOLDER };
