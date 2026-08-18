#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Does the deployment actually work?
#
# "The deployment works properly" is worth marks, and the usual way a team
# finds out it does not is a demo that fails. This exercises the real API the
# way the frontend does — sign in, presign an upload, read the library, probe
# every AWS service — and prints one line per check.
#
#   ./scripts/verify-deployment.sh http://<elastic-ip>
#   ./scripts/verify-deployment.sh https://xxxx.execute-api.us-east-1.amazonaws.com/prod
#
# Read-only apart from creating one throwaway guest account, which expires by
# itself after 30 days. Requires curl. Uses jq if present, falls back to grep.
# ---------------------------------------------------------------------------

set -uo pipefail

BASE="${1:-}"
if [ -z "$BASE" ]; then
  echo "usage: $0 <api-base-url>"
  exit 2
fi
BASE="${BASE%/}"

PASS=0
FAIL=0
green() { printf '\033[32m%s\033[0m' "$1"; }
red() { printf '\033[31m%s\033[0m' "$1"; }
dim() { printf '\033[2m%s\033[0m' "$1"; }

ok()   { printf '  %s  %-26s %s\n' "$(green '  OK  ')" "$1" "$(dim "${2:-}")"; PASS=$((PASS+1)); }
bad()  { printf '  %s  %-26s %s\n' "$(red 'FAILED')" "$1" "$(dim "${2:-}")"; FAIL=$((FAIL+1)); }

# jq is not installed on a fresh Amazon Linux box, and asking people to install
# it before they can check their own deployment is a poor trade.
json_field() {
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -r "$2 // empty" 2>/dev/null
  else
    local key="${2##*.}"
    printf '%s' "$1" | grep -o "\"${key}\":\"[^\"]*\"" | head -1 | cut -d'"' -f4
  fi
}

echo
echo "Verifying $BASE"
echo "============================================================"
echo

# --- reachability ----------------------------------------------------------
echo "API"
echo "------------------------------------------------------------"
HEALTH=$(curl -fsS --max-time 10 "$BASE/health" 2>&1)
if [ $? -ne 0 ]; then
  bad "reachable" "$(printf '%s' "$HEALTH" | head -1)"
  echo
  echo "  Nothing else can be checked until the API answers."
  echo "  Hangs = security group. Refused = nginx. 502 = the Node process."
  exit 1
fi
ok "reachable"

PROVIDERS=$(json_field "$HEALTH" '.providers | join(", ")')
if command -v jq >/dev/null 2>&1; then
  COUNT=$(printf '%s' "$HEALTH" | jq '.providers | length' 2>/dev/null || echo 0)
else
  COUNT=$(printf '%s' "$HEALTH" | grep -o '"providers":\[[^]]*\]' | grep -o '"' | wc -l)
  COUNT=$((COUNT / 2))
fi
if [ "${COUNT:-0}" -ge 2 ]; then
  ok "AI providers" "${PROVIDERS:-2 configured} — failover available"
elif [ "${COUNT:-0}" -eq 1 ]; then
  bad "AI providers" "only one configured; a rate limit mid-demo has nowhere to fall back to"
else
  bad "AI providers" "none configured — recap generation will 503"
fi
echo

# --- AWS services ----------------------------------------------------------
echo "AWS services"
echo "------------------------------------------------------------"
DEEP=$(curl -fsS --max-time 25 "$BASE/health?deep=1" 2>&1)
if [ $? -ne 0 ]; then
  bad "deep health check" "endpoint did not answer"
else
  for svc in DynamoDB S3 Cognito Textract Polly; do
    # Each service appears as {"name":"S3","ok":true,...}
    ENTRY=$(printf '%s' "$DEEP" | grep -o "{[^{}]*\"name\":\"$svc\"[^{}]*}")
    if [ -z "$ENTRY" ]; then
      bad "$svc" "not reported — is it configured?"
    elif printf '%s' "$ENTRY" | grep -q '"ok":true'; then
      MS=$(printf '%s' "$ENTRY" | grep -o '"ms":[0-9]*' | cut -d: -f2)
      ok "$svc" "${MS:-?} ms"
    else
      ERR=$(printf '%s' "$ENTRY" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
      bad "$svc" "${ERR:-unreachable}"
    fi
  done
fi
echo

# --- the real request path -------------------------------------------------
echo "Request path"
echo "------------------------------------------------------------"
GUEST=$(curl -fsS --max-time 10 -X POST "$BASE/auth/guest" 2>&1)
TOKEN=$(json_field "$GUEST" '.token')

if [ -z "$TOKEN" ]; then
  bad "guest sign-in" "no token returned"
else
  ok "guest sign-in" "session token issued"

  ME=$(curl -fsS --max-time 10 -H "Authorization: Bearer $TOKEN" "$BASE/auth/me" 2>&1)
  [ -n "$(json_field "$ME" '.id')" ] && ok "authorizer" "token accepted" || bad "authorizer" "token rejected"

  LIB=$(curl -fsS --max-time 10 -H "Authorization: Bearer $TOKEN" "$BASE/materials" 2>&1)
  case "$LIB" in
    \[*) ok "library read" "DynamoDB query returned a list" ;;
    *)   bad "library read" "unexpected response" ;;
  esac

  UP=$(curl -fsS --max-time 10 -X POST "$BASE/uploads" \
        -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
        -d '{"fileName":"verify.pdf","contentType":"application/pdf","sizeBytes":1024}' 2>&1)
  URL=$(json_field "$UP" '.uploadUrl')
  if printf '%s' "$URL" | grep -q '^https://'; then
    ok "presigned upload" "S3 PUT URL issued"
  else
    bad "presigned upload" "no URL — check the bucket and the instance profile"
  fi

  # 401 here is the correct answer: an unauthenticated caller must not read
  # someone's library.
  CODE=$(curl -s -o /dev/null -w '%{http_code}' --max-time 10 "$BASE/materials")
  [ "$CODE" = "401" ] && ok "auth is enforced" "unauthenticated read rejected" \
                      || bad "auth is enforced" "expected 401, got $CODE"
fi
echo

echo "============================================================"
if [ "$FAIL" -eq 0 ]; then
  printf '  %s  %s\n' "$(green 'READY')" "$PASS checks passed."
  echo
  echo "  Now do the part this cannot: upload a real deck through the UI and"
  echo "  read the recap. This proves the plumbing, not the output."
else
  printf '  %s  %s\n' "$(red 'NOT READY')" "$FAIL of $((PASS+FAIL)) checks failed."
  echo
  echo "  docs/EC2-DEPLOYMENT.md has a table of what each failure usually means."
  exit 1
fi
echo
