# Desktop host-contract discovery

This record closes Phase 7.6's discovery gate. A host is never considered captured merely because GhostD can run in its terminal, expose MCP, or be launched as a new ACP agent. GhostD requires a documented public contract that supplies lifecycle events, a provider session identity, workspace scope, configuration ownership, and clean removal semantics.

## Findings

| Host | Verified public contract | What it does **not** provide to GhostD | GhostD outcome |
| --- | --- | --- | --- |
| JetBrains IDEs | IntelliJ Platform plugins can provide project-scoped tool windows; JetBrains IDEs 2025.3+ can act as ACP clients for external agents. | A public API for observing an already-running AI Chat/ACP conversation owned by the IDE or another agent. | No source capture or active-session claim. A future read-only JetBrains client may use the local bridge only after an explicit user-consented workspace contract and a host test. |
| Zed | Zed can launch new ACP agents, organize terminal threads, and configure MCP servers. | A public API for observing an existing Zed Agent, external-agent, or terminal-thread conversation. Zed's thread export is a user-facing manual action, not a GhostD integration contract. | No source capture or active-session claim. Use terminal-first GhostD commands or configure GhostD MCP explicitly. |
| Other desktop agents | Varies by host. | A verified lifecycle + identity + workspace + removal contract. | Explicitly unsupported until a host-specific discovery record and implementation phase exist. |

The absence conclusion is deliberate: the official documents describe creating or connecting an agent, not a third-party observer for an active private conversation. ACP's session operations are between an ACP client and the agent it owns; they do not authorize GhostD to enumerate another host's conversations.

## Safe workflow everywhere

These workflows do not read host transcripts, scrape UI, inspect process names, or infer foreground focus:

```sh
# Render provenance-bearing context for an explicitly resolved Ghost session.
ghost context --provenance

# Expose GhostD's read-only tools/resources to a host only when the user explicitly configures it.
ghost mcp

# Render an exact-revision provider-neutral handoff for a branch.
ghost acp handoff <branch>
```

`ghost hosts` reports these boundaries at runtime. It does not create a configuration, collect credentials, or imply that GhostD knows an active desktop chat.

## Requirements for a future host implementation

Before implementing a JetBrains, Zed, or another desktop client, the host must document all of the following and pass a version-pinned live suite:

1. User-consented lifecycle delivery with an immutable provider session ID and workspace root.
2. A configuration format that GhostD can install, disable, and remove without overwriting unrelated settings.
3. Explicit concurrent-session selection, restart recovery, secret redaction, large-output behavior, and provider-outage behavior.
4. A bridge client limited to GhostD's workspace-bound read/selection surface; it must never read editor text, private conversation exports, terminal titles, focus state, or credentials.

## Sources

- [JetBrains ACP agent registry](https://blog.jetbrains.com/ai/2026/01/acp-agent-registry/) and [IntelliJ tool windows](https://plugins.jetbrains.com/docs/intellij/tool-window.html)
- [Zed Agent Panel](https://zed.dev/docs/ai/agent-panel), [Zed Agent Server Extensions](https://zed.dev/docs/extensions/agent-servers), and [Zed Terminal Threads](https://zed.dev/docs/ai/terminal-threads)
- [ACP protocol overview](https://github.com/agentclientprotocol/agent-client-protocol/blob/main/docs/protocol/v1/overview.mdx)
