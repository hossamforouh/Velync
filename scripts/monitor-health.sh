#!/usr/bin/env bash
# Velync — Health check monitor (Section D1)
#
# Runs as a cron job (recommended: every 5 minutes) to check the staging/
# production health endpoint and send alerts on failure.
#
# Usage:
#   export HEALTH_CHECK_URL=https://velync-staging-<hash>.run.app/health
#   export ALERT_EMAIL=ops@velync.io       # optional: uses mail command
#   export ALERT_SLACK_WEBHOOK=<url>        # optional: Slack webhook
#   export ALERT_PAGERDUTY_KEY=<key>        # optional: PagerDuty Events API v2
#   bash scripts/monitor-health.sh
#
# Recommended cron: */5 * * * * HEALTH_CHECK_URL=... bash /path/to/scripts/monitor-health.sh

set -euo pipefail

URL="${HEALTH_CHECK_URL:-http://localhost:8080/health}"
TIMEOUT=10
STATE_FILE="${TMPDIR:-/tmp}/velync-health-state"
MAX_FAILURES=3

alert_slack() {
  local msg="$1"
  if [ -n "${ALERT_SLACK_WEBHOOK:-}" ]; then
    curl -s -X POST "$ALERT_SLACK_WEBHOOK" \
      -H "Content-Type: application/json" \
      -d "{\"text\": \"🚨 Velync Health Alert: $msg\"}" \
      -o /dev/null || true
  fi
}

alert_email() {
  local msg="$1"
  if [ -n "${ALERT_EMAIL:-}" ] && command -v mail &>/dev/null; then
    echo "Velync Health Alert: $msg" | mail -s "[Velync] Health Alert" "$ALERT_EMAIL" || true
  fi
}

alert_pagerduty() {
  local msg="$1"
  if [ -n "${ALERT_PAGERDUTY_KEY:-}" ]; then
    curl -s -X POST "https://events.pagerduty.com/v2/enqueue" \
      -H "Content-Type: application/json" \
      -d "{
        \"routing_key\": \"$ALERT_PAGERDUTY_KEY\",
        \"event_action\": \"trigger\",
        \"payload\": {
          \"summary\": \"Velync health check failed: $msg\",
          \"source\": \"monitor-health.sh\",
          \"severity\": \"critical\"
        }
      }" -o /dev/null || true
  fi
}

# ── Check ─────────────────────────────────────
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" --max-time "$TIMEOUT" "$URL" 2>/dev/null || echo "000")

if [ "$HTTP_CODE" = "200" ]; then
  # Success — reset failure count
  echo 0 > "$STATE_FILE"
  exit 0
fi

# ── Failure handling ──────────────────────────
CURRENT=$(cat "$STATE_FILE" 2>/dev/null || echo 0)
CURRENT=$((CURRENT + 1))
echo "$CURRENT" > "$STATE_FILE"

if [ "$CURRENT" -ge "$MAX_FAILURES" ]; then
  MSG="Health check returned HTTP $HTTP_CODE after ${CURRENT} consecutive failures. URL: $URL"
  alert_slack "$MSG"
  alert_email "$MSG"
  alert_pagerduty "$MSG"
  echo "$MSG" >&2
  # Reset to avoid repeated alerts every 5 minutes
  echo 0 > "$STATE_FILE"
  exit 1
fi

echo "Warning: Health check failed ($HTTP_CODE), consecutive failures: $CURRENT/$MAX_FAILURES" >&2
exit 1
