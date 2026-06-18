const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('updater', {
  version: process.env.NEV_APP_VERSION || '',
  on: (cb) => ipcRenderer.on('updater-status', (_e, data) => cb(data)),
  install: () => ipcRenderer.send('updater-install'),
  openReleases: () => ipcRenderer.send('updater-open-releases'),
  continueAnyway: () => ipcRenderer.send('updater-continue')
});
