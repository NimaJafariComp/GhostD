import { execFileSync } from 'node:child_process';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [artifact] = process.argv.slice(2);
if (artifact === undefined || process.argv.length !== 3) {
  throw new Error('Usage: npm run release:install-test -- <ghostd-version.tgz>.');
}
const artifactPath = resolve(artifact);
await stat(artifactPath);
const prefix = await mkdtemp(join(tmpdir(), 'ghostd-release-install-'));
try {
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--prefix', prefix, artifactPath], { stdio: 'inherit' });
  const cli = join(prefix, 'node_modules', 'ghostd', 'dist', 'cli', 'main.js');
  const environment = {
    ...process.env,
    GHOST_DB_PATH: join(prefix, 'ghost', 'ghost.db'),
    GHOST_CONFIG_PATH: join(prefix, 'ghost', 'config.json'),
  };
  execFileSync(process.execPath, [cli, '--help'], { env: environment, stdio: 'inherit' });
  execFileSync(process.execPath, [cli, 'doctor'], { env: environment, stdio: 'inherit' });
  process.stdout.write('Fresh release-package install test passed.\n');
} finally {
  await rm(prefix, { force: true, recursive: true });
}
