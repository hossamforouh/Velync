import { collection, query, where, orderBy, limit, getDocs }
  from "https://www.gstatic.com/firebasejs/10.9.0/firebase-firestore.js";

let cachedLogs = [];
let currentDb = null;
let currentWorkspaceId = null;
let filterListenersAttached = false;

function getFilters() {
  const search = (document.getElementById('logs-search')?.value || '').trim();
  const activePill = document.querySelector('.logs-filter-pill.active');
  const status = activePill?.dataset?.status || 'all';
  const fromDate = document.getElementById('logs-date-from')?.value || '';
  const toDate = document.getElementById('logs-date-to')?.value || '';
  return { search, status, fromDate, toDate };
}

function hasActiveFilters() {
  const f = getFilters();
  return f.search || f.status !== 'all' || f.fromDate || f.toDate;
}

export async function initLogs(db, workspaceId) {
  currentDb = db;
  currentWorkspaceId = workspaceId;

  const logsTbody = document.getElementById('logs-tbody');
  if (!logsTbody) return;

  if (!filterListenersAttached) {
    attachFilterListeners();
    filterListenersAttached = true;
  }

  await fetchLogs();
}

async function fetchLogs() {
  const logsTbody = document.getElementById('logs-tbody');
  if (!logsTbody) return;
  if (!currentDb || !currentWorkspaceId) return;

  logsTbody.innerHTML =
    '<tr><td colspan="4" style="text-align:center;padding:20px;">Loading logs...</td></tr>';

  const f = getFilters();
  const constraints = [
    where("workspaceId", "==", currentWorkspaceId),
    orderBy("startTime", "desc"),
  ];

  if (f.fromDate) {
    constraints.push(where("startTime", ">=", new Date(f.fromDate)));
  }
  if (f.toDate) {
    const endOfDay = new Date(f.toDate);
    endOfDay.setHours(23, 59, 59, 999);
    constraints.push(where("startTime", "<=", endOfDay));
  }

  constraints.push(limit(200));

  try {
    const q = query(collection(currentDb, "execution_logs"), ...constraints);
    const snapshot = await getDocs(q);
    cachedLogs = [];
    snapshot.forEach(doc => {
      cachedLogs.push({ id: doc.id, ...doc.data() });
    });
    renderLogs();
  } catch (err) {
    console.error("Error fetching logs:", err);
    logsTbody.innerHTML =
      `<tr><td colspan="4" style="text-align:center;padding:20px;color:var(--danger);">Failed to load logs: ${err.message}</td></tr>`;
  }
}

function renderLogs() {
  const logsTbody = document.getElementById('logs-tbody');
  if (!logsTbody) return;

  const f = getFilters();
  let filtered = [...cachedLogs];

  if (f.search) {
    const term = f.search.toLowerCase();
    filtered = filtered.filter(l =>
      (l.configName || '').toLowerCase().includes(term)
    );
  }

  if (f.status !== 'all') {
    filtered = filtered.filter(l => l.status === f.status);
  }

  const clearBtn = document.getElementById('logs-clear-filters');
  if (clearBtn) {
    clearBtn.style.display = hasActiveFilters() ? 'inline-flex' : 'none';
  }

  updateCount(filtered.length, cachedLogs.length, f);

  logsTbody.innerHTML = '';

  if (filtered.length === 0) {
    let emptyMsg = 'No execution logs found.';
    if (cachedLogs.length > 0 && hasActiveFilters()) {
      emptyMsg = 'No logs match the current filters. Try adjusting your search or filter criteria.';
    } else if (cachedLogs.length === 0 && hasActiveFilters() && (f.fromDate || f.toDate)) {
      emptyMsg = 'No logs found in the selected date range.';
    } else if (cachedLogs.length === 0) {
      emptyMsg = 'Logs will automatically appear here once your integrations start syncing.';
    }

    logsTbody.innerHTML = `
      <tr>
        <td colspan="4">
          <div style="padding:60px 16px;text-align:center;">
            <div style="margin-bottom:16px;color:var(--violet);display:inline-flex;align-items:center;justify-content:center;width:64px;height:64px;border-radius:50%;background:rgba(124,58,237,0.1);">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                <polyline points="22 12 18 12 15 21 9 3 6 12 2 12"></polyline>
              </svg>
            </div>
            <h3 style="margin-bottom:8px;color:var(--text-1);font-weight:600;font-size:1.1rem;">${emptyMsg}</h3>
          </div>
        </td>
      </tr>`;
    return;
  }

  filtered.forEach(log => {
    const tr = document.createElement('tr');

    const dateObj = new Date(log.startTime);
    const timeStr = dateObj.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const dateStr = dateObj.toLocaleDateString();

    let statusBadge = '';
    let details = '';

    if (log.status === 'running') {
      statusBadge = '<span class="badge badge-warning" style="background:rgba(245,158,11,0.2);color:#fcd34d;padding:4px 8px;border-radius:4px;font-size:0.8rem;font-weight:500;">Running</span>';
      details = 'Sync in progress...';
    } else if (log.status === 'success') {
      statusBadge = '<span class="badge badge-success" style="background:rgba(16,185,129,0.2);color:#6ee7b7;padding:4px 8px;border-radius:4px;font-size:0.8rem;font-weight:500;">Success</span>';
      const parts = [];
      if (log.syncedCount) parts.push(`Synced ${log.syncedCount}`);
      if (log.deletedCount) parts.push(`Deleted ${log.deletedCount}`);
      if (log.failedCount) parts.push(`Failed ${log.failedCount}`);
      details = parts.length > 0 ? parts.join('. ') + '.' : 'Sync completed.';
    } else {
      statusBadge = '<span class="badge badge-failed" style="background:rgba(239,68,68,0.2);color:#fca5a5;padding:4px 8px;border-radius:4px;font-size:0.8rem;font-weight:500;">Failed</span>';
      details = log.error || 'Unknown error occurred.';
    }

    tr.innerHTML = `
      <td style="color:var(--text-3);white-space:nowrap;">${dateStr} ${timeStr}</td>
      <td style="font-weight:500;">${log.configName || 'Unknown Integration'}</td>
      <td>${statusBadge}</td>
      <td style="color:var(--text-2);font-size:0.85rem;">${details}</td>
    `;
    logsTbody.appendChild(tr);
  });
}

function updateCount(shown, total, filters) {
  const el = document.getElementById('logs-count');
  if (!el) return;

  let label = `${shown} log${shown !== 1 ? 's' : ''}`;

  if (shown < total) {
    label += ` (filtered from ${total})`;
  } else if (total === 200) {
    label += ` (showing up to 200)`;
  }

  el.textContent = `Showing ${label}`;
}

function attachFilterListeners() {
  const searchInput = document.getElementById('logs-search');
  const searchClear = document.getElementById('logs-search-clear');
  const refreshBtn = document.getElementById('logs-refresh');
  const clearFiltersBtn = document.getElementById('logs-clear-filters');
  const dateFrom = document.getElementById('logs-date-from');
  const dateTo = document.getElementById('logs-date-to');

  let searchTimer = null;
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      if (searchClear) {
        searchClear.style.display = searchInput.value ? 'flex' : 'none';
      }
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => renderLogs(), 200);
    });
  }

  if (searchClear) {
    searchClear.addEventListener('click', () => {
      searchInput.value = '';
      searchClear.style.display = 'none';
      renderLogs();
    });
    searchClear.style.display = 'none';
  }

  document.querySelectorAll('.logs-filter-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      document.querySelectorAll('.logs-filter-pill').forEach(p => p.classList.remove('active'));
      pill.classList.add('active');
      renderLogs();
    });
  });

  if (dateFrom) {
    dateFrom.addEventListener('change', () => fetchLogs());
  }
  if (dateTo) {
    dateTo.addEventListener('change', () => fetchLogs());
  }

  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => fetchLogs());
  }

  if (clearFiltersBtn) {
    clearFiltersBtn.addEventListener('click', () => {
      if (searchInput) { searchInput.value = ''; }
      if (searchClear) { searchClear.style.display = 'none'; }
      if (dateFrom) { dateFrom.value = ''; }
      if (dateTo) { dateTo.value = ''; }
      document.querySelectorAll('.logs-filter-pill').forEach(p => p.classList.remove('active'));
      const allPill = document.querySelector('.logs-filter-pill[data-status="all"]');
      if (allPill) allPill.classList.add('active');
      fetchLogs();
    });
  }
}
