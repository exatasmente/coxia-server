# Coxia Server

The Coxia core running headless, as a long-lived service on a VPS: the core, the web client served by the instance, a supervisor with one process per workspace, and the systemd unit that keeps it up. Admin clients (desktop, web, CLI) reach it over SSH; every admin device signs sensitive actions with a passkey.

## Status

Private while Coxia works towards 1.0. It becomes public with the 1.0 release, so
everything here is written as if it were public already: no company, person, host,
real issue number or secret in code, tests, docs, commit messages or branch names.
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
`out/headless/coxia.mjs` per workspace. The supervisor is plain Node, no
dependencies; Node 22.18 or later runs the TypeScript sources directly (type stripping), so there
is no build step for it. Everything that depends on the core's command line, its
registry file or `/healthz` is in [`src/core.ts`](src/core.ts).

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
5. fetches the public Coxia repository at `COXIA_REF` into `/opt/coxia/app`,
   builds the web client and the headless bundle as the `coxia` user
   (`ELECTRON_SKIP_BINARY_DOWNLOAD=1 npm ci`, `electron-vite build`,
   `npm run build:headless`), then makes it read-only; it never runs
   `npm run dist`;
6. installs the supervisor in `/opt/coxia/server` and a `coxia-server` command;
7. installs the AppArmor profile that lets `bwrap` create user namespaces on Ubuntu
   24.04 ([`deploy/apparmor/bwrap`](deploy/apparmor/bwrap)) and checks that `bwrap`
   starts as `coxia`;
8. sets up the voice sidecar (below);
9. installs, enables and starts [`coxia.service`](deploy/coxia.service).

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

The cores are not reachable from the network. From your computer:

```bash
ssh -L 8790:127.0.0.1:<port> user@host     # then open http://localhost:8790
```

`<port>` is the workspace's port in `coxia-server status` (8800 for the first).
Browsers treat `localhost` as a secure context, so the microphone works through the
tunnel. The desktop app connects through the same tunnel. A public address, behind
TLS and with a domain, comes later.

## Operating

```bash
journalctl -u coxia -f            # logs, one prefix per workspace
systemctl status coxia
coxia-server status               # workspaces, ports, pids, restarts, /healthz (exit 1 if something is down)
sudo systemctl restart coxia      # restarts every workspace
```

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

- Pairing a first client from the server's shell needs the core's local admin door,
  which comes next.
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
