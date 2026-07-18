/* =============================================================
   confirm.js — Reusable confirmation & alert dialogs
   (replaces window.confirm / alert)
   ============================================================= */

function escHtml(str) {
  if (!str) return '';
  const d = document.createElement('div');
  d.textContent = str;
  return d.innerHTML;
}

/**
 * Show a confirmation dialog. Resolves true if user clicks confirm, false if cancel/escape/backdrop.
 */
export function confirmDialog({
  title = 'Confirm',
  message,
  confirmText = 'Confirm',
  confirmClass = 'btn-danger',
  cancelText = 'Cancel'
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'z-index: 10000;';

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve(false);
      }
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve(false);
      }
    };
    document.addEventListener('keydown', escHandler);

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escHtml(title)}</h3>
        <p>${escHtml(message)}</p>
        <div class="modal-actions">
          <button class="btn btn-secondary" id="confirm-cancel">${escHtml(cancelText)}</button>
          <button class="btn ${escHtml(confirmClass)}" id="confirm-ok">${escHtml(confirmText)}</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const btnCancel = overlay.querySelector('#confirm-cancel');
    const btnOk = overlay.querySelector('#confirm-ok');

    const cleanup = () => {
      document.removeEventListener('keydown', escHandler);
      overlay.remove();
    };

    btnCancel.addEventListener('click', () => {
      cleanup();
      resolve(false);
    });

    btnOk.addEventListener('click', () => {
      cleanup();
      resolve(true);
    });

    btnOk.focus();
  });
}

/**
 * Show a simple informational alert dialog. Resolves when the user clicks OK.
 */
export function alertDialog({ title = 'Info', message } = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'z-index: 10000;';

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve();
      }
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve();
      }
    };
    document.addEventListener('keydown', escHandler);

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <h3>${escHtml(title)}</h3>
        <p>${escHtml(message)}</p>
        <div class="modal-actions" style="justify-content: flex-end;">
          <button class="btn btn-primary" id="alert-ok">OK</button>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    const btnOk = overlay.querySelector('#alert-ok');
    const cleanup = () => {
      document.removeEventListener('keydown', escHandler);
      overlay.remove();
    };

    btnOk.addEventListener('click', () => {
      cleanup();
      resolve();
    });

    btnOk.focus();
  });
}

/**
 * Show a 3-way confirmation dialog. Resolves to 'save', 'discard', or 'cancel'.
 */
export function threeWayConfirmDialog({
  title = 'Unsaved Changes',
  message = 'You have unsaved changes. Would you like to save them before closing?',
  saveText = 'Save',
  saveClass = 'btn-primary',
  discardText = 'Discard',
  discardClass = 'btn-danger',
  cancelText = 'Cancel'
} = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay open';
    overlay.style.cssText = 'z-index: 10000;';

    const cleanup = () => {
      document.removeEventListener('keydown', escHandler);
      overlay.remove();
    };

    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) {
        cleanup();
        resolve('cancel');
      }
    });

    const escHandler = (e) => {
      if (e.key === 'Escape') {
        cleanup();
        resolve('cancel');
      }
    };
    document.addEventListener('keydown', escHandler);

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true" style="max-width: 480px;">
        <h3>${escHtml(title)}</h3>
        <p>${escHtml(message)}</p>
        <div class="modal-actions" style="display: flex; flex-wrap: wrap; gap: 8px; justify-content: space-between;">
          <button class="btn btn-secondary" id="confirm-cancel">${escHtml(cancelText)}</button>
          <div style="display: flex; flex-wrap: wrap; gap: 8px;">
            <button class="btn ${escHtml(discardClass)}" id="confirm-discard">${escHtml(discardText)}</button>
            <button class="btn ${escHtml(saveClass)}" id="confirm-save">${escHtml(saveText)}</button>
          </div>
        </div>
      </div>
    `;

    document.body.appendChild(overlay);

    overlay.querySelector('#confirm-cancel').addEventListener('click', () => {
      cleanup();
      resolve('cancel');
    });

    overlay.querySelector('#confirm-discard').addEventListener('click', () => {
      cleanup();
      resolve('discard');
    });

    const btnSave = overlay.querySelector('#confirm-save');
    btnSave.addEventListener('click', () => {
      cleanup();
      resolve('save');
    });

    btnSave.focus();
  });
}

