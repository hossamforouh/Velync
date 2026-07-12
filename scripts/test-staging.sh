#!/usr/bin/env bash
# Velync — Staging smoke-test suite (Section A2)
# Run this against your deployed staging Cloud Run URL after deploying.
#
# Usage:
#   export STAGING_URL=https://velync-staging-<hash>.us-central1.run.app
#   export TEST_AUTH_TOKEN=<valid Firebase ID token for a test user>
#   export TEST_WORKSPACE_ID=<the test user's workspace ID>
#   bash scripts/test-staging.sh
#
# Requires: curl, jq
#   brew install jq
#
# Billing (Lemon Squeezy) is NOT exercised via CLI here — Lemon Squeezy has
# no event-trigger CLI equivalent to `stripe trigger`. Real webhook
# verification (Section A2.1) is a manual step: complete a real TEST MODE
# checkout in the browser and watch the staging backend logs /
# `execution_logs`-equivalent for the webhook landing and the workspace doc
# updating. See P0-VALIDATION.md Section C.

set -euo pipefail
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; NC='\033[0m'
pass=0; fail=0; skip=0

assert_status() {
  local desc="$1" url="$2" expect="$3" method="${4:-GET}" body="${5:-}"
  local resp
  if [ "$method" = "GET" ]; then
    resp=$(curl -s -o /dev/null -w "%{http_code}" -H "Authorization: Bearer $TEST_AUTH_TOKEN" "$url")
  else
    resp=$(curl -s -o /dev/null -w "%{http_code}" -X "$method" -H "Authorization: Bearer $TEST_AUTH_TOKEN" -H "Content-Type: application/json" -d "$body" "$url")
  fi
  if [ "$resp" = "$expect" ]; then
    echo -e "  ${GREEN}✓${NC} $desc"
    pass=$((pass+1))
  else
    echo -e "  ${RED}✗${NC} $desc (expected $expect, got $resp)"
    fail=$((fail+1))
  fi
}

assert_json() {
  local desc="$1" url="$2" jq_filter="$3" method="${4:-GET}" body="${5:-}"
  local resp
  if [ "$method" = "GET" ]; then
    resp=$(curl -s -H "Authorization: Bearer $TEST_AUTH_TOKEN" "$url")
  else
    resp=$(curl -s -X "$method" -H "Authorization: Bearer $TEST_AUTH_TOKEN" -H "Content-Type: application/json" -d "$body" "$url")
  fi
  local val
  val=$(echo "$resp" | jq -r "$jq_filter" 2>/dev/null || echo "__jq_failed__")
  if [ "$val" = "true" ] || [ "$val" = "1" ]; then
    echo -e "  ${GREEN}✓${NC} $desc"
    pass=$((pass+1))
  else
    echo -e "  ${RED}✗${NC} $desc (jq '$jq_filter' returned: $val)"
    echo "    Response: $(echo "$resp" | head -c 300)"
    fail=$((fail+1))
  fi
}

echo "======================================================"
echo " Velync — Staging Smoke Tests (Section A2)"
echo " STAGING_URL=${STAGING_URL:-<not set>}"
echo "======================================================"
echo ""

if [ -z "${STAGING_URL:-}" ]; then
  echo -e "${RED}ERROR: STAGING_URL not set${NC}"
  exit 1
fi
if [ -z "${TEST_AUTH_TOKEN:-}" ]; then
  echo -e "${YELLOW}WARN: TEST_AUTH_TOKEN not set — skipping authenticated tests${NC}"
  skip=$((skip+1))
fi

BASE="$STAGING_URL/api"

# ──────────────────────────────────────────────
# A2.1 — Lemon Squeezy webhook (manual — see header note)
# ──────────────────────────────────────────────
echo ""
echo "─── A2.1: Lemon Squeezy webhook ───────────────────"
echo -e "  ${YELLOW}⚠ MANUAL: complete a real TEST MODE checkout in the browser,${NC}"
echo "    then verify in staging Firestore that the workspace doc's"
echo "    planId / lsSubscriptionId / subscriptionStatus fields updated:"
echo "    gcloud firestore documents list --collection=workspaces --project=<staging-project>"
echo "    Also confirm no 'signature' verification errors in Cloud Run logs:"
echo "    gcloud run services logs read velync-staging --project=<staging-project> --limit=50"
skip=$((skip+1))

# ──────────────────────────────────────────────
# A2.2 — Checkout → plan upgrade → unlock config
# ──────────────────────────────────────────────
echo ""
echo "─── A2.2: Checkout → upgrade flow ────────────────"
if [ -n "${TEST_AUTH_TOKEN:-}" ]; then
  assert_status "GET /api/billing/plan (authenticated)" "$BASE/billing/plan" 200
  echo -e "  ${YELLOW}⚠ MANUAL: run full checkout with a Lemon Squeezy TEST MODE card via browser${NC}"
  echo "    Visit ${STAGING_URL}/settings → billing tab → click 'Upgrade'"
  echo "    Use test card 4242 4242 4242 4242, exp any future date, CVC any 3 digits"
  skip=$((skip+1))
fi

# ──────────────────────────────────────────────
# A2.3 — Plan-limit enforcement (create + update)
# ──────────────────────────────────────────────
echo ""
echo "─── A2.3: Plan-limit enforcement ─────────────────"
if [ -n "${TEST_AUTH_TOKEN:-}" ]; then
  # Try creating a 2nd active config on Free plan
  assert_status \
    "POST /api/sync-configs — should reject 2nd active (Free limit=1)" \
    "$BASE/sync-configs" \
    403 \
    POST \
    '{"platform1":"notion","platform2":"ticktick","platform1ConnectionId":"test","platform2ConnectionId":"test","status":"active","description":"overflow"}'

  # Try updating an existing config with a tight cron
  assert_status \
    "PUT /api/sync-configs/dummy — cron too tight" \
    "$BASE/sync-configs/dummy" \
    403 \
    PUT \
    '{"cronSchedule":"* * * * *"}'

  # Try updating with a premium platform
  assert_status \
    "PUT /api/sync-configs/dummy — premium tier blocked" \
    "$BASE/sync-configs/dummy" \
    403 \
    PUT \
    '{"platform1":"premium-platform-id"}'
fi

# ──────────────────────────────────────────────
# A2.4 — General endpoint health
# ──────────────────────────────────────────────
echo ""
echo "─── A2.4: General endpoint health ───────────────"
assert_status "GET /" "$STAGING_URL" 200
assert_status "GET /api/admin/status" "$BASE/admin/status" 200
if [ -n "${TEST_AUTH_TOKEN:-}" ]; then
  assert_status "GET /api/workspace (authenticated)" "$BASE/workspace" 200
  assert_json "GET /api/billing/plan — has success field" "$BASE/billing/plan" ".success" GET
fi

# ──────────────────────────────────────────────
# A2.5 — Multi-instance lock (log-based)
# ──────────────────────────────────────────────
echo ""
echo "─── A2.5: Distributed lock ──────────────────────"
echo -e "  ${YELLOW}⚠ MANUAL: Deploy with --min-instances=2, then check logs:${NC}"
echo "    gcloud logging read 'resource.type=cloud_run_revision AND resource.labels.service_name=velync-staging AND \"lease\"' --limit 20"
echo "    Confirm only one instance's 'acquired lease' per config per tick."
echo "    Look for lines containing 'lease held by another instance' as evidence the lock worked."
skip=$((skip+1))

# ──────────────────────────────────────────────
# Results
# ──────────────────────────────────────────────
echo ""
echo "======================================================"
echo -e " Results: ${GREEN}$pass passed${NC}, ${RED}$fail failed${NC}, ${YELLOW}$skip skipped${NC}"
echo "======================================================"
if [ "$fail" -gt 0 ]; then
  exit 1
fi
