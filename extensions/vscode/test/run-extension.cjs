const path = require('node:path');
const fs = require('node:fs');
const { runTests } = require('@vscode/test-electron');

async function main() {
  const bundledCode = '/Applications/Visual Studio Code.app/Contents/MacOS/Code';
  const vscodeExecutablePath = process.env.VSCODE_EXECUTABLE_PATH ?? (process.platform === 'darwin' && fs.existsSync(bundledCode) ? bundledCode : undefined);
  await runTests({
    ...(vscodeExecutablePath === undefined ? {} : { vscodeExecutablePath }),
    extensionDevelopmentPath: path.resolve(__dirname, '..'),
    extensionTestsPath: path.resolve(__dirname, 'suite', 'index.cjs'),
    launchArgs: [path.resolve(__dirname, 'fixture'), '--disable-extensions'],
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
