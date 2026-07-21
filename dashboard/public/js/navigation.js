/* =============================================================
   navigation.js — Sidebar View Router
   Controls which view-panel section is active.
   ============================================================= */

import { confirmDialog } from './confirm.js';

const VIEWS = ['hub', 'flows', 'connections', 'logs', 'admin', 'integration-setup', 'admin-platform-editor', 'admin-plan-editor'];

let currentView = 'flows';

/**
 * Navigate to a named view, hiding all other panels.
 * @param {string} viewName — one of: 'hub', 'flows', 'connections', 'logs'
 */
export async function navigateTo(viewName) {
  if (!VIEWS.includes(viewName)) {
    console.warn(`[navigation] Unknown view: "${viewName}"`);
    return;
  }

  if (window.hasUnsavedConfigChanges && window.hasUnsavedConfigChanges()) {
    const confirmed = await confirmDialog({
      title: 'Discard Changes?',
      message: 'You have unsaved changes. Are you sure you want to discard them and leave?',
      confirmText: 'Discard',
      confirmClass: 'btn-danger'
    });
    if (!confirmed) {
      return;
    }
    if (window.resetConfigDirty) {
      window.resetConfigDirty();
    }
  }

  if (currentView === 'integration-setup' && viewName !== 'integration-setup') {
    delete window.currentIntegration;
    const sidePanel = document.getElementById('side-panel');
    if (sidePanel && sidePanel.classList.contains('inline-mode')) {
      sidePanel.classList.remove('inline-mode');
      document.body.appendChild(sidePanel);
      const panelOverlay = document.getElementById('panel-overlay');
      if (panelOverlay) panelOverlay.style.display = '';
    }
  }

  // Dispatch view-left event for cache invalidation
  window.dispatchEvent(new CustomEvent('view-left', { detail: { view: currentView } }));

  currentView = viewName;

  // Toggle view panels
  VIEWS.forEach(v => {
    const panel = document.getElementById(`view-${v}`);
    if (panel) {
      panel.style.display = (v === viewName) ? '' : 'none';
    }
  });

  // Update sidebar active states
  VIEWS.forEach(v => {
    const navItem = document.getElementById(`nav-${v}`);
    if (navItem) {
      if (v === viewName) {
        navItem.classList.add('active');
      } else {
        navItem.classList.remove('active');
      }
    }
  });

  // Close sidebar on mobile after navigation
  const sidebar = document.getElementById('sidebar');
  const sidebarOverlay = document.getElementById('sidebar-overlay');
  if (sidebar) {
    sidebar.classList.remove('sidebar-open');
  }
  if (sidebarOverlay) {
    sidebarOverlay.classList.remove('show');
  }
  document.body.classList.remove('sidebar-open');
}

/**
 * Return the currently active view name.
 */
export function getCurrentView() {
  return currentView;
}

/**
 * Force the view state back to the default ('flows') without going through
 * navigateTo()'s unsaved-changes confirmation or view-left cleanup — those
 * are for a user *choosing* to navigate away, not appropriate mid
 * onAuthStateChanged. Call this on sign-out so the next sign-in (in the same
 * tab, no page reload) doesn't briefly flash whatever view-panel was left
 * visible from the previous session before the login flow's own
 * navigateTo('flows') call gets around to running.
 */
export function resetToDefaultView() {
  currentView = 'flows';
  VIEWS.forEach(v => {
    const panel = document.getElementById(`view-${v}`);
    if (panel) panel.style.display = (v === 'flows') ? '' : 'none';
    const navItem = document.getElementById(`nav-${v}`);
    if (navItem) navItem.classList.toggle('active', v === 'flows');
  });
}

/**
 * Bind click events to all sidebar nav items.
 * Call once after DOM is ready.
 */
export function bindNavEvents() {
  VIEWS.forEach(v => {
    const navItem = document.getElementById(`nav-${v}`);
    if (navItem) {
      navItem.addEventListener('click', () => navigateTo(v));
      navItem.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          navigateTo(v);
        }
      });
    }
  });
}
