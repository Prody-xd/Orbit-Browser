'use strict';

const MAX_SNAPSHOTS = 30;
const snapshots = new Map();
let nextId = 1;

function storeSource({ url, html }) {
  const id = String(nextId++);
  snapshots.set(id, { url: String(url || ''), html: String(html || '') });
  while (snapshots.size > MAX_SNAPSHOTS) {
    const oldest = snapshots.keys().next().value;
    snapshots.delete(oldest);
  }
  return id;
}

function takeSource(id) {
  return snapshots.get(String(id)) ?? null;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function sourcePage(entry) {
  const url = escapeHtml(entry.url || '');
  const body = escapeHtml(entry.html || '(no se pudo leer el documento)');
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<title>Fuente: ${url}</title>
<link rel="stylesheet" href="orbit://theme/theme.css">
<style>
  html, body { margin: 0; background: var(--base, #0f1017); color: var(--text, #c9d1e6); }
  header {
    padding: 10px 16px;
    background: var(--chrome, #171826);
    border-bottom: 1px solid var(--border, #2b2e42);
    font: 12px/1.4 system-ui, sans-serif;
    color: var(--muted, #79839e);
    word-break: break-all;
  }
  pre {
    margin: 0;
    padding: 16px 18px 32px;
    font: 12px/1.45 ui-monospace, Consolas, monospace;
    white-space: pre-wrap;
    word-break: break-word;
  }
</style>
</head>
<body>
<header>${url}</header>
<pre>${body}</pre>
</body>
</html>`;
}

async function captureHtml(target) {
  if (!target) return '';
  try {
    const html = await target.executeJavaScript(
      `(document.doctype ? '<!DOCTYPE ' + document.doctype.name + '>\\n' : '') + document.documentElement.outerHTML`,
      true,
    );
    return typeof html === 'string' ? html : '';
  } catch {
    return '';
  }
}

/**
 * Abre una pestana con el HTML vivo del documento o del iframe, no con
 * `view-source:`: Electron no mantiene ese esquema como Chrome.
 */
async function openPageSource(tabs, { url, frame, webContents }) {
  const html = (await captureHtml(frame)) || (await captureHtml(webContents));
  const id = storeSource({ url, html });
  tabs.create(`orbit://source/${id}`, { active: true });
}

module.exports = { storeSource, takeSource, sourcePage, openPageSource };
