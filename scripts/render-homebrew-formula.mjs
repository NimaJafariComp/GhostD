import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const argumentsByName = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const name = process.argv[index];
  const value = process.argv[index + 1];
  if (name === undefined || value === undefined || !name.startsWith('--')) {
    throw new Error('Usage: npm run release:formula -- --version <semver> --sha256 <sha256> --output <tap-formula-path>.');
  }
  argumentsByName.set(name, value);
}
const version = argumentsByName.get('--version');
const checksum = argumentsByName.get('--sha256');
const output = argumentsByName.get('--output');
if (argumentsByName.size !== 3 || version === undefined || checksum === undefined || output === undefined) {
  throw new Error('Usage: npm run release:formula -- --version <semver> --sha256 <sha256> --output <tap-formula-path>.');
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) throw new Error('Formula version must be a semantic version.');
if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error('Formula SHA-256 must be 64 hexadecimal characters.');

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const template = await readFile(resolve(scriptDirectory, '../packaging/homebrew/ghostd.rb.template'), 'utf8');
const rendered = template.replaceAll('{{VERSION}}', version).replaceAll('{{SHA256}}', checksum.toLowerCase());
const formulaPath = resolve(output);
await mkdir(dirname(formulaPath), { recursive: true });
await writeFile(formulaPath, rendered, 'utf8');
process.stdout.write(`Rendered checksum-pinned formula: ${formulaPath}\n`);
