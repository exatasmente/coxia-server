#!/usr/bin/env bash
# Installs the Coxia service on a fresh Ubuntu 24.04 server. Run as root from a checkout of this repository:
#
#   sudo COXIA_REF=<tag> ./deploy/install.sh
#
# Safe to run again: it only changes what differs, never regenerates the master key and never touches the data folder.
# It never runs `npm run dist` (that bundles the Claude Agent SDK for redistribution; a server builds from source instead).
set -euo pipefail

# --- what can be set -------------------------------------------------------------------------------------------------------------
# The Coxia release to run: a tag, a branch or a commit of the public repository. The default is a placeholder for the first
# stable tag; name the one you want.
COXIA_REF="${COXIA_REF:-v1.0.0}"
COXIA_REPO_URL="${COXIA_REPO_URL:-https://github.com/exatasmente/coxia.git}"
# The speech model the voice setup downloads (see "Voice" below). COXIA_SKIP_VOICE=1 leaves voice out.
COXIA_VOICE_MODEL="${COXIA_VOICE_MODEL:-small}"
COXIA_SKIP_VOICE="${COXIA_SKIP_VOICE:-0}"
# Optional: the expected SHA-256 of the Node tarball. Without it the checksum comes from nodejs.org's SHASUMS256.txt.
NODE_SHA256="${NODE_SHA256:-}"

SERVICE_USER=coxia
STATE_ROOT=/var/lib/coxia                 # the user's home, the data folder and the supervisor's state
DATA_DIR="$STATE_ROOT/data"
STATE_DIR="$STATE_ROOT/state"
CONF_DIR=/etc/coxia
KEY_FILE="$CONF_DIR/master.key"
ENV_FILE="$CONF_DIR/coxia.env"
OPT=/opt/coxia
NODE_DIR="$OPT/node"
APP_DIR="$OPT/app"
SERVER_DIR="$OPT/server"

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

say() { printf '==> %s\n' "$*"; }
die() { printf 'install: %s\n' "$*" >&2; exit 1; }
# Runs a command as the service user with the pinned Node first on PATH; the same helper deploy/build-release.sh has.
as_service() {
  runuser -u "$SERVICE_USER" -- env HOME="$STATE_ROOT" PATH="$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}

[ "$(id -u)" -eq 0 ] || die "run as root (sudo)"
if [ ! -f "$HERE/.nvmrc" ] || [ ! -f "$HERE/src/main.ts" ]; then die "run it from a checkout of coxia-server"; fi

# shellcheck source=/dev/null
. /etc/os-release
if [ "${ID:-}" != ubuntu ] || [ "${VERSION_ID:-}" != 24.04 ]; then
  echo "warning: written for Ubuntu 24.04, this is ${PRETTY_NAME:-unknown}; the AppArmor step may not apply" >&2
fi

# --- packages --------------------------------------------------------------------------------------------------------------------
# bubblewrap: the command sandbox. git: the cores clone and branch. python3 + venv: the voice sidecar. xz-utils: the Node tarball.
# libatomic1: the official Node binary links it, and a minimal cloud image does not ship it.
install_packages() {
  say "packages"
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y -qq --no-install-recommends ca-certificates curl xz-utils git openssl bubblewrap python3 python3-venv apparmor libatomic1
}

# --- Node ------------------------------------------------------------------------------------------------------------------------
# The version in .nvmrc, from nodejs.org's official tarball, checked against its published SHA-256, and kept in /opt/coxia/node:
# the distribution's nodejs lags behind, and a repository with a third-party apt source would trust that source with root.
# Only the checksum list is fetched from the same site; for a stronger check, pin NODE_SHA256 from a source you trust.
install_node() {
  local want have arch
  want="$(tr -d '[:space:]' < "$HERE/.nvmrc")"; want="v${want#v}"
  have="$("$NODE_DIR/bin/node" --version 2>/dev/null || true)"
  if [ "$have" = "$want" ]; then say "node $want already installed"; return 0; fi
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64) arch=arm64 ;;
    *) die "unsupported machine $(uname -m)" ;;
  esac
  say "node $want"
  (
    tmp="$(mktemp -d)"
    trap 'rm -rf "$tmp"' EXIT
    name="node-$want-linux-$arch.tar.xz"
    curl -fsSL -o "$tmp/$name" "https://nodejs.org/dist/$want/$name"
    expected="$NODE_SHA256"
    if [ -z "$expected" ]; then
      curl -fsSL -o "$tmp/SHASUMS256.txt" "https://nodejs.org/dist/$want/SHASUMS256.txt"
      expected="$(awk -v f="$name" '$2 == f { print $1 }' "$tmp/SHASUMS256.txt")"
    fi
    [ -n "$expected" ] || die "no checksum found for $name"
    echo "$expected  $tmp/$name" | sha256sum -c --status || die "checksum of $name does not match"
    mkdir -p "$tmp/x" "$OPT"
    tar -xJf "$tmp/$name" -C "$tmp/x" --strip-components=1
    rm -rf "$NODE_DIR.old"
    if [ -d "$NODE_DIR" ]; then mv "$NODE_DIR" "$NODE_DIR.old"; fi
    mv "$tmp/x" "$NODE_DIR"
    chmod -R go-w "$NODE_DIR"
    rm -rf "$NODE_DIR.old"
  )
}

# --- user and folders ------------------------------------------------------------------------------------------------------------
setup_user_and_folders() {
  say "user and folders"
  if ! id "$SERVICE_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$STATE_ROOT" --create-home --shell /usr/sbin/nologin "$SERVICE_USER"
  fi
  install -d -m 0750 -o "$SERVICE_USER" -g "$SERVICE_USER" "$STATE_ROOT"
  install -d -m 0700 -o "$SERVICE_USER" -g "$SERVICE_USER" "$DATA_DIR" "$STATE_DIR"
  # root writes the configuration, the service reads it
  install -d -m 0750 -o root -g "$SERVICE_USER" "$CONF_DIR"
  install -d -m 0755 -o root -g root "$OPT"
}

# The key that protects the secrets in the data folder: 32 random bytes as 64 hex digits (the format the core reads), readable
# by the service user only. Created once; an existing file is never overwritten or printed, because replacing it would make
# every stored secret unreadable.
setup_master_key() {
  if [ -e "$KEY_FILE" ]; then say "master key already present, left as it is"; return; fi
  say "master key"
  ( umask 077; openssl rand -hex 32 > "$KEY_FILE.new" )
  chown "$SERVICE_USER:$SERVICE_USER" "$KEY_FILE.new"
  chmod 0600 "$KEY_FILE.new"
  mv "$KEY_FILE.new" "$KEY_FILE"
  cat <<NOTE

  A new master key was created in $KEY_FILE.
  Copy it off this machine now, into your password manager or another safe place: that copy is your recovery.
  Without it, the secrets in $DATA_DIR cannot be read again, on this machine or any other.
  (As the file is not printed here: sudo cat $KEY_FILE)

NOTE
}

# --- the public Coxia repository, built ------------------------------------------------------------------------------------------
as_service() {
  runuser -u "$SERVICE_USER" -- env HOME="$STATE_ROOT" PATH="$NODE_DIR/bin:/usr/local/bin:/usr/bin:/bin" "$@"
}

build_coxia() {
  say "coxia $COXIA_REF"
  install -d -m 0755 -o "$SERVICE_USER" -g "$SERVICE_USER" "$APP_DIR"
  # The build runs as the service user, not as root: it executes the repository's and its dependencies' scripts.
  chown -R "$SERVICE_USER:$SERVICE_USER" "$APP_DIR"
  if [ ! -d "$APP_DIR/.git" ]; then
    as_service git -C "$APP_DIR" init -q
    as_service git -C "$APP_DIR" remote add origin "$COXIA_REPO_URL"
  fi
  as_service git -C "$APP_DIR" remote set-url origin "$COXIA_REPO_URL"
  as_service git -C "$APP_DIR" fetch -q --depth 1 origin "$COXIA_REF"
  as_service git -C "$APP_DIR" -c advice.detachedHead=false checkout -q --detach --force FETCH_HEAD
  # No Electron binary: the server runs no desktop. The web client and the headless bundle are built from source.
  as_service env ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm --prefix "$APP_DIR" ci --no-audit --no-fund
  grep -q '"build:headless"' "$APP_DIR/package.json" || die "this Coxia ref has no 'build:headless' script; use a release that includes the headless entry"
  # The web client first, then the headless bundle (each writes its own folder under out/).
  as_service sh -c "cd '$APP_DIR' && npx electron-vite build"
  as_service npm --prefix "$APP_DIR" run build:headless
  [ -f "$APP_DIR/out/headless/coxia.mjs" ] || die "the headless bundle was not produced"
  [ -f "$APP_DIR/out/renderer/index.html" ] || die "the web client was not built"
  # Read-only for the service from here on.
  chown -R root:root "$APP_DIR"
  chmod -R go-w "$APP_DIR"
}

install_server() {
  say "supervisor"
  rm -rf "$SERVER_DIR"
  install -d -m 0755 "$SERVER_DIR"
  cp -r "$HERE/src" "$HERE/package.json" "$SERVER_DIR/"
  chown -R root:root "$SERVER_DIR"
  # `coxia-server status` for a person: same environment as the unit, same user.
  cat > /usr/local/bin/coxia-server <<WRAP
#!/bin/sh
# Runs the supervisor's commands as the service user, with the unit's environment. Usage: coxia-server status
if [ "\$(id -un)" != $SERVICE_USER ]; then exec sudo -u $SERVICE_USER /usr/local/bin/coxia-server "\$@"; fi
set -a
. $ENV_FILE
set +a
exec $NODE_DIR/bin/node $SERVER_DIR/src/main.ts "\$@"
WRAP
  chmod 0755 /usr/local/bin/coxia-server
  # An environment file an administrator already edited stays; the example is kept next to it for comparison.
  install -m 0640 -o root -g "$SERVICE_USER" "$HERE/deploy/coxia.env.example" "$ENV_FILE.example"
  if [ ! -e "$ENV_FILE" ]; then install -m 0640 -o root -g "$SERVICE_USER" "$HERE/deploy/coxia.env.example" "$ENV_FILE"; fi
}

# --- AppArmor --------------------------------------------------------------------------------------------------------------------
# Ubuntu 24.04 stops unprivileged programs from using the capabilities of a user namespace, which is all bwrap does. The profile
# says bwrap may (see its comment).
install_apparmor() {
  if ! command -v apparmor_parser >/dev/null 2>&1 || [ ! -d /etc/apparmor.d ]; then
    say "AppArmor not available, skipping the bwrap profile"
    return
  fi
  say "apparmor profile for bwrap"
  install -m 0644 -o root -g root "$HERE/deploy/apparmor/bwrap" /etc/apparmor.d/coxia-bwrap
  apparmor_parser -r /etc/apparmor.d/coxia-bwrap
}

check_bwrap() {
  say "bwrap as $SERVICE_USER"
  if runuser -u "$SERVICE_USER" -- bwrap --unshare-user --unshare-pid --ro-bind / / --proc /proc --dev /dev true 2>/dev/null; then
    echo "    ok: the sandbox can start"
  else
    echo "warning: bwrap cannot create a sandbox as $SERVICE_USER. On Ubuntu 24.04 check: sysctl kernel.apparmor_restrict_unprivileged_userns" >&2
    echo "         and 'aa-status | grep bwrap'; the commands the agents run will be refused until this works." >&2
  fi
}

# --- voice -----------------------------------------------------------------------------------------------------------------------
# The same steps the desktop window runs (src/main/voice-setup.ts), without the window: a Python environment with the sidecar's
# packages, then the speech model. They land where the core looks for them, <data folder>/userData/voice-venv and voice-models.
# Not done here: turning voice on. That setting is changed from the desktop app through the SSH tunnel (the web client cannot).
install_voice() {
  if [ "$COXIA_SKIP_VOICE" = 1 ]; then say "voice skipped (COXIA_SKIP_VOICE=1)"; return; fi
  say "voice sidecar (model: $COXIA_VOICE_MODEL)"
  local venv="$DATA_DIR/userData/voice-venv" models="$DATA_DIR/userData/voice-models"
  as_service mkdir -p "$DATA_DIR/userData"
  if [ ! -f "$venv/.cerimonias-ready" ]; then
    as_service rm -rf "$venv"
    as_service python3 -m venv "$venv"
    as_service "$venv/bin/pip" install --disable-pip-version-check -q -r "$APP_DIR/sidecar/requirements.txt"
    as_service "$venv/bin/python" -c 'import faster_whisper, edge_tts, av, soundfile, kokoro_onnx'
    # the marker the core reads as "this environment is complete"
    as_service sh -c "date -u +%FT%TZ > '$venv/.cerimonias-ready'"
  fi
  as_service mkdir -p "$models"
  as_service env HF_HOME="$models" HF_HUB_DISABLE_XET=1 "$venv/bin/python" "$APP_DIR/sidecar/voice_fetch.py" "$COXIA_VOICE_MODEL" | tail -n 1
}

# --- the unit --------------------------------------------------------------------------------------------------------------------
install_unit() {
  say "systemd unit"
  install -m 0644 -o root -g root "$HERE/deploy/coxia.service" /etc/systemd/system/coxia.service
  systemctl daemon-reload
  systemctl enable coxia.service
  systemctl restart coxia.service
}

install_packages
install_node
setup_user_and_folders
setup_master_key
build_coxia
install_server
install_apparmor
check_bwrap
install_voice
install_unit

cat <<DONE

Coxia is running. Next:
  systemctl status coxia            journalctl -u coxia -f            coxia-server status
  coxia-server pair                 a pairing code for a phone or a browser, and the SSH tunnel to reach the workspace
Copy $KEY_FILE off this machine if you have not yet.
DONE
