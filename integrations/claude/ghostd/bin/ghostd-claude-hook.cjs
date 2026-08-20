#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const command = process.platform === 'win32' ? 'ghost.cmd' : 'ghost';
const child = spawn(command, ['claude-hook'], {
  shell: process.platform === 'win32',
  stdio: 'inherit',
});

let completed = false;
function complete() {
  if (completed) return;
  completed = true;
  // Capture is observational. A missing or temporarily unavailable GhostD CLI must not alter Claude's control flow.
  process.exitCode = 0;
}

child.once('error', () => {
  process.stderr.write('GhostD capture skipped: the ghost command is unavailable. Install GhostD and restart Claude Code.\n');
  complete();
});
child.once('close', complete);
