#!/bin/sh
set -eu

container="${POSTGRES_CONTAINER:-walletscaner-postgres-1}"
backup_dir="${POSTGRES_BACKUP_DIRECTORY:-/opt/walletscaner/backups}"
minimum_free_bytes="${POSTGRES_BACKUP_MIN_FREE_BYTES:-2147483648}"

case "$container" in
  walletscaner-postgres-1) ;;
  *) echo "Refusing unexpected PostgreSQL container: $container" >&2; exit 2 ;;
esac
case "$backup_dir" in
  /opt/walletscaner/backups) ;;
  *) echo "Refusing unexpected backup directory: $backup_dir" >&2; exit 2 ;;
esac

test -d "$backup_dir"
test "$(docker inspect "$container" --format '{{.State.Health.Status}}')" = healthy

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
name="memecoin_alpha_${stamp}.dump"
temporary="$backup_dir/$name.tmp"
dump="$backup_dir/$name"
sidecar="$dump.sha256"
status="$backup_dir/current-backup.status"

cleanup() {
  if [ "${dump_client_pid:-}" ]; then
    kill "$dump_client_pid" 2>/dev/null || true
    wait "$dump_client_pid" 2>/dev/null || true
  fi
  rm -f -- "$temporary" "$sidecar.tmp"
}
trap cleanup EXIT INT TERM

available="$(df -B1 "$backup_dir" | awk 'NR==2 {print $4}')"
required="$((minimum_free_bytes + 2147483648))"
if [ "$available" -lt "$required" ]; then
  echo "Insufficient preflight headroom: available=$available required=$required" >&2
  exit 3
fi

printf 'state=running\nname=%s\nstarted_at=%s\n' \
  "$name" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$status"

docker exec "$container" sh -c \
  'exec pg_dump -U postgres -d "$POSTGRES_DB" -Fc --compress=zstd:1 --no-owner --no-acl' \
  > "$temporary" &
dump_client_pid="$!"

while kill -0 "$dump_client_pid" 2>/dev/null; do
  available="$(df -B1 "$backup_dir" | awk 'NR==2 {print $4}')"
  if [ "$available" -lt "$minimum_free_bytes" ]; then
    kill "$dump_client_pid" 2>/dev/null || true
    docker exec "$container" sh -c \
      'pkill -TERM -x pg_dump 2>/dev/null || true' >/dev/null
    wait "$dump_client_pid" 2>/dev/null || true
    echo "Backup aborted at emergency headroom: available=$available" >&2
    exit 4
  fi
  sleep 10
done

if ! wait "$dump_client_pid"; then
  echo 'pg_dump failed' >&2
  exit 5
fi
test -s "$temporary"

docker run --rm \
  --name walletscaner-current-backup-verify \
  --label com.docker.compose.project=walletscaner \
  --memory=64m --cpus=0.02 --pids-limit=32 \
  -v "$backup_dir:/backups:ro" \
  postgres:16-alpine \
  pg_restore --list "/backups/$name.tmp" >/dev/null

hash="$(sha256sum "$temporary" | awk '{print $1}')"
printf '%s  /backups/%s\n' "$hash" "$name" > "$sidecar.tmp"
mv -- "$temporary" "$dump"
mv -- "$sidecar.tmp" "$sidecar"
trap - EXIT INT TERM

printf 'state=complete\nname=%s\nbytes=%s\nsha256=%s\ncompleted_at=%s\n' \
  "$name" "$(stat -c %s "$dump")" "$hash" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$status"
cat "$status"
