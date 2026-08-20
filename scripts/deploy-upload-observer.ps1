param(
  [Parameter(Mandatory = $true)][string]$SourceBucketName,
  [Parameter(Mandatory = $true)][string]$TableName,
  [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$WebOrigin,
  [string]$DataStackName = 'smartrecap-fastapi-data',
  [string]$ObserverStackName = 'smartrecap-upload-observer',
  [string]$LambdaRoleArn = '',
  [string]$Region = 'us-east-1'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$lambdaSource = Join-Path $repoRoot 'backend\lambda\upload_observer.py'
$dataTemplate = Join-Path $repoRoot 'backend\infra\fastapi-data.yaml'
$observerTemplate = Join-Path $repoRoot 'backend\infra\upload-observer.yaml'
$tempZip = Join-Path $env:TEMP "smartrecap-upload-observer-$([guid]::NewGuid()).zip"

function Invoke-Aws([string[]]$Arguments) {
  & aws @Arguments
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI failed: aws $($Arguments -join ' ')" }
}

if (-not (Test-Path $lambdaSource)) { throw "Missing Lambda source: $lambdaSource" }
if (-not $LambdaRoleArn) {
  $accountId = (& aws sts get-caller-identity --query Account --output text --region $Region).Trim()
  if ($LASTEXITCODE -ne 0 -or $accountId -notmatch '^\d{12}$') { throw 'Unable to resolve the AWS account id.' }
  $LambdaRoleArn = "arn:aws:iam::$accountId`:role/LabRole"
}

$hash = (Get-FileHash -LiteralPath $lambdaSource -Algorithm SHA256).Hash.ToLowerInvariant()
$artifactKey = "deployments/lambda/upload-observer-$hash.zip"

try {
  Compress-Archive -LiteralPath $lambdaSource -DestinationPath $tempZip -CompressionLevel Optimal
  Invoke-Aws @('s3', 'cp', $tempZip, "s3://$SourceBucketName/$artifactKey", '--region', $Region, '--only-show-errors')

  # Deploy the dormant observer first. S3 does not emit events until the data
  # stack update below enables EventBridge delivery.
  Invoke-Aws @(
    'cloudformation', 'deploy', '--template-file', $observerTemplate,
    '--stack-name', $ObserverStackName, '--region', $Region,
    '--parameter-overrides',
    "SourceBucketName=$SourceBucketName", "TableName=$TableName",
    "LambdaRoleArn=$LambdaRoleArn", "CodeBucketName=$SourceBucketName",
    "CodeObjectKey=$artifactKey"
  )

  # This is the only change to the existing data stack: S3 starts publishing
  # object events to EventBridge. Bucket retention, CORS, and lifecycle stay intact.
  Invoke-Aws @(
    'cloudformation', 'deploy', '--template-file', $dataTemplate,
    '--stack-name', $DataStackName, '--region', $Region,
    '--parameter-overrides', "WebOrigin=$($WebOrigin.TrimEnd('/'))"
  )

  $functionName = (& aws cloudformation describe-stacks --stack-name $ObserverStackName --region $Region `
    --query "Stacks[0].Outputs[?OutputKey=='FunctionName'].OutputValue | [0]" --output text).Trim()
  if ($LASTEXITCODE -ne 0 -or -not $functionName) { throw 'Unable to resolve the deployed Lambda function.' }

  Write-Host "Lambda upload observer deployed without changing the EC2 request path."
  Write-Host "Function: $functionName"
  Write-Host "Observed prefix: s3://$SourceBucketName/smartrecap/uploads/"
  Write-Host "Receipt namespace: UPLOAD#<source-id> / OBSERVATION"
} finally {
  Remove-Item -LiteralPath $tempZip -Force -ErrorAction SilentlyContinue
}
