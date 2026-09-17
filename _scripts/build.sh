#!/bin/bash
# Builds the API into ./build. This is what `npm run build` runs.
#
# Everything is compiled into ./.build-temp and swapped in with two renames at
# the very end, so it is safe to run while the API is serving from ./build:
# the running processes keep reading a complete tree until the moment of the
# swap. A failed compile leaves ./build untouched.
#
# The last step records which commit was built (see build-stamp.sh), which is
# what lets `npm run start` skip the build when ./build is already current.

set -e
cd "$(dirname "$0")/.."

rm -rf ./.build-temp ./.build-old
npx prisma generate
NODE_OPTIONS=--max-old-space-size=4096 npx tsc --outDir ./.build-temp --incremental --skipDefaultLibCheck --strictFunctionTypes
# tsc only emits .js: views, locales, the blog and reviews content ride along here.
npx ncp ./src ./.build-temp
bash ./_scripts/build-stamp.sh write ./.build-temp

if [ -d ./build ]; then
  mv ./build ./.build-old
fi
mv ./.build-temp ./build
rm -rf ./.build-old
