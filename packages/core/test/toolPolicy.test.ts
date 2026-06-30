import { describe, expect, it } from 'vitest';
import { evaluateToolApproval } from '../src/index.js';

describe('tool approval policy', () => {
  it('requires approval for configured high-risk tools and external prefixes', () => {
    expect(
      evaluateToolApproval({
        toolId: 'write',
        policy: { highRiskToolIds: ['write'] },
      }),
    ).toMatchObject({ requiresApproval: true, reason: 'tool_high_risk' });

    expect(evaluateToolApproval({ toolId: 'mcp__github__delete_branch' })).toMatchObject({
      requiresApproval: true,
      reason: 'external_tool_prefix',
    });
  });

  it('allows full-access mode to bypass approval', () => {
    expect(
      evaluateToolApproval({
        toolId: 'write',
        policy: { mode: 'full_access', highRiskToolIds: ['write'] },
      }),
    ).toMatchObject({ requiresApproval: false, reason: 'permission_mode_full_access' });
  });

  it('supports rule overrides by tool arguments, space, and actor role', () => {
    expect(
      evaluateToolApproval({
        toolId: 'bash',
        arguments: { command: 'rm -rf dist' },
        spaceKind: 'work',
        actorRole: 'user',
        policy: {
          highRiskToolIds: [],
          rules: [
            {
              id: 'destructive-command',
              decision: 'require_approval',
              toolIds: ['bash'],
              spaceKinds: ['work'],
              actorRoles: ['user'],
              arguments: [{ field: 'command', includes: 'rm -rf' }],
            },
          ],
        },
      }),
    ).toMatchObject({ requiresApproval: true, matchedRuleId: 'destructive-command' });

    expect(
      evaluateToolApproval({
        toolId: 'bash',
        arguments: { command: 'pnpm test' },
        spaceKind: 'work',
        actorRole: 'admin',
        policy: {
          highRiskToolIds: ['bash'],
          rules: [
            {
              id: 'admin-test-command',
              decision: 'allow',
              toolIds: ['bash'],
              actorRoles: ['admin'],
              arguments: [{ field: 'command', startsWith: 'pnpm test' }],
            },
          ],
        },
      }),
    ).toMatchObject({ requiresApproval: false, matchedRuleId: 'admin-test-command' });
  });
});
