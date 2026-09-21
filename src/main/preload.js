'use strict';
/**
 * The only bridge between the renderer and Node. Context isolation is on and
 * node integration is off, so the renderer can reach exactly the calls listed
 * below and nothing else.
 */

const { contextBridge, ipcRenderer } = require('electron');

const invoke = (channel, payload) => ipcRenderer.invoke(channel, payload);

const on = (channel, handler) => {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => ipcRenderer.removeListener(channel, wrapped);
};

contextBridge.exposeInMainWorld('finfolio', {
  app: {
    info: () => invoke('app:info'),
  },

  data: {
    status: () => invoke('data:status'),
    load: (password) => invoke('data:load', { password }),
    save: (doc, force = false) => invoke('data:save', { doc, force }),
    lock: () => invoke('data:lock'),

    // Multi-computer sync
    peek: () => invoke('data:peek'),
    reload: () => invoke('data:reload'),
    changedElsewhere: () => invoke('data:changedElsewhere'),
    mergeWithDisk: (doc) => invoke('data:mergeWithDisk', { doc }),
    mergeWith: (doc, other) => invoke('data:mergeWith', { doc, other }),
    compare: (doc, other) => invoke('data:compare', { doc, other }),
    pickFolder: () => invoke('data:pickFolder'),
    inspectLocation: (dir, create) => invoke('data:inspectLocation', { dir, create }),
    setLocation: (dir, mode) => invoke('data:setLocation', { dir, mode }),
    resetLocation: () => invoke('data:resetLocation'),
    suggestFolders: () => invoke('data:suggestFolders'),
    onExternalChange: (cb) => on('data:external-change', cb),

    setPassword: (password) => invoke('data:setPassword', { password }),
    verifyPassword: (password) => invoke('data:verifyPassword', { password }),
    scorePassword: (password) => invoke('data:scorePassword', { password }),
    revealInFolder: () => invoke('data:reveal'),
  },

  backup: {
    now: (keep) => invoke('backup:now', { keep }),
    list: () => invoke('backup:list'),
    openFolder: () => invoke('backup:openFolder'),
    remove: (file) => invoke('backup:delete', { file }),
    export: (opts) => invoke('backup:export', opts || {}),
    testFolder: (dir, create) => invoke('backup:testFolder', { dir, create }),
    mirrorStatus: () => invoke('backup:mirrorStatus'),
    syncMirror: (keep) => invoke('backup:syncMirror', { keep }),
    openMirror: () => invoke('backup:openMirror'),
    suggestFolders: () => invoke('backup:suggestFolders'),
    pick: () => invoke('backup:pick'),
    read: (file, password) => invoke('backup:read', { file, password }),
    restore: (doc) => invoke('backup:restore', { doc }),
  },

  files: {
    openText: (opts) => invoke('file:openText', opts || {}),
    saveText: (opts) => invoke('file:saveText', opts || {}),
    openPath: (file) => invoke('file:openPath', { file }),
  },

  clipboard: {
    write: (text) => invoke('clipboard:write', { text }),
  },

  shell: {
    openExternal: (url) => invoke('shell:openExternal', { url }),
  },

  window: {
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    close: () => invoke('window:close'),
    state: () => invoke('window:state'),
    onState: (cb) => on('window:state', cb),
  },

  theme: {
    apply: (theme) => invoke('theme:apply', { theme }),
    onSystemChange: (cb) => on('theme:system', cb),
  },

  updates: {
    state: () => invoke('updates:state'),
    check: () => invoke('updates:check'),
    download: () => invoke('updates:download'),
    install: () => invoke('updates:install'),
    prefs: (opts) => invoke('updates:prefs', opts || {}),
    onEvent: (cb) => on('updates:event', cb),
  },

  menu: {
    onCommand: (cb) => on('menu:command', cb),
  },

  log: {
    error: (message, stack) => invoke('log:error', { message, stack }),
  },
});
