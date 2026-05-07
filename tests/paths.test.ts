import { mkdtempSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  defaultConfigPath,
  defaultDatabasePath,
  ensureParentDir,
  expandHome
} from '../src/paths.js';

describe('paths', () => {
  it('expands home-relative paths', () => {
    expect(expandHome('~')).toBe(homedir());
    expect(expandHome('~/agentmux')).toBe(resolve(homedir(), 'agentmux'));
    expect(expandHome('/tmp/agentmux')).toBe('/tmp/agentmux');
  });

  it('uses the AgentMux default config and database locations', () => {
    expect(defaultConfigPath()).toBe(resolve(homedir(), '.agentmux', 'agentmux.yaml'));
    expect(defaultDatabasePath()).toBe(resolve(homedir(), '.agentmux', 'usage.sqlite'));
  });

  it('creates parent directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'agentmux-paths-'));
    try {
      const path = join(dir, 'nested', 'usage.sqlite');
      ensureParentDir(path);
      expect(expandHome(path)).toBe(path);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
