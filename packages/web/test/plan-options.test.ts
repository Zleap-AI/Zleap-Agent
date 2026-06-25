import { describe, expect, it } from 'vitest';
import {
  PLAN_EXECUTE_CONFIRM_MARKER,
  PLAN_QUESTION_END_MARKER,
  PLAN_QUESTION_START_MARKER,
  extractPlanOptions,
  extractPlanQuestion,
  extractPlanQuestions,
  latestPlanReplyPrompt,
  needsExecuteConfirmationReply,
  stripPlanReplyMarkers,
} from '../lib/planOptions';

describe('extractPlanOptions', () => {
  it('detects bounded plan choices from assistant text', () => {
    expect(
      extractPlanOptions([
        '请选择一个方向:',
        '',
        'A: 纯静态网页',
        'B: 现代前端框架',
        'C: 文档站生成器',
      ].join('\n')),
    ).toEqual([
      { key: 'A', text: '纯静态网页' },
      { key: 'B', text: '现代前端框架' },
      { key: 'C', text: '文档站生成器' },
    ]);
  });

  it('ignores one-off labels that are not a choice set', () => {
    expect(extractPlanOptions('请选择查看 A: 不是选项集合')).toEqual([]);
  });

  it('requires the fixed marker for execute confirmation replies', () => {
    expect(needsExecuteConfirmationReply(`最终计划已完成。\n${PLAN_EXECUTE_CONFIRM_MARKER}`)).toBe(true);
    expect(needsExecuteConfirmationReply('请回复“执行”或直接忽略此问')).toBe(false);
  });

  it('strips fixed plan reply markers from rendered assistant text', () => {
    const text = [
      '我先问一个问题。',
      PLAN_QUESTION_START_MARKER,
      '{"question":"这次计划希望最终指导产出什么？","options":[{"id":"1","label":"可运行 harness","recommended":true},{"id":"2","label":"调研报告"}]}',
      PLAN_QUESTION_END_MARKER,
      PLAN_EXECUTE_CONFIRM_MARKER,
    ].join('\n');
    expect(stripPlanReplyMarkers(text)).toBe('我先问一个问题。');
  });

  it('parses fixed plan question blocks', () => {
    const text = [
      '我需要确认几个问题。',
      PLAN_QUESTION_START_MARKER,
      '{"questions":[{"question":"这次计划希望最终指导产出什么？","options":[{"id":"1","label":"可运行 harness","recommended":true},{"id":"2","label":"调研报告"},{"id":"3","label":"先 MVP 文档"}]},{"question":"优先控制哪类风险？","options":[{"id":"1","label":"范围失焦"},{"id":"2","label":"技术不可行"}]}]}',
      PLAN_QUESTION_END_MARKER,
    ].join('\n');

    expect(extractPlanQuestions(text)).toEqual([
      {
        question: '这次计划希望最终指导产出什么？',
        options: [
          { id: '1', label: '可运行 harness', recommended: true },
          { id: '2', label: '调研报告', recommended: false },
          { id: '3', label: '先 MVP 文档', recommended: false },
        ],
      },
      {
        question: '优先控制哪类风险？',
        options: [
          { id: '1', label: '范围失焦', recommended: false },
          { id: '2', label: '技术不可行', recommended: false },
        ],
      },
    ]);
    expect(extractPlanQuestion(text)?.question).toBe('这次计划希望最终指导产出什么？');
  });

  it('only surfaces the latest assistant plan prompt for the composer', () => {
    const text = [
      '我需要确认一个问题。',
      PLAN_QUESTION_START_MARKER,
      '{"question":"这次计划希望最终指导产出什么？","options":[{"id":"1","label":"可运行 harness"},{"id":"2","label":"调研报告"}]}',
      PLAN_QUESTION_END_MARKER,
    ].join('\n');

    expect(latestPlanReplyPrompt([
      { id: 'assistant-1', role: 'assistant', text },
    ])).toMatchObject({
      messageId: 'assistant-1',
      needsExecuteConfirmation: false,
      questions: [{ question: '这次计划希望最终指导产出什么？' }],
    });

    expect(latestPlanReplyPrompt([
      { id: 'assistant-1', role: 'assistant', text },
      { id: 'user-1', role: 'user', text: '我选择 1' },
    ])).toBeUndefined();
    expect(latestPlanReplyPrompt([{ id: 'assistant-1', role: 'assistant', text }], new Set(['assistant-1']))).toBeUndefined();
  });

  it('keeps backward compatibility with old single-question blocks', () => {
    const text = [
      '我需要确认一个问题。',
      PLAN_QUESTION_START_MARKER,
      '{"question":"这次计划希望最终指导产出什么？","options":[{"id":"1","label":"可运行 harness"},{"id":"2","label":"调研报告"}]}',
      PLAN_QUESTION_END_MARKER,
    ].join('\n');

    expect(extractPlanQuestions(text)).toEqual([
      {
        question: '这次计划希望最终指导产出什么？',
        options: [
          { id: '1', label: '可运行 harness', recommended: false },
          { id: '2', label: '调研报告', recommended: false },
        ],
      },
    ]);
  });
});
