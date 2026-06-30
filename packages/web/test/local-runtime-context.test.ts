import { describe, expect, it } from 'vitest';
import { GET as GET_RUNTIME_CONTEXT } from '../app/api/runtime/context/route';
import { readGitBranch } from '../lib/server/localRuntimeContext';

describe('local runtime context', () => {
  it('reads the current git branch through an injected runner', async () => {
    await expect(
      readGitBranch('/repo', async (file, args, options) => {
        expect(file).toBe('git');
        expect(args).toEqual(['rev-parse', '--abbrev-ref', 'HEAD']);
        expect(options).toMatchObject({ cwd: '/repo', timeout: 1000 });
        return { stdout: '0613\n' };
      }),
    ).resolves.toBe('0613');
  });

  it('hides the branch when git is unavailable or detached', async () => {
    await expect(readGitBranch('/repo', async () => ({ stdout: 'HEAD\n' }))).resolves.toBeUndefined();
    await expect(
      readGitBranch('/repo', async () => {
        throw new Error('git unavailable');
      }),
    ).resolves.toBeUndefined();
  });

  it('requires an actor before returning runtime context', async () => {
    const response = await GET_RUNTIME_CONTEXT(new Request('http://localhost/api/runtime/context'));

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toMatchObject({ error: 'actor_required' });
  });

  it('returns local runtime context for an actor', async () => {
    const response = await GET_RUNTIME_CONTEXT(actorRequest('/api/runtime/context'));

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ mode: 'local' });
  });
});

function actorRequest(path: string): Request {
  return new Request(`http://localhost${path}`, {
    headers: {
      'x-zleap-user-id': 'u1',
      'x-zleap-actor-role': 'user',
      'x-zleap-tenant-id': 't1',
    },
  });
}
