'use strict';

const os = require('node:os');
const { app } = require('electron');

/**
 * Muestreo de recursos por proceso.
 *
 * `app.getAppMetrics()` no es gratis: recorre todos los procesos hijos. Por eso
 * el muestreo solo corre mientras alguien esta mirando el panel; en cuanto se
 * cierra, el temporizador desaparece. Ese es el compromiso central del
 * proyecto: poder medir y limitar recursos sin que medirlo cueste recursos.
 */
class MetricsSampler {
  /**
   * @param {{tabs: import('./tabs').TabManager, getSettings: () => any, onSample: (sample: object) => void}} deps
   */
  constructor({ tabs, getSettings, onSample }) {
    this.tabs = tabs;
    this.getSettings = getSettings;
    this.onSample = onSample;
    this.subscribers = 0;
    this.timer = null;
  }

  subscribe() {
    this.subscribers++;
    if (this.subscribers === 1) this._start();
    return this.sample();
  }

  unsubscribe() {
    this.subscribers = Math.max(0, this.subscribers - 1);
    if (this.subscribers === 0) this._stop();
  }

  _start() {
    const interval = Math.max(500, Number(this.getSettings().resources.metricsIntervalMs) || 2000);
    this.timer = setInterval(() => {
      try {
        this.onSample(this.sample());
      } catch (err) {
        console.warn('[metrics] fallo el muestreo:', err.message);
      }
    }, interval);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  _stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Reinicia el temporizador si cambio el intervalo en ajustes. */
  refreshInterval() {
    if (this.subscribers > 0) {
      this._stop();
      this._start();
    }
  }

  sample() {
    const metrics = app.getAppMetrics();

    // pid -> pestana, para atribuir memoria y CPU a algo que el usuario reconoce.
    const pidToTab = new Map();
    for (const tab of this.tabs.tabs.values()) {
      const wc = tab.view?.webContents;
      if (!wc || wc.isDestroyed()) continue;
      try {
        pidToTab.set(wc.getOSProcessId(), tab);
      } catch {
        /* proceso ya se fue */
      }
    }

    let totalMemoryKB = 0;
    let totalCpu = 0;
    const byTab = [];
    const byType = {};

    for (const m of metrics) {
      const memKB = m.memory?.workingSetSize ?? 0;
      const cpu = m.cpu?.percentCPUUsage ?? 0;
      totalMemoryKB += memKB;
      totalCpu += cpu;

      const bucket = (byType[m.type] ??= { count: 0, memoryMB: 0, cpu: 0 });
      bucket.count++;
      bucket.memoryMB += memKB / 1024;
      bucket.cpu += cpu;

      const tab = pidToTab.get(m.pid);
      if (tab) {
        byTab.push({
          id: tab.id,
          pid: m.pid,
          memoryMB: round(memKB / 1024),
          cpu: round(cpu, 1),
        });
      }
    }

    for (const bucket of Object.values(byType)) {
      bucket.memoryMB = round(bucket.memoryMB);
      bucket.cpu = round(bucket.cpu, 1);
    }

    const tabsArr = [...this.tabs.tabs.values()];

    return {
      at: Date.now(),
      totals: {
        memoryMB: round(totalMemoryKB / 1024),
        cpu: round(totalCpu, 1),
        processes: metrics.length,
        liveTabs: tabsArr.filter((t) => t.view).length,
        sleepingTabs: tabsArr.filter((t) => t.sleeping).length,
        totalTabs: tabsArr.length,
      },
      system: {
        totalMemoryMB: round(os.totalmem() / 1024 / 1024),
        freeMemoryMB: round(os.freemem() / 1024 / 1024),
        cores: os.cpus().length,
      },
      byTab: byTab.sort((a, b) => b.memoryMB - a.memoryMB),
      byType,
    };
  }
}

function round(value, decimals = 0) {
  const factor = 10 ** decimals;
  return Math.round((Number(value) || 0) * factor) / factor;
}

module.exports = { MetricsSampler };
