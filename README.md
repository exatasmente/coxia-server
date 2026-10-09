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

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
