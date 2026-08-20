# GhostD release and installation policy

## Supported release channels

The intended channels are npm for every supported Node platform and a dedicated
Homebrew tap for macOS and Linux. Homebrew Core is deliberately out of scope
until GhostD is public, stable, and meets
Homebrew's formula requirements.

GhostD is licensed under Apache-2.0, but no npm registry package or Homebrew
tap has been published. GitHub Releases are available as a private-repository
distribution channel once a matching version tag is pushed. The commands below
are release-operator procedures, not end-user installation claims.

## GitHub Releases and private installation

Pushing a tag matching the package version, such as `v0.1.0`, runs the release
workflow. It verifies the project, creates the npm tarball and SHA-256 file,
performs a fresh isolated install test, packages the VS Code extension, and
creates a GitHub Release containing those assets.

For a private repository, download release assets through an authenticated GitHub
CLI session. This avoids placing a token in an install URL or package config:

```sh
gh auth login
gh release download v0.1.0 \
  --repo NimaJafariComp/GhostD \
  --pattern 'ghostd-0.1.0.tgz' \
  --dir ./ghostd-release

npm install --global ./ghostd-release/ghostd-0.1.0.tgz
ghost doctor
```

To test a tarball without changing the global npm installation:

```sh
npm run release:install-test -- ./ghostd-release/ghostd-0.1.0.tgz
```

Uninstalling the CLI does not remove local Ghost history or provider settings:

```sh
npm uninstall --global ghostd
```

## Compatibility policy

GhostD follows semantic versioning:

- Patch releases preserve canonical-ledger and CLI behavior.
- Minor releases may add compatible commands, capture fields, and migrations.
- Major releases may change public CLI or SDK contracts and must include an
  explicit migration and recovery guide.

The canonical event envelope and SQLite migrations are append-only. A newer
build must either open existing local history safely or refuse with a clear
recovery instruction; it must never rewrite history. Downgrades are supported
only across releases whose migration notes explicitly say so. Users keep a copy
of `~/.ghost` before any manual downgrade.

## Platform matrix

The Node package supports Node 22.5 or later on the following test targets:

| Platform | Architectures | Release channel |
| --- | --- | --- |
| macOS | arm64, x64 | npm; dedicated Homebrew tap after publication |
| Linux | x64, arm64 | npm; dedicated Homebrew tap after publication |
| Windows | x64 | npm |

Provider CLIs, provider login, and host-capture verification are separate from
GhostD installation. The host matrix remains the source of truth for what may
be advertised as captured: [host integrations](host-integrations.md).

## Release verification

1. Run `npm ci` and `npm run release:verify` on each platform in the matrix.
   The GitHub workflow performs this baseline check.
2. Push a matching `v<package-version>` tag. GitHub verifies the release,
   creates the npm tarball, SHA-256 file, and VSIX, runs the isolated install
   test, and attaches the immutable assets to a GitHub Release.
3. In a clean temporary prefix, install the tarball with npm, run `ghost
   doctor`, `ghost --help`, and confirm that a missing provider produces a
   recoverable error without creating a provider credential or host hook.
4. Upgrade the temporary prefix from the previous supported release to the
   candidate, run `ghost doctor`, then restore the previous release only when
   that release's migration notes declare downgrade support. Keep the ledger
   backup throughout this test.
5. Uninstall the temporary package and verify that provider configuration and
   `~/.ghost` history remain untouched unless the user explicitly removes them.
6. Publish the exact verified tarball with an authorized npm account. Never put
   an npm token, provider key, or provider login in this repository or a build
   artifact.

## Dedicated Homebrew tap

After the npm tarball is published, render a formula using the *published*
tarball checksum:

```sh
npm run release:formula -- \
  --version 0.1.0 \
  --sha256 <published-tarball-sha256> \
  --output /path/to/homebrew-tap/Formula/ghostd.rb
```

Commit that rendered formula to the dedicated tap and test `brew install
<owner>/tap/ghostd` plus `ghostd doctor` on macOS and Linux. Do not publish the
template itself as a formula: placeholders are intentionally invalid until a
released tarball and checksum exist.

## Installer safety contract

Installing GhostD only installs the package. It does not collect credentials,
perform provider login, grant Codex trust, install hooks, inspect transcripts,
or mutate a workspace. `ghost doctor` is read-only. Host capture requires
`ghost setup <host> --approve` in the intended workspace, and Codex trust
remains an independent user decision.
