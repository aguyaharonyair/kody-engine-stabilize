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

  # Idempotent tagging: if the tag already exists and points at HEAD,
  # treat it as already-published. If it points elsewhere, fail loudly —
  # something is inconsistent and a human should look.
  local remote_sha local_sha head_sha
  head_sha=$(git rev-parse HEAD)
  if local_sha=$(git rev-parse --verify "$tag" 2>/dev/null); then
    if [[ "$local_sha" == "$head_sha" ]]; then
      echo "  tag ${tag} already exists locally at HEAD — skipping create" >&2
    else
      echo "[publish] tag ${tag} exists locally at ${local_sha} but HEAD is ${head_sha}" >&2
      return 1
    fi
  else
    git tag -a "$tag" -m "Release ${tag}"
  fi
  # Push the tag if it isn't already on origin (or push always; gh will
  # no-op on existing remote tag at the same sha).
  if remote_sha=$(git ls-remote --tags origin "refs/tags/${tag}" 2>/dev/null | awk '{print $1}'); then
    if [[ -z "$remote_sha" ]]; then
      git push origin "$tag"
    elif [[ "$remote_sha" != "$head_sha" ]]; then
      echo "  WARN: remote tag ${tag} points at ${remote_sha}, HEAD is ${head_sha}" >&2
    fi
  else
    git push origin "$tag" || true
  fi

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

  # Idempotent: if a release for this tag already exists, reuse it.
  local existing_url
  if existing_url=$(gh release view "$tag" --json url -q .url 2>/dev/null); then
    if [[ -n "$existing_url" ]]; then
      echo "  GH release for ${tag} already exists: ${existing_url}" >&2
      echo "$existing_url"
      return 0
    fi
  fi

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
