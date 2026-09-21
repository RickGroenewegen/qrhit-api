#!/bin/bash
# Records and checks which commit a build directory was compiled from.
#
#   build-stamp.sh write <dir>   write the current commit to <dir>/.build-commit
#   build-stamp.sh check <dir>   exit 0 when <dir> was built from the checked-out
#                                commit and no source file has changed since
#
# `check` answers "can `npm run start` skip the build?". Whenever it cannot be
# sure (no stamp, no git, uncommitted source changes) it says no, and the
# caller falls back to building first, which is always correct.

cd "$(dirname "$0")/.."

MODE="$1"
DIR="${2:-./build}"
STAMP="$DIR/.build-commit"
# Everything that ends up in the build output.
SOURCES="src routes prisma tsconfig.json"

head_commit() {
  git rev-parse HEAD 2>/dev/null
}

sources_are_clean() {
  local changes
  changes="$(git status --porcelain -- $SOURCES 2>/dev/null)" || return 1
  [ -z "$changes" ]
}

case "$MODE" in
  write)
    # A build of uncommitted work is stamped as such, so it never counts as
    # current: the next change to those files would go unnoticed otherwise.
    if COMMIT="$(head_commit)" && sources_are_clean; then
      echo "$COMMIT" > "$STAMP"
    else
      echo "uncommitted" > "$STAMP"
    fi
    ;;
  check)
    [ -f "$STAMP" ] || exit 1
    [ -f "$DIR/src/app.js" ] || exit 1
    COMMIT="$(head_commit)" || exit 1
    [ "$(cat "$STAMP")" = "$COMMIT" ] || exit 1
    sources_are_clean || exit 1
    ;;
  *)
    echo "Usage: $0 write|check [dir]" >&2
    exit 2
    ;;
esac
