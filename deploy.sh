#!/bin/bash

# PitchNest Automated GCP Deployment Script
echo "🚀 Starting automated deployment for PitchNest to Google Cloud Run..."

required_vars=(
  AZURE_OPENAI_ENDPOINT
  AZURE_OPENAI_API_KEY
  AZURE_OPENAI_DEPLOYMENT
  AZURE_SPEECH_KEY
  AZURE_SPEECH_REGION
  SUPABASE_URL
  SUPABASE_ANON_KEY
  SUPABASE_SERVICE_ROLE_KEY
  JWT_SECRET
)

for var in "${required_vars[@]}"; do
  if [ -z "${!var}" ]; then
    echo "⚠️ Warning: $var is not set in your environment."
  fi
done

gcloud run deploy pitchnest \
  --source . \
  --region us-central1 \
  --memory 2Gi \
  --allow-unauthenticated \
  --timeout=3600 \
  --min-instances=1 \
  --set-env-vars="\
AZURE_OPENAI_ENDPOINT=${AZURE_OPENAI_ENDPOINT},\
AZURE_OPENAI_API_KEY=${AZURE_OPENAI_API_KEY},\
AZURE_OPENAI_DEPLOYMENT=${AZURE_OPENAI_DEPLOYMENT},\
AZURE_OPENAI_API_VERSION=${AZURE_OPENAI_API_VERSION:-2024-02-15-preview},\
AZURE_SPEECH_KEY=${AZURE_SPEECH_KEY},\
AZURE_SPEECH_REGION=${AZURE_SPEECH_REGION},\
SUPABASE_URL=${SUPABASE_URL},\
SUPABASE_ANON_KEY=${SUPABASE_ANON_KEY},\
SUPABASE_SERVICE_ROLE_KEY=${SUPABASE_SERVICE_ROLE_KEY},\
JWT_SECRET=${JWT_SECRET},\
ALLOWED_ORIGIN=${ALLOWED_ORIGIN},\
NODE_ENV=production"

echo "✅ Deployment pipeline complete! PitchNest is live."
