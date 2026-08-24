#!/bin/sh
set -eu

# Reconcile only byte-verified Walletscaner PostgreSQL dumps after an off-host
# acknowledgement. The newest server generation is always retained.
backup_dir="${POSTGRES_BACKUP_DIRECTORY:-/opt/walletscaner/backups}"
keep_count="${POSTGRES_BACKUP_KEEP_COUNT:-1}"
apply="${APPLY:-false}"

case "$backup_dir" in
  /opt/walletscaner/backups) ;;
  *) echo "Refusing unexpected backup directory: $backup_dir" >&2; exit 2 ;;
esac
case "$keep_count" in
  ''|*[!0-9]*) echo "POSTGRES_BACKUP_KEEP_COUNT must be a positive integer" >&2; exit 2 ;;
esac
[ "$keep_count" -ge 1 ] || {
  echo "POSTGRES_BACKUP_KEEP_COUNT must retain at least one generation" >&2
  exit 2
}
case "$apply" in
  true|false) ;;
  *) echo "APPLY must be true or false" >&2; exit 2 ;;
esac

resolved_dir="$(readlink -f -- "$backup_dir")"
[ "$resolved_dir" = "/opt/walletscaner/backups" ] || {
  echo "Resolved backup directory escaped the Walletscaner boundary: $resolved_dir" >&2
  exit 3
}

inventory="$({
  find "$resolved_dir" -maxdepth 1 -type f \
    -name 'memecoin_alpha_*.dump' -printf '%T@|%f\n'
} | sort -t '|' -k1,1nr)"
[ -n "$inventory" ] || {
  echo "No completed Walletscaner PostgreSQL dump exists" >&2
  exit 4
}

# Validate every completed generation before planning any removal. One missing
# or mismatched acknowledgement fails the entire reconciliation closed.
validated="$(
  printf '%s\n' "$inventory" |
    while IFS='|' read -r _mtime name; do
      case "$name" in
        memecoin_alpha_[0-9][0-9][0-9][0-9][0-9][0-9][0-9][0-9]T[0-9][0-9][0-9][0-9][0-9][0-9]Z.dump) ;;
        *) echo "Unexpected backup filename: $name" >&2; exit 5 ;;
      esac
      dump="$resolved_dir/$name"
      sidecar="$dump.sha256"
      marker="$dump.offsite-verified"
      [ -f "$sidecar" ] || { echo "Missing checksum sidecar: $name" >&2; exit 6; }
      [ -f "$marker" ] || { echo "Missing off-host acknowledgement: $name" >&2; exit 7; }
      expected="$(awk 'NR == 1 { print $1 }' "$sidecar")"
      acknowledged="$(sed -n 's/^sha256=//p' "$marker" | head -n 1)"
      case "$expected" in
        *[!0-9a-fA-F]*|'') echo "Invalid checksum sidecar: $name" >&2; exit 8 ;;
      esac
      [ "${#expected}" -eq 64 ] || { echo "Invalid checksum length: $name" >&2; exit 8; }
      [ "$expected" = "$acknowledged" ] || {
        echo "Off-host acknowledgement mismatch: $name" >&2
        exit 9
      }
      printf '%s\n' "$name"
    done
)"

index=0
printf '%s\n' "$validated" |
  while IFS= read -r name; do
    [ -n "$name" ] || continue
    index=$((index + 1))
    if [ "$index" -le "$keep_count" ]; then
      echo "KEEP|$name|newest-verified-server-generation"
      continue
    fi
    if [ "$apply" = "true" ]; then
      rm -f -- \
        "$resolved_dir/$name" \
        "$resolved_dir/$name.sha256" \
        "$resolved_dir/$name.offsite-verified"
      echo "REMOVED|$name|offsite-verified"
    else
      echo "WOULD_REMOVE|$name|offsite-verified"
    fi
  done

echo "mode=$apply keep_count=$keep_count directory=$resolved_dir"
