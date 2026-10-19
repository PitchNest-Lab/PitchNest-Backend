#!/usr/bin/env bash
# Runs only after AWS refused the OIDC sign-in. It reports, as annotations
# visible on the run page:
#   - which account and role the role secret names (an ARN is not a secret)
#   - the claims GitHub presents to AWS, which the role's trust policy must match
# The OIDC token itself is never printed.
set -uo pipefail

role=${ROLE:-}
if [ -z "$role" ]; then
  echo "::warning title=AWS sign-in check::The role secret is empty or missing in this repository's Actions secrets."
else
  account=$(printf '%s' "$role" | cut -d: -f5)
  name=${role##*:role/}
  extra=""
  if printf '%s' "$role" | grep -q '[[:space:]]'; then extra=" It contains spaces or line breaks."; fi
  echo "::warning title=AWS sign-in check::The role secret names account ${account:-?}, role ${name:-?} (${#role} characters).${extra}"
fi

if [ -z "${ACTIONS_ID_TOKEN_REQUEST_URL:-}" ]; then
  echo "::warning title=AWS sign-in check::This job cannot request an OIDC token (id-token: write is missing)."
  exit 0
fi

token=$(curl -fsS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value)
payload=$(printf '%s' "$token" | cut -d. -f2 | tr '_-' '/+')
while [ $(( ${#payload} % 4 )) -ne 0 ]; do payload="${payload}="; done
claims=$(printf '%s' "$payload" | base64 -d 2>/dev/null)
sub=$(printf '%s' "$claims" | jq -r .sub)
aud=$(printf '%s' "$claims" | jq -r .aud)
echo "::warning title=AWS sign-in check::GitHub presents sub=${sub} aud=${aud}. The role's trust policy must allow exactly these."
