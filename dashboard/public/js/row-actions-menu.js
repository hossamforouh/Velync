// Shared "⋮" row-actions dropdown menu — wiring, positioning, and
// open/close behavior for table rows. Originally implemented separately
// (and slightly differently) in connections.js and app.js; extracted here
// so every table (Connections, Active Flows, and the Admin Panel tables)
// uses one identical menu instead of each page re-inventing it.
//
// Expected markup per row:
//   <div class="row-actions-dropdown">
//     <button class="row-action-btn btn-row-more" type="button">⋮</button>
//     <div class="row-actions-menu"> ...row-action-menu-item buttons... </div>
//   </div>
//
// Call wireRowActionsMenus() after rendering rows — it skips buttons
// already wired, so it's safe to call on every re-render.

let globalCloseListenerAttached = false;

export function wireRowActionsMenus() {
  document.querySelectorAll('.btn-row-more').forEach(btn => {
    if (btn.dataset.rowMenuWired) return;
    btn.dataset.rowMenuWired = 'true';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const menu = btn.parentElement.querySelector('.row-actions-menu');
      if (!menu) return;
      const isOpen = menu.classList.contains('open');
      closeAllRowActionsMenus();
      if (!isOpen) {
        positionRowActionsMenu(btn, menu);
        menu.classList.add('open');
        btn.classList.add('open');
      }
    });
  });

  if (!globalCloseListenerAttached) {
    globalCloseListenerAttached = true;
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.row-actions-dropdown')) {
        closeAllRowActionsMenus();
      }
    });
  }
}

// Menus are `position: absolute` by default (see .row-actions-menu in
// style.css), which gets clipped by the table's own scroll boundary for
// rows near the bottom of the visible area — so we switch to `position:
// fixed`, computed from the button's rect, flipping upward when there's
// no room below.
function positionRowActionsMenu(btn, menu) {
  const btnRect = btn.getBoundingClientRect();
  const wrapper = btn.closest('.grid-table-wrapper, .connections-table-wrap');
  const wrapperRect = wrapper ? wrapper.getBoundingClientRect() : { right: window.innerWidth };
  const menuWidth = menu.offsetWidth || 180;
  const menuHeight = menu.offsetHeight || 100;
  const left = Math.max(0, Math.min(btnRect.right - menuWidth, wrapperRect.right - menuWidth));
  const spaceBelow = window.innerHeight - btnRect.bottom - 4;

  menu.style.position = 'fixed';
  menu.style.left = left + 'px';
  if (spaceBelow >= menuHeight) {
    menu.style.top = btnRect.bottom + 4 + 'px';
    menu.style.bottom = 'auto';
  } else {
    menu.style.top = 'auto';
    menu.style.bottom = (window.innerHeight - btnRect.top + 4) + 'px';
  }
}

export function closeAllRowActionsMenus() {
  document.querySelectorAll('.row-actions-menu.open').forEach(m => {
    m.classList.remove('open');
    m.style.position = '';
    m.style.left = '';
    m.style.top = '';
    m.style.bottom = '';
  });
  document.querySelectorAll('.btn-row-more.open').forEach(b => b.classList.remove('open'));
}
