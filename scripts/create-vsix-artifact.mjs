import { cp, copyFile, mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const [outputDirectory] = process.argv.slice(2);
if (outputDirectory === undefined || process.argv.length !== 3) {
  throw new Error('Usage: npm run release:vsix -- <output-directory>.');
}
const destination = resolve(outputDirectory);
const rootPackage = JSON.parse(await readFile('package.json', 'utf8'));
const extensionPackage = JSON.parse(await readFile('extensions/vscode/package.json', 'utf8'));
if (typeof rootPackage.version !== 'string' || rootPackage.version !== extensionPackage.version) {
  throw new Error('The GhostD CLI and VS Code extension versions must match before packaging a release.');
}
const filename = `ghostd-vscode-${rootPackage.version}.vsix`;
await mkdir(destination, { recursive: true });
execFileSync('npm', ['run', 'build', '--workspace', 'ghostd-vscode'], { stdio: 'inherit' });
const stagingDirectory = await mkdtemp(join(tmpdir(), 'ghostd-vsix-'));
const extensionDirectory = join(stagingDirectory, 'extension');
try {
  await mkdir(extensionDirectory);
  await Promise.all([
    cp('extensions/vscode/dist', join(extensionDirectory, 'dist'), { recursive: true }),
    copyFile('extensions/vscode/LICENSE', join(extensionDirectory, 'LICENSE')),
    copyFile('extensions/vscode/README.md', join(extensionDirectory, 'README.md')),
    copyFile('extensions/vscode/package.json', join(extensionDirectory, 'package.json')),
  ]);
  execFileSync(process.execPath, [resolve('node_modules/@vscode/vsce/vsce'), 'package', '--out', resolve(destination, filename)], {
    cwd: extensionDirectory,
    stdio: 'inherit',
  });
} finally {
  await rm(stagingDirectory, { force: true, recursive: true });
}
await stat(resolve(destination, filename));
process.stdout.write(`Created ${resolve(destination, filename)}\n`);
