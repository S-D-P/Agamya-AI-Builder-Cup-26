#!/usr/bin/env bash
# Deploys Agamya to Google Cloud: Cloud Run · Cloud SQL for PostgreSQL 16 (pgvector) · Cloud Storage · Secret Manager ·
# Vertex AI (Gemini). Idempotent: re-running updates in place. Creates billable resources, so review first.
#
#   PROJECT=my-project ./scripts/deploy/cloudrun.sh                  # demo profile (default)
#   PROJECT=my-project PROFILE=production ./scripts/deploy/cloudrun.sh
#
# Profiles
#   demo        one service (PROCESS_ROLE=all), CPU always allocated while an instance is up, scales to zero when idle,
#               open sign-up and the shared judge accounts (JUDGE_ACCOUNTS=0 to turn them off). No sample data.
#   production  an API service (scales 0–10) and an internal worker service (min 1 instance, CPU always on).
#               Sample spaces off.
# Optional: REGION (us-central1), SQL_TIER (db-f1-micro), APP (agamya), BUCKET, INSTANCE, PUBLIC_ACCESS (1 = unauthenticated
# HTTPS; the app still requires sign-in), OIDC_ISSUER / OIDC_CLIENT_ID (+ secret ${APP}-oidc-client-secret).
set -euo pipefail

: "${PROJECT:?set PROJECT}"; REGION="${REGION:-us-central1}"; APP="${APP:-agamya}"; PROFILE="${PROFILE:-demo}"
INSTANCE="${INSTANCE:-${APP}-db}"; DB="${APP}"; DB_USER="${APP}_app"
BUCKET="${BUCKET:-${PROJECT}-${APP}-media}"; SQL_TIER="${SQL_TIER:-db-f1-micro}"; PUBLIC_ACCESS="${PUBLIC_ACCESS:-1}"
SA_NAME="${APP}-run"; SA="${SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
IMAGE="${REGION}-docker.pkg.dev/${PROJECT}/${APP}/app:$(date +%Y%m%d-%H%M%S)"
g() { gcloud --project "$PROJECT" "$@"; }
cd "$(dirname "$0")/../.."

echo "== APIs"
g services enable run.googleapis.com sqladmin.googleapis.com aiplatform.googleapis.com storage.googleapis.com \
  secretmanager.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com iamcredentials.googleapis.com

echo "== Service account (least privilege)"
g iam service-accounts describe "$SA" >/dev/null 2>&1 || g iam service-accounts create "$SA_NAME" --display-name "Agamya runtime"
for role in roles/aiplatform.user roles/cloudsql.client roles/logging.logWriter roles/monitoring.metricWriter; do
  g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$SA" --role "$role" --condition=None >/dev/null
done

echo "== Media bucket: private, uniform access, public access prevented. Retention is enforced by the app (per data"
echo "   class, audited); no blanket age rule, because evidence frames are kept after other raw media is purged."
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$BUCKET" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member "serviceAccount:$SA" --role roles/storage.objectAdmin >/dev/null
# Signed URLs are minted with the service account's own identity (IAM signBlob), not a key file.
g iam service-accounts add-iam-policy-binding "$SA" --member "serviceAccount:$SA" --role roles/iam.serviceAccountTokenCreator >/dev/null

echo "== Cloud SQL for PostgreSQL 16 (its own instance; reached through the Cloud SQL connector; automated backups)"
g sql instances describe "$INSTANCE" >/dev/null 2>&1 || g sql instances create "$INSTANCE" --database-version POSTGRES_16 --edition ENTERPRISE \
  --tier "$SQL_TIER" --region "$REGION" --storage-auto-increase --backup-start-time 03:00
g sql databases describe "$DB" --instance "$INSTANCE" >/dev/null 2>&1 || g sql databases create "$DB" --instance "$INSTANCE"

echo "== Secrets (generated once, never printed)"
secret() { g secrets describe "$1" >/dev/null 2>&1 || { head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | g secrets create "$1" --data-file=-; }; \
  g secrets add-iam-policy-binding "$1" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null; }
secret "${APP}-db-password"; secret "${APP}-ip-hash-salt"
DB_PASS="$(g secrets versions access latest --secret "${APP}-db-password")"
g sql users describe "$DB_USER" --instance "$INSTANCE" >/dev/null 2>&1 || g sql users create "$DB_USER" --instance "$INSTANCE" --password "$DB_PASS"
g secrets describe "${APP}-database-url" >/dev/null 2>&1 || \
  printf 'postgres://%s:%s@/%s?host=/cloudsql/%s:%s:%s' "$DB_USER" "$DB_PASS" "$DB" "$PROJECT" "$REGION" "$INSTANCE" | g secrets create "${APP}-database-url" --data-file=-
g secrets add-iam-policy-binding "${APP}-database-url" --member "serviceAccount:$SA" --role roles/secretmanager.secretAccessor >/dev/null
unset DB_PASS

echo "== Build image with Cloud Build (its own service account and staging bucket; the runtime identity cannot push images)"
g artifacts repositories describe "$APP" --location "$REGION" >/dev/null 2>&1 || g artifacts repositories create "$APP" --repository-format docker --location "$REGION"
BUILD_SA="${APP}-build@${PROJECT}.iam.gserviceaccount.com"; BUILD_BUCKET="${PROJECT}-${APP}-build"
g iam service-accounts describe "$BUILD_SA" >/dev/null 2>&1 || g iam service-accounts create "${APP}-build" --display-name "Agamya image build"
gcloud storage buckets describe "gs://$BUILD_BUCKET" >/dev/null 2>&1 || \
  gcloud storage buckets create "gs://$BUILD_BUCKET" --project "$PROJECT" --location "$REGION" --uniform-bucket-level-access --public-access-prevention
for role in roles/storage.objectAdmin roles/storage.legacyBucketReader; do
  gcloud storage buckets add-iam-policy-binding "gs://$BUILD_BUCKET" --member "serviceAccount:$BUILD_SA" --role "$role" >/dev/null
done
g artifacts repositories add-iam-policy-binding "$APP" --location "$REGION" --member "serviceAccount:$BUILD_SA" --role roles/artifactregistry.writer >/dev/null
g projects add-iam-policy-binding "$PROJECT" --member "serviceAccount:$BUILD_SA" --role roles/logging.logWriter --condition=None >/dev/null
sleep 30 # IAM bindings on a new service account take a moment to propagate
g builds submit --tag "$IMAGE" --region "$REGION" --service-account "projects/$PROJECT/serviceAccounts/$BUILD_SA" \
  --gcs-source-staging-dir "gs://$BUILD_BUCKET/source" --gcs-log-dir "gs://$BUILD_BUCKET/logs" .

# Canonical origin: Cloud Run's deterministic URL, known before deployment, so it is set once at deploy time.
# (A follow-up "services update" was observed to reset public access; nothing mutates the service after that step.)
PROJECT_NUMBER="$(g projects describe "$PROJECT" --format 'value(projectNumber)')"
ORIGIN_OF() { echo "https://$1-${PROJECT_NUMBER}.${REGION}.run.app"; }
ENV="NODE_ENV=production,GOOGLE_CLOUD_PROJECT=$PROJECT,GOOGLE_CLOUD_LOCATION=$REGION,STORAGE_DRIVER=gcs,GCS_BUCKET=$BUCKET,DB_POOL_MAX=5${OIDC_ISSUER:+,OIDC_ISSUER=$OIDC_ISSUER,OIDC_CLIENT_ID=$OIDC_CLIENT_ID}"
SECRETS="DATABASE_URL=${APP}-database-url:latest,IP_HASH_SALT=${APP}-ip-hash-salt:latest${OIDC_ISSUER:+,OIDC_CLIENT_SECRET=${APP}-oidc-client-secret:latest}"
COMMON=(--image "$IMAGE" --region "$REGION" --service-account "$SA" --add-cloudsql-instances "$PROJECT:$REGION:$INSTANCE" --set-secrets "$SECRETS" --memory 1Gi)
# Public = no invoker IAM check on the service (the app itself requires sign-in or a private sample space).
# Named PUBLIC_ACCESS, not PUBLIC: Windows defines PUBLIC (the shared user folder), which silently made deploys private.
AUTH=$([ "$PUBLIC_ACCESS" = 1 ] && echo --no-invoker-iam-check || echo --invoker-iam-check)
API="$([ "$PROFILE" = demo ] && echo "$APP" || echo "${APP}-api")"; URL="$(ORIGIN_OF "$API")"

if [ "$PROFILE" = demo ]; then
  echo "== Cloud Run: one service (api + worker), scales to zero. Live Moti is a WebSocket: a request may last up to"
  echo "   the timeout (1 h), and session affinity keeps a person's reconnects on the same instance."
  g run deploy "$APP" "${COMMON[@]}" --set-env-vars "$ENV,PROCESS_ROLE=all,PUBLIC_ORIGIN=$URL,SAMPLE_SPACES=0,ALLOW_SIGNUP=1,JUDGE_ACCOUNTS=${JUDGE_ACCOUNTS:-1}" \
    --no-cpu-throttling --min-instances 0 --max-instances 2 --concurrency 40 --timeout 3600 --session-affinity $AUTH
  SERVICES=("$APP")
else
  echo "== Cloud Run: worker (internal, always-on CPU; SKIP LOCKED makes extra instances safe)"
  g run deploy "${APP}-worker" "${COMMON[@]}" --set-env-vars "$ENV,PROCESS_ROLE=worker,PUBLIC_ORIGIN=$URL" \
    --invoker-iam-check --no-cpu-throttling --min-instances 1 --max-instances 3 --ingress internal
  echo "== Cloud Run: API"
  g run deploy "${APP}-api" "${COMMON[@]}" --set-env-vars "$ENV,PROCESS_ROLE=api,PUBLIC_ORIGIN=$URL" \
    --min-instances 0 --max-instances 10 --concurrency 40 --timeout 300 $AUTH
  SERVICES=("${APP}-api" "${APP}-worker")
fi

# Public access last (no invoker IAM check on the public service; the app itself requires sign-in or a sample space).
if [ "$PUBLIC_ACCESS" = 1 ]; then g run services update "${SERVICES[0]}" --region "$REGION" --no-invoker-iam-check >/dev/null; fi

echo "== Health"
# /readyz checks the database and storage. (Cloud Run's front end intercepts /healthz, so that path is for in-container use.)
sleep 10; curl -fsS "$URL/readyz"; echo; curl -fsS -o /dev/null "$URL/js/core.js" && echo "static assets: ok"
echo "Deployed: $URL"
