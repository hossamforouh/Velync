document.addEventListener('DOMContentLoaded', () => {
  const urlParams = new URLSearchParams(window.location.search);
  const code = urlParams.get('code');
  const state = urlParams.get('state');
  const error = urlParams.get('error');

  const titleEl = document.getElementById('title');
  const subtitleEl = document.getElementById('subtitle');
  const loaderEl = document.getElementById('loader');
  const errorEl = document.getElementById('error-msg');

  function showError(msg) {
    loaderEl.style.display = 'none';
    titleEl.textContent = 'Connection Failed';
    subtitleEl.textContent = 'We could not complete the integration setup.';
    errorEl.textContent = msg;
    errorEl.style.display = 'block';
  }

  function showSuccess() {
    loaderEl.style.display = 'none';
    titleEl.textContent = 'Connection Successful!';
    titleEl.style.color = '#34d399';
    subtitleEl.textContent = 'Your credentials have been securely saved. You can close this window.';
  }

  if (error) {
    showError(`Provider returned an error: ${error}`);
    return;
  }

  if (!code || !state) {
    showError('Invalid callback URL. Missing authorization code or state parameter.');
    return;
  }

  // Guard against posting the same authorization code twice — a reload or
  // bfcache restore of this exact callback URL (e.g. before the 1.5s
  // auto-close fires) would otherwise re-run this script and re-post the
  // same one-time-use code, which the opener would exchange again and the
  // provider would correctly reject as invalid_grant (harmless in that the
  // first exchange already succeeded, but it surfaces a confusing error).
  const dedupeKey = 'velync_oauth_code_posted_' + code;
  if (sessionStorage.getItem(dedupeKey)) {
    showSuccess();
    return;
  }
  sessionStorage.setItem(dedupeKey, '1');

  let platformId = 'unknown';
  let label = 'OAuth Connection';
  let workspaceId = null;
  let attributes = {};
  try {
    const decoded = JSON.parse(atob(state));
    platformId = decoded.platformId || platformId;
    label = decoded.label || label;
    workspaceId = decoded.workspaceId || null;
    attributes = decoded.attributes || {};
  } catch (e) {
    platformId = state;
  }

  // Relay the auth code to the opener window (which has Firebase Auth)
  if (window.opener) {
    window.opener.postMessage({
      type: 'oauth-code',
      code,
      platformId,
      label,
      workspaceId,
      attributes
    }, window.location.origin);
    showSuccess();
    setTimeout(() => window.close(), 1500);
  } else {
    showError('No parent window found. Please try again from the dashboard.');
  }
});
