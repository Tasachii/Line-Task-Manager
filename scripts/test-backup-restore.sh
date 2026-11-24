#!/bin/sh
set -eu

for tool in createdb dropdb psql pg_dump pg_restore mktemp stat cksum; do
  if ! command -v "$tool" >/dev/null 2>&1; then
    echo "Required PostgreSQL tool not found: $tool" >&2
    exit 1
  fi
done

source_db="ltm_backup_source_$$"
restored_db="ltm_backup_restored_$$"
temp_dir=$(mktemp -d "${TMPDIR:-/tmp}/ltm-backup-proof.XXXXXX")
dump_file="$temp_dir/backup.dump"
source_created=false
restored_created=false

cleanup() {
  if [ "$source_created" = true ]; then
    dropdb --if-exists "$source_db" >/dev/null 2>&1 || true
  fi
  if [ "$restored_created" = true ]; then
    dropdb --if-exists "$restored_db" >/dev/null 2>&1 || true
  fi
  rm -rf "$temp_dir"
}
trap cleanup EXIT HUP INT TERM

createdb "$source_db"
source_created=true
for migration in migrations/*.sql; do
  psql --quiet --set=ON_ERROR_STOP=1 --dbname="$source_db" --file="$migration"
done

psql --quiet --set=ON_ERROR_STOP=1 --dbname="$source_db" <<'SQL'
INSERT INTO line_messages (message_id, group_id, user_id, content) VALUES
  ('message-a', 'group-a', 'alice', '/task A1\nA2'),
  ('message-b', 'group-b', 'bob', '/task B1');

INSERT INTO users (id, line_user_id, display_name) VALUES
  ('alice', 'alice', 'Alice'),
  ('bob', 'bob', 'Bob');

INSERT INTO tasks
  (id, title, description, status, source_message_id, group_id, created_by, assignee_id, position)
VALUES
  ('card-a1', 'A first', 'first card', 'todo', 'message-a', 'group-a', 'alice', 'alice', 0),
  ('card-a2', 'A second', 'second card', 'todo', 'message-a', 'group-a', 'alice', 'bob', 1),
  ('card-b1', 'B first', 'other group', 'todo', 'message-b', 'group-b', 'bob', 'bob', 0);
SQL

createdb "$restored_db"
restored_created=true

mkdir "$temp_dir/bin"
cat > "$temp_dir/bin/docker" <<'SH'
#!/bin/sh
set -eu

if [ "$#" -lt 7 ] ||
   [ "$1" != "compose" ] ||
   [ "$2" != "--profile" ] ||
   [ "$3" != "full" ] ||
   [ "$4" != "exec" ] ||
   [ "$5" != "-T" ] ||
   [ "$6" != "db" ]; then
  echo "Unexpected docker adapter arguments: $*" >&2
  exit 2
fi

shift 6
exec "$@"
SH
chmod +x "$temp_dir/bin/docker"

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
PATH="$temp_dir/bin:$PATH" LTM_DATABASE_NAME="$source_db" \
  "$script_dir/backup-database.sh" "$dump_file"

if backup_mode=$(stat -f '%Lp' "$dump_file" 2>/dev/null); then
  :
else
  backup_mode=$(stat -c '%a' "$dump_file")
fi
if [ "$backup_mode" != 600 ]; then
  echo "Backup proof failed: expected private mode 600, got $backup_mode" >&2
  exit 1
fi

backup_checksum=$(cksum "$dump_file")
if PATH="$temp_dir/bin:$PATH" LTM_DATABASE_NAME="$source_db" \
  "$script_dir/backup-database.sh" "$dump_file" >/dev/null 2>&1; then
  echo "Backup proof failed: existing dump was overwritten" >&2
  exit 1
fi
if [ "$backup_checksum" != "$(cksum "$dump_file")" ]; then
  echo "Backup proof failed: existing dump changed" >&2
  exit 1
fi

PATH="$temp_dir/bin:$PATH" LTM_DATABASE_NAME="$restored_db" \
  "$script_dir/restore-database.sh" "$dump_file"
if PATH="$temp_dir/bin:$PATH" LTM_DATABASE_NAME="$restored_db" \
  "$script_dir/restore-database.sh" "$dump_file" >/dev/null 2>&1; then
  echo "Restore proof failed: non-fresh target was accepted" >&2
  exit 1
fi

snapshot_query="SELECT id, group_id, status, position, COALESCE(assignee_id, '') FROM tasks ORDER BY group_id, status, position, id"
source_snapshot=$(psql --set=ON_ERROR_STOP=1 --dbname="$source_db" --tuples-only --no-align --field-separator='|' --command="$snapshot_query")
restored_snapshot=$(psql --set=ON_ERROR_STOP=1 --dbname="$restored_db" --tuples-only --no-align --field-separator='|' --command="$snapshot_query")
restored_groups=$(psql --set=ON_ERROR_STOP=1 --dbname="$restored_db" --tuples-only --no-align --command="SELECT count(DISTINCT group_id) FROM tasks")

if [ "$restored_groups" -ne 2 ]; then
  echo "Restore proof failed: expected two groups, got $restored_groups" >&2
  exit 1
fi
if [ "$source_snapshot" != "$restored_snapshot" ]; then
  echo "Restore proof failed: card IDs, order, or assignments differ" >&2
  exit 1
fi

echo "Backup/restore proof passed: two groups retain card IDs, order, and assignments"
