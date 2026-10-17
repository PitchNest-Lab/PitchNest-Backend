#!/usr/bin/env bash
set -euo pipefail

# Legacy Cloud Run deploy path. Render is the primary deployment (render.yaml),
# but this script remains safe to use: secret VALUES never appear in the command
# line. Create the named Google Secret Manager secrets first, then pass only
# their resource names through the *_SECRET variables below.

required_vars=(
  AZURE_OPENAI_ENDPOINT
  AZURE_OPENAI_DEPLOYMENT
  AZURE_SPEECH_REGION
  SUPABASE_URL
  ALLOWED_ORIGIN
  CLIENT_URL
  APP_BASE_URL
  AZURE_OPENAI_API_KEY_SECRET
  AZURE_SPEECH_KEY_SECRET
  SUPABASE_SERVICE_ROLE_KEY_SECRET
  JWT_SECRET_RESOURCE
)

for var in "${required_vars[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "Missing required deployment variable: ${var}" >&2
    exit 1
  fi
done

gcloud run deploy pitchnest \
  --source . \
  --region "${GCP_REGION:-us-central1}" \
  --memory 2Gi \
  --allow-unauthenticated \
  --timeout=3600 \
  --min-instances=1 \
  --set-env-vars="AZURE_OPENAI_ENDPOINT=${AZURE_OPENAI_ENDPOINT},AZURE_OPENAI_DEPLOYMENT=${AZURE_OPENAI_DEPLOYMENT},AZURE_OPENAI_API_VERSION=${AZURE_OPENAI_API_VERSION:-2024-10-21},AZURE_SPEECH_REGION=${AZURE_SPEECH_REGION},SUPABASE_URL=${SUPABASE_URL},ALLOWED_ORIGIN=${ALLOWED_ORIGIN},CLIENT_URL=${CLIENT_URL},APP_BASE_URL=${APP_BASE_URL},NODE_ENV=production" \
  --set-secrets="AZURE_OPENAI_API_KEY=${AZURE_OPENAI_API_KEY_SECRET}:latest,AZURE_SPEECH_KEY=${AZURE_SPEECH_KEY_SECRET}:latest,SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY_SECRET}:latest,JWT_SECRET=${JWT_SECRET_RESOURCE}:latest"

echo "PitchNest Cloud Run deployment completed."
