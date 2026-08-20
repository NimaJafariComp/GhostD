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
| Codex in VS Code | Codex adapter plus GhostD VS Code extension | Same documented Codex hook; no chat scraping | Show the matching workspace and let the user select a captured session | Live VS Code integrated-terminal session and deliberate wrong-session rejection |
| Claude Code CLI | Project hook now; distributable Claude plugin after contract stabilization | Claude lifecycle hook payload | Optional VS Code UI only | Hook-event coverage, plugin install/update/uninstall, and provider failure recovery |
| Claude Desktop Code tab | The same verified Claude plugin/hook | Claude hook payload supplied by the Code tab | No Desktop UI scraping | Local Desktop Code session, parallel sessions, restart, and clean plugin removal |
| Gemini CLI | Project-hook adapter | Gemini lifecycle hook payload | Optional VS Code UI only | Strict JSON hook output, IDE-connected and standalone terminal sessions, failure recovery |
| Gemini in VS Code, Cursor, or Antigravity | Gemini hook plus GhostD editor client where that editor supports it | Gemini hook or another documented public contract | Report opt-in workspace/editor context only | Verify no dependency on Gemini Companion's private state or transcript data |
| VS Code family | One GhostD extension distributed through the applicable extension registry | No provider events by itself | Status, session list/selection, context inspection, explicit handoff actions | VS Code, Cursor, remote workspace behavior, extension disable/removal, and concurrent providers |
| Antigravity CLI | Native GhostD Antigravity plugin | Documented Antigravity plugin hook payload | Plugin may expose GhostD MCP configuration; it does not infer IDE focus | Install, hook payloads, unload/remove, restart, concurrent sessions, and secret redaction |
| JetBrains and Zed | Separate editor clients only after a verified public API/ACP route exists | Their documented adapter contract, if any | Same local bridge and selection UI | Contract review, host-version compatibility tests, and explicit removal |
| Other desktop agents | No source adapter by default | None | `ghost context` and read-only MCP handoff only | Do not advertise capture or active-session awareness |

## Delivery phases

1. **Phase 7.1 — Integration platform and local bridge:** create the stable, local, authenticated interface that every editor client uses.
2. **Phase 7.2 — VS Code family and Codex workflow:** deliver the shared VS Code extension and validate the Codex-in-VS-Code workflow without chat scraping.
3. **Phase 7.3 — Claude Code CLI and Desktop Code tab:** package and validate the Claude hook integration as a Claude plugin across both supported surfaces.
4. **Phase 7.4 — Gemini CLI and IDE-connected sessions:** harden Gemini hook capture, verify it with explicit IDE association, and preserve the boundary around Gemini Companion.
5. **Phase 7.5 — Antigravity CLI plugin:** build and live-validate Antigravity's native plugin integration.
6. **Phase 7.6 — JetBrains, Zed, and unsupported desktop agents:** run public-contract discovery. Create a host implementation only when its API can satisfy GhostD's safety and session-identity requirements.

Phase 8 packages only the integrations that have passed their associated verification gate.

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

1. Package release can support the verified Codex, Claude Code, and Gemini CLI adapters already implemented.
2. A host moves from `unsupported` to `supported and verified` only after its row's verification suite passes on a pinned host-version range.
3. The word “universal” refers to GhostD's package and adapter model, not to automatic capture of every installed desktop app.
4. “Universal active-session capture” is prohibited in product copy until every advertised desktop/editor host passes its release gate.
