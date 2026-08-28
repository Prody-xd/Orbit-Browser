'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { EventEmitter } = require('node:events');
const { app } = require('electron');
const { JsonStore } = require('./store');

/**
 * Descargas de la sesion `persist:orbit`.
 *
 * Chromium avisa con `will-download`. Guardamos en la carpeta Descargas del
 * usuario, emitimos progreso para la barra, y conservamos un historial corto
 * para el panel.
 */

const MAX_HISTORY = 40;

/** @type {DownloadsManager|null} */
let manager = null;

class DownloadsManager extends EventEmitter {
  constructor(store) {
    super();
    this.store = store;
    if (!Array.isArray(this.store.data.items)) this.store.data.items = [];
    /** @type {Map<number, {id:number, item: import('electron').DownloadItem, record: object}>} */
    this.live = new Map();
    this.nextId = 1;
    this._timer = null;
  }

  install(ses) {
    ses.on('will-download', (_event, item) => {
      const filename = safeName(item.getFilename() || 'descarga');
      const destDir =
        process.env.VITRAL_SMOKE === '1' ? path.join(app.getPath('userData'), 'downloads') : app.getPath('downloads');
      fs.mkdirSync(destDir, { recursive: true });
      const dest = uniquePath(destDir, filename);
      try {
        item.setSavePath(dest);
      } catch {
        /* Electron elige */
      }

      const id = this.nextId++;
      const record = {
        id,
        filename: path.basename(item.getSavePath() || dest),
        path: item.getSavePath() || dest,
        url: item.getURL(),
        mime: item.getMimeType(),
        state: 'progressing',
        receivedBytes: 0,
        totalBytes: Number(item.getTotalBytes()) || 0,
        startedAt: Date.now(),
        endedAt: null,
      };
      this.live.set(id, { id, item, record });
      this._emit();

      item.on('updated', (_e, state) => {
        record.state = state === 'interrupted' ? 'interrupted' : item.isPaused() ? 'paused' : 'progressing';
        record.receivedBytes = Number(item.getReceivedBytes()) || 0;
        record.totalBytes = Number(item.getTotalBytes()) || record.totalBytes;
        record.path = item.getSavePath() || record.path;
        record.filename = path.basename(record.path);
        this._emit();
      });

      item.on('done', (_e, state) => {
        record.state = state;
        record.receivedBytes = Number(item.getReceivedBytes()) || record.receivedBytes;
        record.totalBytes = Number(item.getTotalBytes()) || record.totalBytes;
        record.path = item.getSavePath() || record.path;
        record.filename = path.basename(record.path);
        record.endedAt = Date.now();
        this.live.delete(id);
        this._remember(record);
        this._emit();
      });
    });
  }

  snapshot() {
    const active = [...this.live.values()].map((entry) => publicRecord(entry.record));
    const history = (this.store.data.items || []).map(publicRecord);
    const seen = new Set(active.map((item) => item.id));
    const items = [...active, ...history.filter((item) => !seen.has(item.id))];
    const totals = active.reduce(
      (acc, item) => {
        acc.received += item.receivedBytes;
        acc.total += item.totalBytes > 0 ? item.totalBytes : item.receivedBytes;
        return acc;
      },
      { received: 0, total: 0 },
    );
    const percent =
      active.length === 0
        ? 0
        : totals.total > 0
          ? Math.min(100, Math.round((totals.received / totals.total) * 100))
          : 0;
    return {
      busy: active.length > 0,
      active: active.length,
      percent,
      items: items.slice(0, MAX_HISTORY + active.length),
    };
  }

  pause(id) {
    this.live.get(Number(id))?.item.pause();
    this._emit();
  }

  resume(id) {
    const live = this.live.get(Number(id));
    if (live?.item.canResume()) live.item.resume();
    this._emit();
  }

  cancel(id) {
    this.live.get(Number(id))?.item.cancel();
    this._emit();
  }

  clearDone() {
    this.store.data.items = [];
    this.store.save();
    this._emit();
  }

  saveNow() {
    this.store.saveNow();
  }

  _remember(record) {
    const items = this.store.data.items;
    items.unshift({ ...record });
    this.store.data.items = items.slice(0, MAX_HISTORY);
    this.store.save();
  }

  _emit() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this.emit('update', this.snapshot());
    }, 80);
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }
}

function publicRecord(record) {
  const total = Number(record.totalBytes) || 0;
  const received = Number(record.receivedBytes) || 0;
  const percent = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : record.state === 'completed' ? 100 : 0;
  return { ...record, percent };
}

function safeName(name) {
  const cleaned = String(name || 'descarga').replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').trim() || 'descarga';
  return cleaned.slice(0, 120);
}

function uniquePath(dir, name) {
  const dest = path.join(dir, name);
  if (!fs.existsSync(dest)) return dest;
  const ext = path.extname(name);
  const base = path.basename(name, ext);
  let i = 1;
  while (fs.existsSync(path.join(dir, `${base} (${i})${ext}`))) i += 1;
  return path.join(dir, `${base} (${i})${ext}`);
}

function initDownloads() {
  manager = new DownloadsManager(
    new JsonStore(path.join(app.getPath('userData'), 'downloads.json'), { items: [] }, { debounceMs: 600 }),
  );
  return manager;
}

function getDownloads() {
  return manager;
}

module.exports = { DownloadsManager, initDownloads, getDownloads };
