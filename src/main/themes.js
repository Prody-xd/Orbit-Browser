'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app, shell } = require('electron');

/**
 * Temas como archivos JSON.
 *
 * Hay dos carpetas: la del proyecto (temas incluidos) y una en los datos del
 * usuario (temas propios). Los del usuario ganan si repiten id, asi que se
 * puede sobrescribir un tema incluido sin tocar el codigo. Crear un tema es
 * copiar un archivo y cambiar colores; no hace falta recompilar nada.
 */
const BUNDLED_DIR = path.join(__dirname, '..', '..', 'themes');

function userThemesDir() {
  return path.join(app.getPath('userData'), 'themes');
}

function ensureUserDir() {
  const dir = userThemesDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
    /* no critico */
  }
  return dir;
}

function readDir(dir, source) {
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.toLowerCase().endsWith('.json'));
  } catch {
    return [];
  }

  const out = [];
  for (const file of files) {
    try {
      const theme = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (!theme.id) theme.id = path.basename(file, '.json');
      theme.source = source;
      theme.file = path.join(dir, file);
      out.push(theme);
    } catch (err) {
      console.warn(`[themes] ${file} invalido:`, err.message);
    }
  }
  return out;
}

function listThemes() {
  ensureUserDir();
  const map = new Map();
  for (const theme of readDir(BUNDLED_DIR, 'bundled')) map.set(theme.id, theme);
  for (const theme of readDir(userThemesDir(), 'user')) map.set(theme.id, theme);
  return [...map.values()];
}

function getTheme(id) {
  const themes = listThemes();
  return themes.find((t) => t.id === id) ?? themes[0] ?? null;
}

/** Guarda (o clona) un tema en la carpeta del usuario. */
function saveUserTheme(theme) {
  const dir = ensureUserDir();
  const id = String(theme.id || 'mi-tema').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  const file = path.join(dir, `${id}.json`);
  const payload = { ...theme, id };
  delete payload.source;
  delete payload.file;
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
  return { ...payload, source: 'user', file };
}

function openThemesFolder() {
  return shell.openPath(ensureUserDir());
}

module.exports = { listThemes, getTheme, saveUserTheme, openThemesFolder, userThemesDir };
