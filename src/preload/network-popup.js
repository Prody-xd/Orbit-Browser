'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbitPopup', {
  onInit: (handler) => {
    ipcRenderer.on('network-popup:init', (_e, payload) => handler(payload));
  },
  onUpdate: (handler) => {
    ipcRenderer.on('network-popup:update', (_e, payload) => handler(payload));
  },
  copy: (text) => ipcRenderer.send('network-popup:copy', text),
  copyAll: () => ipcRenderer.send('network-popup:copy-all'),
  reset: () => ipcRenderer.send('network-popup:reset'),
  close: () => ipcRenderer.send('network-popup:close'),
});
