'use strict';

const list = document.getElementById('list');
const head = document.getElementById('head');
const copyAll = document.getElementById('btn-copy-all');
const reset = document.getElementById('btn-reset');

function applyTheme(theme) {
  const root = document.documentElement.style;
  for (const [key, value] of Object.entries(theme ?? {})) root.setProperty(key, value);
}

function render(snap) {
  const count = Number(snap?.count) || 0;
  const endpoints = snap?.endpoints ?? [];
  head.textContent =
    count === 0
      ? 'Este sitio aún no ha hecho fetch'
      : `${count} ${count === 1 ? 'solicitud fetch' : 'solicitudes fetch'}`;

  list.replaceChildren();
  if (!endpoints.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = 'Cuando esta pestaña llame a una API, los endpoints aparecerán aquí.';
    list.append(empty);
  } else {
    const shown = endpoints.slice(0, 22);
    for (const entry of shown) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'row';
      row.title = `${entry.url || entry.key}\nClic para copiar`;
      const countEl = document.createElement('b');
      countEl.textContent = String(entry.count);
      const path = document.createElement('span');
      path.textContent = entry.key;
      row.append(countEl, path);
      row.addEventListener('click', () => window.orbitPopup.copy(entry.url || entry.key));
      list.append(row);
    }
    if (endpoints.length > shown.length) {
      const more = document.createElement('div');
      more.className = 'more';
      more.textContent = `Y ${endpoints.length - shown.length} endpoints más…`;
      list.append(more);
    }
  }

  copyAll.disabled = endpoints.length === 0;
  reset.disabled = count === 0;
}

copyAll.addEventListener('click', () => window.orbitPopup.copyAll());
reset.addEventListener('click', () => window.orbitPopup.reset());
window.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') window.orbitPopup.close();
});

window.orbitPopup.onInit((payload) => {
  applyTheme(payload.theme);
  render(payload.snap);
});
window.orbitPopup.onUpdate((snap) => render(snap));
