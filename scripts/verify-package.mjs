import { execFileSync } from 'node:child_process';

const requiredPaths = [
  'package.json',
  'README.md',
  'LICENSE',
  'dist/cli/main.js',
  'dist/index.js',
  'integrations/claude/ghostd/hooks/hooks.json',
  'integrations/gemini/ghostd/hooks/hooks.json',
  'integrations/antigravity/ghostd/plugin.json',
];
const forbiddenPrefixes = ['src/', 'tests/', 'extensions/', 'docs/', '.github/'];

const output = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], { encoding: 'utf8' });
const packages = JSON.parse(output);
if (!Array.isArray(packages) || packages.length !== 1 || typeof packages[0] !== 'object' || packages[0] === null) {
  throw new Error('npm pack did not return one package manifest.');
}
const files = packages[0].files;
if (!Array.isArray(files) || !files.every((file) => typeof file === 'object' && file !== null && typeof file.path === 'string')) {
  throw new Error('npm pack returned an invalid file manifest.');
}
const paths = files.map((file) => file.path);
for (const path of requiredPaths) {
  if (!paths.includes(path)) throw new Error(`Release package is missing required path: ${path}`);
}
for (const path of paths) {
  if (forbiddenPrefixes.some((prefix) => path.startsWith(prefix))) {
    throw new Error(`Release package includes source-only path: ${path}`);
  }
}
process.stdout.write(`Verified npm package surface (${paths.length} files).\n`);
