#!/usr/bin/env bash
# Deploys NexusMail to Cloud Run and puts Firebase Hosting in front of it. Safe to re-run (it updates in place).
# Needs: gcloud CLI, firebase CLI (npm i -g firebase-tools), both logged in, Blaze plan on the project.
set -euo pipefail
PROJECT="${PROJECT:-balit-and-sons-technologies}"
REGION="${REGION:-us-central1}"
SERVICE=nexusmail
BUCKET="${PROJECT}-nexusmail-data"
cd "$(dirname "$0")/../.."

command -v gcloud >/dev/null || { echo "Install the gcloud CLI first: https://cloud.google.com/sdk/docs/install"; exit 1; }
command -v firebase >/dev/null || { echo "Install the Firebase CLI first: npm i -g firebase-tools"; exit 1; }
gcloud config set project "$PROJECT" >/dev/null

echo "== Enabling APIs"
gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firebasehosting.googleapis.com storage.googleapis.com

NUM="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
SA="${NUM}-compute@developer.gserviceaccount.com"

echo "== Data bucket gs://$BUCKET"
gcloud storage buckets describe "gs://$BUCKET" >/dev/null 2>&1 || gcloud storage buckets create "gs://$BUCKET" --location="$REGION" --uniform-bucket-level-access
gcloud storage buckets add-iam-policy-binding "gs://$BUCKET" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin >/dev/null

put_secret() { # name value
  if gcloud secrets describe "$1" >/dev/null 2>&1; then printf %s "$2" | gcloud secrets versions add "$1" --data-file=- >/dev/null
  else printf %s "$2" | gcloud secrets create "$1" --data-file=- >/dev/null; fi
  gcloud secrets add-iam-policy-binding "$1" --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor >/dev/null
}
SECRETS="ADMIN_PASSWORD=nexusmail-admin-password:latest"
if ! gcloud secrets describe nexusmail-admin-password >/dev/null 2>&1 || [ -n "${NEW_ADMIN_PASSWORD:-}" ]; then
  PW="${NEW_ADMIN_PASSWORD:-}"
  if [ -z "$PW" ]; then read -r -s -p "Choose an admin password for NexusMail (blank = generate one): " PW; echo; fi
  if [ -z "$PW" ]; then PW="$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | head -c 20)"; echo "Generated admin password: $PW   (save it now)"; fi
  put_secret nexusmail-admin-password "$PW"
fi
if [ -n "${GEMINI_API_KEY:-}" ]; then put_secret nexusmail-gemini-key "$GEMINI_API_KEY"; fi
if gcloud secrets describe nexusmail-gemini-key >/dev/null 2>&1; then SECRETS="$SECRETS,GEMINI_API_KEY=nexusmail-gemini-key:latest"; else
  echo "Tip: GEMINI_API_KEY=... ./deploy.sh adds your Gemini key (AI replies and the Inbox Agent need it)."; fi

URL="https://${PROJECT}.web.app"
echo "== Deploying Cloud Run service (first build takes a few minutes)"
gcloud run deploy "$SERVICE" --source . --region "$REGION" \
  --allow-unauthenticated --execution-environment gen2 \
  --min-instances 1 --max-instances 1 --no-cpu-throttling --cpu 1 --memory 512Mi --timeout 3600 \
  --add-volume "name=data,type=cloud-storage,bucket=$BUCKET" --add-volume-mount "volume=data,mount-path=/app/data" \
  --set-env-vars "TRUST_PROXY=1,DATA_DIR=/app/data,PUBLIC_URL=$URL,APP_TIMEZONE=Asia/Kolkata,GEMINI_MODEL=${GEMINI_MODEL:-gemini-3.8-flash}" \
  --set-secrets "$SECRETS"

echo "== Deploying Firebase Hosting"
firebase deploy --only hosting --project "$PROJECT"
echo
echo "NexusMail is live at: $URL"
