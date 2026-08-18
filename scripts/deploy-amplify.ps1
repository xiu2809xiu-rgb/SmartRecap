param(
  [Parameter(Mandatory = $true)][ValidatePattern('^https://')][string]$ApiBaseUrl,
  [string]$AppId = '',
  [string]$AppName = 'smartrecap',
  [string]$Branch = 'main',
  [string]$Region = 'us-east-1'
)

$ErrorActionPreference = 'Stop'
$repoRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$dist = Join-Path $repoRoot 'dist'
$fileMapPath = Join-Path $env:TEMP "smartrecap-amplify-$([guid]::NewGuid()).json"
$env:VITE_API_BASE_URL = $ApiBaseUrl.TrimEnd('/')
$env:VITE_USE_MOCK_API = 'false'

function Invoke-AwsJson([string[]]$Arguments) {
  $output = & aws @Arguments
  if ($LASTEXITCODE -ne 0) { throw "AWS CLI failed: aws $($Arguments -join ' ')" }
  return $output | ConvertFrom-Json
}

function Get-FileMd5([string]$Path) {
  $algorithm = [System.Security.Cryptography.MD5]::Create()
  $stream = [System.IO.File]::OpenRead($Path)
  try {
    return ([BitConverter]::ToString($algorithm.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
  } finally {
    $stream.Dispose()
    $algorithm.Dispose()
  }
}

Push-Location $repoRoot
try {
  npm ci
  if ($LASTEXITCODE -ne 0) { throw 'npm ci failed.' }
  npm run build
  if ($LASTEXITCODE -ne 0) { throw 'Frontend build failed.' }

  if (-not $AppId) {
    $rule = '[{"source":"</^[^.]+$|\\.(?!(css|gif|ico|jpg|jpeg|js|mjs|png|txt|svg|woff|woff2|ttf|map|json|webp|glb|wasm|md|zip)$)([^.]+$)/>","target":"/index.html","status":"200"}]'
    $created = Invoke-AwsJson @('amplify', 'create-app', '--name', $AppName, '--platform', 'WEB', '--custom-rules', $rule, '--region', $Region)
    $AppId = $created.app.appId
  }

  & aws amplify get-branch --app-id $AppId --branch-name $Branch --region $Region *> $null
  if ($LASTEXITCODE -ne 0) {
    Invoke-AwsJson @('amplify', 'create-branch', '--app-id', $AppId, '--branch-name', $Branch, '--stage', 'PRODUCTION', '--region', $Region) | Out-Null
  }

  $fileMap = [ordered]@{}
  $filesByPath = @{}
  Get-ChildItem -Path $dist -Recurse -File | ForEach-Object {
    $relative = $_.FullName.Substring($dist.Length).TrimStart([System.IO.Path]::DirectorySeparatorChar).Replace('\', '/')
    $fileMap[$relative] = Get-FileMd5 $_.FullName
    $filesByPath[$relative] = $_.FullName
  }
  if ($fileMap.Count -eq 0) { throw 'The dist directory contains no deployable files.' }
  [System.IO.File]::WriteAllText($fileMapPath, ($fileMap | ConvertTo-Json -Compress), (New-Object System.Text.UTF8Encoding($false)))

  $deployment = Invoke-AwsJson @('amplify', 'create-deployment', '--app-id', $AppId, '--branch-name', $Branch, '--file-map', "file://$fileMapPath", '--region', $Region)
  foreach ($property in $deployment.fileUploadUrls.PSObject.Properties) {
    $relative = $property.Name
    if (-not $filesByPath.ContainsKey($relative)) { throw "Amplify requested an unknown file: $relative" }
    for ($attempt = 1; $attempt -le 4; $attempt++) {
      try {
        Invoke-WebRequest -Uri $property.Value -Method Put -InFile $filesByPath[$relative] -UseBasicParsing | Out-Null
        break
      } catch {
        if ($attempt -eq 4) { throw }
        Start-Sleep -Seconds ([Math]::Pow(2, $attempt))
      }
    }
  }

  Invoke-AwsJson @('amplify', 'start-deployment', '--app-id', $AppId, '--branch-name', $Branch, '--job-id', $deployment.jobId, '--region', $Region) | Out-Null
  do {
    Start-Sleep -Seconds 5
    $job = Invoke-AwsJson @('amplify', 'get-job', '--app-id', $AppId, '--branch-name', $Branch, '--job-id', $deployment.jobId, '--region', $Region)
    $status = $job.job.summary.status
    Write-Host "Amplify job $($deployment.jobId): $status"
  } while ($status -in @('PENDING', 'PROVISIONING', 'RUNNING', 'CANCELLING'))
  if ($status -ne 'SUCCEED') { throw "Amplify deployment finished with status $status." }

  $app = Invoke-AwsJson @('amplify', 'get-app', '--app-id', $AppId, '--region', $Region)
  Write-Host "Amplify deployment succeeded: https://$Branch.$($app.app.defaultDomain)"
  Write-Host "App ID: $AppId"
} finally {
  Pop-Location
  Remove-Item $fileMapPath -Force -ErrorAction SilentlyContinue
}
