'use client';

import clsx from 'clsx';
import { MarkdownView } from './MarkdownView';

/**
 * Assistant prose in the main chat — delegates to the shared markdown renderer.
 */
export function AssistantMessage({ text, streaming = false }: { text: string; streaming?: boolean }) {
  return (
    <MarkdownView
      text={text}
      streaming={streaming}
      className={clsx(streaming && 'md-streaming')}
    />
  );
}
