const assert = require('node:assert/strict');
const vscode = require('vscode');

exports.run = async () => {
  const extension = vscode.extensions.getExtension('ghostd.ghostd-vscode');
  assert.ok(extension, 'GhostD development extension is available');
  await extension.activate();
  const commands = await vscode.commands.getCommands(true);
  for (const command of [
    'ghostd.connect',
    'ghostd.configureCodex',
    'ghostd.configureClaude',
    'ghostd.configureGemini',
    'ghostd.selectSession',
    'ghostd.showContext',
    'ghostd.copyHandoff',
    'ghostd.disconnect',
    'ghostd.refresh',
  ]) {
    assert.ok(commands.includes(command), `${command} is registered`);
  }
};
