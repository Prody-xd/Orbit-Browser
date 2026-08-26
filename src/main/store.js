'use strict';

const fs = require('node:fs');
const path = require('node:path');

/**
 * Store JSON minimalista con escritura atomica y debounce.
 *
 * Motivo de diseno: un navegador personal no necesita SQLite (dependencia
 * nativa que hay que recompilar en cada actualizacion de Electron). Un JSON
 * escrito de forma diferida es suficiente para settings, sesion e historial
 * de tamano domestico, y nunca bloquea el hilo principal en el camino caliente.
 */
class JsonStore {
  /**
   * @param {string} filePath ruta absoluta del archivo
   * @param {object} defaults valor inicial si el archivo no existe o esta corrupto
   * @param {{debounceMs?: number}} [options]
   */
  constructor(filePath, defaults = {}, options = {}) {
    this.filePath = filePath;
    this.defaults = defaults;
    this.debounceMs = options.debounceMs ?? 400;
    this._timer = null;
    this._writing = false;
    this._pending = false;
    this.data = this._read();
  }

  _read() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const parsed = JSON.parse(raw);
      return deepMerge(structuredClone(this.defaults), parsed);
    } catch (err) {
      if (err && err.code !== 'ENOENT') {
        console.warn(`[store] ${path.basename(this.filePath)} ilegible, usando defaults:`, err.message);
        this._backupCorrupt();
      }
      return structuredClone(this.defaults);
    }
  }

  _backupCorrupt() {
    try {
      fs.copyFileSync(this.filePath, `${this.filePath}.bak`);
    } catch {
      /* sin backup, seguimos */
    }
  }

  /** Programa un guardado. Varias llamadas seguidas colapsan en una escritura. */
  save() {
    if (this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush().catch((err) => console.warn('[store] fallo al guardar:', err.message));
    }, this.debounceMs);
    // No mantener el proceso vivo solo por un guardado pendiente.
    if (typeof this._timer.unref === 'function') this._timer.unref();
  }

  async _flush() {
    if (this._writing) {
      this._pending = true;
      return;
    }
    this._writing = true;
    const tmp = `${this.filePath}.tmp`;
    const payload = JSON.stringify(this.data, null, 2);
    try {
      await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.promises.writeFile(tmp, payload, 'utf8');
      await fs.promises.rename(tmp, this.filePath);
    } finally {
      this._writing = false;
      if (this._pending) {
        this._pending = false;
        await this._flush();
      }
    }
  }

  /** Guardado sincrono, para usar al cerrar la app. */
  saveNow() {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      const tmp = `${this.filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8');
      fs.renameSync(tmp, this.filePath);
    } catch (err) {
      console.warn('[store] fallo al guardar (sync):', err.message);
    }
  }
}

/** Merge recursivo: los objetos se combinan, el resto se reemplaza. */
function deepMerge(base, patch) {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch === undefined ? base : patch;
  const out = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? deepMerge(base[key], value) : value;
  }
  return out;
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

module.exports = { JsonStore, deepMerge, isPlainObject };
