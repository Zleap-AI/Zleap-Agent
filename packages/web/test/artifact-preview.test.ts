import { describe, expect, it } from 'vitest';
import { artifactContentType, artifactPreviewKind, fileExtension, truncateArtifactPreview } from '../lib/artifactPreview';

describe('artifact preview helpers', () => {
  it('renders html artifacts as browser previews', () => {
    expect(artifactPreviewKind('/tmp/report.html')).toBe('html');
    expect(artifactPreviewKind('/tmp/report.HTM?download=1')).toBe('html');
    expect(artifactContentType('/tmp/report.html')).toBe('text/html;charset=utf-8');
  });

  it('renders markdown artifacts as markdown previews', () => {
    expect(artifactPreviewKind('/tmp/notes.md')).toBe('markdown');
    expect(artifactPreviewKind('/tmp/README.markdown')).toBe('markdown');
    expect(artifactContentType('/tmp/notes.md')).toBe('text/markdown;charset=utf-8');
  });

  it('keeps unknown artifacts as code previews', () => {
    expect(artifactPreviewKind('/tmp/data.json')).toBe('code');
    expect(artifactContentType('/tmp/data.json')).toBe('text/plain;charset=utf-8');
    expect(fileExtension('/tmp/archive.tar.gz#section')).toBe('gz');
  });

  it('recognizes common browser-renderable file types', () => {
    expect(artifactPreviewKind('/tmp/photo.png')).toBe('image');
    expect(artifactPreviewKind('/tmp/photo.jpeg')).toBe('image');
    expect(artifactPreviewKind('/tmp/vector.svg')).toBe('image');
    expect(artifactPreviewKind('/tmp/report.pdf')).toBe('pdf');
    expect(artifactPreviewKind('/tmp/slides.pptx')).toBe('pptx');
    expect(artifactPreviewKind('/tmp/demo.mp4')).toBe('video');
    expect(artifactPreviewKind('/tmp/audio.mp3')).toBe('audio');
    expect(artifactContentType('/tmp/photo.png')).toBe('image/png');
    expect(artifactContentType('/tmp/report.pdf')).toBe('application/pdf');
    expect(artifactContentType('/tmp/slides.pptx')).toBe('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('truncates code previews without touching rendered html or markdown paths', () => {
    expect(truncateArtifactPreview('1\n2\n3', 2)).toEqual({ text: '1\n2', overflow: 1 });
  });
});
