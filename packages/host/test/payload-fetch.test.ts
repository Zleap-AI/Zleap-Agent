import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { downloadCandidates } from '../src/payload-fetch.js';

describe('downloadCandidates', () => {
  const original = process.env.ZLEAP_DOWNLOAD_MIRROR;
  const url = 'https://github.com/Zleap-AI/Zleap-Agent/releases/download/v0.1.6/zleap-payload-0.1.6-mac-arm64.tar.gz';

  beforeEach(() => {
    delete process.env.ZLEAP_DOWNLOAD_MIRROR;
  });

  afterEach(() => {
    if (original === undefined) {
      delete process.env.ZLEAP_DOWNLOAD_MIRROR;
    } else {
      process.env.ZLEAP_DOWNLOAD_MIRROR = original;
    }
  });

  it('returns the original url when no mirror is configured', () => {
    expect(downloadCandidates(url)).toEqual([url]);
  });

  it('prefixes a proxy mirror ending in slash and keeps origin last', () => {
    process.env.ZLEAP_DOWNLOAD_MIRROR = 'https://ghproxy.example/';
    expect(downloadCandidates(url)).toEqual([`https://ghproxy.example/${url}`, url]);
  });

  it('expands a {url} template mirror', () => {
    process.env.ZLEAP_DOWNLOAD_MIRROR = 'https://m.example/p?u={url}';
    expect(downloadCandidates(url)).toEqual([`https://m.example/p?u=${url}`, url]);
  });

  it('replaces the host for a bare base mirror', () => {
    process.env.ZLEAP_DOWNLOAD_MIRROR = 'https://mirror.example.com';
    expect(downloadCandidates(url)).toEqual([
      'https://mirror.example.com/Zleap-AI/Zleap-Agent/releases/download/v0.1.6/zleap-payload-0.1.6-mac-arm64.tar.gz',
      url,
    ]);
  });

  it('supports multiple comma-separated mirrors and de-duplicates', () => {
    process.env.ZLEAP_DOWNLOAD_MIRROR = 'https://a.example/, https://a.example/';
    expect(downloadCandidates(url)).toEqual([`https://a.example/${url}`, url]);
  });
});
