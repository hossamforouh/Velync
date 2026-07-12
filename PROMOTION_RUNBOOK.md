# Velync — Staging → Production Promotion Runbook

## Model: one branch, two deploy targets

This project commits directly on `main` — there's no `develop`/feature-branch
workflow, and this split doesn't introduce one. Staging and production are
**not** different branches; they're the same code deployed to two different
Firebase/GCP projects (`staging` / `production` aliases in `.firebaserc`).
"Promotion" means re-running the deploy against the other target once
staging looks good — not merging anything.

```
edit code on main
      │
      ▼
npm run deploy:staging      (backend + hosting → staging project)
      │
      ▼
verify on staging          (bash scripts/test-staging.sh, manual QA,
      │                      P0-VALIDATION.md for real-credential checks)
      ▼
commit on main              (only when the change is done and verified)
      │
      ▼
deploy to production         (see "Production deploy" below — manual,
                              confirmed step, never scripted/automatic)
```

Because there's no branch divergence, staging and `main` can never drift out
of sync the way a long-lived branch would — staging is always "whatever's on
`main` right now, deployed to the staging project." If you need to keep
working on the next change while staging is mid-verification, that's fine —
just don't deploy to production until the verified state is what's live on
staging.

## Staging deploy

```
npm run deploy:staging
```

Runs `infrastructure/cloudbuild.yaml` (backend → Cloud Run, staging project)
then `firebase deploy --only hosting -P staging`. Safe to run as often as
needed — it only ever targets the `staging` project alias, and
`scripts/deploy-staging.sh` refuses to run if that alias still points at
`velync` (production).

Then verify:
```
bash scripts/test-staging.sh          # basic smoke tests (set STAGING_URL, TEST_AUTH_TOKEN first)
```
For anything needing real third-party credentials (live OAuth token
refresh, a real Lemon Squeezy webhook, multi-instance lock behavior), see
`P0-VALIDATION.md` — those steps are the same whether run against staging
or production, staging is just the safe place to run them first.

## Production deploy

Deliberately **not** a single scripted command — this is the one step in the
whole pipeline that touches real user data and real billing, so it stays a
manual, confirmed sequence (matches this project's existing convention, see
CLAUDE.md's Deployment section):

```
# Backend (only if backend code changed):
gcloud run deploy velync-backend --source . --project velync --region us-central1

# Frontend (only if dashboard/public changed):
firebase deploy --only hosting -P production
```

Before running either: confirm staging verification actually passed for this
change, and that this is a change the user has explicitly approved deploying
to production right now. If only one side (backend or frontend) changed,
only deploy that side.

## What's still gated on your go-ahead, not automated

- **Pre-launch data scrub** of the `velync` (production) Firestore — this
  project's test data (workspaces, sync configs, connections created during
  development) needs clearing before real users sign up. Not built yet,
  deliberately — do this right before launch, not now, and only on your
  explicit instruction (it's a destructive, hard-to-reverse operation against
  the project that will become the live production system).
- Anything in `STAGING_CHECKLIST.md` Section A (one-time GCP/Firebase
  project creation, billing, OAuth app registration, Lemon Squeezy test
  store) — requires your own accounts/logins, can't be done on your behalf.
