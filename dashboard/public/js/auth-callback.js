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
