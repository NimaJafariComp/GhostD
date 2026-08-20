import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const [outputDirectory] = process.argv.slice(2);
if (outputDirectory === undefined || process.argv.length !== 3) {
  throw new Error('Usage: npm run release:artifact -- <output-directory>.');
}
const destination = resolve(outputDirectory);
await mkdir(destination, { recursive: true });
execFileSync('npm', ['run', 'verify:package'], { stdio: 'inherit' });
const output = execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', destination], { encoding: 'utf8' });
const packages = JSON.parse(output);
const artifact = Array.isArray(packages) && packages.length === 1 && typeof packages[0] === 'object' && packages[0] !== null
  ? packages[0].filename
  : undefined;
if (typeof artifact !== 'string') throw new Error('npm pack did not return an artifact filename.');
const artifactPath = resolve(destination, artifact);
const checksum = createHash('sha256').update(await readFile(artifactPath)).digest('hex');
await writeFile(`${artifactPath}.sha256`, `${checksum}  ${artifact}\n`, 'utf8');
process.stdout.write(`Created ${artifactPath}\nSHA-256: ${checksum}\n`);
