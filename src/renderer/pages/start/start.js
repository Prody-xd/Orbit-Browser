/**
 * Pagina de inicio.
 *
 * Es una pagina normal cargada bajo `orbit://`, sin acceso a las APIs del
 * navegador: no puede leer ni cambiar ajustes. Los accesos rapidos viven en el
 * `localStorage` de esta pagina, que es suficiente para algo personal y evita
 * darle permisos a una pagina que no los necesita.
 */

const DEFAULT_LINKS = [
  { title: 'GitHub', url: 'https://github.com' },
  { title: 'Wikipedia', url: 'https://es.wikipedia.org' },
  { title: 'YouTube', url: 'https://youtube.com' },
  { title: 'Correo', url: 'https://mail.google.com' },
];

function readLinks() {
  try {
    const raw = JSON.parse(localStorage.getItem('orbit.links') ?? 'null');
    if (Array.isArray(raw) && raw.length) return raw;
  } catch {
    /* datos corruptos: volvemos a los de fabrica */
  }
  return DEFAULT_LINKS;
}

function hostOf(url) {
  try {
    return new URL(url).host.replace(/^www\./, '');
  } catch {
    return url;
  }
}

function renderLinks() {
  const container = document.getElementById('links');
  container.replaceChildren();
  for (const link of readLinks()) {
    const anchor = document.createElement('a');
    anchor.href = link.url;
    anchor.textContent = link.title;
    const small = document.createElement('small');
    small.textContent = hostOf(link.url);
    anchor.append(small);
    container.append(anchor);
  }
}

function tickClock() {
  const now = new Date();
  document.getElementById('clock').textContent = now.toLocaleString('es', {
    weekday: 'long',
    day: 'numeric',
    month: 'long',
    hour: '2-digit',
    minute: '2-digit',
  });
}

renderLinks();
tickClock();
// Un minuto es suficiente para un reloj sin segundos, y no despierta la CPU
// mas de lo necesario en una pestana que suele quedarse abierta.
setInterval(tickClock, 60_000);
