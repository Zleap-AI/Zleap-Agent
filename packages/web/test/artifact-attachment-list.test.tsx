import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { ArtifactAttachmentList } from '../components/ArtifactAttachmentList';
import type { ArtifactView } from '../lib/types';

(globalThis as typeof globalThis & { React: typeof React }).React = React;

vi.mock('../components/ui/button', () => ({
  Button: ({ children, ...props }: React.ComponentProps<'button'>) => <button {...props}>{children}</button>,
}));

vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogDescription: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
  DialogHeader: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
}));

vi.mock('../components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  DropdownMenuTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

vi.mock('../components/ui/item', () => ({
  Item: ({ children, ...props }: React.ComponentProps<'div'>) => <div {...props}>{children}</div>,
  ItemActions: ({ children, ...props }: React.ComponentProps<'div'>) => <div {...props}>{children}</div>,
  ItemContent: ({ children, ...props }: React.ComponentProps<'div'>) => <div {...props}>{children}</div>,
  ItemDescription: ({ children, ...props }: React.ComponentProps<'p'>) => <p {...props}>{children}</p>,
  ItemMedia: ({ children, ...props }: React.ComponentProps<'div'>) => <div {...props}>{children}</div>,
  ItemTitle: ({ children, ...props }: React.ComponentProps<'div'>) => <div {...props}>{children}</div>,
}));

describe('ArtifactAttachmentList', () => {
  it('shows at most three artifacts in a chat message before expansion', () => {
    const html = renderToStaticMarkup(<ArtifactAttachmentList artifacts={Array.from({ length: 5 }, (_, index) => artifact(index + 1))} />);

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
    detail: 'Created via write',
    path: `/tmp/artifact-${index}.md`,
  };
}
