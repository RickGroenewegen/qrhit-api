#!/usr/bin/env bash
# One read-only query against the production database, as the read-only user.
#
#   _scripts/ro-query.sh "SELECT code, percent, startDate, endDate FROM discount_codes WHERE code = 'BF2026'"
#   _scripts/ro-query.sh --vertical "SELECT * FROM playlists WHERE id = 159"
#   _scripts/ro-query.sh --batch "SELECT id, orderId FROM payments WHERE email = 'x@y.nl'"
#
# Production is reached only as LIVE_DB_READONLY_USER (grants: SELECT, SHOW
# VIEW on qrhit.*), on the host of DATABASE_URL, never with DATABASE_URL's own
# user: being reachable does not make it permitted. Every session gets a 10 s
# statement limit. Keep queries narrow (indexed ids, LIMIT): this is the live
# database. The password goes to mysql through MYSQL_PWD and is never printed.
set -euo pipefail

cd "$(dirname "$0")/.."

# --vertical: one column per line; --batch: tab-separated with a header row
# (mysql's escaping of tab, newline and backslash), for scripts such as qrsong.
vertical=""
if [[ "${1:-}" == "--vertical" ]]; then
  vertical="--vertical"
  shift
elif [[ "${1:-}" == "--batch" ]]; then
  vertical="--batch"
  shift
fi
sql="${1:-}"
if [[ -z "$sql" ]]; then
  echo "usage: _scripts/ro-query.sh [--vertical|--batch] \"SELECT …\"" >&2
  exit 1
fi
if ! [[ "$(printf '%s' "$sql" | tr '[:lower:]' '[:upper:]' | sed -E 's/^[[:space:]]+//')" =~ ^(SELECT|SHOW|DESCRIBE|EXPLAIN|WITH) ]]; then
  echo "ro-query: only SELECT, SHOW, DESCRIBE, EXPLAIN or WITH (the user could not write anyway)" >&2
  exit 1
fi

value() { grep -E "^$1=" .env | head -1 | cut -d= -f2- | sed -E 's/^"(.*)"$/\1/'; }
host="$(value DATABASE_URL | sed -E 's#.*@([^:/]+).*#\1#')"
user="$(value LIVE_DB_READONLY_USER)"
if [[ -z "$host" || -z "$user" ]]; then
  echo "ro-query: DATABASE_URL (for the host) and LIVE_DB_READONLY_USER must be in .env" >&2
  exit 1
fi

MYSQL_PWD="$(value LIVE_DB_READONLY_PASSWORD)" mysql -h "$host" -u "$user" ${vertical} qrhit \
  -e "SET SESSION max_execution_time = 10000; ${sql}" 2> >(grep -v "Using a password" >&2)
