#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# What can this Learner Lab account actually do?
#
# The published allowlist and what your account permits are not always the same
# thing, and the difference only shows up mid-deploy. This probes each service
# SmartRecap touches with a cheap read-only call and reports what came back.
#
# Nothing here creates, modifies or deletes anything. Safe to run any time.
#
#   chmod +x scripts/check-learner-lab.sh
#   ./scripts/check-learner-lab.sh
#
# Requires: aws CLI v2, and credentials already in ~/.aws/credentials.
# ---------------------------------------------------------------------------

set -uo pipefail

REGION="${AWS_REGION:-us-east-1}"
PASS=0
FAIL=0

green() { printf '\033[32m%s\033[0m' "$1"; }
red()   { printf '\033[31m%s\033[0m' "$1"; }
dim()   { printf '\033[2m%s\033[0m' "$1"; }

probe() {
  local label="$1"; shift
  local note="${NOTE:-}"
  local out
  if out=$("$@" 2>&1); then
    printf '  %s  %-22s %s\n' "$(green '  OK  ')" "$label" "$(dim "$note")"
    PASS=$((PASS + 1))
  else
    local reason
    reason=$(printf '%s' "$out" | grep -oE '(AccessDenied[A-Za-z]*|UnauthorizedOperation|OptInRequired|InvalidClientTokenId|ExpiredToken|not authorized[^"]*)' | head -1)
    printf '  %s  %-22s %s\n' "$(red 'BLOCKED')" "$label" "$(dim "${reason:-see below}")"
    [ -z "$reason" ] && printf '           %s\n' "$(dim "$(printf '%s' "$out" | head -1 | cut -c1-100)")"
    FAIL=$((FAIL + 1))
  fi
  NOTE=""
}

echo
echo "Learner Lab capability probe — region $REGION"
echo "============================================================"

# --- identity -------------------------------------------------------------
if ! IDENTITY=$(aws sts get-caller-identity --output text --query 'Arn' 2>&1); then
  echo
  red "Credentials are not working."; echo
  echo "$IDENTITY" | head -2
  echo
  echo "Copy a fresh block from the Learner Lab's 'AWS Details > AWS CLI: Show'"
  echo "into ~/.aws/credentials. They expire when the lab session ends."
  exit 1
fi
echo
echo "  Identity: $IDENTITY"
ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
echo "  Account:  $ACCOUNT"
echo

# --- what SmartRecap needs ------------------------------------------------
echo "Core services"
echo "------------------------------------------------------------"
probe "S3"            aws s3api list-buckets --region "$REGION"
probe "DynamoDB"      aws dynamodb list-tables --region "$REGION"
probe "Lambda"        aws lambda list-functions --max-items 1 --region "$REGION"
probe "API Gateway"   aws apigateway get-rest-apis --limit 1 --region "$REGION"
probe "CloudFormation" aws cloudformation list-stacks --region "$REGION"
probe "CloudWatch Logs" aws logs describe-log-groups --limit 1 --region "$REGION"
echo

echo "Identity"
echo "------------------------------------------------------------"
NOTE="needed only if you use Cognito for auth" \
  probe "Cognito"     aws cognito-idp list-user-pools --max-results 1 --region "$REGION"
NOTE="read-only is expected; role CREATION is blocked" \
  probe "IAM (read)"  aws iam list-roles --max-items 1
echo

echo "AI services"
echo "------------------------------------------------------------"
NOTE="OCR for scans and photos" \
  probe "Textract"    aws textract list-adapters --max-results 1 --region "$REGION"
NOTE="text-to-speech for read-aloud" \
  probe "Polly"       aws polly describe-voices --language-code en-GB --region "$REGION"
NOTE="expected to be BLOCKED in Learner Lab" \
  probe "Bedrock"     aws bedrock list-foundation-models --region "$REGION"
echo

echo "EC2 path"
echo "------------------------------------------------------------"
probe "EC2"           aws ec2 describe-instances --max-items 1 --region "$REGION"
probe "EC2 key pairs" aws ec2 describe-key-pairs --region "$REGION"
probe "Security groups" aws ec2 describe-security-groups --max-items 1 --region "$REGION"
NOTE="needed for a stable IP across lab sessions" \
  probe "Elastic IPs" aws ec2 describe-addresses --region "$REGION"
echo

echo "Commonly restricted"
echo "------------------------------------------------------------"
NOTE="frontend hosting alternative to S3" \
  probe "CloudFront"  aws cloudfront list-distributions
NOTE="often blocked; S3 static hosting is the fallback" \
  probe "Amplify"     aws amplify list-apps --region "$REGION"
probe "Step Functions" aws stepfunctions list-state-machines --max-items 1 --region "$REGION"
probe "SNS"           aws sns list-topics --region "$REGION"
probe "Secrets Manager" aws secretsmanager list-secrets --max-results 1 --region "$REGION"
echo

# --- the LabRole ----------------------------------------------------------
echo "LabRole"
echo "------------------------------------------------------------"
if LABROLE=$(aws iam get-role --role-name LabRole --query 'Role.Arn' --output text 2>/dev/null); then
  printf '  %s  %s\n' "$(green '  OK  ')" "$LABROLE"
  echo
  echo "  Use this for the LabRoleArn parameter if you deploy the SAM stack."
else
  printf '  %s  LabRole not found — check the IAM console for its exact name.\n' "$(red 'BLOCKED')"
fi
echo

echo "============================================================"
echo "  $PASS available, $FAIL blocked"
echo
echo "  Bedrock showing BLOCKED is expected and is why generation runs on"
echo "  OpenRouter and NVIDIA NIM instead."
echo
