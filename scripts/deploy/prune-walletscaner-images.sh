#!/bin/sh
set -eu

# Remove only obsolete Walletscaner worker tags. Do not replace this with a
# Docker-wide prune: the daemon and its BuildKit cache are shared.

repository="${WALLETSCANER_IMAGE_REPOSITORY:-walletscaner-worker}"
apply="${APPLY:-false}"
keep_release="${KEEP_RELEASE_TAG:-}"
keep_rollback="${KEEP_ROLLBACK_TAG:-}"

test "$repository" = "walletscaner-worker"
case "$apply" in
  true|false) ;;
  *) echo "APPLY must be true or false" >&2; exit 2 ;;
esac
for tag in "$keep_release" "$keep_rollback"; do
  case "$tag" in
    ""|*[!A-Za-z0-9_.-]*)
      if [ -n "$tag" ]; then
        echo "Invalid keep tag: $tag" >&2
        exit 2
      fi
      ;;
  esac
done

protected_ids="$(
  docker ps -aq |
    while IFS= read -r container_id; do
      [ -n "$container_id" ] || continue
      docker inspect "$container_id" --format '{{.Image}}'
    done |
    sort -u
)"

docker image ls "$repository" \
  --format '{{.Repository}}|{{.Tag}}|{{.ID}}' |
  while IFS='|' read -r found_repository tag image_id; do
    [ "$found_repository" = "$repository" ] || {
      echo "Refusing unexpected repository: $found_repository" >&2
      exit 3
    }
    [ "$tag" != "<none>" ] || continue

    reason=""
    case "$tag" in
      local) reason="active-local-tag" ;;
      "$keep_release") [ -n "$keep_release" ] && reason="kept-release" ;;
      "$keep_rollback") [ -n "$keep_rollback" ] && reason="kept-rollback" ;;
    esac
    if printf '%s\n' "$protected_ids" | grep -Fxq "$image_id"; then
      reason="container-referenced"
    fi
    if [ -n "$reason" ]; then
      echo "KEEP|$repository:$tag|$image_id|$reason"
      continue
    fi

    if [ "$apply" = "true" ]; then
      docker image rm "$repository:$tag"
      echo "REMOVED|$repository:$tag|$image_id"
    else
      echo "WOULD_REMOVE|$repository:$tag|$image_id"
    fi
  done

echo "mode=$apply repository=$repository"
docker system df
