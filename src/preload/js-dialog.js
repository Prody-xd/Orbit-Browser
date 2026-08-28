'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('orbitDialog', {
  onShow: (handler) => {
    ipcRenderer.on('js-dialog:show', (_e, payload) => handler(payload));
  },
  reply: (result) => ipcRenderer.invoke('js-dialog:reply', result),
});
