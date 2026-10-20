'use strict';

const titleEl = document.getElementById('title');
const messageEl = document.getElementById('message');
const hintEl = document.getElementById('hint');
const promptEl = document.getElementById('prompt');
const suppressWrap = document.getElementById('suppress-wrap');
const suppressEl = document.getElementById('suppress');
const cancelBtn = document.getElementById('btn-cancel');
const okBtn = document.getElementById('btn-ok');

function applyTheme(theme) {
  const root = document.documentElement.style;
  for (const [key, value] of Object.entries(theme ?? {})) root.setProperty(key, value);
}

function reply(ok) {
  window.orbitDialog.reply({
    ok,
    value: promptEl.hidden ? '' : promptEl.value,
    suppress: Boolean(suppressEl.checked),
  });
}

okBtn.addEventListener('click', () => reply(true));
cancelBtn.addEventListener('click', () => reply(false));

window.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault();
    reply(true);
    return;
  }
  if (event.key === 'Escape') {
    event.preventDefault();
    reply(!cancelBtn.hidden ? false : true);
  }
});

window.orbitDialog.onShow((payload) => {
  applyTheme(payload.theme);
  titleEl.textContent = payload.title || '';
  messageEl.textContent = payload.message || '';
  hintEl.textContent = payload.hint || '';
  hintEl.hidden = !payload.hint;
  promptEl.value = payload.defaultPrompt || '';
  promptEl.hidden = !payload.showPrompt;
  cancelBtn.hidden = !payload.showCancel;
  cancelBtn.textContent = payload.cancelLabel || 'Cancelar';
  okBtn.textContent = payload.okLabel || 'Aceptar';
  suppressWrap.hidden = !payload.showSuppress;
  suppressEl.checked = false;
  requestAnimationFrame(() => {
    if (!promptEl.hidden) {
      promptEl.focus();
      promptEl.select();
    } else {
      okBtn.focus();
    }
  });
});
