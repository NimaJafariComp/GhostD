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
- [x] Test the installer, canonical normalization, provenance, storage redaction, deterministic context compilation, and unresolved-question recall (10 automated tests).
- [x] Capture and label the trusted, live-Codex suite: simple implementation, changed requirements, an observable failed hypothesis, large tool output, sensitive values, a dirty tree with multiple modified files, and an unresolved question. Codex project trust remains user-controlled; the adapter does not and must not grant it.

**Exit criterion:** A labeled real-session suite establishes a defensible current-state-fidelity baseline with no observed secret or obsolete-state leakage. Ghost can answer those questions from its deterministic, secret-safe artifact without consulting the original Codex session. The 90% target is experimental until the first real-session results establish a meaningful threshold.

**Current evidence:** The shipped Codex hook format is validated against the installed Codex hook schema. Automated checks cover canonical context recall, constraints, decisions, unresolved questions, modified files, failures, provenance, and secret redaction. Trusted live Codex runs captured the canonical lifecycle, assistant response, Git snapshots, decisions, an observable failure, changed requirements (with the current objective correctly superseding the prior objective), a 12,001-byte tool result, a redacted test credential, two dirty working-tree files, and an unresolved question. No secret or obsolete-state leakage was observed. Silent tool failures are not inferred when Codex provides no result text; this is deliberate to avoid unsupported facts.

**Initial evaluation suite:** simple implementation; changed requirements; rejected hypothesis followed by a correct diagnosis; large tool output; sensitive data in tool or file output; and a dirty Git tree with multiple modified files.

## Phase 1 — Context graph and logical replicas

**Status:** Not started

- [ ] Add meaningful immutable `GhostRevision` checkpoints, each with an event high-water mark and workspace snapshot identity.
- [ ] Add copy-on-write `GhostBranch` records with base and head revision IDs.
- [ ] Record branch tracking revision, originating session, and explicit lifecycle state.
- [ ] Add `ghost branch <name>` to create cold logical replicas without an LLM call.
- [ ] Add `ghost branch close <name>`; preserve closed-branch history.
- [ ] Add provider-specific `BranchMaterialization` records with a synchronized revision and provider handle; derive staleness from revision ancestry.
- [ ] Prove immutable ancestry, zero-copy branch creation, and exact materialization revision attribution.

## Phase 2 — Lazy materialization and target adapters

**Status:** Not started

- [ ] Add capability metadata for native forks, session resume, cache scope/lifetime, context limits, workspace/tool access, and write access.
- [ ] Implement pluggable materialization strategies that choose fidelity, cost, and latency rather than a fixed provider-specific branch.
- [ ] Add a read-only Claude target adapter and `ghost ask claude "…"`.
- [ ] Define `ghost ask <agent> "…"` as ephemeral and `ghost ask <branch> "…"` as persistent.
- [ ] Store provider handles separately from canonical Ghost branches.
- [ ] Record materialization decisions, source revision, token cost, and provider-failure recovery details.
- [ ] Run context-fidelity and token/latency evaluations.

## Phase 3 — Synchronization and temporal context

**Status:** Not started

- [ ] Add lazy delta synchronization and stale-materialization detection.
- [ ] Add explicit `ghost rebase <branch>` with rebase-fidelity evaluation.
- [ ] Track temporal validity, supersession, reaffirmation, and invalidation for constraints, decisions, assumptions, failures, and hypotheses.
- [ ] Add Claude as a source.

## Phase 4 — Multi-agent reasoning

**Status:** Not started

- [ ] Add Gemini source/target adapters and frozen-revision `ghost compare` runs.
- [ ] Add structured insights that separate findings, evidence, and recommendations.
- [ ] Add explicit merge/copy flows.
- [ ] Add `ghost switch <agent>` for intentional cross-agent continuation.

## Phase 5 — Write-capable branches

**Status:** Not started

- [ ] Add isolated Git worktrees for explicit write-capable replicas.
- [ ] Track patch provenance, branch cleanup, and concurrent-agent safety.
- [ ] Compare implementations and selectively promote user-approved code changes.

## Phase 6 — Ecosystem integrations

**Status:** Not started

- [ ] Add ACP proxy support where it provides cleaner session ownership.
- [ ] Add MCP as an interface to Ghost, not the Ghost core.
- [ ] Publish the adapter SDK and compatibility ladder.
- [ ] Add IDE/editor integrations only after CLI fidelity is proven.
