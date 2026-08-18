param(
  [Parameter(Mandatory = $true)][string]$ApiBaseUrl,
  [string]$AppId = '',
  [string]$AppName = 'smartrecap',
  [string]$Branch = 'main',
  [string]$Region = 'us-east-1'
)

$ErrorActionPreference = 'Stop'
$env:VITE_API_BASE_URL = $ApiBaseUrl.TrimEnd('/')
$env:VITE_USE_MOCK_API = 'false'

npm ci
npm run build

$archive = Join-Path $env:TEMP "smartrecap-amplify-$([guid]::NewGuid()).zip"
Compress-Archive -Path 'dist\*' -DestinationPath $archive -CompressionLevel Optimal

if (-not $AppId) {
  $rule = '[{"source":"</^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|js|png|txt|svg|woff|woff2|ttf|map|json|webp)$)([^.]+$)/>","target":"/index.html","status":"200"}]'
  $created = aws amplify create-app --name $AppName --platform WEB --custom-rules $rule --region $Region | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Amplify app creation failed.' }
  $AppId = $created.app.appId
}

aws amplify get-branch --app-id $AppId --branch-name $Branch --region $Region *> $null
if ($LASTEXITCODE -ne 0) {
  aws amplify create-branch --app-id $AppId --branch-name $Branch --stage PRODUCTION --region $Region | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'Amplify branch creation failed.' }
}

$deployment = aws amplify create-deployment --app-id $AppId --branch-name $Branch --region $Region | ConvertFrom-Json
if ($LASTEXITCODE -ne 0) { throw 'Amplify deployment creation failed.' }
Invoke-WebRequest -Uri $deployment.zipUploadUrl -Method Put -InFile $archive -ContentType 'application/zip' | Out-Null
aws amplify start-deployment --app-id $AppId --branch-name $Branch --job-id $deployment.jobId --region $Region | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Amplify deployment start failed.' }

$app = aws amplify get-app --app-id $AppId --region $Region | ConvertFrom-Json
Remove-Item $archive -Force
Write-Host "Amplify deployment started: https://$Branch.$($app.app.defaultDomain)"
Write-Host "App ID: $AppId"
