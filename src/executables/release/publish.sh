#!/usr/bin/env bash
#
# release/publish.sh — function library for the publish phase.
#
# Functions:
#   tag_and_publish <new_version>     -> creates tag locally, pushes, runs publishCommand
#   create_gh_release <tag>           -> echoes release URL or empty

# shellcheck disable=SC2148

tag_and_publish() {
  local new_version="$1"
  local publish_cmd="${KODY_CFG_RELEASE_PUBLISHCOMMAND:-}"
  local timeout_ms="${KODY_CFG_RELEASE_TIMEOUTMS:-600000}"
  local timeout_s=$((timeout_ms / 1000))
  local tag="v${new_version}"

  # Refuse if the tag already exists locally (left over from a prior failed run).
  if git rev-parse --verify "$tag" >/dev/null 2>&1; then
    echo "[publish] tag ${tag} already exists locally" >&2
    return 1
  fi

  git tag -a "$tag" -m "Release ${tag}"
  git push origin "$tag"

  # publishCommand (optional). Failure here is recorded but does not abort —
  # we still want the GH release entry so the tag is discoverable.
  local publish_status="skipped"
  if [[ -n "$publish_cmd" ]]; then
    local cmd="${publish_cmd//\$VERSION/$new_version}"
    echo "  publish: ${cmd}" >&2
    if timeout "${timeout_s}" bash -c "$cmd"; then
      publish_status="ok"
    else
      publish_status="failed"
      echo "[publish] publishCommand failed (continuing to create GH release)" >&2
    fi
  fi

  echo "$publish_status"
  return 0
}

create_gh_release() {
  local tag="$1"
  local draft="${KODY_CFG_RELEASE_DRAFTRELEASE:-false}"
  local draft_flag=""
  [[ "$draft" == "true" ]] && draft_flag="--draft"

  local release_url=""
  if release_url=$(gh release create "$tag" --title "$tag" --notes "Release ${tag} — automated by kody." $draft_flag 2>&1); then
    echo "$release_url"
    return 0
  else
    echo "[publish] gh release create failed: $release_url" >&2
    echo ""
    return 1
  fi
}
