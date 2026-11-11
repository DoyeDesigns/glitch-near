#!/usr/bin/env node
/** Spawn server + Vite for local play. No extra deps. */
import { spawn } from 'node:child_process';
import process from 'node:process';

const kids = [];

function run(label, args) {
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    stdio: 'inherit',
    shell: true,
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    else if (code && code !== 0) {
      console.error(`[dev] ${label} exited ${code}`);
      shutdown(code);
    }
  });
  kids.push(child);
  return child;
}

function shutdown(code = 0) {
  for (const c of kids) {
    try {
      c.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }
  process.exit(code);
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

run('server', ['run', 'dev', '-w', '@glitch/server']);
run('web', ['run', 'dev', '-w', 'web']);
