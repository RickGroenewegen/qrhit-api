#!/bin/bash
# Starts a compiled entry point from ./build. This is what `npm run start`
# (app) and `npm run start:worker` (worker) run, and therefore what pm2 runs.
#
#   start.sh app|worker
#
# The build used to run here unconditionally, which meant it ran while the API
# was down: `pm2 restart` stops the old process first, so every deploy and
# every crash restart was offline for a full prisma generate + tsc. The deploy
# scripts now build BEFORE they restart, while the old process still serves,
# and this script only builds when ./build does not match the checked-out
# commit (a manual `git pull` + `pm2 restart`, a first checkout, local edits).

cd "$(dirname "$0")/.."

ENTRY="${1:-app}"

if bash ./_scripts/build-stamp.sh check ./build; then
  echo "Build is current ($(cat ./build/.build-commit | cut -c1-8)), starting without a rebuild"
else
  echo "Build is missing or stale, building first"
  npm run build || exit 1
fi

exec node -r dotenv/config "build/src/${ENTRY}.js"
