# GhostD Claude Code plugin

This plugin forwards only Claude Code's documented hook JSON to `ghost claude-hook`. GhostD derives the canonical event type and trust class, redacts before storage, and retains provider/session/workspace provenance. It never reads `transcript_path`, desktop UI state, a focused window, or provider credentials.

GhostD must already be installed and available as `ghost` on the environment `PATH` used by Claude Code. The plugin is intentionally observational: if GhostD is unavailable, the hook exits successfully and Claude continues normally.

## Try locally

From the GhostD repository, run:

```sh
claude --plugin-dir ./integrations/claude/ghostd
```

For a normal install through the included local marketplace:

```sh
claude plugin validate .
claude plugin marketplace add .
claude plugin install ghostd@ghostd --scope local
```

Use `claude plugin disable ghostd@ghostd --scope local` to stop capture without removing the plugin, and `claude plugin uninstall ghostd@ghostd --scope local --yes` for clean removal. Restart Claude Code or use `/reload-plugins` after changing plugin state.

Claude Desktop's **Code** tab and Claude Code CLI share Claude Code configuration and plugins. Enable the same plugin in Desktop's plugin manager to capture local Code-tab sessions. Remote desktop sessions are outside this plugin's local GhostD capture boundary.

## Safety and recovery

- The plugin has no network, MCP, tool, shell, or write capability beyond launching the already-installed `ghost` CLI with the hook's stdin.
- It emits no decision-control JSON, so it cannot block a prompt, tool call, compaction, stop, or session close.
- Each plugin update is treated as a disposable host artifact. Canonical GhostD history remains in the local ledger.
- Use `ghost session list` and `ghost session use <id>` when multiple captured Claude sessions share a workspace. GhostD never chooses based on Desktop focus.
