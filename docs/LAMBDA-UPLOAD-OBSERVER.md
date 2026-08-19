# Additive Lambda upload observer

SmartRecap uses both EC2 and Lambda without moving or duplicating the working FastAPI API.

## Responsibility split

- **EC2/FastAPI:** authentication, Binder state, extraction, OCR, AI generation, chat, quizzes, Social, and multiplayer.
- **Lambda:** reacts to completed S3 source uploads, checks the first five bytes for the PDF signature, and records a short-lived upload receipt.
- **S3:** remains the private upload and overflow-record store.
- **DynamoDB:** keeps application records plus Lambda receipts in a separate key namespace.
- **EventBridge:** routes only `smartrecap/uploads/` object-created events to Lambda.

The Lambda never modifies, moves, or deletes an upload. It never updates `USER#` or `PUBLIC` records and does not start extraction. If it fails, EventBridge retries it while the existing EC2 upload and commit flow continues normally.

## Receipt shape

```text
pk = UPLOAD#<source-id>
sk = OBSERVATION
status = valid_pdf | invalid_pdf
bucket, objectKey, eventId, etag, sizeBytes, contentType
observedAt, expiresAt
```

Writing the same source again replaces the same receipt, making retries idempotent. DynamoDB TTL removes receipts after seven days by default.

## Files

- `backend/lambda/upload_observer.py` — Python 3.12 handler using only boto3 and the standard library.
- `backend/infra/upload-observer.yaml` — independent Lambda/EventBridge stack.
- `backend/infra/fastapi-data.yaml` — enables native S3-to-EventBridge delivery.
- `scripts/deploy-upload-observer.ps1` — packages, deploys, enables, and smoke-tests the observer.

## Safe deployment

Refresh Learner Lab credentials first. Obtain the existing FastAPI `S3_BUCKET` and `TABLE_NAME` values without copying any application secrets, then run:

```powershell
.\scripts\deploy-upload-observer.ps1 `
  -SourceBucketName "YOUR_EXISTING_BUCKET" `
  -TableName "YOUR_EXISTING_TABLE" `
  -WebOrigin "https://main.d3uxoyzrio5seq.amplifyapp.com"
```

The script performs the safe order:

1. Package and upload the versioned Lambda artifact.
2. Deploy the observer stack while S3 event delivery is still dormant.
3. Enable S3 EventBridge delivery through the bucket-owning data stack.
4. Resolve and print the deployed function name.

CloudFormation changes IAM usage only by assigning the existing `LabRole`; it does not create roles or copy credentials into code.

## Validation

After deployment, upload a PDF through the normal Binder interface. Confirm:

```powershell
aws dynamodb get-item `
  --table-name "YOUR_EXISTING_TABLE" `
  --key '{"pk":{"S":"UPLOAD#SOURCE_ID"},"sk":{"S":"OBSERVATION"}}' `
  --consistent-read --region us-east-1
```

The Binder should continue from `pending` to `processing` to `ready` exactly as before. Lambda receipts are observability records and are not queried by FastAPI.

## Rollback

Disabling or deleting the observer stack stops Lambda invocations without affecting EC2, S3 objects, or application records:

```powershell
aws cloudformation delete-stack `
  --stack-name smartrecap-upload-observer `
  --region us-east-1
```

Leaving S3 EventBridge delivery enabled is harmless when no matching rule exists. It can also be disabled by reverting the `NotificationConfiguration` addition and redeploying `smartrecap-fastapi-data`.
