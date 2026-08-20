# GhostD for VS Code

This extension is the workspace UI for a locally installed GhostD CLI. It does not read editor text, Codex chats, provider transcripts, credentials, window titles, or process state.

## Connect a workspace

1. Install GhostD and ensure `ghost` is available to the VS Code extension host. Set `ghostd.cliPath` if it is not on that host's `PATH`.
2. Run **GhostD: Connect this workspace** and explicitly confirm. GhostD writes a workspace-bound bridge credential into VS Code private extension storage; the credential is never printed.
3. For Codex, run **GhostD: Configure Codex capture** and separately trust the project in Codex.
4. Use the **GhostD Sessions** Explorer view or **GhostD: Select captured session**. GhostD never guesses between simultaneous sessions.

The extension can show redacted, provenance-bearing context and copy a branch handoff. It cannot invoke an AI provider, edit a workspace, create a Ghost branch, or promote code.

## Removal

Run **GhostD: Disconnect this workspace** to revoke the extension credential and remove its private credential file. Removing the extension alone never removes a provider hook; use `ghost setup remove <host> --approve` for that explicit action.

## Development

Run `npm install --prefix extensions/vscode` followed by `npm run build --prefix extensions/vscode`. Use VS Code's **Run Extension** launch profile to test against a locally installed GhostD CLI.
