import { homedir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';

export function expandHome(path: string): string {
  if (path === '~') return homedir();
  if (path.startsWith('~/')) return resolve(homedir(), path.slice(2));
  return path;
}

export function defaultConfigPath(): string {
  return resolve(homedir(), '.agentmux', 'agentmux.yaml');
}

export function defaultDatabasePath(): string {
  return resolve(homedir(), '.agentmux', 'usage.sqlite');
}

export function ensureParentDir(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
