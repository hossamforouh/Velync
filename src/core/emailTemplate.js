/**
 * Shared branded HTML shell for every outbound email (Firestore `mail`
 * collection, consumed by the Firebase "Trigger Email" extension). Colors
 * match the dashboard's own CSS variables (dashboard/public/style.css)
 * rather than a separate palette, so an email looks like it came from the
 * same product as the app.
 */

const COLORS = {
  bg: '#0F0F1A',
  card: '#16162A',
  border: 'rgba(255,255,255,0.08)',
  text1: '#E2E4F0',
  text2: '#A8AEC0',
  text3: '#7A8095',
  grad: 'linear-gradient(135deg, #818CF8 0%, #06B6D4 100%)',
  accents: {
    default: '#818CF8',
    success: '#34D399',
    warning: '#FBBF24',
    danger: '#FB7185',
  },
};

function escHtml(str) {
  return String(str ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/**
 * @param {object} opts
 * @param {string} opts.heading - Plain text, escaped automatically.
 * @param {string} opts.bodyHtml - Pre-built HTML (already escaped by the caller for any interpolated values).
 * @param {string} [opts.eyebrow] - Short uppercase label above the heading (e.g. "SYNC FAILED"), colored by `accent`.
 * @param {'default'|'success'|'warning'|'danger'} [opts.accent]
 * @param {string} [opts.ctaText]
 * @param {string} [opts.ctaUrl]
 * @param {string} [opts.footerNote] - Small print under the copyright line (e.g. an unsubscribe hint). Plain text, escaped automatically.
 */
function renderEmailHtml({ heading, bodyHtml, eyebrow, accent = 'default', ctaText, ctaUrl, footerNote }) {
  const accentColor = COLORS.accents[accent] || COLORS.accents.default;
  const eyebrowHtml = eyebrow ? `
              <div style="display:inline-block;padding:4px 12px;border-radius:20px;background:${accentColor}22;color:${accentColor};font-size:12px;font-weight:700;letter-spacing:0.5px;text-transform:uppercase;margin-bottom:16px;">${escHtml(eyebrow)}</div>` : '';
  const ctaHtml = ctaText && ctaUrl ? `
              <div style="text-align:center;margin-top:32px;">
                <a href="${ctaUrl}" style="display:inline-block;padding:15px 32px;background:${COLORS.grad};color:#ffffff;text-decoration:none;border-radius:12px;font-size:15px;font-weight:700;box-shadow:0 4px 15px rgba(129,140,248,0.35);">${escHtml(ctaText)}</a>
              </div>` : '';
  const footerNoteHtml = footerNote ? `<br>${escHtml(footerNote)}` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
</head>
<body style="margin:0;padding:0;background-color:${COLORS.bg};color:${COLORS.text1};font-family:'Helvetica Neue', Helvetica, Arial, sans-serif;">
  <table width="100%" border="0" cellspacing="0" cellpadding="0" style="background-color:${COLORS.bg};padding:40px 20px;">
    <tr>
      <td align="center">
        <table width="600" border="0" cellspacing="0" cellpadding="0" style="max-width:600px;width:100%;background-color:${COLORS.card};border-radius:16px;overflow:hidden;box-shadow:0 10px 30px rgba(0,0,0,0.5);border:1px solid ${COLORS.border};">
          <tr>
            <td align="center" style="padding:36px 0 32px;background:${COLORS.grad};">
              <span style="color:#ffffff;font-size:28px;font-weight:700;letter-spacing:0.5px;">Velync</span>
            </td>
          </tr>
          <tr>
            <td style="padding:40px;">${eyebrowHtml}
              <h2 style="color:${COLORS.text1};font-size:20px;margin:0 0 18px;">${escHtml(heading)}</h2>
              ${bodyHtml}${ctaHtml}
            </td>
          </tr>
          <tr>
            <td align="center" style="padding:22px;background-color:${COLORS.bg};border-top:1px solid ${COLORS.border};">
              <p style="color:${COLORS.text3};font-size:12px;margin:0;line-height:18px;">
                © 2026 Velync — Secure integrations for modern teams.${footerNoteHtml}
              </p>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

/** Standard paragraph styling for use inside `bodyHtml`. */
function p(html) {
  return `<p style="color:${COLORS.text2};font-size:15px;line-height:23px;margin:0 0 16px;">${html}</p>`;
}

module.exports = { renderEmailHtml, escHtml, p, COLORS };
