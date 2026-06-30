import { describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli/router.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const PKG = join(dirname(dirname(fileURLToPath(import.meta.url))), 'package.json');

describe('CLI router', () => {
  it('prints version', async () => {
    const version = (JSON.parse(readFileSync(PKG, 'utf8')) as { version: string }).version;
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    await runCli(['--version']);
    spy.mockRestore();
    expect(out.trim()).toBe(version);
  });

  it('prints help text', async () => {
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    await runCli(['--help']);
    spy.mockRestore();
    expect(out).toContain('zleap init');
    expect(out).toContain('channels');
    expect(out).toContain('zleap serve');
    expect(out).toContain('zleap status');
    expect(out).toContain('zleap stop');
    expect(out).toContain('zleap setup');
    expect(out).toContain('zleap app');
  });

  it('config help subcommand does not throw', async () => {
    await expect(runCli(['config', 'help'])).resolves.toBeUndefined();
  });
});
