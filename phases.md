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
- [x] Add active-session awareness with documented lifecycle signals and a user-controlled selector: `ghost session list`, `ghost session status`, and `ghost session use <number|id>`. Lists use stable local numbers and redacted Ghost-derived objective labels, never opaque provider metadata, private chat titles, or transcript scraping. GhostD automatically resolves only a single open captured session in the current workspace; it never chooses the most recently seen session from another workspace or provider. Current official CLI hooks do not expose foreground-window focus, so simultaneous sessions require explicit user selection rather than a guessed focus state.
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

**Status:** Complete for Visual Studio Code — compatible-editor registry verification and publication remain Phase 8 release work

- [x] Build one workspace-hosted GhostD extension against the stable VS Code API. It provides capture status, a sessions Explorer view, explicit session selection, provenance-bearing context inspection, read-only branch-handoff copy, and an explicit disconnect action.
- [x] Connect the extension only to the Phase 7.1 authenticated bridge. The extension reads no editor text, Codex chat, provider transcript, process title, or window-focus state; its client credential is workspace-bound and stored in VS Code private storage.
- [x] Add explicit setup/removal workflows: **Connect this workspace** writes a credential directly to private storage after confirmation; **Configure Codex capture** requires confirmation before running `ghost setup codex --approve`; **Disconnect** revokes the credential without removing a provider hook. Codex project trust remains user-controlled.
- [x] Validate the Codex workflow boundary through core bridge tests, the extension bridge client against the real local bridge, and a real VS Code extension-host test that activates the extension and registers every command. A VSIX packaged from this source installed successfully into an isolated VS Code 1.133 extensions directory. Existing Codex-hook tests cover configured capture, trust-safe setup, concurrent-session ambiguity, selection, and recovery.
- [x] Package the extension as a versioned VSIX-ready workspace. Registry publication is intentionally deferred to Phase 8, after release metadata, platform support, and registry policy are complete.

**Exit criterion:** Met for Visual Studio Code. A Codex user can explicitly configure capture, connect the workspace, identify and select the correct captured session without focus guessing, inspect safe context, copy a handoff, and revoke the extension credential. The existing Codex project trust boundary remains intact. Cursor and other forks are not claimed verified until their host and registry tests run in Phase 8.

## Phase 7.3 — Claude Code CLI and Desktop Code tab

**Status:** Implementation complete — Desktop Code-tab live validation pending an installed, authenticated Desktop host

- [x] Keep the existing Claude project hook as the development integration and package the stable configuration as the versioned `ghostd` Claude plugin with a local marketplace manifest.
- [x] Capture the documented Claude lifecycle set through native `hooks/hooks.json`; the plugin forwards stdin only to `ghost claude-hook`, uses no transcript, desktop UI, focus, credential, or hidden-provider-state access, and never emits hook decision-control output.
- [x] Correct the Claude normalizer for documented streamed `MessageDisplay.delta` content and `PostToolUseFailure.error` / `StopFailure` provider-failure fields.
- [x] Validate against Claude Code 2.1.237: strict plugin and marketplace validation; real local marketplace install; upgrade from the initial 0.1.0 package to 0.1.1; enable/disable/restart behavior; a bounded live Claude turn; and uninstall. The enabled plugin registered 11 hooks, captured lifecycle/user/assistant events with provenance, and added no events while disabled or uninstalled.
- [x] Exercise the launcher with parallel session IDs, a tool failure, a provider failure, and a credential-shaped value. GhostD required explicit session selection for the parallel sessions, retained the failure state, and stored the credential-shaped value only as `[REDACTED]`.
- [x] Preserve history after uninstall. Claude removes the plugin configuration immediately; its cache cleanup follows Claude's documented disposable-plugin lifecycle. GhostD's separate canonical ledger remains intact.
- [ ] Run the same plugin in a local authenticated Claude Desktop **Code** tab and its plugin manager. This machine has no Claude Desktop installation, so GhostD does not claim that live-host check has occurred. Anthropic documents that Code Desktop runs the same engine and shares Claude Code hooks/configuration, which establishes the implementation contract but does not substitute for a host run.
- [x] Do not use Desktop UI scraping or treat a Desktop window as a session identity signal.

**Exit criterion:** Pending only the local Claude Desktop Code-tab run. The CLI plugin is verified; GhostD will not claim Desktop source capture until that explicit host check passes.

## Phase 7.4 — Gemini CLI and IDE-connected sessions

**Status:** Implementation complete — Gemini CLI capture verified; a real Gemini Companion editor session and provider session-continuity contract remain host-validation gates

- [x] Package GhostD as a versioned native Gemini CLI extension. Its documented lifecycle hooks forward stdin only to `ghost gemini-hook`, preserve existing Gemini configuration, set a bounded 10-second timeout, and always emit exactly `{}` to stdout so capture cannot control Gemini's flow.
- [x] Correct Gemini `AfterAgent` normalization to prefer the documented final response over the original prompt, and preserve documented `AfterTool` error text as a canonical tool failure.
- [x] Test standalone Gemini CLI 0.56.0: extension validation, install, update, restart, disable/enable, live capture, a deliberate invalid-key provider outage, unavailable/failed GhostD launcher recovery, workspace binding, and strict JSON stdout. No credential is stored by GhostD or the extension.
- [x] Treat Gemini CLI Companion as Gemini's own IDE-context channel. GhostD reads neither Companion state nor transcripts, editor text, terminal titles, focus, or credentials; it relies only on documented hook payloads and the optional GhostD editor client.
- [x] Bind a Gemini session through hook-supplied identity; when identity is ambiguous, require `ghost session use <number|id>` rather than merging based on CWD, timing, or process information.
- [ ] Run the same extension in a supported editor with the official Gemini CLI Companion. This machine has no verified Companion-connected editor workspace, so GhostD does not claim IDE-session capture validation.
- [ ] Obtain or verify a Gemini CLI contract that keeps all lifecycle events for one turn under a single provider session ID. Gemini CLI 0.56.0 headless live runs supplied different IDs for the request and response lifecycle events. GhostD deliberately retains those as distinct host sessions instead of guessing that they belong together.

**Exit criterion:** Pending the two explicit host gates above. Terminal capture is verified and safe; GhostD will not claim a unified active Gemini session or an IDE workflow until Gemini provides a validated session-continuity path and the public Companion workflow is exercised.

## Phase 7.5 — Antigravity CLI plugin

**Status:** Implementation complete — native plugin lifecycle verified; authenticated agent-turn validation remains a host-account gate

- [x] Build the versioned native `ghostd` Antigravity plugin with the documented `plugin.json`, `hooks.json`, and `mcp_config.json` layout. Its MCP entry starts GhostD's existing read-only local server only.
- [x] Implement explicit setup, status, disable, enable, and uninstall paths. `ghost setup antigravity --approve` invokes only `agy plugin install`; `ghost setup remove antigravity --approve` invokes only the matching native uninstall. Neither path edits unrelated Antigravity configuration.
- [x] Normalize documented `PreInvocation`, `PostInvocation`, `PostToolUse`, and `Stop` payloads into canonical events with provider-supplied `conversationId`, each declared absolute workspace, provenance, and storage redaction. A multi-workspace payload becomes separate workspace-scoped sessions instead of a guessed active workspace.
- [x] Preserve Antigravity's permission boundary: GhostD deliberately does not register `PreToolUse`, because that hook requires a permission decision and could otherwise allow, deny, or prompt for agent actions. Every registered GhostD hook returns `{}` and cannot inject trajectory steps, change a tool decision, or prevent a stop.
- [x] Validate the plugin with Antigravity CLI 1.1.16: real local plugin install/list, MCP and hook component discovery, GhostD-managed disable/enable/uninstall, direct documented hook ingestion, strict JSON output, tool failure capture, and ended-session recovery. The automated suite covers malformed identity/workspace data, multi-workspace isolation, background-task stop semantics, plugin command failures, and the no-gating-hook invariant.
- [ ] Run the plugin during a local authenticated Antigravity agent session, including simultaneous conversations, restart, large output, secret-shaped values, and actual provider outage. This machine has the CLI but no authenticated Antigravity agent session; GhostD will not claim that provider-level run occurred.

**Exit criterion:** Pending only the authenticated agent-session suite. The plugin lifecycle and documented-input path are verified; full host source-capture support is not claimed until a real Antigravity conversation supplies those hook events.

## Phase 7.6 — JetBrains, Zed, and unsupported desktop agents

**Status:** Complete — discovery gate closed; safe handoff-only support is explicit

- [x] Evaluate JetBrains and Zed against the required lifecycle, session identity, workspace scope, configuration ownership, and removal criteria. Both expose useful public ACP/editor extension surfaces, but neither documents a third-party observer for an existing private AI conversation.
- [x] Decline to build speculative editor clients. JetBrains ACP and Zed Agent Server extensions create new agent sessions; they do not authorize GhostD to enumerate or attach to a running host-owned chat. GhostD's existing local bridge remains available for a future client only after a user-consented, version-pinned host contract exists.
- [x] Make the result visible through `ghost hosts [jetbrains|zed|other-desktop]`. Every listed host reports source capture and active-session awareness as unsupported, explains why, and offers only `ghost context`, read-only `ghost mcp`, and `ghost acp handoff` as safe workflows.
- [x] Publish the evidence, host-version constraints, and future implementation gate in [docs/host-contract-discovery.md](docs/host-contract-discovery.md). The document prohibits transcript export/import, UI scraping, terminal-title/process inspection, foreground-focus inference, credential access, and automatic configuration writes.

**Exit criterion:** Met. JetBrains, Zed, and other desktop agents have an explicit unsupported status and safe handoff workflow. A new implementation phase is required before any host can be marketed as captured or active-session-aware.

**Integration matrix:** [docs/host-integrations.md](docs/host-integrations.md) records the delivery ownership, capture authority, and verification matrix for every host above.

## Phase 7.7 — Terminal-first sidecar questions

**Status:** Complete

**Scope boundary:** This phase is a read-only, terminal-first question workflow. It is not provider-session injection, a visible provider branch, a persistent Ghost branch, or a workspace-writing agent workflow.

- [x] Add `ghost question "…"` as the primary concise terminal command for asking what is true in a captured workspace.
- [x] Make the direct provider commands the primary terminal interface: `ghost codex "…"`, `ghost claude "…"`, and `ghost gemini "…"`. An unqualified `ghost "…"` automatically routes to the provider of the resolved selected session; explicit provider commands override that choice. `ghost ask <provider> "…"` remains a compatibility alias, while `ghost ask <branch> "…"` remains the explicit persistent-branch workflow.
- [x] Add an explicit, user-configured default answer provider via `ghost configure default <codex|claude|gemini>`. The configuration stores only the selected provider, never a credential; `ghost question "…"` remains a convenience shortcut, refuses when no default is set, and preserves an actionable recovery path when the selected provider is unavailable.
- [x] Resolve the selected current-workspace Ghost session automatically. When no session is resolvable, or more than one captured session is eligible and none is selected, refuse without guessing and direct the user to `ghost session list` and `ghost session use <number|id>`.
- [x] Create a fresh exact revision and workspace snapshot at every invocation, materialize a read-only answer ephemerally against that latest captured context, print the answer and attribution in the terminal, and preserve the redacted materialization record in the Ghost ledger. New source events captured after one question are included in the next; GhostD never scrapes or invents uncaptured host state.
- [x] Leave the original Codex, Claude, Gemini, or other host chat untouched. GhostD creates no provider-side conversation/session; an internal closed ephemeral ledger anchor exists solely to retain the materialization audit record and is not a user-managed branch.
- [x] Add the Codex target through the public `codex exec` contract: an isolated empty temporary workspace, read-only sandbox, automatic approval denial, ephemeral execution, no user/project config or rules, no session resume, and captured final-message output. It uses the user's existing Codex CLI authentication but never attaches to the active Codex chat.
- [x] Treat host support precisely: the command has the same interface in every terminal, but automatic session resolution is available only for a verified, configured capture integration. An unqualified question refuses if the selected source has no matching answer target (for example, Antigravity); it does not silently substitute a provider. Unsupported hosts require an explicit selected or imported Ghost session and must not be described as active-session-aware.
- [x] Let each selected Ghost session retain an explicit successful model and thinking preference per answer provider. `--model <id>` and `--thinking <level>` override the provider default for a sidecar question and become that session/provider's future default only after a successful call. Without an explicit choice, same-provider questions reuse a model identifier only when a verified source event supplied it (currently Claude `SessionStart`); otherwise GhostD uses that provider's configured baseline. Cross-provider questions use the target provider's configured mid-range baseline with medium thinking. The effective model and thinking policy are retained with the materialization record; entitlement and model support are verified by the provider at request time, never guessed by GhostD.
- [x] Test default-provider configuration, selected-session resolution, no-session failure, ambiguous-session refusal, exact revision/snapshot pinning, redacted persisted history, provider-unavailable recovery, and the invariant that the original host session and workspace are never mutated.

**Exit criterion:** Met. From any terminal in a workspace with one resolvable selected Ghost session, `ghost codex|claude|gemini "What is true right now?"` returns a revision-pinned ephemeral answer with provenance. `ghost "What is true right now?"` targets that session's provider, while `ghost question` routes to the configured default. Neither changes the original chat, creates a managed provider session, user-managed branch, or workspace write. Ambiguity and missing configuration produce actionable refusal rather than a guessed choice.

**Current evidence:** The 90-test suite covers no-session and multi-session refusal, explicit selection, selected-session provider resolution and unsupported-provider refusal, a fresh revision per question while later captured events arrive, Codex/Claude/Gemini sidecar dispatch, redacted answer persistence, internal ephemeral-anchor closure, provider-outage recovery, invalid default-provider configuration rejection, and the fixed Codex sidecar invocation contract. Built CLI smoke runs verified default-provider configuration, no-session refusal, source ingestion, missing-key recovery, a live `ghost codex` answer, and a live unqualified `ghost "…"` answer routed to a captured Codex session. The Codex run returned `GhostD selected-provider sidecar succeeded.` with exact Ghost revision and workspace-snapshot attribution; it ran through the separate CLI sidecar, never the active chat.

## Phase 8 — Distribution and universal installation

**Status:** Implementation complete — external publication pending an explicit public license, authorized npm publication, and a dedicated Homebrew tap

**Release boundary:** Distribution may ship supported CLI-host capture, but must not market GhostD as providing universal active-session capture until the relevant Phase 7.2–7.6 host verification criteria are met.

- [x] Define supported release channels, semantic-versioning policy, upgrade compatibility policy, and explicit platform support matrix.
- [x] Package the CLI for npm with a clean public package surface, executable entry point, provenance metadata, and install/update/uninstall documentation. The tarball includes only built CLI/SDK files, integration assets, and public release material; it excludes source and tests.
- [x] Produce immutable, versioned release artifacts with checksums and a repeatable release-verification process. `npm run release:artifact -- <directory>` creates the tarball plus SHA-256, and `npm run release:verify` runs strict checks, build, tests, and package-surface validation.
- [x] Prepare the dedicated Homebrew-tap formula generator. `npm run release:formula` requires an explicit version and published-tarball checksum; it cannot generate a formula with placeholders or a guessed checksum. Creating/publishing the separate tap remains an external release action.
- [ ] Evaluate eligibility for Homebrew Core only after GhostD is public, appropriately licensed, stable, and compatible with Homebrew's formula requirements; until then, do not imply `brew install ghostd` is supported.
- [x] Make all installers safe by default: no credential collection, no provider login bypass, no project-trust bypass, and no implicit hook installation into untrusted workspaces.
- [x] Provide a post-install `ghost doctor` flow that identifies missing optional agents, supported installation paths, owner-only storage permissions, host capture configuration, project-trust boundary, and recovery steps without modifying anything.
- [x] Test fresh packed-install diagnostics, package artifact checksums, Homebrew-formula rendering, offline/provider-unavailable recovery behavior, and clean package contents locally. CI now executes the full release-verification suite on macOS, Linux, and Windows under Node 22 and 24; upgrade/downgrade remains a release-operator compatibility check until two published versions exist.

**Release exit criterion:** Pending external publication. A new user can install a verified, released GhostD build through npm or the supported Homebrew tap, run `ghost doctor`, and complete explicit setup without manually cloning the repository or exposing credentials to GhostD. This is intentionally not claimed until a public license, a published npm tarball, a checksum-pinned formula in a dedicated tap, and CI results on the platform matrix exist.

## Phase 9 — Human-centered interaction and product surfaces

**Status:** Planned

- [ ] Define the primary user journeys: first-run setup, capture confidence, session selection, sidecar questions, context inspection, branch creation, agent comparison, review, promotion, recovery, and removal.
- [x] Implement the first progressive-disclosure CLI slice: safe defaults, concise `--help`, numbered redacted session selection, actionable ambiguity errors, explicit read-only versus write commands, and session-scoped model/thinking preferences.
- [ ] Complete the progressive-disclosure CLI experience across every remaining workflow, including branch, comparison, worktree, recovery, configuration, and removal flows.
- [ ] Make trust, provenance, freshness, workspace scope, selected provider/model/thinking policy, provider availability, estimated cost, and write/promotion authority visible at the moment a user makes a decision. Availability and entitlement must be reported from verified local/provider evidence, never guessed.
- [ ] Create a human-readable context and branch inspection experience that lets users understand why GhostD believes a fact, whether it is current, and what source evidence supports it.
- [ ] Deliver an accessible, keyboard-first interactive surface for the workflows that cannot be safely understood through terse CLI output alone. Select the smallest appropriate product form after user research: enhanced terminal UI, local web interface, native desktop application, or an expanded VS Code extension.
- [ ] Treat the tested VSIX extension as the baseline editor client. Validate user workflows, compatibility, release metadata, signing/publishing requirements, Marketplace/Open VSX readiness, and safe update/removal behavior before publication.
- [ ] Build and run a labeled paired live-session evaluation across Codex, Claude, and Gemini: capture a real source session, ask the same question in that original session and through a revision-pinned GhostD sidecar, and compare results under provider/model parity controls. Measure objective, constraint, decision, modified-file, failure-state, unresolved-question, and workspace/Git-state recall; treat secret leakage and obsolete-state leakage as zero-tolerance failures; record unsupported-fact/hallucination rate and a labeled fidelity score. Controlled synthetic traces do not satisfy this gate.
- [ ] Run moderated usability sessions and task-based evaluation with developers using different agent/provider setups; use the findings to set measurable targets for setup success, task completion, error recovery, and trust comprehension.
- [ ] Preserve the core safety invariants across every interface: secret-safe displays, explicit user-controlled promotion, no background or silent provider execution, and no hidden workspace writes.

**Exit criterion:** Representative developers can install, configure, select a session/provider/model/thinking policy, inspect, compare, and explicitly promote work using GhostD with demonstrated comprehension of source provenance, current state, availability, cost, and write authority. The labeled paired live-session evaluation demonstrates sidecar fidelity against original Codex, Claude, and Gemini sessions without secret or obsolete-state leakage. Any GUI or editor surface remains a client of the same local GhostD core rather than a second source of truth.
