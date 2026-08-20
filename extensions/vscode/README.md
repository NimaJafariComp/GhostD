# GhostD for VS Code

This extension is the workspace UI for a locally installed GhostD CLI. It does not read editor text, Codex chats, provider transcripts, credentials, window titles, or process state.

## Connect a workspace

1. Install GhostD and ensure `ghost` is available to the VS Code extension host. Set `ghostd.cliPath` if it is not on that host's `PATH`.
2. Run **GhostD: Connect this workspace** and explicitly confirm. GhostD writes a workspace-bound bridge credential into VS Code private extension storage; the credential is never printed.
3. For Codex, run **GhostD: Configure Codex capture**, separately trust the project in Codex, then reload the Codex extension. If VS Code reports that Codex is not detected but it runs in your terminal, set `ghostd.codexCliPath` to its absolute executable path and run the command again.
4. For Claude Code in VS Code, run **GhostD: Configure Claude Code capture**. Claude Code shares project hook settings between its CLI and VS Code extension; start or resume a Claude Code session after setup. If needed, set `ghostd.claudeCliPath` to its absolute executable path.
5. For Gemini, install the **Gemini CLI Companion** extension, connect it from a Gemini CLI session with `/ide enable`, and run **GhostD: Configure Gemini CLI capture**. If needed, set `ghostd.geminiCliPath` to its absolute executable path. **Gemini Code Assist is not a Gemini CLI session host and GhostD does not capture its private chat.**
6. Use the **GhostD Sessions** Explorer view or **GhostD: Select captured session**. GhostD never guesses between simultaneous sessions.

The extension can show redacted, provenance-bearing context and copy a branch handoff. It never reads chat panes, provider transcripts, editor text, credentials, window titles, or process state. It captures only documented lifecycle hook events emitted by the configured host.

## Removal

Run **GhostD: Disconnect this workspace** to revoke the extension credential and remove its private credential file. Removing the extension alone never removes a provider hook; use `ghost setup remove <host> --approve` for that explicit action.

## Development

Run `npm install --prefix extensions/vscode` followed by `npm run build --prefix extensions/vscode`. Use VS Code's **Run Extension** launch profile to test against a locally installed GhostD CLI.
