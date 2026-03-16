#!/bin/bash

# PitchNest Automated GCP Deployment Script
echo "🚀 Starting automated deployment for PitchNest to Google Cloud Run..."

# Ensure environment variables are passed or set locally
if [ -z "$GEMINI_API_KEY" ]; then
  echo "⚠️ Warning: GEMINI_API_KEY is not set in your environment."
fi

# Execute the Cloud Run deployment with optimized memory and timeout limits
gcloud run deploy pitchnest \
  --source . \
  --region us-central1 \
  --memory 2Gi \
  --allow-unauthenticated \
  --timeout=3600 \
  --min-instances=1 \
  --set-env-vars="GEMINI_API_KEY=$GEMINI_API_KEY,GCS_BUCKET_NAME=pitchnest-media-vault"

echo "✅ Deployment pipeline complete! PitchNest is live."