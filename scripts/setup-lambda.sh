#!/usr/bin/env bash
#
# One-command setup for the AWS Lambda proxy.
#
# Prerequisites:
#   - AWS CLI installed and configured (aws configure)
#   - An Alexa Smart Home Skill created in the Alexa developer console
#
# Usage:
#   ./scripts/setup-lambda.sh <FORWARD_URL>
#
# Example with Tailscale Funnel:
#   tailscale funnel 3100           # stable URL, no signup, free
#   ./scripts/setup-lambda.sh https://your-machine.tail1234.ts.net/directive
#
# What this does:
#   1. Creates an IAM role for the Lambda (if it doesn't exist)
#   2. Compiles the proxy TypeScript to JavaScript
#   3. Bundles it into a zip
#   4. Creates or updates the Lambda function
#   5. Adds the Alexa Smart Home trigger permission
#   6. Prints the Lambda ARN to paste into the Alexa developer console

set -euo pipefail

FUNCTION_NAME="alexa-agent-proxy"
ROLE_NAME="alexa-agent-proxy-role"
REGION="${AWS_REGION:-us-east-1}"
RUNTIME="nodejs20.x"
HANDLER="proxy.handler"
TIMEOUT=8
MEMORY=128

FORWARD_URL="${1:-}"
if [ -z "$FORWARD_URL" ]; then
  echo "Usage: $0 <FORWARD_URL>"
  echo ""
  echo "  FORWARD_URL is where Lambda will forward Alexa directives."
  echo "  Start your local server and Tailscale Funnel first:"
  echo ""
  echo "    npm run dev                                              # start local server on :3100"
  echo "    tailscale funnel 3100                                    # expose via Tailscale"
  echo "    ./scripts/setup-lambda.sh https://MACHINE.TAILNET.ts.net/directive"
  echo ""
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

echo "==> Building project..."
cd "$PROJECT_DIR"
npx tsc

echo "==> Bundling Lambda proxy..."
BUNDLE_DIR=$(mktemp -d)
cp dist/lambda/proxy.js "$BUNDLE_DIR/proxy.js"
cd "$BUNDLE_DIR"
zip -q proxy.zip proxy.js
cd "$PROJECT_DIR"

# -----------------------------------------------------------------------
# IAM role
# -----------------------------------------------------------------------

ROLE_ARN=$(aws iam get-role --role-name "$ROLE_NAME" --query 'Role.Arn' --output text 2>/dev/null || true)

if [ -z "$ROLE_ARN" ] || [ "$ROLE_ARN" = "None" ]; then
  echo "==> Creating IAM role: $ROLE_NAME"
  ROLE_ARN=$(aws iam create-role \
    --role-name "$ROLE_NAME" \
    --assume-role-policy-document '{
      "Version": "2012-10-17",
      "Statement": [{
        "Effect": "Allow",
        "Principal": { "Service": "lambda.amazonaws.com" },
        "Action": "sts:AssumeRole"
      }]
    }' \
    --query 'Role.Arn' --output text)

  aws iam attach-role-policy \
    --role-name "$ROLE_NAME" \
    --policy-arn arn:aws:iam::aws:policy/service-role/AWSLambdaBasicExecutionRole

  echo "    Waiting for role to propagate..."
  sleep 10
fi

echo "    Role ARN: $ROLE_ARN"

# -----------------------------------------------------------------------
# Lambda function
# -----------------------------------------------------------------------

LAMBDA_ARN=$(aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" --query 'Configuration.FunctionArn' --output text 2>/dev/null || true)

if [ -z "$LAMBDA_ARN" ] || [ "$LAMBDA_ARN" = "None" ]; then
  echo "==> Creating Lambda function: $FUNCTION_NAME"
  LAMBDA_ARN=$(aws lambda create-function \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --runtime "$RUNTIME" \
    --handler "$HANDLER" \
    --role "$ROLE_ARN" \
    --zip-file "fileb://$BUNDLE_DIR/proxy.zip" \
    --timeout "$TIMEOUT" \
    --memory-size "$MEMORY" \
    --environment "Variables={FORWARD_URL=$FORWARD_URL}" \
    --query 'FunctionArn' --output text)
else
  echo "==> Updating Lambda function: $FUNCTION_NAME"
  aws lambda update-function-code \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --zip-file "fileb://$BUNDLE_DIR/proxy.zip" \
    --query 'FunctionArn' --output text > /dev/null

  # Wait for update to complete before updating config
  aws lambda wait function-updated --function-name "$FUNCTION_NAME" --region "$REGION" 2>/dev/null || sleep 5

  aws lambda update-function-configuration \
    --function-name "$FUNCTION_NAME" \
    --region "$REGION" \
    --environment "Variables={FORWARD_URL=$FORWARD_URL}" \
    --query 'FunctionArn' --output text > /dev/null

  LAMBDA_ARN=$(aws lambda get-function --function-name "$FUNCTION_NAME" --region "$REGION" --query 'Configuration.FunctionArn' --output text)
fi

# -----------------------------------------------------------------------
# Alexa Smart Home trigger permission
# -----------------------------------------------------------------------

echo "==> Adding Alexa trigger permission (idempotent)..."
aws lambda add-permission \
  --function-name "$FUNCTION_NAME" \
  --region "$REGION" \
  --statement-id "alexa-smart-home" \
  --action "lambda:InvokeFunction" \
  --principal "alexa-connectedhome.amazon.com" \
  2>/dev/null || true

# -----------------------------------------------------------------------
# Cleanup
# -----------------------------------------------------------------------

rm -rf "$BUNDLE_DIR"

echo ""
echo "============================================"
echo "  Lambda deployed successfully!"
echo "============================================"
echo ""
echo "  Function:    $FUNCTION_NAME"
echo "  Region:      $REGION"
echo "  Lambda ARN:  $LAMBDA_ARN"
echo "  Forward URL: $FORWARD_URL"
echo ""
echo "  Next steps:"
echo "  1. Go to the Alexa developer console"
echo "  2. Open your Smart Home skill"
echo "  3. Under 'Endpoint', paste this ARN:"
echo ""
echo "     $LAMBDA_ARN"
echo ""
echo "  4. Save and enable the skill on your Alexa account"
echo ""
echo "  To update the forward URL later:"
echo "    ./scripts/setup-lambda.sh <NEW_URL>"
echo ""
