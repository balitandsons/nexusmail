# Deploys NexusMail to Cloud Run and puts Firebase Hosting in front of it. Safe to re-run (updates in place).
# Needs: gcloud CLI, firebase CLI (npm i -g firebase-tools), both logged in, Blaze plan on the project.
# Optional: $env:GEMINI_API_KEY = "..." before running to store your Gemini key.
$ErrorActionPreference = 'Stop'
$Project = if ($env:PROJECT) { $env:PROJECT } else { 'balit-and-sons-technologies' }
$Region  = if ($env:REGION)  { $env:REGION }  else { 'us-central1' }
$Service = 'nexusmail'
$Bucket  = "$Project-nexusmail-data"
Set-Location (Join-Path $PSScriptRoot '..\..')

function Need($cmd, $hint) { if (-not (Get-Command $cmd -ErrorAction SilentlyContinue)) { throw "$cmd not found. $hint" } }
Need gcloud 'Install: https://cloud.google.com/sdk/docs/install then reopen PowerShell.'
Need firebase 'Install: npm i -g firebase-tools'
function Run { & $args[0] $args[1..($args.Length-1)]; if ($LASTEXITCODE -ne 0) { throw "Command failed: $($args -join ' ')" } }
function Quiet { & $args[0] $args[1..($args.Length-1)] *> $null; return ($LASTEXITCODE -eq 0) }

Run gcloud config set project $Project
Write-Host '== Enabling APIs'
Run gcloud services enable run.googleapis.com cloudbuild.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com firebasehosting.googleapis.com storage.googleapis.com

$Num = (& gcloud projects describe $Project --format='value(projectNumber)').Trim()
$SA  = "$Num-compute@developer.gserviceaccount.com"

Write-Host "== Data bucket gs://$Bucket"
if (-not (Quiet gcloud storage buckets describe "gs://$Bucket")) { Run gcloud storage buckets create "gs://$Bucket" --location=$Region --uniform-bucket-level-access }
Run gcloud storage buckets add-iam-policy-binding "gs://$Bucket" --member="serviceAccount:$SA" --role=roles/storage.objectAdmin | Out-Null

function Put-Secret($name, $value) {
  $tmp = New-TemporaryFile
  try {
    [IO.File]::WriteAllText($tmp.FullName, $value)
    if (Quiet gcloud secrets describe $name) { Run gcloud secrets versions add $name --data-file=$($tmp.FullName) | Out-Null }
    else { Run gcloud secrets create $name --data-file=$($tmp.FullName) | Out-Null }
  } finally { Remove-Item $tmp -Force }
  Run gcloud secrets add-iam-policy-binding $name --member="serviceAccount:$SA" --role=roles/secretmanager.secretAccessor | Out-Null
}

$Secrets = 'ADMIN_PASSWORD=nexusmail-admin-password:latest'
if (-not (Quiet gcloud secrets describe nexusmail-admin-password) -or $env:NEW_ADMIN_PASSWORD) {
  $pw = $env:NEW_ADMIN_PASSWORD
  if (-not $pw) {
    $sec = Read-Host 'Choose an admin password for NexusMail (blank = generate one)' -AsSecureString
    $pw = [Runtime.InteropServices.Marshal]::PtrToStringAuto([Runtime.InteropServices.Marshal]::SecureStringToBSTR($sec))
  }
  if (-not $pw) { $pw = -join ((48..57) + (65..90) + (97..122) | Get-Random -Count 20 | ForEach-Object { [char]$_ }); Write-Host "Generated admin password: $pw   (save it now)" }
  Put-Secret 'nexusmail-admin-password' $pw
}
if ($env:GEMINI_API_KEY) { Put-Secret 'nexusmail-gemini-key' $env:GEMINI_API_KEY }
if (Quiet gcloud secrets describe nexusmail-gemini-key) { $Secrets += ',GEMINI_API_KEY=nexusmail-gemini-key:latest' }
else { Write-Host 'Tip: set $env:GEMINI_API_KEY first to enable AI replies and the Inbox Agent.' }

$Url = "https://$Project.web.app"
$Model = if ($env:GEMINI_MODEL) { $env:GEMINI_MODEL } else { 'gemini-3.8-flash' }
Write-Host '== Deploying Cloud Run service (first build takes a few minutes)'
Run gcloud run deploy $Service --source . --region $Region `
  --allow-unauthenticated --execution-environment gen2 `
  --min-instances 1 --max-instances 1 --no-cpu-throttling --cpu 1 --memory 512Mi --timeout 3600 `
  --add-volume "name=data,type=cloud-storage,bucket=$Bucket" --add-volume-mount "volume=data,mount-path=/app/data" `
  --set-env-vars "TRUST_PROXY=1,DATA_DIR=/app/data,PUBLIC_URL=$Url,APP_TIMEZONE=Asia/Kolkata,GEMINI_MODEL=$Model" `
  --set-secrets $Secrets

Write-Host '== Deploying Firebase Hosting'
Run firebase deploy --only hosting --project $Project
Write-Host ''
Write-Host "NexusMail is live at: $Url"
