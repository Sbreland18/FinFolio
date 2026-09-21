'use strict';
/**
 * Durable, crash-safe persistence for the FinFolio document.
 *
 * Writes are atomic: content goes to a temp file, is fsync'd, then renamed over
 * the live file. The previous good copy is kept as data.prev.json, so even a
 * power cut mid-write leaves two recoverable versions on disk.
 *
 * The document can live anywhere — pointing it at a OneDrive/Dropbox/Drive
 * folder is how FinFolio syncs between computers. Because two machines can then
 * write the same file, every save first checks that the file on disk is still
 * the one we loaded; if it is not, the save is refused with CONFLICT and the
 * interface offers to merge.
 */

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { encryptJSON, decryptJSON, isEncrypted } = require('./crypto');
const { migrate, emptyDocument, looksLikeDocument } = require('./schema');

const LOCATION_FILE = 'location.json';

class Store {
  constructor(userDataPath, appVersion = '0.0.0') {
    this.userDataPath = userDataPath;
    this.appVersion = appVersion;
    this.password = null; // held in memory only while unlocked
    this.doc = null;
    this._writing = Promise.resolve();
    // Signature of the file as we last read or wrote it, used to spot writes
    // made by another computer.
    this.knownSignature = null;
    // Set when a configured shared folder could not be reached at startup.
    this.locationUnavailable = null;
    this._useDir(userDataPath);
  }

  _useDir(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'data.json');
    this.prevFile = path.join(dir, 'data.prev.json');
    this.tmpFile = path.join(dir, 'data.tmp.json');
    this.backupDir = path.join(dir, 'backups');
  }

  get locationFile() {
    return path.join(this.userDataPath, LOCATION_FILE);
  }

  async init() {
    await fsp.mkdir(this.userDataPath, { recursive: true });
    // The pointer to the data folder always stays on this computer.
    let dir = this.userDataPath;
    try {
      const raw = JSON.parse(await fsp.readFile(this.locationFile, 'utf8'));
      if (raw && typeof raw.dataDir === 'string' && raw.dataDir.trim()) {
        await fsp.access(raw.dataDir, fs.constants.W_OK);
        dir = raw.dataDir;
      }
    } catch {
      /* no pointer, or the folder is gone — fall back to the default */
    }
    this._useDir(dir);

    try {
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.mkdir(this.backupDir, { recursive: true });
    } catch (err) {
      // A shared folder can be offline (laptop away from the network, cloud
      // client not signed in). Falling back to this computer's own folder keeps
      // FinFolio usable; the pointer is left alone so it reconnects later.
      if (dir === this.userDataPath) throw err;
      this.locationUnavailable = { dir, reason: String((err && err.code) || err) };
      this._useDir(this.userDataPath);
      await fsp.mkdir(this.dir, { recursive: true });
      await fsp.mkdir(this.backupDir, { recursive: true });
    }

    return {
      dataDir: this.dir,
      isDefault: this.dir === this.userDataPath,
      locationUnavailable: this.locationUnavailable || null,
    };
  }

  /* -------------------------------------------------- state -------- */

  async status() {
    let exists = false;
    let encrypted = false;
    let size = 0;
    let modified = null;
    try {
      const raw = await this._readRaw();
      exists = true;
      encrypted = isEncrypted(raw.parsed);
      size = raw.size;
      modified = raw.modified;
    } catch {
      exists = false;
    }
    return {
      exists,
      encrypted,
      size,
      modified,
      path: this.file,
      dir: this.dir,
      defaultDir: this.userDataPath,
      isDefaultLocation: this.dir === this.userDataPath,
      backupDir: this.backupDir,
      unlocked: this.doc !== null,
      changedElsewhere: await this.hasChangedElsewhere(),
      locationUnavailable: this.locationUnavailable || null,
    };
  }

  /** Cheap fingerprint of the file, used for conflict detection. */
  async signature() {
    try {
      const st = await fsp.stat(this.file);
      return `${Math.round(st.mtimeMs)}:${st.size}`;
    } catch {
      return null;
    }
  }

  /** True when the file on disk is not the one this session last read/wrote. */
  async hasChangedElsewhere() {
    if (this.knownSignature === null) return false;
    const now = await this.signature();
    return now !== null && now !== this.knownSignature;
  }

  async _readRaw() {
    const stat = await fsp.stat(this.file);
    const text = await fsp.readFile(this.file, 'utf8');
    return { parsed: JSON.parse(text), size: stat.size, modified: stat.mtime.toISOString() };
  }

  /* -------------------------------------------------- load --------- */

  /**
   * @returns {{ok:true, doc:object, created?:boolean}|{ok:false, error:string}}
   */
  async load(password) {
    let parsed = null;
    try {
      parsed = (await this._readRaw()).parsed;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        // Try to recover from the previous-good copy before starting fresh.
        try {
          parsed = JSON.parse(await fsp.readFile(this.prevFile, 'utf8'));
        } catch {
          const doc = emptyDocument();
          doc.meta.appVersion = this.appVersion;
          this.doc = doc;
          this.password = null;
          await this._write(doc);
          this.knownSignature = await this.signature();
          return { ok: true, doc, created: true };
        }
      } else {
        // Corrupt primary file — fall back to the previous good copy.
        try {
          parsed = JSON.parse(await fsp.readFile(this.prevFile, 'utf8'));
        } catch {
          return { ok: false, error: 'CORRUPT' };
        }
      }
    }

    if (isEncrypted(parsed)) {
      if (password == null) return { ok: false, error: 'PASSWORD_REQUIRED' };
      let plain;
      try {
        plain = await decryptJSON(parsed, password);
      } catch (err) {
        return { ok: false, error: err.message === 'BAD_PASSWORD' ? 'BAD_PASSWORD' : 'CORRUPT' };
      }
      if (!looksLikeDocument(plain)) return { ok: false, error: 'CORRUPT' };
      this.password = String(password);
      this.doc = migrate(plain);
    } else {
      if (!looksLikeDocument(parsed)) return { ok: false, error: 'CORRUPT' };
      this.password = null;
      this.doc = migrate(parsed);
    }

    this.doc.meta.appVersion = this.appVersion;
    this.knownSignature = await this.signature();
    return { ok: true, doc: this.doc };
  }

  /**
   * Read whatever is on disk right now without disturbing the in-memory
   * document — used to merge in another computer's changes.
   */
  async peek() {
    let parsed;
    try {
      parsed = (await this._readRaw()).parsed;
    } catch (err) {
      return { ok: false, error: err && err.code === 'ENOENT' ? 'MISSING' : 'CORRUPT' };
    }
    if (isEncrypted(parsed)) {
      if (this.password == null) return { ok: false, error: 'PASSWORD_REQUIRED' };
      try {
        parsed = await decryptJSON(parsed, this.password);
      } catch (err) {
        return { ok: false, error: err.message === 'BAD_PASSWORD' ? 'BAD_PASSWORD' : 'CORRUPT' };
      }
    }
    if (!looksLikeDocument(parsed)) return { ok: false, error: 'CORRUPT' };
    return { ok: true, doc: migrate(parsed), signature: await this.signature() };
  }

  lock() {
    this.password = null;
    this.doc = null;
    this.knownSignature = null;
  }

  /* -------------------------------------------------- save --------- */

  /**
   * @param {object} doc
   * @param {{force?:boolean}} [options] force skips the conflict check, which
   *        the interface uses after the user has chosen what to keep.
   */
  async save(doc, { force = false } = {}) {
    if (!looksLikeDocument(doc)) return { ok: false, error: 'INVALID' };

    if (!force && (await this.hasChangedElsewhere())) {
      return {
        ok: false,
        error: 'CONFLICT',
        signature: await this.signature(),
        knownSignature: this.knownSignature,
      };
    }

    doc.schemaVersion = require('./schema').SCHEMA_VERSION;
    doc.meta = doc.meta || {};
    doc.meta.updatedAt = new Date().toISOString();
    doc.meta.appVersion = this.appVersion;
    this.doc = doc;
    await this._write(doc);
    this.knownSignature = await this.signature();
    return { ok: true, updatedAt: doc.meta.updatedAt, signature: this.knownSignature };
  }

  /** Serialise writes so two saves can never interleave on the same file. */
  _write(doc) {
    const run = async () => {
      const payload = this.password ? await encryptJSON(doc, this.password) : doc;
      const text = JSON.stringify(payload, null, this.password ? 0 : 2);

      const fh = await fsp.open(this.tmpFile, 'w');
      try {
        await fh.writeFile(text, 'utf8');
        await fh.sync();
      } finally {
        await fh.close();
      }
      // Keep the last good copy before replacing it.
      try {
        await fsp.copyFile(this.file, this.prevFile);
      } catch {
        /* first write — nothing to preserve */
      }
      await fsp.rename(this.tmpFile, this.file);
    };
    this._writing = this._writing.then(run, run);
    return this._writing;
  }

  /* -------------------------------------------------- password ----- */

  /**
   * Turn encryption on, off, or change the password. Requires the document to
   * be unlocked already (it is, whenever the UI is running).
   */
  async setPassword(nextPassword) {
    if (!this.doc) return { ok: false, error: 'LOCKED' };
    this.password = nextPassword ? String(nextPassword) : null;
    await this._write(this.doc);
    this.knownSignature = await this.signature();
    return { ok: true, encrypted: !!this.password };
  }

  async verifyPassword(password) {
    if (this.password == null) return { ok: true, matches: password == null || password === '' };
    return { ok: true, matches: String(password) === this.password };
  }

  /* -------------------------------------------------- backups ------ */

  backupEnvelope(doc, payload, encrypted) {
    return {
      app: 'FinFolio',
      kind: 'backup',
      formatVersion: 1,
      schemaVersion: doc.schemaVersion,
      appVersion: this.appVersion,
      createdAt: new Date().toISOString(),
      encrypted,
      counts: {
        accounts: (doc.accounts || []).length,
        transactions: (doc.transactions || []).length,
        recurring: (doc.recurring || []).length,
        budgets: (doc.budgets || []).length,
        goals: (doc.goals || []).length,
      },
      payload,
    };
  }

  /** Build a .finbak envelope for the current document. */
  async makeBackupEnvelope({ password = undefined } = {}) {
    if (!this.doc) throw new Error('LOCKED');
    // `password === undefined` -> reuse the app password (if any).
    const pw = password === undefined ? this.password : password;
    const payload = pw ? await encryptJSON(this.doc, pw) : this.doc;
    return this.backupEnvelope(this.doc, payload, !!pw);
  }

  /** Write a timestamped automatic backup and prune old ones. */
  async autoBackup(keep = 20) {
    if (!this.doc) return { ok: false, error: 'LOCKED' };
    await fsp.mkdir(this.backupDir, { recursive: true });
    const env = await this.makeBackupEnvelope({});
    const stamp = new Date()
      .toISOString()
      .replace(/[-:]/g, '')
      .replace('T', '-')
      .slice(0, 15);
    const file = path.join(this.backupDir, `finfolio-${stamp}.finbak`);
    await fsp.writeFile(file, JSON.stringify(env), 'utf8');
    await this.pruneBackups(keep);

    // A copy in a cloud folder is the part that survives losing the computer.
    // It must never be able to break the local backup, so failures are reported
    // rather than thrown.
    const mirror = await this.mirrorBackup(file, keep);
    return { ok: true, file, mirror };
  }

  /* ---------------- cloud copies of the backups ------------------- */

  get mirrorDir() {
    const dir = this.doc && this.doc.settings && this.doc.settings.backupMirrorDir;
    return typeof dir === 'string' && dir.trim() ? dir : null;
  }

  /**
   * Copy one backup into the cloud folder, then prune it to the same depth.
   * @returns {{ok:true,file:string}|{ok:false,error:string}|null} null = not configured
   */
  async mirrorBackup(sourceFile, keep = 20) {
    const dir = this.mirrorDir;
    if (!dir) return null;
    try {
      await fsp.mkdir(dir, { recursive: true });
      const target = path.join(dir, path.basename(sourceFile));
      await fsp.copyFile(sourceFile, target);
      await this.pruneFolder(dir, keep);
      return { ok: true, file: target };
    } catch (err) {
      return { ok: false, error: String((err && err.code) || err) };
    }
  }

  /** Bring the cloud folder up to date with every local backup. */
  async syncMirror(keep = 20) {
    const dir = this.mirrorDir;
    if (!dir) return { ok: false, error: 'NOT_CONFIGURED' };
    try {
      await fsp.mkdir(dir, { recursive: true });
      const local = await this.listBackups();
      let copied = 0;
      for (const item of local.slice(0, keep)) {
        const target = path.join(dir, item.name);
        if (fs.existsSync(target)) continue;
        await fsp.copyFile(item.path, target);
        copied += 1;
      }
      await this.pruneFolder(dir, keep);
      return { ok: true, copied, total: (await this.listFolder(dir)).length };
    } catch (err) {
      return { ok: false, error: String((err && err.code) || err) };
    }
  }

  async mirrorStatus() {
    const dir = this.mirrorDir;
    if (!dir) return { ok: true, configured: false };
    let reachable = true;
    let items = [];
    try {
      await fsp.access(dir);
      items = await this.listFolder(dir);
    } catch {
      reachable = false;
    }
    return {
      ok: true,
      configured: true,
      dir,
      reachable,
      count: items.length,
      newest: items.length ? items[0].modified : null,
    };
  }

  async listFolder(dir) {
    try {
      const names = await fsp.readdir(dir);
      const out = [];
      for (const n of names) {
        if (!n.endsWith('.finbak')) continue;
        const full = path.join(dir, n);
        const st = await fsp.stat(full);
        out.push({ name: n, path: full, size: st.size, modified: st.mtime.toISOString() });
      }
      return out.sort((a, b) => (a.modified < b.modified ? 1 : -1));
    } catch {
      return [];
    }
  }

  async pruneFolder(dir, keep = 20) {
    const list = await this.listFolder(dir);
    for (const f of list.slice(Math.max(1, keep))) {
      try {
        await fsp.unlink(f.path);
      } catch {
        /* ignore */
      }
    }
  }

  async listBackups() {
    return this.listFolder(this.backupDir);
  }

  async pruneBackups(keep = 20) {
    const list = await this.listBackups();
    const extra = list.slice(Math.max(1, keep));
    for (const f of extra) {
      try {
        await fsp.unlink(f.path);
      } catch {
        /* ignore */
      }
    }
    return { removed: extra.length };
  }

  /**
   * Read a .finbak (or raw .json export) and return a usable document.
   * @returns {{ok:true, doc:object, info:object}|{ok:false, error:string}}
   */
  async readBackupFile(filePath, password) {
    let raw;
    try {
      raw = JSON.parse(await fsp.readFile(filePath, 'utf8'));
    } catch {
      return { ok: false, error: 'UNREADABLE' };
    }

    let payload = raw;
    let info = { createdAt: null, appVersion: null, counts: null, encrypted: false };
    if (raw && raw.app === 'FinFolio' && raw.kind === 'backup') {
      payload = raw.payload;
      info = {
        createdAt: raw.createdAt,
        appVersion: raw.appVersion,
        counts: raw.counts || null,
        encrypted: !!raw.encrypted,
      };
    }

    if (isEncrypted(payload)) {
      info.encrypted = true;
      if (password == null) return { ok: false, error: 'PASSWORD_REQUIRED', info };
      try {
        payload = await decryptJSON(payload, password);
      } catch (err) {
        return { ok: false, error: err.message === 'BAD_PASSWORD' ? 'BAD_PASSWORD' : 'CORRUPT', info };
      }
    }

    if (!looksLikeDocument(payload)) return { ok: false, error: 'NOT_A_BACKUP', info };
    return { ok: true, doc: migrate(payload), info };
  }

  /** Replace the live document with an imported one (a safety copy is kept). */
  async restoreDocument(doc) {
    if (!looksLikeDocument(doc)) return { ok: false, error: 'INVALID' };
    // Safety net: snapshot whatever is currently on disk first.
    try {
      if (fs.existsSync(this.file)) {
        const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
        await fsp.copyFile(this.file, path.join(this.backupDir, `pre-restore-${stamp}.finbak`));
      }
    } catch {
      /* non-fatal */
    }
    this.doc = migrate(doc);
    await this._write(this.doc);
    this.knownSignature = await this.signature();
    return { ok: true, doc: this.doc };
  }

  /* -------------------------------------------------- location ----- */

  /**
   * Inspect a candidate data folder before committing to it, so the interface
   * can ask the right question ("use the file that is already there, or put
   * this computer's data in it?").
   */
  /**
   * @param {string} dir
   * @param {{create?:boolean}} [options] create makes the folder when it is
   *        missing, which is what the suggested cloud folders need — they point
   *        at a "FinFolio" subfolder that has never existed before.
   */
  /**
   * Confirm a folder exists (creating it on request) and can really be written
   * to. `fs.access(W_OK)` lies about directories on Windows and is meaningless
   * on the virtual filesystems cloud clients use, so this writes a probe file.
   */
  async ensureWritableFolder(dir, { create = false } = {}) {
    const target = path.resolve(String(dir || ''));
    if (!target || target === path.parse(target).root) {
      return { ok: false, error: 'NOT_A_FOLDER' };
    }

    let stat = null;
    try {
      stat = await fsp.stat(target);
    } catch {
      stat = null;
    }
    if (stat && !stat.isDirectory()) return { ok: false, error: 'NOT_A_FOLDER' };

    if (!stat) {
      if (!create) return { ok: false, error: 'MISSING' };
      try {
        await fsp.mkdir(target, { recursive: true });
      } catch (err) {
        return { ok: false, error: 'CANNOT_CREATE', detail: String((err && err.code) || err) };
      }
    }

    const probe = path.join(target, `.finfolio-write-test-${process.pid}`);
    try {
      await fsp.writeFile(probe, 'ok');
      await fsp.unlink(probe);
    } catch (err) {
      return { ok: false, error: 'UNWRITABLE', detail: String((err && err.code) || err) };
    }
    return { ok: true, dir: target };
  }

  async inspectLocation(dir, { create = false } = {}) {
    const target = path.resolve(String(dir || ''));
    if (target === path.resolve(this.dir)) return { ok: false, error: 'SAME_FOLDER' };

    const writable = await this.ensureWritableFolder(target, { create });
    if (!writable.ok) return writable;

    const candidate = path.join(target, 'data.json');
    let existing = null;
    try {
      const st = await fsp.stat(candidate);
      const parsed = JSON.parse(await fsp.readFile(candidate, 'utf8'));
      const encrypted = isEncrypted(parsed);
      existing = {
        size: st.size,
        modified: st.mtime.toISOString(),
        encrypted,
        counts: encrypted
          ? null
          : {
              accounts: (parsed.accounts || []).length,
              transactions: (parsed.transactions || []).length,
            },
      };
    } catch {
      existing = null;
    }
    return { ok: true, dir: target, existing };
  }

  /**
   * Point FinFolio at another folder.
   * @param {string} dir
   * @param {'move'|'adopt'} mode  move = take this computer's data along,
   *                               adopt = use the file already in that folder.
   */
  async setLocation(dir, mode = 'move') {
    const inspected = await this.inspectLocation(dir, { create: true });
    if (!inspected.ok) return inspected;
    const target = inspected.dir;
    const previousDir = this.dir;

    if (mode === 'adopt') {
      if (!inspected.existing) return { ok: false, error: 'NOTHING_TO_ADOPT' };
    } else {
      // Copy this computer's data across before switching.
      try {
        await fsp.mkdir(path.join(target, 'backups'), { recursive: true });
        if (fs.existsSync(this.file)) {
          if (inspected.existing) {
            // Never silently destroy a file that is already there.
            const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
            await fsp.rename(path.join(target, 'data.json'), path.join(target, `data.replaced-${stamp}.json`));
          }
          await fsp.copyFile(this.file, path.join(target, 'data.json'));
        }
        for (const name of await safeReadDir(this.backupDir)) {
          if (!name.endsWith('.finbak')) continue;
          const to = path.join(target, 'backups', name);
          if (!fs.existsSync(to)) await fsp.copyFile(path.join(this.backupDir, name), to);
        }
      } catch (err) {
        return { ok: false, error: 'COPY_FAILED', detail: String(err && err.message) };
      }
    }

    await fsp.writeFile(this.locationFile, JSON.stringify({ dataDir: target }, null, 2), 'utf8');
    this._useDir(target);
    await fsp.mkdir(this.backupDir, { recursive: true });
    this.knownSignature = null;

    // Leave the old copy behind but clearly superseded, so nothing is lost and
    // nothing is mistaken for live data.
    if (mode === 'move' && previousDir !== target) {
      try {
        const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
        const old = path.join(previousDir, 'data.json');
        if (fs.existsSync(old)) {
          await fsp.rename(old, path.join(previousDir, `data.moved-${stamp}.json`));
        }
      } catch {
        /* non-fatal */
      }
    }

    const loaded = await this.load(this.password);
    if (!loaded.ok) return { ok: false, error: loaded.error, dir: target };
    return { ok: true, dir: target, doc: loaded.doc, mode };
  }

  /** Go back to storing data in this computer's own app-data folder. */
  async resetLocation() {
    return this.setLocation(this.userDataPath, 'move').catch(() => ({ ok: false, error: 'FAILED' }));
  }
}

async function safeReadDir(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

module.exports = { Store };
