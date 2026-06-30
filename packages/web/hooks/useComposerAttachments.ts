'use client';

import { useCallback, useEffect, useMemo, useReducer, useRef } from 'react';
import { toast } from 'sonner';
import type { TFunction } from 'i18next';
import {
  createImageAttachmentId,
  fileToImageRequestAttachment,
  validateImageAttachmentFiles,
  type ChatImageRequestAttachment,
  type ImageAttachmentValidationError,
} from '@/lib/chatAttachments';

export type ComposerImageAttachment = {
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
  previewUrl: string;
} & (
  | { status: 'pending' }
  | { status: 'ready'; attachment: ChatImageRequestAttachment }
  | { status: 'error'; message: string }
);

type AttachmentState = {
  items: ComposerImageAttachment[];
  pendingErrors: ImageAttachmentValidationError[];
};

type AttachmentAction =
  | { type: 'appendPending'; items: ComposerImageAttachment[]; errors?: ImageAttachmentValidationError[] }
  | { type: 'markReady'; id: string; attachment: ChatImageRequestAttachment }
  | { type: 'markError'; id: string; message: string }
  | { type: 'remove'; id: string }
  | { type: 'clear' }
  | { type: 'clearErrors' };

const initialState: AttachmentState = { items: [], pendingErrors: [] };

function reducer(state: AttachmentState, action: AttachmentAction): AttachmentState {
  switch (action.type) {
    case 'appendPending':
      return {
        items: [...state.items, ...action.items],
        pendingErrors: [...state.pendingErrors, ...(action.errors ?? [])],
      };
    case 'markReady':
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === action.id ? { ...item, status: 'ready', attachment: action.attachment } : item,
        ),
      };
    case 'markError':
      return {
        ...state,
        items: state.items.map((item) =>
          item.id === action.id ? { ...item, status: 'error', message: action.message } : item,
        ),
      };
    case 'remove':
      return { ...state, items: state.items.filter((item) => item.id !== action.id) };
    case 'clear':
      return initialState;
    case 'clearErrors':
      return state.pendingErrors.length === 0 ? state : { ...state, pendingErrors: [] };
    default:
      return state;
  }
}

/**
 * Owns the composer image-attachment lifecycle: validation, object-URL previews
 * (created + reliably revoked), async base64 conversion, and toast feedback for
 * validation errors. Extracted from `Composer` to shrink the god-component.
 */
export function useComposerAttachments(t: TFunction, onAdded?: () => void) {
  const [state, dispatch] = useReducer(reducer, initialState);
  const previewUrlsRef = useRef<Set<string>>(new Set());

  const attachments = state.items;
  const readyAttachments = useMemo(
    () => attachments.flatMap((item) => (item.status === 'ready' ? [item.attachment] : [])),
    [attachments],
  );
  const preparing = attachments.some((item) => item.status === 'pending');
  const failed = attachments.some((item) => item.status === 'error');

  const showErrors = useCallback(
    (errors: ImageAttachmentValidationError[]) => {
      for (const error of errors) {
        const label = error.fileName || t('chat.imageAttachmentFallbackName', { defaultValue: '图片' });
        if (error.code === 'unsupported_type') {
          toast.error(t('chat.imageUnsupported', { defaultValue: `不支持的图片类型：${label}` }));
        }
        if (error.code === 'too_large') {
          toast.error(t('chat.imageTooLarge', { defaultValue: `图片超过 10 MB：${label}` }));
        }
        if (error.code === 'too_many') {
          toast.error(t('chat.imageTooMany', { defaultValue: '每条消息最多添加 4 张图片' }));
        }
      }
    },
    [t],
  );

  useEffect(() => {
    if (state.pendingErrors.length === 0) return;
    showErrors(state.pendingErrors);
    dispatch({ type: 'clearErrors' });
  }, [state.pendingErrors, showErrors]);

  const revokePreviewUrl = useCallback((url: string) => {
    URL.revokeObjectURL(url);
    previewUrlsRef.current.delete(url);
  }, []);

  const clearPreviews = useCallback(() => {
    for (const url of previewUrlsRef.current) {
      URL.revokeObjectURL(url);
    }
    previewUrlsRef.current.clear();
  }, []);

  useEffect(() => () => clearPreviews(), [clearPreviews]);

  const removeAttachment = useCallback(
    (id: string) => {
      const item = attachments.find((attachment) => attachment.id === id);
      if (item) revokePreviewUrl(item.previewUrl);
      dispatch({ type: 'remove', id });
    },
    [attachments, revokePreviewUrl],
  );

  const clearAttachments = useCallback(() => {
    clearPreviews();
    dispatch({ type: 'clear' });
  }, [clearPreviews]);

  const addImageFiles = useCallback(
    async (files: File[]) => {
      const validation = validateImageAttachmentFiles(files, attachments.length);
      if (validation.files.length === 0) {
        dispatch({ type: 'appendPending', items: [], errors: validation.errors });
        return;
      }
      const pendingItems = validation.files.map((file): ComposerImageAttachment => {
        const id = createImageAttachmentId();
        const previewUrl = URL.createObjectURL(file);
        previewUrlsRef.current.add(previewUrl);
        return {
          id,
          name: file.name || t('chat.imageAttachmentFallbackName', { defaultValue: '图片' }),
          mimeType: file.type,
          sizeBytes: file.size,
          previewUrl,
          status: 'pending',
        };
      });
      dispatch({ type: 'appendPending', items: pendingItems, errors: validation.errors });
      await Promise.all(
        pendingItems.map(async (item, index) => {
          const file = validation.files[index];
          if (!file) return;
          try {
            const attachment = await fileToImageRequestAttachment(file, item.id);
            dispatch({ type: 'markReady', id: item.id, attachment });
          } catch {
            dispatch({ type: 'markError', id: item.id, message: t('chat.imageReadFailed', { defaultValue: '读取图片失败' }) });
          }
        }),
      );
      onAdded?.();
    },
    [attachments.length, onAdded, t],
  );

  return { attachments, readyAttachments, preparing, failed, addImageFiles, removeAttachment, clearAttachments };
}
