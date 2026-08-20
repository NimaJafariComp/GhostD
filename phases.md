# GhostD implementation status

GhostD is a local-first universal agent context runtime. It owns a canonical, immutable context graph; agent conversations are imported through adapters or evaluated as compute engines. A Ghost branch is copy-on-write: it points at a shared revision until it diverges, and no model context is sent until that branch is used.

## System invariants

1. Canonical history is immutable.
2. Creating a Ghost branch copies no parent context.
3. Provider state is disposable; Ghost state is authoritative.
4. Every materialized answer is attributable to an exact Ghost revision and workspace snapshot.
5. Nothing enters Main from a Ghost branch without an explicit user-controlled promotion.
6. A provider-handle loss or adapter removal never loses or corrupts canonical Ghost history.
7. Persistent branches have explicit lifecycle state: closing preserves history; deletion is explicit and recoverable where supported.
8. Cross-provider materialization never assumes access to hidden model state.
9. Secret leakage has zero tolerance.
10. Obsolete-state leakage has zero tolerance in labeled correctness cases.

## Phase 0 — Canonical capture and fidelity

**Status:** Complete

- [x] Create the TypeScript CLI foundation.
- [x] Define the canonical, append-only `GhostEvent` format.
- [x] Version the canonical event envelope and migrate stored events safely.
- [x] Assign every canonical event a required or derived trust class.
- [x] Persist sessions and events locally in SQLite.
- [x] Add `ghost ingest` for newline-delimited canonical events.
- [x] Add deterministic `ghost context` output.
- [x] Preserve event provenance for every compiled context fact.
- [x] Redact obvious credentials before local storage; keep storage and remote-redaction policies distinct.
- [x] Define and exercise an internal source-adapter boundary with a fixture adapter.
- [x] Add fixture-backed context-fidelity scoring.
- [x] Define fidelity dimensions and an experimental 90% current-state target; obsolete-state and secret leakage have zero tolerance.
- [x] Add the Codex hook installer and event normalizer.
- [x] Test the installer, canonical normalization, provenance, storage redaction, deterministic context compilation, and unresolved-question recall (21 automated tests, including malformed inputs, unsupported hooks, changed requirements, clean-after-dirty workspace state, nested credentials, and partial private keys).
- [x] Capture and label the trusted, live-Codex suite: simple implementation, changed requirements, an observable failed hypothesis, large tool output, sensitive values, a dirty tree with multiple modified files, and an unresolved question. Codex project trust remains user-controlled; the adapter does not and must not grant it.

**Exit criterion:** A labeled real-session suite establishes a defensible current-state-fidelity baseline with no observed secret or obsolete-state leakage. Ghost can answer those questions from its deterministic, secret-safe artifact without consulting the original Codex session. The 90% target is experimental until the first real-session results establish a meaningful threshold.

**Current evidence:** The shipped Codex hook format is validated against the installed Codex hook schema. Automated checks cover canonical context recall, constraints, decisions, unresolved questions, modified files, failures, provenance, malformed boundaries, unsupported hooks, hook-config preservation, changed-requirement supersession, clean-after-dirty workspace state, and nested/partial credentials. Trusted live Codex runs captured the canonical lifecycle, assistant response, Git snapshots, decisions, an observable failure, changed requirements (with the current objective correctly superseding the prior objective), a 12,001-byte tool result, a redacted test credential, two dirty working-tree files, and an unresolved question. No secret or obsolete-state leakage was observed. Silent tool failures are not inferred when Codex provides no result text; this is deliberate to avoid unsupported facts.

**Initial evaluation suite:** simple implementation; changed requirements; rejected hypothesis followed by a correct diagnosis; large tool output; sensitive data in tool or file output; and a dirty Git tree with multiple modified files.

## Phase 1 — Context graph and logical replicas

**Status:** Complete

- [x] Add meaningful immutable `GhostRevision` checkpoints, each with an event high-water mark and workspace snapshot identity.
- [x] Add copy-on-write `GhostBranch` records with base and head revision IDs.
- [x] Record branch tracking revision, originating session, and explicit lifecycle state.
- [x] Add `ghost branch <name>` to create cold logical replicas without an LLM call.
- [x] Add `ghost branch close <name>`; preserve closed-branch history.
- [x] Add provider-specific `BranchMaterialization` records with a synchronized revision and provider handle; derive staleness from revision ancestry.
- [x] Prove immutable ancestry, zero-copy branch creation, and exact materialization revision attribution with database integration tests.

## Phase 2 — Lazy materialization and target adapters

**Status:** Complete

- [x] Add capability metadata for native forks, session resume, cache scope/lifetime, context limits, workspace/tool access, and write access.
- [x] Implement pluggable materialization strategies that choose fidelity, cost, and latency rather than a fixed provider-specific branch.
- [x] Add a read-only Claude target adapter and `ghost ask claude "…"`.
- [x] Define `ghost ask <agent> "…"` as ephemeral and `ghost ask <branch> "…"` as persistent.
- [x] Store provider handles separately from canonical Ghost branches.
- [x] Record materialization decisions, source revision, token counts, configured cost, latency, redacted answer text, and provider-failure recovery details.
- [x] Run deterministic context-pinning and token/latency evaluations with mocked provider responses, plus bounded live Claude materializations that returned a response with Ghost revision and workspace-snapshot attribution. The latest isolated live verification used a one-event Ghost context and a 64-token cap and returned `GhostD Claude live materialization succeeded.` No credential was stored in GhostD or this repository.

## Phase 3 — Synchronization and temporal context

**Status:** Complete

- [x] Add lazy delta synchronization and stale-materialization detection. `ghost branch status <name>` creates only the necessary immutable checkpoint and reports pending events separately from stale branch materializations.
- [x] Add explicit `ghost rebase <branch>` with rebase-fidelity evaluation. Rebase advances only the branch head/tracking pointers, records an auditable rebase, and never rewrites events, revisions, or prior provider runs.
- [x] Track temporal validity, supersession, reaffirmation, and invalidation for constraints, decisions, assumptions, failures, and hypotheses using explicit canonical payload relations; malformed or prose-only metadata never causes guessed state transitions.
- [x] Add the Claude hook-shaped source normalizer and `ghost claude-hook` ingestion boundary without reading hidden provider transcripts or state.

## Phase 4 — Multi-agent reasoning

**Status:** Complete

- [x] Add Gemini source/target adapters and frozen-revision `ghost compare` runs. Gemini defaults to `gemini-3.6-flash` with minimal thinking (configurable by `GHOST_GEMINI_THINKING_LEVEL`), uses a stateless, read-only `generateContent` request, and never sends tools, workspace access, or hidden-session continuation.
- [x] Add structured insights that separate findings, evidence, and recommendations. Evidence is persisted only when every cited canonical event ID exists in the exact frozen comparison revision.
- [x] Add explicit merge/copy flows. Copies share the source revision without duplicating events; merges are audited, same-session fast-forwards and never infer conflict resolution. Promotion into a branch named `main` is therefore always an explicit `ghost merge` action.
- [x] Add `ghost switch <agent>` for intentional cross-agent continuation. It records the switch and renders a provenance-bearing handoff at the branch's exact revision without materializing or assuming provider state.
- [x] Test Gemini request/response parsing, Gemini source normalization, frozen-revision two-provider comparisons, malformed/unsupported evidence rejection, partial provider failure, audit retrieval, and explicit copy/merge/switch behavior (46 automated tests). A local CLI smoke test validates rebase, copy, merge, and switch without calling a provider.
- [x] Run bounded live Gemini materializations after setting `GEMINI_API_KEY`. The latest isolated live verification used a one-event Ghost context and a 64-token cap and returned `GhostD Gemini live materialization succeeded.` with exact Ghost revision and workspace-snapshot attribution. No credential was stored in GhostD or this repository.

## Phase 5 — Write-capable branches

**Status:** Complete

- [x] Add isolated Git worktrees for explicit write-capable replicas. Creation requires a clean repository at the exact Git commit captured by the Ghost revision; worktrees live under GhostD’s managed root and use a deterministic per-branch Git ref.
- [x] Track patch provenance, branch cleanup, and concurrent-agent safety. GhostD persists only commit ranges, changed-file counts, and SHA-256 patch identities—never patch contents—and retains the Git branch and audit history when a clean worktree is closed. Database uniqueness plus Git’s branch/worktree locking permits only one active replica per Ghost branch.
- [x] Compare implementations and selectively promote user-approved code changes. `ghost worktree diff <branch>` renders an unpersisted review diff; `ghost worktree promote <branch> <target-git-branch> --approve` requires a clean source and target, the named target checked out, and a fast-forward-only merge. It never resolves conflicts or promotes automatically.

## Phase 6 — Ecosystem integration foundations

**Status:** Complete

- [x] Add ACP proxy support where it provides cleaner session ownership. `ghost acp handoff <branch>` emits a revision- and workspace-pinned, provider-neutral payload with `providerSession: null`; it never claims ownership of hidden provider state.
- [x] Add MCP as an interface to Ghost, not the Ghost core. `ghost mcp` provides a local JSON-RPC stdio server with read-only `ghost_context` and `ghost_branch_status` tools plus a latest-context resource; no MCP tool can write files, invoke providers, or promote code.
- [x] Publish the adapter SDK and compatibility ladder. The public package entry point exports canonical events, source/target adapter contracts, Ghost database access, provider adapters, ACP handoffs, MCP server, and opt-in integration configuration.
- [x] Add IDE/editor integrations only after CLI fidelity is proven. `ghost vscode setup` merges GhostD Context and MCP tasks into the current workspace’s `.vscode/tasks.json` without replacing existing tasks or extensions.
- [x] Add Antigravity integration discovery. `ghost providers` detects the official `antigravity` executable and lets users record explicit `subscription` or `api` provider mode via `ghost configure`; credentials are never persisted by GhostD, and no unverified installer command is run.

**Scope boundary:** This phase provides provider-neutral interfaces and a Codex project-hook installer. Universal source capture and active-session coordination are delivered in Phase 7; unsupported apps and providers remain explicitly unavailable rather than inferred.

## Phase 7 — Universal host integration and session coordination

**Status:** Complete — blocks Phase 8 release distribution until release packaging exists

- [x] Replace the Codex-only meaning of `ghost setup` with an explicit, provider-neutral setup flow. `ghost setup` reports installed-host and capture status without changing host configuration; `ghost setup <codex|claude|gemini> --approve` requires an explicit per-host approval before a project hook is written; and `ghost setup remove <host> --approve` removes only GhostD's exact hook command.
- [x] Implement and validate source-capture installers for the documented Codex, Claude Code, and Gemini CLI hook contracts. Claude uses project-local `.claude/settings.local.json`; Gemini uses project `.gemini/settings.json`; Codex retains its project hook and trust boundary. Editor extensions, desktop applications, Antigravity, and any provider without a verified capture contract are reported as unavailable.
- [x] Normalize received lifecycle events into a stable stored host-session identity composed of provider, provider-supplied session ID, and workspace CWD. No process names, window titles, transcript files, or undocumented provider state are inspected. Existing unambiguous raw session IDs remain readable for compatibility; ambiguous IDs are rejected.
- [x] Add active-session awareness with documented lifecycle signals and a user-controlled selector: `ghost session list`, `ghost session status`, and `ghost session use <id>`. GhostD automatically resolves only a single open captured session in the current workspace; it never chooses the most recently seen session from another workspace or provider. Current official CLI hooks do not expose foreground-window focus, so simultaneous sessions require explicit user selection rather than a guessed focus state.
- [x] Support concurrent sessions in one workspace and concurrent providers without implicit merging. Cross-provider continuation remains an intentional Ghost handoff or branch action.
- [x] Record capture availability separately from provider availability: CLI discovery does not imply capture is configured or that GhostD can observe a desktop/editor session.
- [x] Keep host boundaries safe: hooks send only documented stdin payloads; GhostD does not read hidden transcripts, collect credentials, grant trust, or modify a host configuration unless the user supplies `--approve` for that specific supported host.
- [x] Test idempotent configuration merging, exact-command removal, unsupported-host reporting, documented lifecycle aliases, provider/workspace session identity, simultaneous-session ambiguity, explicit selection, legacy compatibility, and degraded status behavior. The 63-test automated suite includes messy Codex, Claude, Gemini, secret-redaction, large-output, changed-direction, failed-hypothesis, and concurrent-session scenarios; macOS CLI smoke tests confirm status and end-to-end Codex-hook ingestion without mutating host configuration.

**Exit criterion:** Met for supported CLI hosts. A user can explicitly enable GhostD capture, see the exact host session and workspace GhostD is receiving, choose among simultaneous sessions when necessary, and remove the integration cleanly. GhostD never claims to capture an app, plugin, or session for which no verified integration is active.

## Phase 7.1 — Integration platform and local bridge

**Status:** Complete

- [x] Implement `ghost bridge serve`, a versioned authenticated local bridge over an owner-only Unix socket (or Windows named pipe). The service is local-only; endpoint configuration and registered-client credentials are persisted with owner-only permissions.
- [x] Bind each generated editor-client credential to one normalized workspace. A credential from another workspace, a revoked credential, or an invalid token cannot enumerate sessions or read context.
- [x] Expose only the versioned allowlist: capture status, captured-session list and explicit selection, provenance-bearing context, branch status, and read-only ACP handoff rendering. The bridge cannot ingest events, invoke a provider, expose raw payloads or credentials, modify branches, or promote code.
- [x] Implement `ghost bridge status` without printing credentials. It reports only the local endpoint and registered-client count.
- [x] Define and serve the capability states `supported and verified`, `installed but not configured`, `configured but inactive`, and `unsupported` using configured capture and observed workspace sessions.
- [x] Test authentication, workspace isolation, credential rotation and revocation, private filesystem permissions, redacted context/handoffs, branch isolation, and capability reporting. Typecheck, build, full tests (65), dependency audit, and a real `ghost bridge serve`/`status` CLI smoke run pass.

**Exit criterion:** Met. The stable local bridge is ready for an editor client to register during setup, authenticate to its one workspace, and use only GhostD's safe read/explicit-selection surface. No VS Code client exists yet; that is Phase 7.2.

## Phase 7.2 — VS Code family and Codex workflow

**Status:** Planned

- [ ] Build one GhostD VS Code extension for VS Code-compatible editors, with workspace-scoped capture status, session list/selection, context inspection, and explicit handoff commands.
- [ ] Connect the extension only to the Phase 7.1 bridge; it must not scrape Codex chats, inspect process state, or read provider transcripts.
- [ ] Validate the end-to-end Codex-in-VS-Code workflow: `ghost setup codex --approve`, host trust, captured session visibility, explicit selection from the integrated terminal, simultaneous sessions, restart, and clean removal.
- [ ] Publish to each applicable editor registry only after its compatibility and remote-workspace behavior are verified.

**Exit criterion:** A Codex user in a verified VS Code-family host can identify and select the correct captured Codex session without focus guessing; the existing Codex project trust boundary remains intact.

## Phase 7.3 — Claude Code CLI and Desktop Code tab

**Status:** Planned

- [ ] Keep the existing Claude project hook as the development integration and package the stable configuration as a versioned Claude plugin.
- [ ] Validate the plugin across Claude Code CLI and the Desktop Code tab using documented lifecycle hooks and host-provided session/workspace data.
- [ ] Test plugin install, upgrade, disable, uninstall, parallel sessions, host restart, provider failure, secret redaction, and exact cleanup.
- [ ] Do not use Desktop UI scraping or treat a Desktop window as a session identity signal.

**Exit criterion:** One verified Claude plugin captures both supported CLI and Desktop Code sessions with provenance, recovery, and clean removal.

## Phase 7.4 — Gemini CLI and IDE-connected sessions

**Status:** Planned

- [ ] Harden and package Gemini lifecycle-hook setup, preserving Gemini's strict JSON stdout contract and existing user configuration.
- [ ] Test Gemini CLI both standalone and connected to a verified editor workspace, including multiple sessions, workspace mismatches, hook failure, provider outage, and restart recovery.
- [ ] Treat Gemini CLI Companion as Gemini's own IDE-context channel. GhostD may use only documented public contracts and never its private extension state.
- [ ] Bind a Gemini session through hook-supplied identity; when identity is ambiguous, require `ghost session use <id>`.

**Exit criterion:** Gemini CLI capture is reliable in both terminal and verified IDE workflows without hidden-state dependencies.

## Phase 7.5 — Antigravity CLI plugin

**Status:** Planned

- [ ] Build the GhostD Antigravity plugin using the documented manifest, hooks, and MCP configuration contract.
- [ ] Implement explicit install, status, disable, uninstall, and recovery behavior without overwriting unrelated Antigravity configuration.
- [ ] Normalize documented Antigravity events into canonical GhostEvents with provenance, redaction, host session identity, and workspace scope.
- [ ] Run live integration tests for install/remove, lifecycle capture, concurrent sessions, restart recovery, large output, secret redaction, and provider outage.

**Exit criterion:** Antigravity becomes `supported and verified` only after a version-pinned, live plugin test captures canonical events and cleanly removes itself.

## Phase 7.6 — JetBrains, Zed, and unsupported desktop agents

**Status:** Planned discovery gate

- [ ] Evaluate each host's stable public extension or ACP contract, lifecycle event coverage, session identity, workspace scope, configuration ownership, and removal semantics.
- [ ] Build a separate editor client only when the contract supports the Phase 7.1 bridge and an unambiguous, user-consented session model.
- [ ] For hosts without a verified contract, provide only explicit `ghost context` and read-only MCP handoffs; do not advertise source capture or active-session awareness.

**Exit criterion:** Each evaluated host has either a verified implementation phase with a version range and test plan, or an explicit unsupported status with a safe handoff workflow.

**Integration matrix:** [docs/host-integrations.md](docs/host-integrations.md) records the delivery ownership, capture authority, and verification matrix for every host above.

## Phase 8 — Distribution and universal installation

**Status:** Planned

**Release boundary:** Distribution may ship supported CLI-host capture, but must not market GhostD as providing universal active-session capture until the relevant Phase 7.2–7.6 host verification criteria are met.

- [ ] Define supported release channels, semantic-versioning policy, upgrade compatibility policy, and explicit platform support matrix.
- [ ] Package the CLI for npm with a clean public package surface, executable entry point, provenance metadata, and install/update/uninstall documentation.
- [ ] Produce immutable, versioned release artifacts with checksums and a repeatable release-verification process. Native binaries are optional only when they materially improve the supported installation experience.
- [ ] Create and maintain a dedicated Homebrew tap and formula so macOS and Linux users can install a released version with `brew install <owner>/tap/ghostd`.
- [ ] Evaluate eligibility for Homebrew Core only after GhostD is public, appropriately licensed, stable, and compatible with Homebrew's formula requirements; until then, do not imply `brew install ghostd` is supported.
- [ ] Make all installers safe by default: no credential collection, no provider login bypass, no project-trust bypass, and no implicit hook installation into untrusted workspaces.
- [ ] Provide a post-install `ghost doctor` flow that identifies missing optional agents, supported installation paths, permissions, project trust state, and recovery steps without modifying anything unless the user explicitly confirms.
- [ ] Test fresh install, upgrade, downgrade/recovery where supported, uninstall, and offline/provider-unavailable behavior on every supported platform.

**Exit criterion:** A new user can install a verified, released GhostD build through npm or the supported Homebrew tap, run `ghost doctor`, and complete explicit setup without manually cloning the repository or exposing credentials to GhostD.

## Phase 9 — Human-centered interaction and product surfaces

**Status:** Planned

- [ ] Define the primary user journeys: first-run setup, capture confidence, context inspection, branch creation, agent comparison, review, promotion, recovery, and removal.
- [ ] Design the CLI as a progressive-disclosure interface: safe defaults, actionable errors, concise status, discoverable help, and a clear distinction between read-only operations and writes.
- [ ] Make trust, provenance, freshness, workspace scope, provider cost, and write/promotion authority visible at the moment a user makes a decision.
- [ ] Create a human-readable context and branch inspection experience that lets users understand why GhostD believes a fact, whether it is current, and what source evidence supports it.
- [ ] Deliver an accessible, keyboard-first interactive surface for the workflows that cannot be safely understood through terse CLI output alone. Select the smallest appropriate product form after user research: enhanced terminal UI, local web interface, native desktop application, or a real VS Code extension.
- [ ] Treat the current `ghost vscode setup` task integration as a baseline, not a Marketplace extension; define and test the extension boundary before publishing one.
- [ ] Run moderated usability sessions and task-based evaluation with developers using different agent/provider setups; use the findings to set measurable targets for setup success, task completion, error recovery, and trust comprehension.
- [ ] Preserve the core safety invariants across every interface: secret-safe displays, explicit user-controlled promotion, no silent provider execution, and no hidden workspace writes.

**Exit criterion:** Representative developers can install, configure, inspect, compare, and explicitly promote work using GhostD with demonstrated comprehension of source provenance, current state, cost, and write authority. Any GUI or editor surface remains a client of the same local GhostD core rather than a second source of truth.
