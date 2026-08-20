#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const command = process.platform === 'win32' ? 'ghost.cmd' : 'ghost';
const child = spawn(command, ['gemini-hook'], {
  shell: process.platform === 'win32',
  stdio: ['pipe', 'ignore', 'pipe'],
});

process.stdin.pipe(child.stdin);
child.stderr.pipe(process.stderr);

let completed = false;
function complete() {
  if (completed) return;
  completed = true;
  // Gemini parses stdout as hook control JSON. Capture must remain observational and always allow the host to continue.
  process.stdout.write('{}\n');
  process.exitCode = 0;
}

child.once('error', () => {
  process.stderr.write('GhostD capture skipped: the ghost command is unavailable. Install GhostD and restart Gemini CLI.\n');
  complete();
});
child.once('close', (code) => {
  if (code !== 0) {
    process.stderr.write('GhostD capture skipped: the ghost command could not process this Gemini hook event.\n');
  }
  complete();
});
