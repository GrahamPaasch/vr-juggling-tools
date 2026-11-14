#!/usr/bin/env bash
# Copy the static site (index.html, src/, vendor/) into a folder that a web server publishes.
#
#   tools/deploy-copy.sh ~/personal-webpage/public/juggling/vr
#
# Nothing is built and nothing is deleted. The target must be empty, missing, or an earlier copy
# of this page; anything else is refused so a wrong path cannot be overwritten by accident.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: tools/deploy-copy.sh <target-folder>" >&2
  exit 2
fi

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$1"
marker='See the ideal juggling pattern in VR'

if [ -d "$target" ] && [ -n "$(ls -A "$target")" ]; then
  if ! grep -qs "$marker" "$target/index.html"; then
    echo "Refusing: $target is not empty and is not an earlier copy of this page." >&2
    exit 1
  fi
fi

mkdir -p "$target"
cp "$root/index.html" "$target/index.html"
cp -R "$root/src" "$target/"
cp -R "$root/vendor" "$target/"

echo "Copied index.html, src/ and vendor/ to $target"
echo "If this is the grahampaasch.com repo, also add 'juggling/vr' to STATIC_APP_DIRS in next.config.mjs."
