const activeLoads = new Set();

function updateBanner() {
  const span = document.querySelector('#offline-banner span');
  if (!span) return;
  if (!navigator.onLine) {
    span.textContent = activeLoads.size > 0
      ? `No internet available — ${activeLoads.size} operation${activeLoads.size > 1 ? 's' : ''} paused`
      : 'No internet available';
  }
}

export function startLoad(key) {
  activeLoads.add(key);
}

export function endLoad(key) {
  activeLoads.delete(key);
  updateBanner();
}

export function isLoading() {
  return activeLoads.size > 0;
}

let bound = false;
function ensureListeners() {
  if (bound) return;
  bound = true;
  window.addEventListener('offline', updateBanner);
  window.addEventListener('online', updateBanner);
}
ensureListeners();
