#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/backup.dump" >&2
  exit 2
fi

output=$1
if [ -e "$output" ]; then
  echo "Refusing to overwrite existing backup: $output" >&2
  exit 1
fi

database_name=${LTM_DATABASE_NAME:-line_task_manager}
umask 077
partial=$(mktemp "${output}.partial.XXXXXX")
trap 'rm -f "$partial"' EXIT HUP INT TERM

docker compose --profile full exec -T db \
  pg_dump --username=line --dbname="$database_name" \
    --format=custom --no-owner --no-privileges > "$partial"

if ! ln "$partial" "$output"; then
  echo "Refusing to overwrite existing backup: $output" >&2
  exit 1
fi
rm -f "$partial"
trap - EXIT HUP INT TERM
echo "Database backup written to $output"
