'use strict';

const list = document.getElementById('list');
const head = document.getElementById('head');
const clearBtn = document.getElementById('btn-clear');
const folderBtn = document.getElementById('btn-folder');

function applyTheme(theme) {
  const root = document.documentElement.style;
  for (const [key, value] of Object.entries(theme ?? {})) root.setProperty(key, value);
}

function formatBytes(n) {
  const value = Number(n) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`;
  if (value < 1024 * 1024 * 1024) return `${(value / (1024 * 1024)).toFixed(1)} MB`;
  return `${(value / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function statusText(item) {
  if (item.state === 'completed') return 'Completado';
  if (item.state === 'cancelled') return 'Cancelado';
  if (item.state === 'interrupted') return 'Interrumpido';
  if (item.state === 'paused') return `Pausado · ${item.percent}%`;
  if (item.totalBytes > 0) return `${formatBytes(item.receivedBytes)} / ${formatBytes(item.totalBytes)} · ${item.percent}%`;
  return `${formatBytes(item.receivedBytes)}`;
}

function render(snap) {
  const items = snap?.items ?? [];
  const busy = Number(snap?.active) || 0;
  head.textContent =
    busy > 0 ? `${busy} ${busy === 1 ? 'descarga en curso' : 'descargas en curso'}` : 'Descargas';

  list.replaceChildren();
  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Aún no hay descargas. Los archivos se guardan en la carpeta Descargas.';
    list.append(empty);
  } else {
    for (const item of items.slice(0, 8)) {
      const row = document.createElement('div');
      row.className = 'row';
      if (item.state === 'completed') row.classList.add('is-done');
      if (item.state === 'cancelled' || item.state === 'interrupted') row.classList.add('is-fail');

      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = item.filename || 'Archivo';

      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = statusText(item);

      const bar = document.createElement('div');
      bar.className = 'bar';
      const fill = document.createElement('i');
      fill.style.width = `${Math.max(item.state === 'completed' ? 100 : 0, Number(item.percent) || 0)}%`;
      bar.append(fill);

      const actions = document.createElement('div');
      actions.className = 'actions';

      const addBtn = (label, fn) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = label;
        btn.addEventListener('click', (event) => {
          event.stopPropagation();
          fn();
        });
        actions.append(btn);
      };

      if (item.state === 'progressing') {
        addBtn('Pausar', () => window.orbitDownloads.pause(item.id));
        addBtn('Cancelar', () => window.orbitDownloads.cancel(item.id));
      } else if (item.state === 'paused') {
        addBtn('Reanudar', () => window.orbitDownloads.resume(item.id));
        addBtn('Cancelar', () => window.orbitDownloads.cancel(item.id));
      } else if (item.state === 'completed') {
        addBtn('Abrir', () => window.orbitDownloads.open(item.id));
        addBtn('Carpeta', () => window.orbitDownloads.show(item.id));
      }

      row.append(name, meta, actions, bar);
      if (item.state === 'completed') {
        row.addEventListener('click', () => window.orbitDownloads.open(item.id));
      }
      list.append(row);
    }
  }

  clearBtn.disabled = !items.some((item) => item.state === 'completed' || item.state === 'cancelled');
}

clearBtn.addEventListener('click', () => window.orbitDownloads.clear());
folderBtn.addEventListener('click', () => window.orbitDownloads.folder());
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.orbitDownloads.close();
});

window.orbitDownloads.onInit((payload) => {
  applyTheme(payload.theme);
  render(payload.snap);
});
window.orbitDownloads.onUpdate((snap) => render(snap));
