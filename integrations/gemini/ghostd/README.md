# GhostD Gemini CLI extension

This native Gemini CLI extension forwards only documented hook JSON to `ghost gemini-hook`. It always writes exactly one empty JSON object to standard output, so it cannot block, alter, or inject context into Gemini's agent loop. Diagnostics use standard error only.

GhostD derives canonical event and trust information, redacts data before local storage, and preserves Gemini's provider-supplied session ID and workspace CWD. It never reads `transcript_path`, Gemini Companion state, editor text, terminal titles, foreground windows, or credentials.

GhostD must already be installed and available as `ghost` on the Gemini CLI hook environment `PATH`.

## Install and manage

From the GhostD repository:

```sh
gemini extensions validate ./integrations/gemini/ghostd
gemini extensions install ./integrations/gemini/ghostd
```

Restart Gemini CLI after installation or update. To disable or remove it:

```sh
gemini extensions disable ghostd --scope workspace
gemini extensions enable ghostd --scope workspace
gemini extensions uninstall ghostd
```

The extension is intentionally capture-only. Gemini CLI Companion remains Gemini's own IDE context channel; GhostD receives only the public Gemini hook payload. Use `ghost session list` and `ghost session use <id>` when multiple captured sessions share a workspace.

## Recovery and privacy

- Gemini may run hooks synchronously. GhostD sets a bounded 10-second hook timeout and exits with `{}` even when GhostD itself is unavailable.
- A disabled or uninstalled extension stops capture without deleting GhostD's separate canonical history.
- Extension environment sanitization means GhostD does not request or receive Gemini API keys. Provider credentials remain owned by Gemini CLI or the user's normal environment.
