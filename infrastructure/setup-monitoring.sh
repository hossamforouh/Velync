#!/usr/bin/env bash
# Sets up the operational safety net for a Velync GCP project:
#   1. Daily Firestore backups (7-day retention)
#   2. An email notification channel for alerts
#   3. An uptime check on the backend /health endpoint (every 5 min)
#   4. Alert: backend DOWN (health check failing for 5+ minutes)
#   5. Alert: elevated 5xx error rate from the backend (>10 in 5 min)
#
# Idempotency: Firestore backup schedules error harmlessly if one already
# exists; uptime checks and alert policies will DUPLICATE if re-run, so
# check the Cloud Console (Monitoring > Alerting) before re-running.
#
# Usage:
#   ./infrastructure/setup-monitoring.sh velync-staging velync-backend-7ficeiyopq-uc.a.run.app you@example.com
#   ./infrastructure/setup-monitoring.sh velync         velync-backend-632548720073.us-central1.run.app you@example.com
set -euo pipefail

PROJECT="${1:?usage: setup-monitoring.sh <gcp-project> <backend-host> <alert-email>}"
BACKEND_HOST="${2:?backend host required (no https://, no path)}"
ALERT_EMAIL="${3:?alert email required}"

echo "── 1/5 Firestore daily backups (7d retention) on ${PROJECT}"
gcloud firestore backups schedules create \
  --database='(default)' --recurrence=daily --retention=7d \
  --project="${PROJECT}" || echo "  (backup schedule may already exist — fine)"

echo "── 2/5 Email notification channel → ${ALERT_EMAIL}"
CHANNEL=$(gcloud beta monitoring channels create \
  --display-name="Velync Admin Email" --type=email \
  --channel-labels="email_address=${ALERT_EMAIL}" \
  --project="${PROJECT}" --format="value(name)")
echo "  channel: ${CHANNEL}"

echo "── 3/5 Uptime check on https://${BACKEND_HOST}/health"
gcloud monitoring uptime create "velync-backend-health" \
  --protocol=https --resource-type=uptime-url \
  --resource-labels="host=${BACKEND_HOST},project_id=${PROJECT}" \
  --path=/health --period=5 --timeout=10 \
  --project="${PROJECT}"
CHECK_ID=$(gcloud monitoring uptime list-configs --project="${PROJECT}" \
  --filter="displayName=velync-backend-health" --format="value(name)" | awk -F/ '{print $NF}')
echo "  check id: ${CHECK_ID}"

TMPDIR_POLICIES=$(mktemp -d)
trap 'rm -rf "${TMPDIR_POLICIES}"' EXIT

echo "── 4/5 Alert policy: backend DOWN"
cat > "${TMPDIR_POLICIES}/uptime-policy.json" << EOF
{
  "displayName": "Velync ${PROJECT} — backend DOWN (health check failing)",
  "documentation": {
    "content": "The backend /health endpoint has been failing its uptime check for 5+ minutes. Check Cloud Run logs for velync-backend in ${PROJECT}.",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "Uptime check failing",
      "conditionThreshold": {
        "filter": "metric.type=\\"monitoring.googleapis.com/uptime_check/check_passed\\" AND resource.type=\\"uptime_url\\" AND metric.labels.check_id=\\"${CHECK_ID}\\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_NEXT_OLDER",
            "crossSeriesReducer": "REDUCE_COUNT_FALSE",
            "groupByFields": ["resource.label.host"]
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 1,
        "duration": "300s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "notificationChannels": ["${CHANNEL}"]
}
EOF
gcloud alpha monitoring policies create \
  --policy-from-file="${TMPDIR_POLICIES}/uptime-policy.json" --project="${PROJECT}"

echo "── 5/5 Alert policy: elevated 5xx errors"
cat > "${TMPDIR_POLICIES}/error-rate-policy.json" << EOF
{
  "displayName": "Velync ${PROJECT} — elevated backend 5xx errors",
  "documentation": {
    "content": "The velync-backend Cloud Run service in ${PROJECT} is returning an elevated number of 5xx responses (more than 10 in 5 minutes). Check Cloud Run logs and the Client Errors admin tab.",
    "mimeType": "text/markdown"
  },
  "combiner": "OR",
  "conditions": [
    {
      "displayName": "5xx responses over threshold",
      "conditionThreshold": {
        "filter": "metric.type=\\"run.googleapis.com/request_count\\" AND resource.type=\\"cloud_run_revision\\" AND resource.labels.service_name=\\"velync-backend\\" AND metric.labels.response_code_class=\\"5xx\\"",
        "aggregations": [
          {
            "alignmentPeriod": "300s",
            "perSeriesAligner": "ALIGN_SUM",
            "crossSeriesReducer": "REDUCE_SUM"
          }
        ],
        "comparison": "COMPARISON_GT",
        "thresholdValue": 10,
        "duration": "0s",
        "trigger": { "count": 1 }
      }
    }
  ],
  "notificationChannels": ["${CHANNEL}"]
}
EOF
gcloud alpha monitoring policies create \
  --policy-from-file="${TMPDIR_POLICIES}/error-rate-policy.json" --project="${PROJECT}"

echo "✓ Done. Backups, uptime check, and both alert policies are live on ${PROJECT}."
