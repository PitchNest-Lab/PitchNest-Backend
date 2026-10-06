#!/usr/bin/env bash
set -euo pipefail

rm -rf dist/lambda dist/pitchnest-api.zip
mkdir -p dist/lambda

npx esbuild src/lambda.ts \
  --bundle \
  --platform=node \
  --target=node22 \
  --format=esm \
  --outfile=dist/lambda/index.mjs \
  --external:bcrypt \
  --external:better-sqlite3 \
  --banner:js="import { createRequire } from 'module'; const require = createRequire(import.meta.url);"

(cd dist/lambda && zip -r ../pitchnest-api.zip .)
echo "Built dist/pitchnest-api.zip (handler = index.handler)"
