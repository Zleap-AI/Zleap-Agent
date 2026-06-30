'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';

type Initial<T> = T | (() => T);

function resolveInitial<T>(initial: Initial<T>): T {
  return typeof initial === 'function' ? (initial as () => T)() : initial;
}

/**
 * Removes the reset-on-open + submit + toast boilerplate duplicated across every
 * entity dialog (Avatar/Space/Project/Skill/Model/...). Owns the form values, a
 * `busy` flag, resets when the dialog opens, and wraps submit with toast feedback.
 */
export function useEntityFormDialog<T>({
  open,
  initial,
  onSubmit,
  successMessage,
  onSuccess,
}: {
  open: boolean;
  initial: Initial<T>;
  onSubmit: (values: T) => Promise<void> | void;
  successMessage?: string;
  onSuccess?: () => void;
}) {
  const initialRef = useRef(initial);
  initialRef.current = initial;

  const [values, setValues] = useState<T>(() => resolveInitial(initial));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setValues(resolveInitial(initialRef.current));
      setBusy(false);
    }
  }, [open]);

  const patch = useCallback((partial: Partial<T>) => {
    setValues((prev) => ({ ...prev, ...partial }));
  }, []);

  const submit = useCallback(
    async (event?: { preventDefault?: () => void }) => {
      event?.preventDefault?.();
      if (busy) return false;
      setBusy(true);
      try {
        await onSubmit(values);
        if (successMessage) toast.success(successMessage);
        onSuccess?.();
        return true;
      } catch (error) {
        toast.error(error instanceof Error ? error.message : String(error));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [busy, onSubmit, onSuccess, successMessage, values],
  );

  return { values, setValues, patch, busy, submit };
}
