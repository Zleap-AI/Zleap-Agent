import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ArtifactList } from '../components/console/ArtifactList';
import type { ArtifactView } from '../lib/types';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

describe('ArtifactList', () => {
  it('shows at most three workspace artifacts before expansion', () => {
    const html = renderToStaticMarkup(<ArtifactList artifacts={Array.from({ length: 5 }, (_, index) => artifact(index + 1))} />);

    expect(html).toContain('artifact-1.md');
    expect(html).toContain('artifact-2.md');
    expect(html).toContain('artifact-3.md');
    expect(html).not.toContain('artifact-4.md');
    expect(html).not.toContain('artifact-5.md');
    // i18n: no provider in this SSR test, so the `{{count}}` interpolation stays
    // literal — assert the stable CTA prefix (折叠数量已由 artifact-4/5 不渲染验证).
    expect(html).toContain('展开剩余');
  });
});

function artifact(index: number): ArtifactView {
  return {
    id: index,
    spaceId: 'cli',
    kind: 'file',
    title: `artifact-${index}.md`,
    detail: 'workspace result · file',
    path: `/tmp/artifact-${index}.md`,
  };
}
