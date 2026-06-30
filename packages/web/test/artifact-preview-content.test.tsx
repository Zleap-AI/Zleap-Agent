import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { ArtifactPreviewContent, calculatePptxFitScale, createPptxPreviewObjectUrl, inlineHtmlAssets } from '../components/ArtifactPreviewContent';

describe('ArtifactPreviewContent', () => {
  it('renders html artifacts inside a sandboxed iframe', () => {
    const html = renderToStaticMarkup(
      <ArtifactPreviewContent content={'<!doctype html><html><body><h1>Hello</h1></body></html>'} path="/tmp/page.html" />,
    );

    expect(html).toContain('<iframe');
    expect(html).toContain('sandbox="allow-scripts"');
    expect(html).toContain('srcDoc=');
    expect(html).not.toContain('<code');
  });

  it('inlines relative html css and js assets before iframe preview', async () => {
    const html = await inlineHtmlAssets(
      '<!doctype html><link rel="stylesheet" href="style.css"><script src="./script.js" defer></script>',
      '/tmp/weather-app/index.html',
      async (assetPath) => {
        if (assetPath === '/tmp/weather-app/style.css') return 'body { color: red; }';
        if (assetPath === '/tmp/weather-app/script.js') return 'window.loaded = true;';
        throw new Error(`unexpected asset ${assetPath}`);
      },
    );

    expect(html).toContain('<style data-zleap-inlined-asset="style.css">body { color: red; }</style>');
    expect(html).toContain('<script data-zleap-inlined-asset="./script.js">window.loaded = true;</script>');
    expect(html).not.toContain('href="style.css"');
    expect(html).not.toContain('src="./script.js"');
  });

  it('renders markdown artifacts as markdown, not source code', () => {
    const html = renderToStaticMarkup(
      <ArtifactPreviewContent content={'# Title\n\n- item'} path="/tmp/notes.md" />,
    );

    expect(html).toContain('markdown-body');
    expect(html).toContain('<h1');
    expect(html).toContain('<li');
    expect(html).not.toContain('lineNumbers');
  });

  it('lets full-height markdown previews scroll vertically', () => {
    const html = renderToStaticMarkup(
      <ArtifactPreviewContent content={'# Title'} path="/tmp/notes.md" fullHeight />,
    );

    expect(html).toContain('overflow-y-auto');
  });

  it('renders image artifacts as media previews, not source code', () => {
    const html = renderToStaticMarkup(
      <ArtifactPreviewContent content={''} path="/tmp/photo.png" />,
    );

    expect(html).toContain('data-media-kind="image"');
    expect(html).not.toContain('<code');
  });

  it('renders pptx artifacts with the PPTXjs preview shell', () => {
    const html = renderToStaticMarkup(
      <ArtifactPreviewContent content={''} path="/tmp/deck.pptx" />,
    );

    expect(html).toContain('data-media-kind="pptx"');
    expect(html).toContain('data-pptx-preview');
    expect(html).not.toContain('<code');
  });

  it('fetches pptx artifacts through the app API before handing a blob URL to PPTXjs', async () => {
    const originalCreateObjectUrl = URL.createObjectURL;
    URL.createObjectURL = (() => 'blob:zleap-pptx-preview') as typeof URL.createObjectURL;
    const seen: string[] = [];

    try {
      const url = await createPptxPreviewObjectUrl('/tmp/deck.pptx', async (input) => {
        seen.push(String(input));
        return new Response(new Blob(['pptx-bytes']));
      });

      expect(url).toBe('blob:zleap-pptx-preview');
      expect(seen).toEqual(['/api/artifacts/local?path=%2Ftmp%2Fdeck.pptx&raw=1']);
    } finally {
      URL.createObjectURL = originalCreateObjectUrl;
    }
  });

  it('calculates a PPTX fit-to-width scale from the preview container and slide width', () => {
    expect(calculatePptxFitScale(720, 960)).toBe(0.75);
    expect(calculatePptxFitScale(1440, 960)).toBe(1.5);
    expect(calculatePptxFitScale(0, 960)).toBe(1);
    expect(calculatePptxFitScale(720, 0)).toBe(1);
  });
});
