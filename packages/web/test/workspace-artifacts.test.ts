import { describe, expect, it } from 'vitest';
import { artifactFromToolResult, artifactPathFromTitle, artifactsFromExitWorkspace, dedupeArtifactViews, refToLocalPath, resolveArtifactPath } from '../lib/workspaceArtifacts';

describe('workspace artifacts', () => {
  it('turns a write diff into a visible file artifact with inline preview', () => {
    const result = [
      'Created /Users/jomymac/Documents/Zleap/conversations/web-123/project_analysis.md (+196)',
      '+# 项目分析',
      '+',
      '+这里是最终文档内容',
    ].join('\n');

    const artifact = artifactFromToolResult({
      id: 7,
      name: 'write',
      result,
      spaceId: 'basic',
    });

    expect(artifact).toMatchObject({
      id: 7,
      spaceId: 'basic',
      kind: 'diff',
      title: 'project_analysis.md',
      path: '/Users/jomymac/Documents/Zleap/conversations/web-123/project_analysis.md',
      detail: 'Created (+196) · via write',
      preview: result,
    });
  });

  it('does not create artifacts for read-only tool results', () => {
    expect(
      artifactFromToolResult({
        id: 1,
        name: 'read',
        result: 'file contents',
        spaceId: 'basic',
      }),
    ).toBeNull();
  });

  it('extracts a local path from legacy artifact titles', () => {
    expect(artifactPathFromTitle('Created /Users/jomymac/Documents/Zleap/conversations/web-123/project_analysis.md (+196)')).toBe(
      '/Users/jomymac/Documents/Zleap/conversations/web-123/project_analysis.md',
    );
  });

  it('maps exitWorkspace artifact refs to console cards', () => {
    const args = JSON.stringify({
      status: 'completed',
      summary: 'done',
      artifacts: [{ kind: 'document', ref: 'file:///tmp/report.md', description: 'Agent记忆框架对比分析报告' }],
    });
    expect(artifactsFromExitWorkspace(args, 'web', () => 11)).toEqual([
      {
        id: 11,
        spaceId: 'web',
        kind: 'file',
        title: 'Agent记忆框架对比分析报告',
        detail: 'exitWorkspace · document',
        path: '/tmp/report.md',
      },
    ]);
  });

  it('dedupes the same file when one artifact only has the basename', () => {
    const fullPath = '/Users/jomymac/Documents/Zleap/2026-06-18/spaceX-pdf/SpaceX_Valuation_Report_2026.pdf';
    expect(
      dedupeArtifactViews([
        {
          id: 1,
          spaceId: 'cli',
          kind: 'file',
          title: 'SpaceX_Valuation_Report_2026.pdf',
          detail: 'Created (+1) · via write',
          path: fullPath,
        },
        {
          id: 2,
          spaceId: 'cli',
          kind: 'file',
          title: 'SpaceX_Valuation_Report_2026.pdf',
          detail: '消息中提到的文件',
          path: 'SpaceX_Valuation_Report_2026.pdf',
        },
      ]),
    ).toEqual([
      expect.objectContaining({
        id: 1,
        title: 'SpaceX_Valuation_Report_2026.pdf',
        path: fullPath,
      }),
    ]);
  });

  it('does not dedupe same basename when both artifacts have different full paths', () => {
    const artifacts = dedupeArtifactViews([
      {
        id: 1,
        spaceId: 'cli',
        kind: 'file',
        title: 'report.pdf',
        detail: 'first',
        path: '/tmp/a/report.pdf',
      },
      {
        id: 2,
        spaceId: 'cli',
        kind: 'file',
        title: 'report.pdf',
        detail: 'second',
        path: '/tmp/b/report.pdf',
      },
    ]);
    expect(artifacts).toHaveLength(2);
  });

  it('parses file:// refs', () => {
    expect(refToLocalPath('file:///Users/me/report.md')).toBe('/Users/me/report.md');
  });

  it('resolves relative artifact paths against a workspace root', () => {
    expect(resolveArtifactPath('output/pdf/302_AI_Research_Report.pdf', '/Users/me/Zleap/conversation-1')).toBe(
      '/Users/me/Zleap/conversation-1/output/pdf/302_AI_Research_Report.pdf',
    );
  });
});
