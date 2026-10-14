# Coxia Server

The Coxia core running headless, as a long-lived service on a VPS: the core, the web client served by the instance, a supervisor with one process per workspace, and the systemd unit that keeps it up. Admin clients (desktop, web, CLI) reach it over SSH; every admin device signs sensitive actions with a passkey.

## Status

Public, working towards the Coxia 1.0 release. The repository carries no company, person, host,
real issue number or secret in code, tests, docs, commit messages or branch names:
`node scripts/public-audit.mjs` enforces that in CI. The script is a copy of the
one in the Coxia repository; keep them in sync.

## How it fits

The Coxia core and its client contract live in the public repository
[exatasmente/coxia](https://github.com/exatasmente/coxia). This repository depends
on them; the public repository never depends on this one.

```
systemd unit (coxia.service, user "coxia")
  └─ supervisor (src/main.ts run)
       ├─ core process for workspace "a"   127.0.0.1:8800   serves the web client + /healthz
       ├─ core process for workspace "b"   127.0.0.1:8801
       └─ ...
```

The core keeps one workspace per process, so the supervisor reads the workspace
registry (`<data>/workspaces.json`, never written from here) and runs one
`out/headless/coxia.mjs` per workspace. On a fresh data folder it first runs the entry
once with `--init`, which makes the registry and its first workspace the way the core
does. The supervisor is plain Node, no
dependencies; Node 22.18 or later runs the TypeScript sources directly (type stripping), so there
is no build step for it. Everything that depends on the core's command line, its
registry file, `/healthz` or its admin socket is in [`src/core.ts`](src/core.ts).

- **A crashed core is restarted alone**, after 1 s, then 2 s, 4 s ... up to 60 s
  while it keeps dying; a core that stayed up 30 s starts again from 1 s. The others
  are not touched. The supervisor itself is restarted by systemd (`Restart=always`),
  and the unit is enabled, so everything comes back after a reboot.
- **Workspaces added to or removed from the registry** are noticed within 5 s: a new
  one gets a process, a removed one gets SIGTERM.
- **Stopping**: SIGTERM to the supervisor sends SIGTERM to every core, waits up to
  15 s, then SIGKILLs the rest. `TimeoutStopSec=30` in the unit stays above that.
- **Ports**: each workspace gets the lowest free port from `COXIA_BASE_PORT`
  (default 8800) and keeps it for as long as it exists in the registry, across
  restarts. The assignment is `<state>/ports.json`. A removed workspace gives its
  port back. Cores listen on `127.0.0.1` only; that is not configurable.
- **Logs** go to the journal, every line prefixed with the workspace id.

## Install

On a fresh Ubuntu 24.04 server, as root, from a checkout of this repository:

```bash
sudo COXIA_REF=<release tag> ./deploy/install.sh
```

It is safe to run again. It:

1. installs `bubblewrap`, `git`, Python 3 with `venv` and a few tools from the
   distribution;
2. installs the Node version of [`.nvmrc`](.nvmrc) under `/opt/coxia/node` from the
   official tarball, after checking its SHA-256 (set `NODE_SHA256` to pin it
   yourself);
3. creates the unprivileged `coxia` user, `/var/lib/coxia/data` (0700),
   `/var/lib/coxia/state` and `/etc/coxia` (0750);
4. creates the master key once (below);
5. builds the public Coxia repository at `COXIA_REF` into
   `/opt/coxia/releases/<version>` with [`deploy/build-release.sh`](deploy/build-release.sh)
   (the one build path, also used by updates): as the `coxia` user,
   `ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`, `electron-vite build`,
   `npm run build:headless`, then read-only; it never runs `npm run dist`. It makes
   `/opt/coxia/app` a link to that release. A server that already runs another
   version is not switched by the install script (that would skip the snapshot and the
   health check): it builds the new one beside it and says to use `coxia-server update`;
6. installs the supervisor in `/opt/coxia/server` and a `coxia-server` command;
7. installs the AppArmor profile that lets `bwrap` create user namespaces on Ubuntu
   24.04 ([`deploy/apparmor/bwrap`](deploy/apparmor/bwrap)) and checks that `bwrap`
   starts as `coxia`;
8. sets up the voice sidecar (below);
9. installs, enables and starts [`coxia.service`](deploy/coxia.service), and enables
   the update timer (below).

Paths and the base port are in `/etc/coxia/coxia.env`
([example](deploy/coxia.env.example)). If you move the data folder, change
`ReadWritePaths=` in the unit as well.

## The master key and its recovery copy

Secrets in the data folder are encrypted with a master key, a file of 64 hex digits
at `/etc/coxia/master.key` (0600, owned by `coxia`), outside the data folder on
purpose: the core refuses a key inside it, and a backup of the data does not carry
the key. The install script creates it once, never overwrites it and never prints
it.

**Copy it off the machine** (`sudo cat /etc/coxia/master.key`, into a password
manager) as soon as the install ends. If the server is lost, the data without that
copy cannot be read again.

## Reaching an instance

The cores are not reachable from the network. On the server, ask a workspace's core
for a pairing code; it prints the tunnel to open from your computer and the address:

```bash
coxia-server pair [workspace]      # the workspace can be left out when there is only one
ssh -N -L <port>:127.0.0.1:<port> user@host
# then open http://localhost:<port>/cerimonias/ and type the code (valid for 10 minutes, one device)
```

`<port>` is the workspace's port in `coxia-server status` (8800 for the first). The code
comes through the core's local admin socket (`<data>/workspaces/<id>/admin.sock`, mode
0600), which only the `coxia` user can open: being on the server is the authentication.
`coxia-server call <workspace> <channel> [json-args]` calls any channel of the core the
same way, with the desktop's rights, and prints the answer as JSON.
Browsers treat `localhost` as a secure context, so the microphone works through the
tunnel. The desktop app connects through the same tunnel. A public address, behind
TLS and with a domain, comes later.

## Operating

```bash
journalctl -u coxia -f            # logs, one prefix per workspace
systemctl status coxia
coxia-server status               # workspaces, ports, pids, restarts, /healthz (exit 1 if something is down)
coxia-server pair [workspace]     # a pairing code for a phone or a browser, and the tunnel to reach it
sudo coxia-server import <bundle> # take in a workspace moved from another machine (see below)
sudo coxia-server deploy-key      # the service user's SSH key, created once; prints its public line
sudo coxia-server update --check  # is there a newer version, and is now a safe point
sudo systemctl restart coxia      # restarts every workspace
```

## Importing a workspace from another machine

Moving a workspace here (from a Coxia on a computer) clones its repositories on the server,
so the server needs a key the code host accepts.

```bash
sudo coxia-server deploy-key      # prints the public line; add it to the repositories as a deploy key
```

The key is `/var/lib/coxia/.ssh/id_ed25519`, owned by the `coxia` user, created once. Running
the command again never replaces it; it prints the same public line. A read-only deploy key is
enough to clone; pushing needs write access, which is the host's setting, not this command's.

Then, with a bundle on the server (the move tool copies it there):

```bash
sudo coxia-server import bundle.tar.gz     # or an unpacked bundle folder
```

The command, as root, in this order:

1. Unpacks into a temporary folder owned by `coxia` (mode 0700). An archive with an absolute
   path, a `..` segment, or anything but plain files and folders (links, devices) is refused
   before a byte is extracted. It reads `manifest.json` (format 1; workspace and repository
   ids and branch names must be plain names).
2. Clones each repository as `coxia` into `/var/lib/coxia/repos/<workspace id>/<repo id>`,
   using the deploy key. A folder that is already a clone of the same remote is kept. Run
   branches the old machine had only locally arrive from `git/<repo id>.bundle`; the
   checked-out branch is never a fetch target. `user.name` and `user.email` are set in each
   clone from the manifest.
3. Runs the core's one-shot `--import` as `coxia`, with the service's data folder and master
   key file: it places the workspace, merges its secrets and registers it. Nothing is
   registered before every clone has worked: a clone that fails stops the import with exit 1
   and a message that names the repository.
4. Restarts the service, waits for the workspace's `/healthz`, removes the temporary folder
   and prints one JSON line: `{"imported":"<id>","repos":[{"id","path"}],"health":"ok"}`.

Running it again with the same bundle is safe: clones are kept, the core answers that the
workspace is already there, and the service restarts.

**Trust on first use.** The clones run `ssh` with `StrictHostKeyChecking=accept-new`: the
first time the server meets a code host it records the host's key without asking, and from
then on a different key is refused. The first clone is therefore the moment to be on a network
you trust; compare the fingerprint with the host's published one if that matters to you.
Only ssh, https and git remotes are cloned. `status` lists the imported workspace like any
other, from the registry the core wrote. `COXIA_REPOS_DIR` in `/etc/coxia/coxia.env` moves
the clones; the default is inside the service's writable path.

## Updates, snapshots and rollback

The instance follows the public repository's tags `v*.*.*` on its own and goes back by
itself when a version does not hold. Nobody has to be there.

**Channel.** `COXIA_UPDATE_CHANNEL` in `/etc/coxia/coxia.env`: `beta` (default: every
beta and every release, the newest semver above the running one), `stable` (releases
only) or `off`. Versions are found with `git ls-remote --tags` against
`COXIA_REPO_URL`, so no token is needed. [`coxia-update.timer`](deploy/coxia-update.timer)
runs `coxia-server update` as root every 6 hours (plus up to 30 minutes of jitter, and
once at boot if a run was missed). A version a rollback already left is not offered
again by the timer.

**Layout.**

```
/opt/coxia/releases/<version>/     one build per version; the active one and the previous one stay
/opt/coxia/app                     link to the active release; the supervisor reads the core through it
/var/lib/coxia/snapshots/          root-owned, 0750
    <timestamp>-<fromVersion>/     data/ (a copy of the whole data folder, owners and modes kept) + meta.json; the newest two stay
    <timestamp>-failed-<version>/  the data a rollback set aside; never deleted by the updater, yours to remove
/var/lib/coxia/state/updates.jsonl one line per update, rollback, postponement or failure
```

**What one run does**, in this order:

1. Finds a newer version. None: it ends.
2. Builds it into `releases/<version>` while the running version keeps serving. A failed
   build changes nothing.
3. **Safe point.** Every running core is asked through its admin socket. The update
   waits (logged, audited, tried again at the next timer) if any core has an
   action executing (`actions:list`, state `running`: an approved push, pull request,
   comment or release step in flight) or a run with an agent working a step
   (`runs:list`, status `working`). The second is wider than "an external effect" on
   purpose: the runner's autonomous pushes, pull requests and comments are audited
   but are not listed anywhere while they run, so a working run is the only sign of
   them. Runs parked at a gate, a question, a wait, to-start, to-accept or failed
   do not block: they are files and resume after the restart. A core that cannot be
   asked counts as busy. The check is made right before stopping; a run that starts
   in the milliseconds between the check and the stop is stopped like any restart
   would stop it.
4. Stops the service (every core gets SIGTERM), **snapshots** the data folder and
   keeps the newest two. It refuses when the disk has no room (the size of the data
   plus 10%). The master key is not in the data folder and is not copied.
5. Points `/opt/coxia/app` at the new release, starts the service and **watches** it.
   Every workspace in the registry must have its core running on the new version
   (`/healthz`), the runner must answer on the admin socket (`runs:list`), and the web
   client must answer 200 on the base path `web:view` gives. It has 2 minutes to get
   there; then all of it must keep holding for `COXIA_UPDATE_HEALTH_MINUTES` (default
   5) minutes. A core restart is a failure at once (no restart loops), and so is any
   look that fails after the first good one. "Able to resume" is as far as the
   contract lets the server see: the runner answers; nothing exposes that a run
   resumed.
6. **Rollback** if that fails (or the service does not start, or the snapshot cannot be
   made before anything changed, then it only starts the old version again): stops,
   restores the snapshot's data (copied beside the data folder first, then swapped by
   rename; what was there goes to `snapshots/<timestamp>-failed-<version>`, not
   deleted), points the link back at the previous release, starts, and watches the old
   version for a minute. Swapping the binary alone would not do: an older version
   refuses a config a newer schema wrote, so release and data go back together.
7. On success it prunes to the two newest snapshots and the active and the previous
   release.

**Telling the person.** Every outcome is a line in `updates.jsonl` and in the journal
(`journalctl -u coxia-update`), `coxia-server status` shows the running version, the
channel, the last update, the last rollback (in capitals) and the snapshots, and each
workspace gets a line in its general thread through the core's admin socket
(`forum:post`). That line is posted as the admin, not as the app: the core has no
channel for an app-authored notice yet. `COXIA_UPDATE_NOTICE=0` turns it off. A timer
run that rolled back ends with exit 3 (and 2 when the rollback failed too), so
`systemctl --failed` shows it.

**Commands** (root; the `coxia-server` wrapper uses sudo for these two):

```bash
coxia-server update --check   # the newest version, and whether now is a safe point; changes nothing
coxia-server update           # what the timer runs
coxia-server update --now     # same, with the channel off too, and a version a rollback left may be tried again
coxia-server rollback         # to the previous release and the snapshot taken before the update; what was written since is set aside
```

**What is and is not covered.**

- Snapshotted: everything under the data folder (`COXIA_DATA_DIR`): config, secrets,
  runs, workspaces, the voice environment and models in `userData` too (they can be
  large: leave room for three copies of the data, two snapshots plus the one being made).
- Not snapshotted: the master key (`/etc/coxia/master.key`), the supervisor's state
  folder, the operating system.
- **Off-machine backups are yours**, outside the app: the snapshots are on the same
  disk, and the key is only in `/etc/coxia`.
- Only the core is updated. The supervisor (`/opt/coxia/server`) and the Node version
  change when you run the install script from a newer checkout of this repository.
  The voice setup is not repeated for a new release.
- Work done on a new version before it is rolled back is not in the restored data;
  it is in the `-failed-` folder.

## Voice

The sidecar runs on the server, and the install script does what the desktop's
voice window does: a Python environment with the sidecar's packages and the speech
model (`COXIA_VOICE_MODEL`, default `small`), in `<data>/userData/voice-venv` and
`voice-models`, which is where the core looks. `COXIA_SKIP_VOICE=1` leaves it out.

Turning voice **on** is a setting of the core that only the desktop app may change
(the web client is refused on the `voice:*` channels): connect the desktop through
the tunnel and enable it in the voice settings. The `userData` location is taken from
the core's sources, not from a running headless instance; check it on the first
install.

## Not done yet

- The update timer, the switch of a real release and a rollback have only run against fake
  cores in the tests, not on a server with systemd and a real build.
- Nothing here has run on a real server yet: the unit's hardening, the AppArmor
  profile and the install script are checked by reading and by the tests of the
  supervisor, not by a boot. Run `coxia-server status` and a sandboxed command after
  the first install.
- The public address, TLS and a domain.

## Development

```bash
nvm use && npm ci
npm run typecheck
npm test            # the supervisor against a fake core on 127.0.0.1
```

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
