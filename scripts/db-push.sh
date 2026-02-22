#!/usr/bin/env bash
set -euo pipefail

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is required."
  exit 1
fi

if [ ! -d "node_modules" ]; then
  echo "node_modules not found. Installing dependencies..."
  npm ci
else
  echo "node_modules found. Skipping npm ci."
fi

if [ ! -d "node_modules/drizzle-orm" ] || [ ! -d "node_modules/drizzle-kit" ]; then
  echo "Required drizzle packages missing. Running npm install..."
  npm install
fi

echo "Running drizzle db:push..."
npx drizzle-kit push
echo "Database push completed."
