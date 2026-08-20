import { execFileSync } from 'node:child_process';

/**
 * Runs npm without executing its Windows .cmd shim through a shell. Package
 * scripts always receive npm_execpath; direct Node execution is supported on
 * POSIX where npm is an executable.
 */
export function execNpm(arguments_, options) {
  const npmEntrypoint = process.env['npm_execpath'];
  if (npmEntrypoint !== undefined) return execFileSync(process.execPath, [npmEntrypoint, ...arguments_], options);
  if (process.platform === 'win32') throw new Error('Run this release helper through npm on Windows.');
  return execFileSync('npm', arguments_, options);
}
