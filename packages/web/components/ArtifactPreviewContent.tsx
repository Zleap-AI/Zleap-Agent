'use client';

import clsx from 'clsx';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { artifactPreviewKind, truncateArtifactPreview } from '../lib/artifactPreview';
import { webApiFetch } from '../lib/api';
import { CodeView, langFromPath } from './CodeView';
import { MarkdownView } from './MarkdownView';

type ArtifactPreviewContentProps = {
  content: string;
  path: string;
  compact?: boolean;
  codeLineNumbers?: boolean;
  maxCodeLines?: number;
  className?: string;
  fullHeight?: boolean;
};

export function ArtifactPreviewContent({
  content,
  path,
  compact = false,
  codeLineNumbers = false,
  maxCodeLines,
  className,
  fullHeight = false,
}: ArtifactPreviewContentProps) {
  const kind = artifactPreviewKind(path);

  if (kind === 'html') {
    return <HtmlArtifactPreview content={content} path={path} className={className} fullHeight={fullHeight} />;
  }

  if (kind === 'markdown') {
    return (
      <div className={clsx('w-full min-w-0 max-w-full overflow-x-auto rounded-sm border border-border bg-background px-3 py-3', fullHeight && 'h-full soft-scroll overflow-y-auto', className)}>
        <MarkdownView text={content} compact={compact} />
      </div>
    );
  }

  if (kind === 'pptx') {
    return <PptxArtifactPreview path={path} className={className} fullHeight={fullHeight} />;
  }

  if (kind === 'image' || kind === 'pdf' || kind === 'video' || kind === 'audio') {
    return <RawMediaPreview kind={kind} path={path} className={className} fullHeight={fullHeight} />;
  }

  const preview = maxCodeLines ? truncateArtifactPreview(content, maxCodeLines) : { text: content, overflow: 0 };
  return (
    <div className={clsx('w-full min-w-0 max-w-full', className)}>
      <CodeView code={preview.text} lang={langFromPath(path)} lineNumbers={codeLineNumbers} />
      {preview.overflow > 0 ? (
        <div className="px-1 pt-1.5 text-xs text-muted-foreground">... +{preview.overflow} more lines</div>
      ) : null}
    </div>
  );
}

function HtmlArtifactPreview({
  content,
  path,
  className,
  fullHeight,
}: {
  content: string;
  path: string;
  className?: string;
  fullHeight?: boolean;
}) {
  const { t } = useTranslation();
  const [html, setHtml] = useState(content);

  useEffect(() => {
    let cancelled = false;
    setHtml(content);
    inlineHtmlAssets(content, path).then((nextHtml) => {
      if (!cancelled) setHtml(nextHtml);
    });
    return () => {
      cancelled = true;
    };
  }, [content, path]);

  return (
    <div className={clsx('overflow-hidden rounded-sm border border-border bg-white', fullHeight && 'h-full', className)}>
      <iframe
        title={t('preview.previewName', { defaultValue: '预览 {{name}}', name: artifactName(path) })}
        srcDoc={html}
        sandbox="allow-scripts"
        className={clsx('w-full bg-white', fullHeight ? 'h-full' : 'h-[520px]')}
      />
    </div>
  );
}

function PptxArtifactPreview({
  path,
  className,
  fullHeight,
}: {
  path: string;
  className?: string;
  fullHeight?: boolean;
}) {
  const { t } = useTranslation();
  const frameRef = React.useRef<HTMLDivElement>(null);
  const containerRef = React.useRef<HTMLDivElement>(null);
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready' } | { status: 'error'; message: string }>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let pptxObjectUrl: string | undefined;
    let resizeObserver: ResizeObserver | undefined;
    let mutationObserver: MutationObserver | undefined;
    let fitFrame: number | undefined;
    const fitTimers: number[] = [];
    const fitSlides = () => {
      if (cancelled || fitFrame !== undefined) return;
      fitFrame = window.requestAnimationFrame(() => {
        fitFrame = undefined;
        if (!cancelled && containerRef.current && frameRef.current) {
          fitPptxSlidesToWidth(containerRef.current, frameRef.current);
        }
      });
    };

    setState({ status: 'loading' });
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
    }

    Promise.all([ensurePptxJsLoaded(), createPptxPreviewObjectUrl(path)])
      .then(([, objectUrl]) => {
        if (cancelled) {
          URL.revokeObjectURL(objectUrl);
          return;
        }
        pptxObjectUrl = objectUrl;
        if (cancelled || !containerRef.current) return;
        const jquery = window.jQuery ?? window.$;
        if (!jquery?.fn?.pptxToHtml) {
          throw new Error('PPTXjs renderer is not available.');
        }
        jquery(containerRef.current).pptxToHtml({
          pptxFileUrl: objectUrl,
          slidesScale: '',
          slideMode: false,
          keyBoardShortCut: false,
          mediaProcess: true,
          jsZipV2: false,
          themeProcess: true,
        });
        mutationObserver = new MutationObserver(fitSlides);
        mutationObserver.observe(containerRef.current, { childList: true, subtree: true });
        if (typeof ResizeObserver !== 'undefined' && frameRef.current) {
          resizeObserver = new ResizeObserver(fitSlides);
          resizeObserver.observe(frameRef.current);
        } else {
          window.addEventListener('resize', fitSlides);
        }
        for (const delay of [0, 100, 300, 800, 1500]) {
          fitTimers.push(window.setTimeout(fitSlides, delay));
        }
        fitSlides();
        if (!cancelled) setState({ status: 'ready' });
      })
      .catch((error: unknown) => {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
      if (containerRef.current) {
        containerRef.current.innerHTML = '';
      }
      if (fitFrame !== undefined) {
        window.cancelAnimationFrame(fitFrame);
      }
      for (const timer of fitTimers) {
        window.clearTimeout(timer);
      }
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
      window.removeEventListener('resize', fitSlides);
      if (pptxObjectUrl) {
        URL.revokeObjectURL(pptxObjectUrl);
      }
    };
  }, [path]);

  const frameClass = clsx('soft-scroll overflow-x-hidden overflow-y-auto rounded-sm border border-border bg-white', fullHeight ? 'h-full' : 'min-h-[420px] max-h-[720px]', className);
  return (
    <div ref={frameRef} className={frameClass} data-media-kind="pptx">
      {state.status === 'loading' ? (
        <div className="flex min-h-[360px] items-center justify-center px-4 text-sm text-muted-foreground">
          {t('preview.loadingPptx', { defaultValue: '正在加载 PPTX 预览...' })}
        </div>
      ) : null}
      {state.status === 'error' ? (
        <div className="flex min-h-[360px] items-center justify-center px-4 text-sm text-destructive">{state.message}</div>
      ) : null}
      <div ref={containerRef} data-pptx-preview className={clsx('w-full min-w-0', state.status === 'error' && 'hidden')} />
    </div>
  );
}

type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

export async function createPptxPreviewObjectUrl(path: string, fetcher: FetchLike = webApiFetch): Promise<string> {
  const response = await fetcher(rawArtifactUrl(path));
  if (!response.ok) {
    const message = await response.text().catch(() => '');
    throw new Error(message || `HTTP ${response.status}`);
  }
  return URL.createObjectURL(await response.blob());
}

export function calculatePptxFitScale(containerWidth: number, slideWidth: number): number {
  if (!Number.isFinite(containerWidth) || !Number.isFinite(slideWidth) || containerWidth <= 0 || slideWidth <= 0) return 1;
  return containerWidth / slideWidth;
}

function fitPptxSlidesToWidth(container: HTMLElement, frame: HTMLElement): boolean {
  const wrapper = container.querySelector<HTMLElement>('#all_slides_warpper');
  const firstSlide = container.querySelector<HTMLElement>('.slide');
  if (!wrapper || !firstSlide) return false;

  const slideWidth = readPositiveDatasetNumber(wrapper, 'zleapSlideWidth') ?? (firstSlide.offsetWidth || firstSlide.clientWidth);
  const slideHeight = readPositiveDatasetNumber(wrapper, 'zleapSlideHeight') ?? (firstSlide.offsetHeight || firstSlide.clientHeight);
  if (slideWidth <= 0 || slideHeight <= 0) return false;

  const slideStyle = window.getComputedStyle(firstSlide);
  const slideBlockHeight = readPositiveDatasetNumber(wrapper, 'zleapSlideBlockHeight') ?? slideHeight + cssPixels(slideStyle.marginTop) + cssPixels(slideStyle.marginBottom);
  wrapper.dataset.zleapSlideWidth = String(slideWidth);
  wrapper.dataset.zleapSlideHeight = String(slideHeight);
  wrapper.dataset.zleapSlideBlockHeight = String(slideBlockHeight);

  const slideCount = container.querySelectorAll('.slide').length || 1;
  const scale = calculatePptxFitScale(frame.clientWidth, slideWidth);
  const scaleCss = cssNumber(scale);
  const unscaledWrapperHeight = Math.ceil(slideBlockHeight * slideCount);
  const usesLayoutZoom = typeof CSS !== 'undefined' && CSS.supports?.('zoom', '1') === true;

  setStyleIfChanged(wrapper, 'transformOrigin', 'top left');
  setStyleIfChanged(wrapper, 'width', `${slideWidth}px`);
  setStyleIfChanged(wrapper, 'marginLeft', '0px');
  setStyleIfChanged(wrapper, 'marginRight', '0px');
  if (usesLayoutZoom) {
    setStyleIfChanged(wrapper, 'transform', 'none');
    setCssPropertyIfChanged(wrapper, 'zoom', scaleCss);
    setStyleIfChanged(wrapper, 'height', `${unscaledWrapperHeight}px`);
  } else {
    setCssPropertyIfChanged(wrapper, 'zoom', '');
    setStyleIfChanged(wrapper, 'transform', `scale(${scaleCss})`);
    setStyleIfChanged(wrapper, 'height', `${Math.ceil(unscaledWrapperHeight * scale)}px`);
  }
  return true;
}

function readPositiveDatasetNumber(element: HTMLElement, key: string): number | undefined {
  const value = Number(element.dataset[key]);
  return Number.isFinite(value) && value > 0 ? value : undefined;
}

function cssPixels(value: string): number {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function cssNumber(value: number): string {
  return Number(value.toFixed(4)).toString();
}

type WritablePptxStyleKey = 'transform' | 'transformOrigin' | 'width' | 'height' | 'marginLeft' | 'marginRight';

function setStyleIfChanged(element: HTMLElement, key: WritablePptxStyleKey, value: string): void {
  if (element.style[key] !== value) {
    element.style[key] = value;
  }
}

function setCssPropertyIfChanged(element: HTMLElement, key: string, value: string): void {
  if (element.style.getPropertyValue(key) !== value) {
    if (value) {
      element.style.setProperty(key, value);
    } else {
      element.style.removeProperty(key);
    }
  }
}

type JQueryWithPptx = ((element: Element) => { pptxToHtml: (options: Record<string, unknown>) => void }) & {
  fn?: { pptxToHtml?: unknown };
};

declare global {
  interface Window {
    jQuery?: JQueryWithPptx;
    $?: JQueryWithPptx;
  }
}

const PPTXJS_ASSET_BASE = '/vendor/pptxjs';
const PPTXJS_STYLES = [`${PPTXJS_ASSET_BASE}/css/pptxjs.css`, `${PPTXJS_ASSET_BASE}/css/nv.d3.min.css`];
const PPTXJS_SCRIPTS = [
  `${PPTXJS_ASSET_BASE}/js/jquery-1.11.3.min.js`,
  `${PPTXJS_ASSET_BASE}/js/jszip.min.js`,
  `${PPTXJS_ASSET_BASE}/js/filereader.js`,
  `${PPTXJS_ASSET_BASE}/js/d3.min.js`,
  `${PPTXJS_ASSET_BASE}/js/nv.d3.min.js`,
  `${PPTXJS_ASSET_BASE}/js/dingbat.js`,
  `${PPTXJS_ASSET_BASE}/js/pptxjs.min.js`,
  `${PPTXJS_ASSET_BASE}/js/divs2slides.min.js`,
];

let pptxJsLoadPromise: Promise<void> | undefined;

function ensurePptxJsLoaded(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('PPTX preview requires a browser.'));
  if (window.jQuery?.fn?.pptxToHtml || window.$?.fn?.pptxToHtml) return Promise.resolve();
  pptxJsLoadPromise ??= (async () => {
    for (const href of PPTXJS_STYLES) {
      loadStylesheetOnce(href);
    }
    for (const src of PPTXJS_SCRIPTS) {
      await loadScriptOnce(src);
    }
  })();
  return pptxJsLoadPromise;
}

function loadStylesheetOnce(href: string): void {
  if (document.querySelector(`link[data-zleap-pptxjs="${cssEscape(href)}"]`)) return;
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = href;
  link.dataset.zleapPptxjs = href;
  document.head.appendChild(link);
}

const scriptLoaders = new Map<string, Promise<void>>();

function loadScriptOnce(src: string): Promise<void> {
  const existing = scriptLoaders.get(src);
  if (existing) return existing;
  const loader = new Promise<void>((resolve, reject) => {
    const alreadyLoaded = document.querySelector(`script[data-zleap-pptxjs="${cssEscape(src)}"]`) as HTMLScriptElement | null;
    if (alreadyLoaded?.dataset.loaded === 'true') {
      resolve();
      return;
    }
    const script = alreadyLoaded ?? document.createElement('script');
    script.src = src;
    script.async = false;
    script.dataset.zleapPptxjs = src;
    script.addEventListener('load', () => {
      script.dataset.loaded = 'true';
      resolve();
    }, { once: true });
    script.addEventListener('error', () => reject(new Error(`Failed to load ${src}`)), { once: true });
    if (!alreadyLoaded) document.body.appendChild(script);
  });
  scriptLoaders.set(src, loader);
  return loader;
}

function cssEscape(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function RawMediaPreview({
  kind,
  path,
  className,
  fullHeight,
}: {
  kind: 'image' | 'pdf' | 'video' | 'audio';
  path: string;
  className?: string;
  fullHeight?: boolean;
}) {
  const { t } = useTranslation();
  const [state, setState] = useState<{ status: 'loading' } | { status: 'ready'; url: string } | { status: 'error'; message: string }>({ status: 'loading' });

  useEffect(() => {
    let cancelled = false;
    let objectUrl: string | undefined;
    setState({ status: 'loading' });
    webApiFetch(rawArtifactUrl(path))
      .then(async (response) => {
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const blob = await response.blob();
        objectUrl = URL.createObjectURL(blob);
        if (!cancelled) setState({ status: 'ready', url: objectUrl });
      })
      .catch((error) => {
        if (!cancelled) setState({ status: 'error', message: error instanceof Error ? error.message : String(error) });
      });
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [path]);

  const frameClass = clsx('flex items-center justify-center rounded-sm border border-border bg-background', fullHeight ? 'h-full' : 'min-h-[360px]', className);
  if (state.status === 'loading') {
    return (
      <div className={frameClass} data-media-kind={kind}>
        {t('preview.loading', { defaultValue: '正在加载预览...' })}
      </div>
    );
  }
  if (state.status === 'error') {
    return <div className={clsx(frameClass, 'px-4 text-sm text-destructive')} data-media-kind={kind}>{state.message}</div>;
  }
  if (kind === 'image') {
    return (
      <div className={clsx('soft-scroll overflow-auto rounded-sm border border-border bg-background', fullHeight ? 'h-full' : 'max-h-[720px]', className)} data-media-kind={kind}>
        <img src={state.url} alt={artifactName(path)} className="mx-auto h-auto max-w-full object-contain" />
      </div>
    );
  }
  if (kind === 'pdf') {
    return <iframe title={t('preview.previewName', { defaultValue: '预览 {{name}}', name: artifactName(path) })} src={state.url} className={clsx('w-full rounded-sm border border-border bg-background', fullHeight ? 'h-full' : 'h-[720px]', className)} data-media-kind={kind} />;
  }
  if (kind === 'video') {
    return <video src={state.url} controls className={clsx('w-full rounded-sm border border-border bg-black', fullHeight ? 'h-full' : 'max-h-[720px]', className)} data-media-kind={kind} />;
  }
  return <audio src={state.url} controls className={clsx('w-full', className)} data-media-kind={kind} />;
}

function rawArtifactUrl(path: string): string {
  return `/api/artifacts/local?path=${encodeURIComponent(path)}&raw=1`;
}

type TextAssetFetcher = (path: string) => Promise<string>;

export async function inlineHtmlAssets(content: string, path: string, fetchAsset: TextAssetFetcher = fetchTextAsset): Promise<string> {
  const withStyles = await replaceAsync(
    content,
    /<link\b([^>]*?)\bhref\s*=\s*(["'])([^"']+)\2([^>]*)>/gi,
    async (match, before: string, _quote: string, href: string, after: string) => {
      const attrs = `${before} ${after}`;
      if (!isRelativeAssetUrl(href) || !isStylesheetLink(attrs, href)) return match;
      try {
        const css = await fetchAsset(resolveSiblingPath(path, href));
        return `<style data-zleap-inlined-asset="${escapeHtmlAttr(href)}">${escapeStyleContent(css)}</style>`;
      } catch {
        return match;
      }
    },
  );

  return replaceAsync(
    withStyles,
    /<script\b([^>]*?)\bsrc\s*=\s*(["'])([^"']+)\2([^>]*)>\s*<\/script>/gi,
    async (match, before: string, _quote: string, src: string, after: string) => {
      if (!isRelativeAssetUrl(src)) return match;
      try {
        const js = await fetchAsset(resolveSiblingPath(path, src));
        const attrs = stripInlineScriptOnlyAttrs(`${before} ${after}`);
        return `<script${attrs} data-zleap-inlined-asset="${escapeHtmlAttr(src)}">${escapeScriptContent(js)}</script>`;
      } catch {
        return match;
      }
    },
  );
}

async function fetchTextAsset(path: string): Promise<string> {
  const response = await webApiFetch(rawArtifactUrl(path));
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

async function replaceAsync(
  input: string,
  pattern: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const matches = [...input.matchAll(pattern)];
  if (!matches.length) return input;

  const parts: string[] = [];
  let lastIndex = 0;
  for (const match of matches) {
    const index = match.index ?? 0;
    parts.push(input.slice(lastIndex, index));
    parts.push(await replacer(...(match as unknown as string[])));
    lastIndex = index + match[0].length;
  }
  parts.push(input.slice(lastIndex));
  return parts.join('');
}

function isStylesheetLink(attrs: string, href: string): boolean {
  return /\brel\s*=\s*(["'])?[^"'>\s]*stylesheet/i.test(attrs) || href.split(/[?#]/, 1)[0]?.toLowerCase().endsWith('.css') === true;
}

function stripInlineScriptOnlyAttrs(attrs: string): string {
  const cleaned = attrs.replace(/\s+(?:async|defer)(?=\s|$)/gi, ' ').replace(/\s+/g, ' ').trim();
  return cleaned ? ` ${cleaned}` : '';
}

function escapeHtmlAttr(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

function escapeStyleContent(value: string): string {
  return value.replace(/<\/style/gi, '<\\/style');
}

function escapeScriptContent(value: string): string {
  return value.replace(/<\/script/gi, '<\\/script');
}

function isRelativeAssetUrl(value: string): boolean {
  const trimmed = value.trim();
  return Boolean(trimmed) && !trimmed.startsWith('#') && !trimmed.startsWith('/') && !trimmed.startsWith('//') && !/^[a-z][a-z0-9+.-]*:/i.test(trimmed);
}

function resolveSiblingPath(filePath: string, relativeUrl: string): string {
  const cleanRelative = relativeUrl.split(/[?#]/, 1)[0] ?? relativeUrl;
  const separator = filePath.includes('\\') ? '\\' : '/';
  const parts = filePath.split(/[\\/]/);
  parts.pop();
  for (const segment of cleanRelative.split(/[\\/]/)) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      if (parts.length > 1) parts.pop();
      continue;
    }
    parts.push(segment);
  }
  return parts.join(separator);
}

function artifactName(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}
