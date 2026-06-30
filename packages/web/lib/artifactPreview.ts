export type ArtifactPreviewKind = 'html' | 'markdown' | 'image' | 'pdf' | 'pptx' | 'video' | 'audio' | 'code';

export function artifactPreviewKind(path: string): ArtifactPreviewKind {
  const ext = fileExtension(path);
  if (ext === 'html' || ext === 'htm') return 'html';
  if (ext === 'md' || ext === 'mdx' || ext === 'markdown') return 'markdown';
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'bmp', 'svg', 'ico'].includes(ext)) return 'image';
  if (ext === 'pdf') return 'pdf';
  if (ext === 'pptx') return 'pptx';
  if (['mp4', 'webm', 'ogv', 'mov'].includes(ext)) return 'video';
  if (['mp3', 'wav', 'ogg', 'm4a', 'flac'].includes(ext)) return 'audio';
  return 'code';
}

export function artifactContentType(path: string): string {
  const kind = artifactPreviewKind(path);
  const ext = fileExtension(path);
  if (kind === 'html') return 'text/html;charset=utf-8';
  if (kind === 'markdown') return 'text/markdown;charset=utf-8';
  if (kind === 'image') return imageContentType(ext);
  if (kind === 'pdf') return 'application/pdf';
  if (kind === 'pptx') return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
  if (kind === 'video') return videoContentType(ext);
  if (kind === 'audio') return audioContentType(ext);
  return 'text/plain;charset=utf-8';
}

export function artifactPreviewNeedsText(path: string): boolean {
  return ['html', 'markdown', 'code'].includes(artifactPreviewKind(path));
}

export function truncateArtifactPreview(content: string, maxLines: number): { text: string; overflow: number } {
  const lines = content.split('\n');
  const shown = lines.slice(0, maxLines);
  return {
    text: shown.join('\n'),
    overflow: Math.max(0, lines.length - shown.length),
  };
}

export function fileExtension(path: string): string {
  const clean = path.split(/[?#]/, 1)[0] ?? path;
  const name = clean.split(/[\\/]/).filter(Boolean).at(-1) ?? clean;
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function imageContentType(ext: string): string {
  if (ext === 'jpg') return 'image/jpeg';
  if (ext === 'svg') return 'image/svg+xml';
  if (ext === 'ico') return 'image/x-icon';
  return `image/${ext || 'png'}`;
}

function videoContentType(ext: string): string {
  if (ext === 'ogv') return 'video/ogg';
  if (ext === 'mov') return 'video/quicktime';
  return `video/${ext || 'mp4'}`;
}

function audioContentType(ext: string): string {
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a') return 'audio/mp4';
  return `audio/${ext || 'mpeg'}`;
}
