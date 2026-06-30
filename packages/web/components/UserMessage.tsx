'use client';

import { Maximize2 } from 'lucide-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { ChatImageAttachment } from '../lib/chatAttachments';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from './ui/dialog';

export function UserMessage({ text, attachments = [] }: { text: string; attachments?: ChatImageAttachment[] }) {
  const { t } = useTranslation();
  const [previewAttachment, setPreviewAttachment] = useState<ChatImageAttachment | null>(null);

  return (
    <div className="flex justify-end">
      <div className="flex max-w-[min(82%,560px)] flex-col items-end gap-2">
        {attachments.length ? (
          <div className="flex max-w-[min(220px,52vw)] flex-wrap justify-end gap-1.5">
            {attachments.map((attachment) => (
              <button
                key={attachment.id}
                type="button"
                aria-label={t('chat.zoomImage', { defaultValue: '放大图片：{{name}}', name: attachment.name })}
                className="group relative size-20 cursor-zoom-in overflow-hidden rounded-lg border border-border/80 bg-card p-0 shadow-sm transition hover:border-border hover:shadow-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/30"
                onClick={() => setPreviewAttachment(attachment)}
              >
                <img
                  src={attachment.thumbnailDataUrl}
                  alt={attachment.name}
                  className="h-full w-full bg-muted object-cover transition duration-[var(--duration-fast)] group-hover:scale-[1.02]"
                />
                <span className="pointer-events-none absolute inset-0 flex items-center justify-center bg-black/0 opacity-0 transition duration-[var(--duration-fast)] group-hover:bg-black/20 group-hover:opacity-100 group-focus-visible:bg-black/20 group-focus-visible:opacity-100">
                  <Maximize2 className="size-5 text-white drop-shadow" aria-hidden="true" />
                </span>
              </button>
            ))}
          </div>
        ) : null}
        {text ? (
          <div className="max-w-full rounded-lg rounded-br-sm bg-accent-grad px-4 py-2.5 text-sm leading-7 text-white shadow-sm whitespace-pre-wrap wrap-break-word">
            {text}
          </div>
        ) : null}
      </div>
      {previewAttachment ? (
        <ImagePreviewDialog
          attachment={previewAttachment}
          open={Boolean(previewAttachment)}
          onOpenChange={(open) => {
            if (!open) setPreviewAttachment(null);
          }}
        />
      ) : null}
    </div>
  );
}

export function ImagePreviewDialog({
  attachment,
  open,
  onOpenChange,
}: {
  attachment: ChatImageAttachment | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  if (!attachment) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="grid h-[min(900px,calc(100dvh-48px))] !w-[calc(100vw-32px)] !max-w-[calc(100vw-32px)] grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0 sm:!w-[calc(100vw-48px)] sm:!max-w-[min(1100px,calc(100vw-48px))]">
        <DialogHeader className="border-b border-border px-5 py-4 pr-12">
          <DialogTitle className="truncate text-sm">{attachment.name}</DialogTitle>
          <DialogDescription className="truncate text-xs">
            {attachment.mimeType} · {formatBytes(attachment.sizeBytes)}
          </DialogDescription>
        </DialogHeader>
        <div className="flex min-h-0 items-center justify-center bg-black/90 p-3 sm:p-6">
          <img
            src={attachment.previewDataUrl || attachment.thumbnailDataUrl}
            alt={attachment.name}
            className="h-full w-full object-contain drop-shadow-2xl"
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  const kilobytes = bytes / 1024;
  if (kilobytes < 1024) return `${kilobytes.toFixed(kilobytes >= 10 ? 0 : 1)} KB`;
  const megabytes = kilobytes / 1024;
  return `${megabytes.toFixed(megabytes >= 10 ? 0 : 1)} MB`;
}
