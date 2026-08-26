'use strict';

const { contextBridge, ipcRenderer } = require('electron');

/**
 * API que ve la UI. Es la unica puerta entre el chrome del navegador y el
 * proceso principal: nada de Node ni de `require` en el renderer.
 */
const on = (channel) => (handler) => {
  const listener = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
};

contextBridge.exposeInMainWorld('orbit', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),

  tabs: {
    snapshot: () => ipcRenderer.invoke('tabs:snapshot'),
    create: (url, opts) => ipcRenderer.invoke('tabs:create', url, opts),
    close: (id) => ipcRenderer.invoke('tabs:close', id),
    activate: (id) => ipcRenderer.invoke('tabs:activate', id),
    sleep: (id) => ipcRenderer.invoke('tabs:sleep', id),
    wake: (id) => ipcRenderer.invoke('tabs:wake', id),
    sleepOthers: () => ipcRenderer.invoke('tabs:sleepOthers'),
    navigate: (id, url) => ipcRenderer.invoke('tabs:navigate', id, url),
    reload: (id, opts) => ipcRenderer.invoke('tabs:reload', id, opts),
    stop: (id) => ipcRenderer.invoke('tabs:stop', id),
    back: (id) => ipcRenderer.invoke('tabs:back', id),
    forward: (id) => ipcRenderer.invoke('tabs:forward', id),
    pin: (id, pinned) => ipcRenderer.invoke('tabs:pin', id, pinned),
    mute: (id, muted) => ipcRenderer.invoke('tabs:mute', id, muted),
    move: (id, index) => ipcRenderer.invoke('tabs:move', id, index),
    menu: (id) => ipcRenderer.invoke('tabs:menu', id),
    detach: (id, point) => ipcRenderer.invoke('tabs:detach', id, point),
    viewSource: (id) => ipcRenderer.invoke('tabs:viewSource', id),
    inspect: (id) => ipcRenderer.invoke('tabs:inspect', id),
    print: (id) => ipcRenderer.invoke('tabs:print', id),
    save: (id) => ipcRenderer.invoke('tabs:save', id),
    onUpdate: on('tabs:update'),
  },

  network: {
    snapshot: () => ipcRenderer.invoke('network:snapshot'),
    menu: (anchor) => ipcRenderer.send('network:menu', anchor),
    onUpdate: on('network:update'),
  },

  layout: {
    setPageBounds: (bounds, radius) => ipcRenderer.send('layout:pageBounds', bounds, radius),
    ignorePageMouse: (ignore) => ipcRenderer.send('layout:ignorePageMouse', ignore),
  },

  settings: {
    patch: (patch) => ipcRenderer.invoke('settings:patch', patch),
    applyProfile: (name) => ipcRenderer.invoke('settings:profile', name),
    onChange: on('settings:changed'),
  },

  themes: {
    list: () => ipcRenderer.invoke('themes:list'),
    save: (theme) => ipcRenderer.invoke('themes:save', theme),
    openFolder: () => ipcRenderer.invoke('themes:openFolder'),
  },

  resources: {
    subscribe: () => ipcRenderer.invoke('metrics:subscribe'),
    unsubscribe: () => ipcRenderer.invoke('metrics:unsubscribe'),
    sample: () => ipcRenderer.invoke('metrics:sample'),
    onSample: on('metrics:sample'),
    blockerStats: () => ipcRenderer.invoke('blocker:stats'),
    reloadBlocklist: () => ipcRenderer.invoke('blocker:reload'),
  },

  window: {
    minimize: () => ipcRenderer.send('window:minimize'),
    toggleMaximize: () => ipcRenderer.send('window:toggleMaximize'),
    close: () => ipcRenderer.send('window:close'),
    resizeStart: (edge) => ipcRenderer.send('window:resizeStart', edge),
    resizeEnd: () => ipcRenderer.send('window:resizeEnd'),
    onState: on('window:state'),
  },

  app: {
    onShortcut: on('app:shortcut'),
    restart: () => ipcRenderer.invoke('app:restart'),
    openExternal: (url) => ipcRenderer.invoke('app:openExternal', url),
    openPath: (target) => ipcRenderer.invoke('app:openPath', target),
    copy: (text) => ipcRenderer.invoke('app:copy', text),
  },
});
