import { describe, expect, it } from 'vitest';
import {
  dataUrlToBase64Payload,
  fileToImageRequestAttachment,
  requestToDisplayAttachments,
  validateImageAttachmentFiles,
  type ChatImageRequestAttachment,
} from '../lib/chatAttachments';

const png = (name = 'shot.png', size = 1024) => ({ name, type: 'image/png', size });

describe('chat image attachments', () => {
  it('accepts supported image files within limits', () => {
    const result = validateImageAttachmentFiles([png()], 0);

    expect(result.files).toEqual([png()]);
    expect(result.errors).toEqual([]);
  });

  it('rejects unsupported MIME types', () => {
    const result = validateImageAttachmentFiles([{ name: 'notes.txt', type: 'text/plain', size: 12 }], 0);

    expect(result.files).toEqual([]);
    expect(result.errors).toEqual([{ code: 'unsupported_type', fileName: 'notes.txt' }]);
  });

  it('rejects files over 10 MB', () => {
    const result = validateImageAttachmentFiles([png('huge.png', 10 * 1024 * 1024 + 1)], 0);

    expect(result.files).toEqual([]);
    expect(result.errors).toEqual([{ code: 'too_large', fileName: 'huge.png' }]);
  });

  it('keeps only the available slots when the message already has images', () => {
    const result = validateImageAttachmentFiles([png('a.png'), png('b.png')], 3);

    expect(result.files.map((file) => file.name)).toEqual(['a.png']);
    expect(result.errors).toEqual([{ code: 'too_many', fileName: 'b.png' }]);
  });

  it('strips full image data from display attachments', () => {
    const request: ChatImageRequestAttachment[] = [{
      id: 'img_1',
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      thumbnailDataUrl: 'data:image/png;base64,thumb',
      previewDataUrl: 'data:image/png;base64,preview',
      dataUrl: 'data:image/png;base64,full',
    }];

    expect(requestToDisplayAttachments(request)).toEqual([{
      id: 'img_1',
      kind: 'image',
      name: 'shot.png',
      mimeType: 'image/png',
      sizeBytes: 5,
      thumbnailDataUrl: 'data:image/png;base64,thumb',
      previewDataUrl: 'data:image/png;base64,preview',
    }]);
  });

  it('parses a supported image data URL into MIME and base64 payload', () => {
    expect(dataUrlToBase64Payload('data:image/webp;base64,aGVsbG8=')).toEqual({
      mimeType: 'image/webp',
      base64: 'aGVsbG8=',
    });
  });

  it.each(['image/png', 'image/jpeg', 'image/webp'] as const)('accepts valid %s data URLs', (mimeType) => {
    expect(dataUrlToBase64Payload(`data:${mimeType};base64,aGVsbG8=`)).toEqual({
      mimeType,
      base64: 'aGVsbG8=',
    });
  });

  it.each([
    'data:image/png;base64,====',
    'data:image/png;base64,a=bc',
    'data:image/png;base64,a',
    'data:image/png;base64,aGVsbG8===',
  ])('rejects malformed image base64 payloads: %s', (dataUrl) => {
    expect(dataUrlToBase64Payload(dataUrl)).toBeUndefined();
  });

  it('uses a generated thumbnail instead of reusing the full image data url', async () => {
    const file = new File(['full-image'], 'shot.png', { type: 'image/png' });

    const attachment = await fileToImageRequestAttachment(file, 'img_1', {
      createThumbnailDataUrl: async () => 'data:image/png;base64,thumb',
      createPreviewDataUrl: async () => 'data:image/png;base64,preview',
    });

    expect(attachment.dataUrl).not.toBe(attachment.thumbnailDataUrl);
    expect(attachment.dataUrl).not.toBe(attachment.previewDataUrl);
    expect(attachment.dataUrl).toContain('ZnVsbC1pbWFnZQ==');
    expect(attachment.thumbnailDataUrl).toBe('data:image/png;base64,thumb');
    expect(attachment.previewDataUrl).toBe('data:image/png;base64,preview');
  });

  it('keeps the image attachable when preview generation fails', async () => {
    const file = new File(['full-image'], 'shot.png', { type: 'image/png' });

    const attachment = await fileToImageRequestAttachment(file, 'img_1', {
      createThumbnailDataUrl: async () => {
        throw new Error('thumbnail_failed');
      },
      createPreviewDataUrl: async () => {
        throw new Error('preview_failed');
      },
    });

    expect(attachment.dataUrl).toContain('ZnVsbC1pbWFnZQ==');
    expect(attachment.thumbnailDataUrl).toBe(attachment.dataUrl);
    expect(attachment.previewDataUrl).toBe(attachment.dataUrl);
  });
});
