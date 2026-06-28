const MAX_TOASTS = 4;

const ICONS = {
  success: 'check-circle',
  error: 'x-circle',
  warning: 'alert-triangle',
  info: 'zap'
};

function escHtml(str) {
  return String(str ?? '')
    .replace(/&/g,'&amp;').replace(/</g,'&lt;')
    .replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

const DURATIONS = {
  success: 5000,
  error: 7000,
  warning: 6000,
  info: 4500
};

let activeToasts = [];

/**
 * @param {string} msg
 * @param {'success'|'error'|'warning'|'info'} [type='info']
 * @param {object} [opts]
 * @param {string} [opts.actionLabel] — eg "Undo"
 * @param {() => void} [opts.onAction] — callback for action button
 */
export function showToast(msg, type = 'info', opts = {}) {
  const container = document.getElementById('toast-container');
  if (!container) return;

  while (activeToasts.length >= MAX_TOASTS) {
    const oldest = activeToasts.shift();
    if (oldest && oldest.parentNode) {
      clearTimeout(oldest._timeout);
      oldest.remove();
    }
  }

  const el = document.createElement('div');
  const iconName = ICONS[type] || ICONS.info;
  const iconSvg = feather.icons[iconName].toSvg({ width: 18, height: 18, 'stroke-width': 2.5 });
  const duration = DURATIONS[type] || DURATIONS.info;

  el.className = `toast toast-${type}`;

  let html = `
    <span class="toast-icon">${iconSvg}</span>
    <span class="toast-msg">${escHtml(msg)}</span>`;

  if (opts.actionLabel && opts.onAction) {
    html += `<button class="toast-action" type="button">${opts.actionLabel}</button>`;
  }

  html += `<button class="toast-dismiss" type="button" aria-label="Dismiss">✕</button>`;

  el.innerHTML = html;

  const dismissBtn = el.querySelector('.toast-dismiss');
  const actionBtn = el.querySelector('.toast-action');

  const remove = () => {
    if (!el.parentNode) return;
    clearTimeout(el._timeout);
    el.classList.add('toast-exit');
    el.addEventListener('animationend', () => { el.remove(); }, { once: true });
    activeToasts = activeToasts.filter(t => t !== el);
  };

  dismissBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    remove();
  });

  if (actionBtn) {
    actionBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      opts.onAction();
      remove();
    });
  }

  container.appendChild(el);
  activeToasts.push(el);

  requestAnimationFrame(() => {
    el.classList.add('toast-visible');
  });

  el._timeout = setTimeout(remove, duration);
}

export function showSuccess(msg, opts) { return showToast(msg, 'success', opts); }
export function showError(msg, opts) { return showToast(msg, 'error', opts); }
export function showWarning(msg, opts) { return showToast(msg, 'warning', opts); }
export function showInfo(msg, opts) { return showToast(msg, 'info', opts); }
