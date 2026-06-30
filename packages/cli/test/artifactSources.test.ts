import { describe, expect, it } from 'vitest';
import { classifyArtifactSource, parseBashCommand } from '../../agent/src/artifactSources';

describe('artifact source classification', () => {
  it.each([
    ['bash', { command: 'git clone https://github.com/Zleap-AI/SAG.git SAG' }],
    ['bash', { cmd: 'gh repo clone Zleap-AI/SAG SAG' }],
    ['bash', { command: 'curl -L https://example.com/report.pdf -o report.pdf' }],
    ['bash', { command: 'wget https://example.com/archive.zip -O archive.zip' }],
    ['bash', { command: 'unzip archive.zip -d repo' }],
    ['bash', { command: 'tar -xzf repo.tar.gz' }],
    ['bash', { command: 'tar --extract --file repo.tar.gz' }],
    ['bash', { command: 'bsdtar -xf repo.tar.gz' }],
    ['bash', { command: '7z x repo.zip' }],
    ['bash', { command: 'python -m zipfile -e repo.zip repo' }],
    ['bash', { command: 'python3 -m zipfile -e repo.zip repo' }],
  ])('marks %s %j as imported source', (toolName, input) => {
    expect(classifyArtifactSource(toolName, input)).toBe('imported');
  });

  it.each([
    ['write', { path: 'report.md', content: '# Report' }],
    ['edit', { path: 'report.md', old_string: 'a', new_string: 'b' }],
    ['append', { path: 'report.md', content: 'more' }],
    ['bash', { command: 'python generate_report.py' }],
    ['bash', { command: 'python3 generate_report.py' }],
    ['bash', { command: 'node scripts/build-report.mjs' }],
    ['bash', { command: 'pnpm build:report' }],
  ])('marks %s %j as generated source', (toolName, input) => {
    expect(classifyArtifactSource(toolName, input)).toBe('generated');
  });

  it('marks unrelated read-only tools and shell commands as neutral', () => {
    expect(classifyArtifactSource('read', { path: 'README.md' })).toBe('neutral');
    expect(classifyArtifactSource('bash', { command: 'ls -la' })).toBe('neutral');
  });

  it('reads bash command from common argument names', () => {
    expect(parseBashCommand({ command: 'echo ok' })).toBe('echo ok');
    expect(parseBashCommand({ cmd: 'echo ok' })).toBe('echo ok');
    expect(parseBashCommand({ script: 'echo ok' })).toBe('echo ok');
  });
});
