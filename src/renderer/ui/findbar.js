import { $ } from './dom.js';
import { icons } from './icons.js';

/**
 * Barra de buscar en la pagina (Ctrl+F).
 *
 * Vive en el chrome, no encima de la vista nativa: si estuviera en el hueco
 * de la pagina, Chromium la taparia. El resaltado lo hace `findInPage`.
 */
export function createFindbar({ getActiveId, onLayout }) {
  const root = $('#findbar');
  const input = $('#find-input');
  const count = $('#find-count');
  const prev = $('#find-prev');
  const next = $('#find-next');
  const closeBtn = $('#find-close');
  const findApi = window.orbit?.find;

  if (!root || !input || !count || !prev || !next || !closeBtn || !findApi) {
    console.error('[findbar] no se pudo montar');
    return {
      open() {},
      close() {},
      isOpen: () => false,
      next() {},
      prev() {},
      onTabChange() {},
    };
  }

  prev.innerHTML = icons.findPrev;
  next.innerHTML = icons.findNext;
  closeBtn.innerHTML = icons.close;

  let open = false;
  let debounce = null;
  let lastId = null;

  function setOpen(nextOpen) {
    if (nextOpen === open) {
      if (nextOpen) {
        input.focus();
        input.select();
      }
      return;
    }
    open = nextOpen;
    root.hidden = !open;
    root.classList.toggle('is-open', open);
    findApi.setVisible(open);
    onLayout?.();
    if (open) {
      input.focus();
      input.select();
      if (input.value) search({ findNext: false });
    } else {
      const id = getActiveId();
      if (id != null) findApi.stop(id);
      count.textContent = '';
      root.classList.remove('not-found');
    }
  }

  function search(opts) {
    const id = getActiveId();
    lastId = id;
    const text = input.value;
    if (id == null) return;
    if (!text) {
      findApi.stop(id);
      count.textContent = '';
      root.classList.remove('not-found');
      return;
    }
    findApi.start(id, text, opts);
  }

  function nextMatch() {
    if (!open) return setOpen(true);
    search({ findNext: true, forward: true });
  }

  function prevMatch() {
    if (!open) return setOpen(true);
    search({ findNext: true, forward: false });
  }

  input.addEventListener('input', () => {
    clearTimeout(debounce);
    debounce = setTimeout(() => search({ findNext: false }), 40);
  });

  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      if (event.shiftKey) prevMatch();
      else nextMatch();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setOpen(false);
    }
  });

  prev.addEventListener('click', () => prevMatch());
  next.addEventListener('click', () => nextMatch());
  closeBtn.addEventListener('click', () => setOpen(false));

  findApi.onResult(({ tabId, result }) => {
    if (!open || !result?.finalUpdate) return;
    if (tabId !== getActiveId()) return;
    const matches = Number(result.matches) || 0;
    const active = Number(result.activeMatchOrdinal) || 0;
    if (!input.value) {
      count.textContent = '';
      root.classList.remove('not-found');
      return;
    }
    count.textContent = matches ? `${active} / ${matches}` : 'Sin resultados';
    root.classList.toggle('not-found', matches === 0);
  });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    next: nextMatch,
    prev: prevMatch,
    onTabChange(activeId) {
      if (!open) return;
      if (lastId != null && lastId !== activeId) findApi.stop(lastId);
      search({ findNext: false });
    },
  };
}
