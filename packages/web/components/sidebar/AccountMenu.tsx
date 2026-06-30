'use client';

import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'framer-motion';
import { EASE_OUT } from "@/lib/motion";
import { Info, MoreHorizontal, Settings } from 'lucide-react';
import clsx from 'clsx';
import { useTranslation } from 'react-i18next';

const ABOUT_URL = 'https://github.com/Zleap-AI/Zleap-Agent/';

export function AccountMenu({
  compact,
  model,
  active,
  onOpenSettings,
}: {
  compact: boolean;
  model: string;
  active?: boolean;
  onOpenSettings?: () => void;
}) {
  const { t } = useTranslation();
  const [menuOpen, setMenuOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const openAbout = () => {
    window.open(ABOUT_URL, '_blank', 'noopener,noreferrer');
    setMenuOpen(false);
  };

  const cancelClose = () => {
    if (closeTimer.current) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setMenuOpen(false), 140);
  };

  useEffect(() => () => cancelClose(), []);

  return (
    <div
      className="relative shrink-0 border-t border-border p-2.5"
      onMouseEnter={() => {
        cancelClose();
        setMenuOpen(true);
      }}
      onMouseLeave={scheduleClose}
    >
      <AnimatePresence>
        {menuOpen ? (
          <motion.div
            initial={{ opacity: 0, y: 8, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ duration: 0.18, ease: EASE_OUT }}
            className={clsx(
              'absolute z-50 w-56 overflow-hidden rounded-lg border border-border bg-popover p-1.5 shadow-lg',
              compact ? 'bottom-2 left-full ml-2' : 'bottom-full left-2.5 right-2.5 mb-2',
            )}
          >
            <MenuItem icon={<Settings className="h-4 w-4" />} label={t('account.settings')} active={active} onClick={onOpenSettings} />
            <MenuItem icon={<Info className="h-4 w-4" />} label={t('account.about')} onClick={openAbout} />
            <div className="px-2 pt-1 font-mono text-2xs text-muted-foreground/70">{model}</div>
          </motion.div>
        ) : null}
      </AnimatePresence>

      <button
        type="button"
        onClick={() => setMenuOpen((v) => !v)}
        className={clsx(
          'flex w-full items-center rounded-sm text-sm transition outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
          compact ? 'h-9 justify-center' : 'gap-2.5 px-2 py-1.5',
          menuOpen || active ? 'bg-muted' : 'hover:bg-muted',
        )}
        title={t('account.settings')}
      >
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
          <Settings className="h-4 w-4" />
        </span>
        {!compact ? (
          <>
            <span className="truncate font-medium text-foreground">{t('account.settings')}</span>
            <MoreHorizontal className="ml-auto h-4 w-4 shrink-0 text-muted-foreground/70" />
          </>
        ) : null}
      </button>
    </div>
  );
}

function MenuItem({
  icon,
  label,
  active,
  onClick,
}: {
  icon: ReactNode;
  label: string;
  active?: boolean;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={clsx(
        'flex w-full items-center gap-2.5 rounded-sm px-2 py-1.5 text-sm transition outline-none focus-visible:ring-2 focus-visible:ring-ring/40',
        active ? 'bg-muted text-foreground' : 'text-muted-foreground hover:bg-muted hover:text-foreground',
      )}
    >
      <span className="shrink-0">{icon}</span>
      <span>{label}</span>
    </button>
  );
}
