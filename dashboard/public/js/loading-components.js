/**
 * loading-components.js
 * Centralized templates for consistent loading states across the application.
 */

/**
 * Returns a standardized skeleton row for data tables.
 * @param {number} columns - Number of columns to span.
 * @returns {string} HTML string
 */
export function getSkeletonRowHTML(columns = 4) {
  let cells = '';
  for (let i = 0; i < columns; i++) {
    cells += `
      <td>
        <div class="skeleton-line" style="width: ${Math.random() * 40 + 40}%; height: 16px; border-radius: 4px;"></div>
      </td>`;
  }
  return `<tr>${cells}</tr>`;
}

/**
 * Returns standardized skeleton rows to fill a table.
 * @param {number} columns - Number of columns in the table.
 * @param {number} rows - Number of rows to generate.
 * @returns {string} HTML string
 */
export function getSkeletonTableHTML(columns = 4, rows = 4) {
  let html = '';
  for (let i = 0; i < rows; i++) {
    html += getSkeletonRowHTML(columns);
  }
  return html;
}

/**
 * Returns a standardized skeleton card for grids (e.g. Integration Hub).
 * @returns {string} HTML string
 */
export function getSkeletonCardHTML() {
  return `
    <div class="card skeleton-card" style="padding: 24px; border: 1px solid var(--border); border-radius: 12px; background: var(--card-bg);">
      <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 24px;">
        <div class="skeleton-line" style="width: 48px; height: 48px; border-radius: 12px;"></div>
        <div style="flex: 1;">
          <div class="skeleton-line long" style="height: 18px; margin-bottom: 8px;"></div>
          <div class="skeleton-line short" style="height: 14px;"></div>
        </div>
      </div>
      <div class="skeleton-line" style="width: 100%; height: 14px; margin-bottom: 8px;"></div>
      <div class="skeleton-line" style="width: 80%; height: 14px; margin-bottom: 24px;"></div>
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div class="skeleton-line" style="width: 60px; height: 28px; border-radius: 14px;"></div>
        <div class="skeleton-line" style="width: 32px; height: 32px; border-radius: 50%;"></div>
      </div>
    </div>
  `;
}

/**
 * Returns a grid of skeleton cards.
 * @param {number} count - Number of cards to generate.
 * @returns {string} HTML string
 */
export function getSkeletonCardGridHTML(count = 6) {
  let html = '';
  for (let i = 0; i < count; i++) {
    html += getSkeletonCardHTML();
  }
  return html;
}

/**
 * Returns a standardized skeleton layout for forms (e.g. side panel).
 * @returns {string} HTML string
 */
export function getSkeletonFormHTML() {
  return `
    <div class="skeleton-card" style="padding: 20px; border: none; background: transparent;">
      <div class="skeleton-line short" style="height: 24px; margin-bottom: 24px;"></div>
      <div class="skeleton-line" style="width: 120px; height: 32px; border-radius: 8px; margin-bottom: 32px;"></div>
      
      <div class="skeleton-line long" style="height: 16px; margin-bottom: 24px;"></div>
      
      <div class="skeleton-card" style="margin-bottom: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface);">
        <div class="skeleton-line long" style="height: 20px; margin-bottom: 8px;"></div>
        <div class="skeleton-line short" style="height: 20px; margin-bottom: 8px;"></div>
        <div class="skeleton-line" style="width: 80px; height: 20px;"></div>
      </div>
      
      <div class="skeleton-card" style="margin-bottom: 12px; padding: 16px; border: 1px solid var(--border); border-radius: 8px; background: var(--surface);">
        <div class="skeleton-line long" style="height: 20px; margin-bottom: 8px;"></div>
        <div class="skeleton-line short" style="height: 20px; margin-bottom: 8px;"></div>
        <div class="skeleton-line" style="width: 80px; height: 20px;"></div>
      </div>
    </div>
  `;
}

/**
 * Returns a centered spinner for empty states or small containers.
 * @param {string} text - Optional text to display below the spinner.
 * @returns {string} HTML string
 */
export function getEmptySpinnerHTML(text = 'Loading...') {
  return `
    <div class="empty-spinner-container" style="display: flex; flex-direction: column; align-items: center; justify-content: center; padding: 40px 20px; text-align: center; gap: 16px; color: var(--text-3);">
      <div class="spinner" style="width: 32px; height: 32px; border-width: 3px;"></div>
      ${text ? `<span style="font-size: 0.95rem; font-weight: 500;">${text}</span>` : ''}
    </div>
  `;
}

/**
 * Sets the loading state on a button — the one spinner+label treatment
 * every admin action button (Save, Refresh, Export, Import, Delete
 * Selected, ...) should use, so loading feedback looks the same everywhere
 * instead of some buttons getting a spinner and others just swapping text.
 * Uses a data attribute to store the original text if not provided.
 * @param {HTMLElement} btn - The button element
 * @param {boolean} isLoading - Whether the button is loading
 * @param {string} originalText - The original text to restore (optional)
 * @param {string} loadingLabel - Text shown next to the spinner while loading (optional, defaults to "Saving...")
 */
export function setButtonLoading(btn, isLoading, originalText = null, loadingLabel = 'Saving...') {
  if (!btn) return;

  if (isLoading) {
    if (!btn.dataset.originalText) {
      btn.dataset.originalText = originalText || btn.textContent.trim();
    }
    // Prevent multiple clicks
    btn.disabled = true;
    // Set fixed width to prevent layout shift if possible, or just add spinner
    btn.innerHTML = `<span class="spinner btn-spinner" style="width: 16px; height: 16px; border-width: 2px; margin-right: 8px; display: inline-block; vertical-align: middle;"></span> <span style="vertical-align: middle;">${loadingLabel}</span>`;
  } else {
    btn.disabled = false;
    if (btn.dataset.originalText) {
      btn.textContent = btn.dataset.originalText;
      delete btn.dataset.originalText;
    } else if (originalText) {
      btn.textContent = originalText;
    }
  }
}
