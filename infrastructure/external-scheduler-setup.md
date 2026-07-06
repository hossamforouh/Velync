# External Scheduler Setup (Decision 3)

Moves sync scheduling off the always-on Cloud Run instance. Instead of in-process
`node-cron`, **Cloud Scheduler** calls an HTTP tick endpoint on a fixed cadence.
The service can then scale to zero / run request-driven (`--min-instances=0`).

The code ships in a **safe, reversible** state: with `SCHEDULER_MODE` unset (or
`internal`), behaviour is unchanged (in-process cron still runs). Nothing switches
until you complete the steps below.

## Endpoints (already deployed with the app)
- `POST /api/internal/scheduler/tick` — runs all *due* configs.
- `POST /api/internal/scheduler/cleanup` — daily log-retention cleanup.

Both require header `X-Scheduler-Secret: <SCHEDULER_SECRET>`.

## 1. Pick a secret
```
SECRET=$(openssl rand -hex 32)
echo "$SECRET"   # keep this
```

## 2. Set env on the Cloud Run service, then redeploy the backend
```
gcloud run services update velync-backend --region us-central1 --project velync \
  --update-env-vars SCHEDULER_MODE=external,SCHEDULER_SECRET=$SECRET
```
(Or set them at deploy time.) With `SCHEDULER_MODE=external`, the in-process cron
is disabled on boot.

## 3. Create the Cloud Scheduler jobs
Tick every minute:
```
gcloud scheduler jobs create http velync-sync-tick \
  --location us-central1 --project velync \
  --schedule "* * * * *" \
  --uri "https://velync-backend-632548720073.us-central1.run.app/api/internal/scheduler/tick" \
  --http-method POST \
  --headers "X-Scheduler-Secret=$SECRET" \
  --attempt-deadline 300s
```
Daily cleanup at 02:00:
```
gcloud scheduler jobs create http velync-log-cleanup \
  --location us-central1 --project velync \
  --schedule "0 2 * * *" \
  --uri "https://velync-backend-632548720073.us-central1.run.app/api/internal/scheduler/cleanup" \
  --http-method POST \
  --headers "X-Scheduler-Secret=$SECRET"
```

## 4. (Optional) allow scale-to-zero
Once ticks are confirmed running:
```
gcloud run services update velync-backend --region us-central1 --project velync \
  --min-instances=0
```

## Rollback
```
gcloud scheduler jobs pause velync-sync-tick --location us-central1 --project velync
gcloud run services update velync-backend --region us-central1 --project velync \
  --update-env-vars SCHEDULER_MODE=internal --min-instances=1
```

## Verify
```
curl -s -X POST -H "X-Scheduler-Secret: $SECRET" \
  https://velync-backend-632548720073.us-central1.run.app/api/internal/scheduler/tick
# → {"ok":true,"due":N,"ran":N,"errors":0}
```
A missing/wrong secret returns 403; an unset server secret returns 503.
