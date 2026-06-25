import { describe, expect, it } from 'vitest';
import { qrImageSrc } from '../lib/connectionQr';

describe('qrImageSrc', () => {
  it('passes through data URLs', () => {
    const data = 'data:image/png;base64,AAAA';
    expect(qrImageSrc(data)).toBe(data);
  });

  it('passes through http(s) URLs', () => {
    expect(qrImageSrc('https://example.com/qr.png')).toBe('https://example.com/qr.png');
  });

  it('wraps bare base64 as PNG data URL', () => {
    expect(qrImageSrc('iVBORw0KGgo')).toBe('data:image/png;base64,iVBORw0KGgo');
  });

  it('trims whitespace', () => {
    expect(qrImageSrc('  iVBORw0KGgo  ')).toBe('data:image/png;base64,iVBORw0KGgo');
  });
});
