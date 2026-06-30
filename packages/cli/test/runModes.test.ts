import { describe, expect, it } from 'vitest';
import { needsExecuteConfirmationReply, PLAN_EXECUTE_CONFIRM_MARKER } from '../src/planMarkers.js';
import { nextPermissionMode, normalizePermissionMode } from '@zleap/agent';
import { buildReplyRuntimeOptions } from '../src/hooks/useChat.js';
import { systemPromptWithRunControls } from '../src/runModePrompt.js';
import { isPlanExecuteText, nextRunMode, normalizeRunMode, runModeLabel } from '@zleap/agent';
import { patchSessionPrefs, resolveSessionPrefs } from '@zleap/host';

describe('runModes', () => {
  it('cycles normal → plan → goal → normal', () => {
    expect(nextRunMode('normal')).toBe('plan');
    expect(nextRunMode('plan')).toBe('goal');
    expect(nextRunMode('goal')).toBe('normal');
  });

  it('detects plan execute user text', () => {
    expect(isPlanExecuteText('执行')).toBe(true);
    expect(isPlanExecuteText('/execute')).toBe(true);
    expect(isPlanExecuteText('继续吧')).toBe(false);
  });

  it('labels modes in Chinese', () => {
    expect(runModeLabel('plan')).toBe('计划');
    expect(normalizeRunMode('invalid')).toBe('normal');
  });
});

describe('permissions', () => {
  it('toggles approval modes', () => {
    expect(nextPermissionMode('request_approval')).toBe('full_access');
    expect(nextPermissionMode('full_access')).toBe('request_approval');
    expect(normalizePermissionMode(undefined)).toBe('request_approval');
  });
});

describe('sessionPrefs', () => {
  it('persists run and permission mode in config', () => {
    const config = patchSessionPrefs({}, { runMode: 'plan', permissionMode: 'full_access' });
    expect(resolveSessionPrefs(config)).toEqual({ runMode: 'plan', permissionMode: 'full_access' });
  });
});

describe('buildReplyRuntimeOptions', () => {
  it('maps plan mode to disableAllTools and permission to approvalPolicy', async () => {
    const confirm = async () => true;
    expect(
      buildReplyRuntimeOptions(confirm, null, { runMode: 'plan', permissionMode: 'request_approval' }),
    ).toEqual({
      confirm,
      disableAllTools: true,
      approvalPolicy: { mode: 'request_approval' },
    });
    expect(
      buildReplyRuntimeOptions(confirm, null, { runMode: 'normal', permissionMode: 'full_access' }),
    ).toEqual({
      confirm,
      approvalPolicy: { mode: 'full_access' },
    });
  });
});

describe('runModePrompt', () => {
  it('injects plan mode system guidance', () => {
    const prompt = systemPromptWithRunControls('base persona', 'plan');
    expect(prompt).toContain('计划模式');
    expect(prompt).toContain(PLAN_EXECUTE_CONFIRM_MARKER);
    expect(systemPromptWithRunControls('base', 'normal')).toBe('base');
  });
});

describe('planMarkers', () => {
  it('detects execute confirmation marker', () => {
    expect(needsExecuteConfirmationReply(`done\n${PLAN_EXECUTE_CONFIRM_MARKER}`)).toBe(true);
  });
});
