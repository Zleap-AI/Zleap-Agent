'use client';

import type { ReactNode } from 'react';

/** Small hover-revealed icon action used in sidebar rows (manager + conversation). */
export function RowAction({
  icon,
  title,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={(event) => {
        event.stopPropagation();
        onClick?.();
      }}
      title={title}
      aria-label={title}
      className="flex h-5 w-5 items-center justify-center rounded-sm text-muted-foreground/70 transition hover:bg-background hover:text-foreground"
    >
      {icon}
    </button>
  );
}
