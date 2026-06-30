import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import '../lib/i18n';
import { ImagePreviewDialog, UserMessage } from '../components/UserMessage';

vi.mock('../components/ui/dialog', () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => <div data-testid="dialog">{children}</div>,
  DialogContent: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
  DialogDescription: ({ children, className }: { children: React.ReactNode; className?: string }) => <p className={className}>{children}</p>,
  DialogHeader: ({ children, className }: { children: React.ReactNode; className?: string }) => <div className={className}>{children}</div>,
  DialogTitle: ({ children, className }: { children: React.ReactNode; className?: string }) => <h2 className={className}>{children}</h2>,
}));

describe('UserMessage', () => {
  it('renders image attachments as zoomable preview buttons', () => {
    const html = renderToStaticMarkup(
      <UserMessage
        text="能看到吗"
        attachments={[
          {
            id: 'image-1',
            kind: 'image',
            name: 'shot.png',
            mimeType: 'image/png',
            sizeBytes: 1024,
            thumbnailDataUrl: 'data:image/png;base64,dGh1bWI=',
            previewDataUrl: 'data:image/png;base64,cHJldmlldw==',
          },
        ]}
      />,
    );

    expect(html).toContain('aria-label="放大图片：shot.png"');
    expect(html).toContain('cursor-zoom-in');
    expect(html).toContain('data:image/png;base64,dGh1bWI=');
    expect(html).toContain('能看到吗');
  });

  it('scales the preview image to the dialog instead of rendering at intrinsic thumbnail size', () => {
    const html = renderToStaticMarkup(
      <ImagePreviewDialog
        attachment={{
          id: 'image-1',
          kind: 'image',
          name: 'shot.png',
          mimeType: 'image/png',
          sizeBytes: 1024,
          thumbnailDataUrl: 'data:image/png;base64,dGh1bWI=',
          previewDataUrl: 'data:image/png;base64,cHJldmlldw==',
        }}
        open
        onOpenChange={() => {}}
      />,
    );

    expect(html).toContain('h-full w-full');
    expect(html).toContain('object-contain');
    expect(html).toContain('data:image/png;base64,cHJldmlldw==');
  });
});
