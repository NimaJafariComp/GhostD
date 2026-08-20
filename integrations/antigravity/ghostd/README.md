# GhostD Antigravity plugin

This native Antigravity plugin captures only documented hook JSON and exposes GhostD's existing read-only MCP server. It never reads `transcriptPath`, artifact directories, editor state, terminal titles, focus state, or credentials.

The public Antigravity contract requires `PreToolUse` hooks to return a permission decision. GhostD deliberately does **not** register that event: returning `allow`, `deny`, or `ask` would change Antigravity's permission behavior. `PostToolUse` captures the executed tool metadata and any documented error without changing execution.

## Install and manage

GhostD must be installed and available as `ghost` on `PATH`. With the Antigravity CLI (`agy`) installed, use either the native CLI or GhostD's explicit setup command:

```sh
agy plugin install ./integrations/antigravity/ghostd
# or
ghost setup antigravity --approve
```

```sh
ghost antigravity status
ghost antigravity disable --approve
ghost antigravity enable --approve
ghost antigravity uninstall --approve
```

Antigravity's own equivalents are `agy plugin list`, `agy plugin disable ghostd`, `agy plugin enable ghostd`, and `agy plugin uninstall ghostd`.

## Capture and recovery

- The plugin observes `PreInvocation`, `PostInvocation`, `PostToolUse`, and `Stop` only. It returns `{}` for every hook, so it never injects steps, grants permissions, prevents a stop, or otherwise controls Antigravity.
- Antigravity exposes lifecycle and tool metadata but not user-prompt or model-response text in these hook payloads. GhostD records only facts the public payload supports.
- A missing or failing GhostD command falls back to Antigravity's default behavior. The plugin has no provider credential and GhostD's separate canonical ledger is retained after disable or uninstall.
- A multi-workspace hook payload is stored once per declared workspace rather than guessing which mounted workspace is active. Use `ghost session use <id>` if that produces an ambiguous session choice.
