#!/usr/bin/env bash
# Release the verified package (dist/pitchnest-api-prod.zip) to a Lambda function.
#
#   scripts/release-lambda.sh alias  <function> <api-url>
#     PROD: API Gateway invokes the `live` alias. Publish an immutable version,
#     smoke-test it directly, move `live`, then check the public API and move
#     `live` back if that check fails.
#
#   scripts/release-lambda.sh latest <function> <api-url>
#     DEV: API Gateway invokes $LATEST, so the upload is live at once. Smoke-test
#     it and check the public API; a failure fails the run (fix forward on DEV).
#
# Needs: aws (signed in), jq, curl. Every AWS call prints one field only, because
# function configuration (including environment variables) must never reach
# public CI logs.
set -euo pipefail

mode=${1:?usage: release-lambda.sh <alias|latest> <function> <api-url>}
fn=${2:?function name required}
api=${3:?public API URL required}
zip=dist/pitchnest-api-prod.zip
manifest=dist/pitchnest-api-prod.manifest.json

case "$mode" in
  alias | latest) ;;
  *) echo "::error::Unknown mode '$mode' (use alias or latest)." >&2; exit 2 ;;
esac

expected=$(jq -r .sha256_base64 "$manifest")
built_from=$(jq -r .gitCommit "$manifest")
commit=${GITHUB_SHA:-$built_from}
if [ "$built_from" != "$commit" ]; then
  echo "::error::The package was built from $built_from, not $commit." >&2
  exit 1
fi

record() {
  if [ -n "${GITHUB_OUTPUT:-}" ]; then echo "$1=$2" >> "$GITHUB_OUTPUT"; fi
}

# smoke <qualifier> <path>: GET <path> through the handler of that exact version.
smoke() {
  local qualifier=$1 path=$2 payload function_error status
  payload=$(jq -cn --arg p "$path" '{
    version: "2.0", routeKey: "$default", rawPath: $p, rawQueryString: "",
    headers: { host: "smoke" }, isBase64Encoded: false,
    requestContext: { stage: "$default",
      http: { method: "GET", path: $p, protocol: "HTTP/1.1", sourceIp: "127.0.0.1", userAgent: "smoke" } }
  }')
  rm -f smoke.json
  function_error=$(aws lambda invoke --function-name "$fn" --qualifier "$qualifier" \
    --cli-binary-format raw-in-base64-out --payload "$payload" \
    --query FunctionError --output text smoke.json) || return 1
  status=$(jq -r '.statusCode // "none"' smoke.json 2>/dev/null || echo "unreadable")
  echo "$fn:$qualifier GET $path -> $status"
  [ "$function_error" = "None" ] && [ "$status" = "200" ]
}

public_api_healthy() {
  local attempt
  for attempt in 1 2 3 4 5 6; do
    if curl -fsS --max-time 20 -o /dev/null "$api/api/health"; then return 0; fi
    echo "public health check attempt $attempt failed; retrying"
    sleep 10
  done
  return 1
}

previous=""
if [ "$mode" = alias ]; then
  previous=$(aws lambda get-alias --function-name "$fn" --name live --query FunctionVersion --output text)
  echo "live is on version $previous"
fi

uploaded=$(aws lambda update-function-code --function-name "$fn" --zip-file "fileb://$zip" \
  --query CodeSha256 --output text)
if [ "$uploaded" != "$expected" ]; then
  echo "::error::Uploaded CodeSha256 $uploaded does not match the package ($expected)." >&2
  exit 1
fi
aws lambda wait function-updated --function-name "$fn"
echo "uploaded ${commit:0:7} ($expected)"

if [ "$mode" = latest ]; then
  for path in /api/health /api/public/businesses; do
    if ! smoke '$LATEST' "$path"; then
      echo "::error::$fn failed GET $path after the update. Fix forward: push a corrected commit." >&2
      exit 1
    fi
  done
  if ! public_api_healthy; then
    echo "::error::The public API at $api failed its health check." >&2
    exit 1
  fi
  record version '$LATEST'
  exit 0
fi

# --code-sha256 refuses to publish if $LATEST changed in the meantime. With no
# change since the last version, Lambda returns that version instead.
version=$(aws lambda publish-version --function-name "$fn" --code-sha256 "$expected" \
  --description "${GITHUB_REF_NAME:-manual} ${commit:0:7} (run ${GITHUB_RUN_ID:-local})" \
  --query Version --output text)
echo "published version $version"

for path in /api/health /api/public/businesses; do
  if ! smoke "$version" "$path"; then
    echo "::error::Version $version failed GET $path. live stays on version $previous." >&2
    exit 1
  fi
done

if [ "$version" != "$previous" ]; then
  aws lambda update-alias --function-name "$fn" --name live --function-version "$version" \
    --query FunctionVersion --output text > /dev/null
fi
echo "live -> version $version"

if ! public_api_healthy; then
  echo "::error::The public API failed its health check. Moving live back to version $previous." >&2
  aws lambda update-alias --function-name "$fn" --name live --function-version "$previous" \
    --query FunctionVersion --output text > /dev/null
  exit 1
fi

record version "$version"
record previous "$previous"
