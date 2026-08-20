# GhostD

GhostD is a local-first context runtime for developer-agent workflows. It
captures only documented host lifecycle events, stores a redacted canonical
history locally, and sends revision-pinned context to sidecar questions.

It never reads hidden provider transcripts, collects provider credentials,
bypasses host trust, or silently installs capture hooks.

## Release status

The repository contains the release packaging for the `ghostd` npm package and
the source used to render a Homebrew-tap formula. It is not published to npm or
Homebrew yet, and it remains `UNLICENSED`; do not represent either installation
command as available until a signed release and public license are published.

When a release is published, the installation commands will be:

```sh
npm install --global ghostd
ghost doctor
```

The Homebrew command will be documented only after the dedicated tap receives a
checksum-pinned formula.

## Safe first use

`ghost doctor` is read-only. It reports local storage, CLI availability,
capture configuration, and safe recovery steps without inspecting credentials,
authentication, provider account state, or private transcripts.

To enable capture for a supported CLI host, the user must explicitly approve
that one project-local integration:

```sh
cd /path/to/workspace
ghost setup codex --approve
```

Codex project trust remains a separate user-controlled step. See the
[host integration matrix](https://github.com/NimaJafariComp/GhostD/blob/main/docs/host-integrations.md)
and [release guide](https://github.com/NimaJafariComp/GhostD/blob/main/docs/releasing.md)
for supported-host boundaries and release verification.
