export const SUPPORTED_IMAGE_MIME_TYPES = ['image/png', 'image/jpeg', 'image/webp'] as const;

export type SupportedImageMimeType = (typeof SUPPORTED_IMAGE_MIME_TYPES)[number];

export const IMAGE_ATTACHMENT_LIMITS = {
  maxCount: 4,
  maxBytes: 10 * 1024 * 1024,
} as const;

export type ChatImageAttachment = {
  id: string;
  kind: 'image';
  name: string;
  mimeType: SupportedImageMimeType;
  sizeBytes: number;
  thumbnailDataUrl: string;
  previewDataUrl: string;
};

export type ChatImageRequestAttachment = ChatImageAttachment & {
  dataUrl: string;
};

export type ImageAttachmentValidationError = {
  code: 'unsupported_type' | 'too_large' | 'too_many';
  fileName: string;
};

export type ImageFileLike = {
  name: string;
  type: string;
  size: number;
};

export type FileToImageRequestAttachmentOptions = {
  createThumbnailDataUrl?: (file: File) => Promise<string>;
  createPreviewDataUrl?: (file: File) => Promise<string>;
};

export function isSupportedImageMimeType(mimeType: string): mimeType is SupportedImageMimeType {
  return (SUPPORTED_IMAGE_MIME_TYPES as readonly string[]).includes(mimeType);
}

export function validateImageAttachmentFiles<T extends ImageFileLike>(
  files: readonly T[],
  existingCount = 0,
): { files: T[]; errors: ImageAttachmentValidationError[] } {
  const accepted: T[] = [];
  const errors: ImageAttachmentValidationError[] = [];
  let availableSlots = Math.max(IMAGE_ATTACHMENT_LIMITS.maxCount - existingCount, 0);

  for (const file of files) {
    if (!isSupportedImageMimeType(file.type)) {
      errors.push({ code: 'unsupported_type', fileName: file.name });
      continue;
    }
    if (file.size > IMAGE_ATTACHMENT_LIMITS.maxBytes) {
      errors.push({ code: 'too_large', fileName: file.name });
      continue;
    }
    if (availableSlots <= 0) {
      errors.push({ code: 'too_many', fileName: file.name });
      continue;
    }
    accepted.push(file);
    availableSlots -= 1;
  }

  return { files: accepted, errors };
}

export function requestToDisplayAttachments(
  attachments: readonly ChatImageRequestAttachment[],
): ChatImageAttachment[] {
  return attachments.map(({ dataUrl: _dataUrl, ...attachment }) => attachment);
}

export async function fileToDataUrl(file: File): Promise<string> {
  const buffer = await file.arrayBuffer();
  return `data:${file.type};base64,${arrayBufferToBase64(buffer)}`;
}

export async function createImageThumbnailDataUrl(file: File, maxSide = 320): Promise<string> {
  return createResizedImageDataUrl(file, maxSide, 0.82);
}

export async function createImagePreviewDataUrl(file: File, maxSide = 1280): Promise<string> {
  return createResizedImageDataUrl(file, maxSide, 0.88);
}

async function createResizedImageDataUrl(file: File, maxSide: number, quality: number): Promise<string> {
  const image = await loadImageSource(file);
  try {
    const { width, height } = getThumbnailDimensions(image.width, image.height, maxSide);
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('thumbnail_context_unavailable');
    }
    context.drawImage(image.source, 0, 0, width, height);
    return canvas.toDataURL(file.type, quality);
  } finally {
    image.close?.();
  }
}

export async function fileToImageRequestAttachment(
  file: File,
  id = createImageAttachmentId(),
  options: FileToImageRequestAttachmentOptions = {},
): Promise<ChatImageRequestAttachment> {
  if (!isSupportedImageMimeType(file.type)) {
    throw new Error('unsupported_image_type');
  }
  const createThumbnailDataUrl = options.createThumbnailDataUrl ?? createImageThumbnailDataUrl;
  const createPreviewDataUrl = options.createPreviewDataUrl ?? createImagePreviewDataUrl;
  const dataUrl = await fileToDataUrl(file);
  const [thumbnailDataUrl, previewDataUrl] = await Promise.all([
    createImageDataUrlOrFallback(file, dataUrl, createThumbnailDataUrl),
    createImageDataUrlOrFallback(file, dataUrl, createPreviewDataUrl),
  ]);
  return {
    id,
    kind: 'image',
    name: file.name || 'pasted-image',
    mimeType: file.type,
    sizeBytes: file.size,
    thumbnailDataUrl,
    previewDataUrl,
    dataUrl,
  };
}

export function createImageAttachmentId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return `img_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

async function createImageDataUrlOrFallback(
  file: File,
  fallbackDataUrl: string,
  createDataUrl: (file: File) => Promise<string>,
): Promise<string> {
  try {
    return await createDataUrl(file);
  } catch {
    return fallbackDataUrl;
  }
}

export function dataUrlToBase64Payload(dataUrl: string): { mimeType: SupportedImageMimeType; base64: string } | undefined {
  const match = /^data:([^;,]+);base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) return undefined;
  const mimeType = match[1] ?? '';
  if (!isSupportedImageMimeType(mimeType)) return undefined;
  const base64 = match[2] ?? '';
  if (!isStrictBase64Payload(base64)) return undefined;
  return { mimeType, base64 };
}

function isStrictBase64Payload(base64: string): boolean {
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)
    || base64.length % 4 === 1
    || (base64.includes('=') && base64.length % 4 !== 0)
  ) {
    return false;
  }

  const bytes = base64ToBytes(base64);
  if (!bytes) return false;
  const normalizedInput = stripBase64Padding(base64);
  const normalizedDecoded = stripBase64Padding(bytesToBase64(bytes));
  return normalizedInput === normalizedDecoded;
}

function base64ToBytes(base64: string): Uint8Array | undefined {
  try {
    if (typeof atob === 'function') {
      const binary = atob(base64);
      const bytes = new Uint8Array(binary.length);
      for (let index = 0; index < binary.length; index += 1) {
        bytes[index] = binary.charCodeAt(index);
      }
      return bytes;
    }
    return new Uint8Array(Buffer.from(base64, 'base64'));
  } catch {
    return undefined;
  }
}

function stripBase64Padding(base64: string): string {
  return base64.replace(/=+$/, '');
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  return bytesToBase64(new Uint8Array(buffer));
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  if (typeof btoa === 'function') {
    return btoa(binary);
  }
  return Buffer.from(bytes).toString('base64');
}

type LoadedImageSource = {
  source: CanvasImageSource;
  width: number;
  height: number;
  close?: () => void;
};

async function loadImageSource(file: File): Promise<LoadedImageSource> {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        source: bitmap,
        width: bitmap.width,
        height: bitmap.height,
        close: () => bitmap.close(),
      };
    } catch {
      // Some browsers still fail createImageBitmap for clipboard-backed Blobs.
      // Fall back to the older object URL path below.
    }
  }

  const objectUrl = URL.createObjectURL(file);
  try {
    const image = await loadImage(objectUrl);
    return {
      source: image,
      width: image.width,
      height: image.height,
      close: () => URL.revokeObjectURL(objectUrl),
    };
  } catch (error) {
    URL.revokeObjectURL(objectUrl);
    throw error;
  }
}

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('thumbnail_load_failed'));
    image.src = src;
  });
}

function getThumbnailDimensions(
  width: number,
  height: number,
  maxSide: number,
): { width: number; height: number } {
  if (width <= 0 || height <= 0) {
    throw new Error('invalid_image_dimensions');
  }
  const scale = Math.min(1, maxSide / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}
