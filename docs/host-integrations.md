# GhostD host-integration matrix

## Product shape

GhostD is a local package with host-native capture adapters and editor clients. The core package owns canonical history, local storage, session selection, and the local bridge. Host integrations only submit documented lifecycle data or render GhostD state; none becomes a second source of truth.

```text
Homebrew or npm package
        |
        +-- GhostD core: CLI, ledger, context compiler, local bridge
        |
        +-- provider adapters: documented hooks or host plugins
        |
        +-- editor clients: explicit workspace/session UI
```

## Integration rules

1. Install and capture are separate states. Discovering a host never authorizes configuration changes.
2. Every host integration requires explicit user approval, exact-command removal, and a documented recovery path.
3. A provider hook is authoritative for agent lifecycle and provider session identity. An editor client may report opted-in workspace, editor, or terminal activity, but never invents an agent session.
4. GhostD never identifies a conversation through window focus, process names, terminal titles, transcript files, accessibility APIs, or screen scraping.
5. If no public contract produces an unambiguous session ID, GhostD requires `ghost session use <id>`.
6. Secrets are redacted before storage and are never displayed in extension status or local-bridge traffic.

## Delivery matrix

| Surface | Deliverable | Capture authority | Editor responsibility | Verification required |
| --- | --- | --- | --- | --- |
| Codex CLI | Project-hook adapter installed by `ghost setup codex --approve` | Documented Codex hook payload | GhostD VS Code extension displays capture and selection state | Fresh setup, trusted-project boundary, concurrent sessions, removal, restart recovery |
| Codex in VS Code | Codex adapter plus GhostD VS Code extension | Same documented Codex hook; no chat scraping | Show the matching workspace, capture state, sessions, redacted context, and explicit handoffs | VS Code extension-host activation, bridge protocol, VSIX installation, wrong-session rejection, and Codex hook coverage |
| Claude Code CLI | Versioned `ghostd` Claude plugin, with the project hook retained for development | Documented Claude lifecycle hook payload | Optional VS Code UI only | Complete: strict manifest validation; install, update, disable/enable, restart, live capture, failure/redaction, and uninstall on Claude Code 2.1.237 |
| Claude Desktop Code tab | The same native Claude plugin/hook | Claude hook payload supplied by the Code tab | No Desktop UI scraping | Implementation contract verified through Claude's shared Code/CLI configuration; a local authenticated Desktop Code-tab run remains required before claiming verified host support |
| Gemini CLI | Versioned native `ghostd` Gemini CLI extension, with the project hook retained for development | Documented Gemini lifecycle hook payload | Optional VS Code UI only | Terminal capture verified on Gemini CLI 0.56.0: manifest validation, install/update/restart, disable/enable, live capture, provider outage, and non-blocking hook recovery. Provider session continuity remains a host gate because headless lifecycle events supplied divergent session IDs. |
| Gemini in VS Code, Cursor, or Antigravity | Gemini hook plus GhostD editor client where that editor supports it | Gemini hook or another documented public contract | Report opt-in workspace/editor context only | Verify a public Companion-connected editor workflow, without Companion-private state or transcript data, before claiming support |
| VS Code family | One GhostD extension, verified in Visual Studio Code and VSIX-ready; registry distribution is Phase 8 | No provider events by itself | Status, session list/selection, context inspection, explicit handoff actions, and credential revocation | VS Code extension-host activation, bridge protocol, VSIX installation, extension disconnect, and concurrent providers; verify each fork before claiming support |
| Antigravity CLI | Native `ghostd` Antigravity plugin | Documented Antigravity lifecycle and post-tool payloads | Plugin exposes only GhostD's read-only MCP server; it does not infer IDE focus or alter permissions | Plugin lifecycle verified on `agy` 1.1.16: install/list, MCP/hook discovery, disable/enable, uninstall, and strict direct-hook ingestion. An authenticated agent-turn suite remains required before claiming verified host capture. |
| JetBrains IDEs | No source adapter or editor client at this time | No verified public observer for an existing AI Chat/ACP conversation | `ghost context`, read-only MCP, or exact-revision ACP handoff only | Discovery complete: JetBrains ACP can launch an agent but does not grant GhostD access to host-owned session history. Require a user-consented lifecycle/session contract before implementation. |
| Zed | No source adapter or editor client at this time | No verified public observer for an existing agent or terminal thread | `ghost context`, read-only MCP, or exact-revision ACP handoff only | Discovery complete: Zed can start external ACP agents and MCP servers but does not expose an active-thread observer. Require a user-consented lifecycle/session contract before implementation. |
| Other desktop agents | No source adapter by default | None | `ghost context` and read-only MCP handoff only | Explicitly unsupported until a host-specific public contract and live test pass |

## Delivery phases

1. **Phase 7.1 — Integration platform and local bridge:** create the stable, local, authenticated interface that every editor client uses.
2. **Phase 7.2 — VS Code family and Codex workflow:** complete for Visual Studio Code. The shared VS Code extension uses the Phase 7.1 bridge, is VSIX-ready, and validates the Codex-in-VS-Code workflow boundary without chat scraping. Test each compatible editor and publish to its registry in Phase 8.
3. **Phase 7.3 — Claude Code CLI and Desktop Code tab:** the versioned Claude plugin and CLI verification are complete. Run the remaining local Desktop Code-tab check before claiming Desktop source capture.
4. **Phase 7.4 — Gemini CLI and IDE-connected sessions:** the native Gemini CLI extension and safe terminal capture are complete. Validate a real public Gemini Companion editor workflow and Gemini's single-session lifecycle continuity before claiming IDE or unified-session support.
5. **Phase 7.5 — Antigravity CLI plugin:** the native plugin and local lifecycle validation are complete. Run an authenticated agent-turn suite before claiming provider-level source capture; GhostD deliberately omits Antigravity's permission-gating `PreToolUse` hook.
6. **Phase 7.6 — JetBrains, Zed, and unsupported desktop agents:** complete. `ghost hosts` reports the discovery result and the safe handoff-only workflow. Build a host client only after a future public contract meets GhostD's safety and session-identity requirements.

Phase 8 packages only the integrations that have passed their associated verification gate. The Phase 7.6 safe handoff path is distributable, but it is not source capture.

## Shared local bridge

**Phase 7.1 status: complete.** The core package exposes `ghost bridge serve`, a versioned local-only bridge over an owner-only Unix socket (or Windows named pipe). Editor setup registers a per-client, workspace-bound credential through the exported GhostD API; `ghost bridge status` intentionally never prints credentials.

The bridge scopes each request to one workspace and exposes only:

- capture capability and configuration state;
- sessions already captured by documented provider adapters;
- explicit session selection;
- provenance-bearing context and read-only branch status;
- user-initiated handoff actions.

It must not expose raw secrets, provider credentials, unredacted hook payloads, hidden transcripts, provider-control operations, or automatic code promotion.

The currently implemented methods are `capture/status`, `sessions/list`, `sessions/select`, `context/read`, `branches/status`, and `handoff/read`. Phase 7.2 is responsible for the first editor client that consumes this interface.

## Release gates

1. Package release can support the verified Codex and Claude Code adapters. Gemini CLI may be shipped as capture-only with explicit-session selection; do not claim unified-session or IDE support until Phase 7.4's two remaining host gates pass.
2. A host moves from `unsupported` to `supported and verified` only after its row's verification suite passes on a pinned host-version range.
3. The word “universal” refers to GhostD's package and adapter model, not to automatic capture of every installed desktop app.
4. “Universal active-session capture” is prohibited in product copy until every advertised desktop/editor host passes its release gate.
