#!/bin/bash
# Updates dependencies within the package.json ranges, but only to versions
# published at least MIN_RELEASE_AGE_DAYS (default 7) days ago, transitive
# dependencies included. Hijacked releases are usually caught and pulled within
# days, so the age gate keeps them out while they are live. Install scripts are
# skipped for the same reason, which is why the Prisma client is generated here
# explicitly (prisma-client-js writes it into node_modules/.prisma).
#
# Usage: npm run deps:update [-- package ...]
#        MIN_RELEASE_AGE_DAYS=14 npm run deps:update

set -e
cd "$(dirname "$0")/.."

DAYS=${MIN_RELEASE_AGE_DAYS:-7}
CUTOFF=$(node -e "console.log(new Date(Date.now() - $DAYS * 86400000).toISOString())")

echo "Updating to versions published before $CUTOFF ($DAYS days), install scripts off"
npm update --before="$CUTOFF" --ignore-scripts "$@"
npx prisma generate

node ./_scripts/check-lockfile-age.mjs . --days "$DAYS"
echo "Done. Check the build and unit tests: npm run build && npm run test:unit"
