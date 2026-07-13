import { showToast } from './toast.js';
import { confirmDialog } from './confirm.js';

let authInstance = null;

// After an import, click the matching tab's Refresh button so the table
// reflects the new data without a full page reload.
const REFRESH_BTN_ID = {
  platforms: 'admin-plat-refresh-btn',
  plans: 'admin-plans-refresh-btn',
  integrations: 'admin-int-refresh-btn',
};

const LABEL = {
  platforms: 'Platforms',
  plans: 'Plans',
  integrations: 'Marketplace',
};

async function authFetch(path, options = {}) {
  const token = authInstance && authInstance.currentUser ? await authInstance.currentUser.getIdToken() : null;
  const res = await fetch(`${window.VELYNC_CONFIG.apiBase}${path}`, {
    ...options,
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, ...(options.headers || {}) },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

async function exportCollection(slug, btn) {
  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Exporting…'; }
  try {
    const payload = await authFetch(`/api/admin/export/${slug}`);
    const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const date = new Date().toISOString().slice(0, 10);
    a.href = url;
    a.download = `velync-${slug}-${date}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
    showToast(`Exported ${payload.count} ${LABEL[slug] || slug}`, 'success');
  } catch (err) {
    showToast('Export failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

function pickFile() {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.onchange = () => resolve(input.files && input.files[0] ? input.files[0] : null);
    input.click();
  });
}

async function importCollection(slug, btn) {
  const file = await pickFile();
  if (!file) return;

  let parsed;
  try {
    parsed = JSON.parse(await file.text());
  } catch (_) {
    showToast('That file is not valid JSON.', 'error');
    return;
  }
  const docs = Array.isArray(parsed) ? parsed : parsed.docs;
  if (!Array.isArray(docs) || docs.length === 0) {
    showToast('No documents found in that file.', 'error');
    return;
  }
  if (!Array.isArray(parsed) && parsed.collection && parsed.collection !== slug) {
    showToast(`That file is a "${parsed.collection}" export, not ${LABEL[slug] || slug}.`, 'error');
    return;
  }

  const ok = await confirmDialog({
    title: `Import ${LABEL[slug] || slug}?`,
    message: `This will add or overwrite ${docs.length} document(s) in ${LABEL[slug] || slug}, matched by id. Existing entries not in the file are left untouched. This cannot be undone — export a backup first if unsure.`,
    confirmText: 'Import',
  });
  if (!ok) return;

  const original = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Importing…'; }
  try {
    const result = await authFetch(`/api/admin/import/${slug}`, {
      method: 'POST',
      body: JSON.stringify({ collection: slug, docs }),
    });
    showToast(`Imported ${result.imported} ${LABEL[slug] || slug}`, 'success');
    const refreshBtn = document.getElementById(REFRESH_BTN_ID[slug]);
    if (refreshBtn) refreshBtn.click();
  } catch (err) {
    showToast('Import failed: ' + err.message, 'error');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = original; }
  }
}

let wired = false;

export function initAdminData(auth) {
  authInstance = auth;
  if (wired) return;
  wired = true;
  // Delegated so it works for every Export/Import button across the admin
  // tabs without per-button wiring.
  document.addEventListener('click', (e) => {
    const exp = e.target.closest('[data-export]');
    if (exp) { exportCollection(exp.dataset.export, exp); return; }
    const imp = e.target.closest('[data-import]');
    if (imp) { importCollection(imp.dataset.import, imp); return; }
  });
}
