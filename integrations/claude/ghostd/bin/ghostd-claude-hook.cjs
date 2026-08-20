#!/usr/bin/env node
'use strict';

const { spawn } = require('node:child_process');

const command = process.platform === 'win32' ? 'ghost.cmd' : 'ghost';
const arguments_ = ['claude-hook'];
const child = process.platform === 'win32'
  ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', command, ...arguments_], {
    stdio: 'inherit',
  })
  : spawn(command, arguments_, {
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
child.once('close', (code) => {
  if (code !== 0) {
    process.stderr.write('GhostD capture skipped: the ghost command could not process this Claude hook event.\n');
  }
  complete();
});
