'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbitDownloads', {
  onInit: (handler) => {
    ipcRenderer.on('downloads-popup:init', (_e, payload) => handler(payload));
  },
  onUpdate: (handler) => {
    ipcRenderer.on('downloads-popup:update', (_e, payload) => handler(payload));
  },
  open: (id) => ipcRenderer.send('downloads-popup:open', id),
  show: (id) => ipcRenderer.send('downloads-popup:show', id),
  pause: (id) => ipcRenderer.send('downloads-popup:pause', id),
  resume: (id) => ipcRenderer.send('downloads-popup:resume', id),
  cancel: (id) => ipcRenderer.send('downloads-popup:cancel', id),
  clear: () => ipcRenderer.send('downloads-popup:clear'),
  folder: () => ipcRenderer.send('downloads-popup:folder'),
  close: () => ipcRenderer.send('downloads-popup:close'),
});
