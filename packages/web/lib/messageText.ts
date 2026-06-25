const ESCAPED_NEWLINE_RE = /\\n/g;

export function normalizeAssistantDisplayText(text: string | undefined): string {
  const value = text ?? '';
  const decoded = shouldDecodeEscapedMarkdown(value)
    ? value
      .replace(/\\r\\n/g, '\n')
      .replace(/\\n/g, '\n')
      .replace(/\\t/g, '\t')
    : value;
  return sanitizeDisplayText(decoded);
}

export function sanitizeDisplayText(text: string | undefined, fallback = ''): string {
  const value = (text ?? '').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (!value) {
    return fallback;
  }
  const lines = value.split(/\r?\n/);
  const kept = lines.filter((line) => !isMojibakeLine(line));
  const cleaned = kept.join('\n');
  return cleaned.trim() ? cleaned : fallback;
}

function isMojibakeLine(line: string): boolean {
  const compact = line.replace(/\s+/g, '');
  if (!compact) {
    return false;
  }
  const replacementCount = (compact.match(/\uFFFD/g) ?? []).length;
  if (replacementCount >= 3) {
    return true;
  }
  if (replacementCount > 0 && replacementCount / compact.length > 0.08) {
    return true;
  }
  const suspiciousRuns = compact.match(/[^\p{L}\p{N}\p{P}\p{S}\p{Zs}]{2,}/gu);
  return Boolean(suspiciousRuns?.length);
}

function shouldDecodeEscapedMarkdown(text: string): boolean {
  const newlineEscapes = text.match(ESCAPED_NEWLINE_RE)?.length ?? 0;
  if (newlineEscapes < 2) {
    return false;
  }
  if (/\\n(?:#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|)/.test(text)) {
    return true;
  }
  return newlineEscapes >= 4 && /(?:#{1,6}\s|[-*+]\s|\*\*|Report|Analysis|Summary|Findings|Conclusion)/i.test(text);
}
