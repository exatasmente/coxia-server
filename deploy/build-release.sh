#!/usr/bin/env bash
# Builds one Coxia release from the public repository into <releases-dir>/<version>, as the service user, then makes it read-only for it.
# The one build path: install.sh runs it for the first release and `coxia-server update` runs it for every later one.
#
#   build-release.sh <ref> <releases-dir>
#
# <ref> is a tag, a branch or a commit of COXIA_REPO_URL. The folder is named after the version in the checkout's package.json, so a tag
# v1.2.3-beta.4 must carry version 1.2.3-beta.4. Standard output is only that version (the last line); everything else goes to standard error.
# A version that is already built is left as it is. It never runs `npm run dist` (that bundles the Claude Agent SDK for redistribution).
set -euo pipefail

COXIA_REPO_URL="${COXIA_REPO_URL:-https://github.com/exatasmente/coxia.git}"
SERVICE_USER="${SERVICE_USER:-coxia}"
STATE_ROOT="${STATE_ROOT:-/var/lib/coxia}"
NODE_DIR="${NODE_DIR:-/opt/coxia/node}"

REF="${1:-}"
RELEASES_DIR="${2:-}"

say() { printf '==> %s\n' "$*" >&2; }
die() { printf 'build-release: %s\n' "$*" >&2; exit 1; }

if [ -z "$REF" ] || [ -z "$RELEASES_DIR" ]; then die "usage: build-release.sh <ref> <releases-dir>"; fi
[ "$(id -u)" -eq 0 ] || die "run as root"

as_service() {
  runuser -u "$SERVICE_USER" -- env HOME="$STATE_ROOT" PATH="$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}

install -d -m 0755 -o root -g root "$RELEASES_DIR"
# A hidden folder next to the releases: it is only renamed to its version once it is complete, so a folder named like a version is always whole.
WORK="$(mktemp -d "$RELEASES_DIR/.build-XXXXXX")"
trap 'rm -rf "$WORK"' EXIT
chown "$SERVICE_USER:$SERVICE_USER" "$WORK"
chmod 0755 "$WORK"

say "coxia $REF"
# The build runs as the service user, not as root: it executes the repository's and its dependencies' scripts.
as_service git -C "$WORK" init -q >&2
as_service git -C "$WORK" remote add origin "$COXIA_REPO_URL"
as_service git -C "$WORK" fetch -q --depth 1 origin "$REF" >&2
as_service git -C "$WORK" -c advice.detachedHead=false checkout -q --detach --force FETCH_HEAD >&2
# No Electron binary: the server runs no desktop. The web client and the headless bundle are built from source.
as_service env ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm --prefix "$WORK" ci --no-audit --no-fund >&2
grep -q '"build:headless"' "$WORK/package.json" || die "this Coxia ref has no 'build:headless' script; use a release that includes the headless entry"
# The web client first, then the headless bundle (each writes its own folder under out/).
as_service sh -c "cd '$WORK' && npx electron-vite build" >&2
as_service npm --prefix "$WORK" run build:headless >&2
[ -f "$WORK/out/headless/coxia.mjs" ] || die "the headless bundle was not produced"
[ -f "$WORK/out/renderer/index.html" ] || die "the web client was not built"

VERSION="$("$NODE_DIR/bin/node" -p "require('$WORK/package.json').version")"
if ! [[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]]; then die "the version '$VERSION' in package.json is not a plain semver"; fi
if [[ "$REF" =~ ^v[0-9] ]] && [ "$REF" != "v$VERSION" ]; then die "tag $REF carries version $VERSION"; fi

if [ -d "$RELEASES_DIR/$VERSION" ]; then
  say "version $VERSION is already built, left as it is"
else
  # Read-only for the service from here on.
  chown -R root:root "$WORK"
  chmod -R go-w "$WORK"
  mv "$WORK" "$RELEASES_DIR/$VERSION"
  say "built $VERSION"
fi
printf '%s\n' "$VERSION"
