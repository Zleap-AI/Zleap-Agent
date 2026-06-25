/** Normalize a gateway-published QR payload into an `<img src>` value. */
export function qrImageSrc(image: string): string {
  const trimmed = image.trim();
  if (trimmed.startsWith('data:') || trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    return trimmed;
  }
  return `data:image/png;base64,${trimmed}`;
}
