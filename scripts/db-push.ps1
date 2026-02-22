$ErrorActionPreference = "Stop"

if (-not $env:DATABASE_URL) {
  throw "DATABASE_URL is required."
}

if (-not (Test-Path "node_modules")) {
  Write-Host "node_modules not found. Installing dependencies with npm ci..."
  npm ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed." }
}

$drizzleOrmExists = Test-Path "node_modules\drizzle-orm"
$drizzleKitExists = Test-Path "node_modules\drizzle-kit"

if (-not $drizzleOrmExists -or -not $drizzleKitExists) {
  Write-Host "Required drizzle packages missing. Running npm install..."
  npm install
  if ($LASTEXITCODE -ne 0) {
    throw "npm install failed. If you see EPERM for @bitwarden native module, stop running app/dev server and retry as Administrator."
  }
}

Write-Host "Running drizzle db:push..."
npx drizzle-kit push
if ($LASTEXITCODE -ne 0) {
  throw "drizzle-kit push failed."
}

Write-Host "Database push completed."
