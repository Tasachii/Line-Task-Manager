#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "Usage: $0 /path/to/backup.dump" >&2
  exit 2
fi

backup=$1
if [ ! -f "$backup" ]; then
  echo "Backup file not found: $backup" >&2
  exit 1
fi

database_name=${LTM_DATABASE_NAME:-line_task_manager}
public_tables=$(docker compose --profile full exec -T db \
  psql --username=line --dbname="$database_name" --tuples-only --no-align \
    --set=ON_ERROR_STOP=1 \
    --command="SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')")

if [ "$public_tables" -ne 0 ]; then
  echo "Refusing to restore: line_task_manager is not a fresh database" >&2
  exit 1
fi

docker compose --profile full exec -T db \
  pg_restore --username=line --dbname="$database_name" \
    --no-owner --no-privileges --single-transaction < "$backup"

echo "Database restored from $backup"
