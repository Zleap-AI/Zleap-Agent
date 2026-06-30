'use client';

import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import {
  ArrowLeft,
  Box,
  ChevronRight,
  Cpu,
  Globe,
  Image as ImageIcon,
  Moon,
  PlugZap,
  Settings,
  Sun,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DeleteConfirmDialog } from '@/components/ui/delete-confirm-dialog';
import { useLanguage } from '@/lib/i18n/useLanguage';
import { useTheme } from '@/lib/theme';
import type { Resources } from '@/lib/useResources';
import type { PageKey } from './manage/pages';

type SettingsPageProps = {
  resources: Resources;
  onBack: () => void;
  onNavigate: (view: PageKey) => void;
  onClearRecords: () => Promise<{ removedCount?: number; history?: { removedCount?: number }; database?: { enabled?: boolean; tablesCleared?: number } } | void>;
};

type SettingLink = {
  key: PageKey;
  icon: LucideIcon;
  titleKey: string;
  descKey: string;
};

const MANAGEMENT_LINKS: SettingLink[] = [
  { key: 'model', icon: Cpu, titleKey: 'nav.model', descKey: 'settings.modelDesc' },
  { key: 'tool', icon: PlugZap, titleKey: 'nav.tool', descKey: 'settings.toolDesc' },
  { key: 'memory', icon: Box, titleKey: 'nav.memory', descKey: 'settings.memoryDesc' },
  { key: 'artifact', icon: ImageIcon, titleKey: 'nav.artifact', descKey: 'settings.artifactDesc' },
];

export function SettingsPage({
  resources,
  onBack,
  onNavigate,
  onClearRecords,
}: SettingsPageProps) {
  const { t } = useTranslation();
  const { theme, toggle: toggleTheme } = useTheme();
  const { lang, toggle: toggleLanguage } = useLanguage();
  const [clearOpen, setClearOpen] = useState(false);
  const counts: Partial<Record<PageKey, number>> = {
    model: resources.models.length,
    tool: resources.tools.length,
  };

  const clearRecords = async () => {
    const result = await onClearRecords();
    toast.success(
      t('settings.clearRecordsDone', {
        count: result?.history?.removedCount ?? result?.removedCount ?? 0,
        tables: result?.database?.tablesCleared ?? 0,
      }),
    );
  };

  return (
    <div className="soft-scroll h-full overflow-y-auto">
      <DeleteConfirmDialog
        open={clearOpen}
        onOpenChange={setClearOpen}
        title={t('settings.clearRecords')}
        description={t('settings.clearRecordsConfirm')}
        confirmLabel={t('settings.clearRecordsConfirmButton')}
        onConfirm={clearRecords}
      />
      <div className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-background/85 px-5 py-3 backdrop-blur">
        <Button variant="ghost" size="icon-sm" onClick={onBack} title={t('common.back')} aria-label={t('common.back')}>
          <ArrowLeft className="size-4" />
        </Button>
        <span className="flex size-8 items-center justify-center rounded-lg bg-accent-soft text-primary">
          <Settings className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-foreground">{t('settings.title')}</div>
          <div className="truncate text-xs text-muted-foreground">{t('settings.subtitle')}</div>
        </div>
      </div>

      <div className="mx-auto max-w-3xl px-6 py-8">
        <SectionTitle>{t('settings.preferences')}</SectionTitle>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <SettingRow
            icon={theme === 'dark' ? Moon : Sun}
            title={t('account.theme')}
            description={t('settings.themeDesc')}
            value={theme === 'dark' ? t('account.dark') : t('account.light')}
            onClick={toggleTheme}
          />
          <Divider />
          <SettingRow
            icon={Globe}
            title={t('account.language')}
            description={t('settings.languageDesc')}
            value={lang === 'zh' ? '中文' : 'English'}
            onClick={toggleLanguage}
          />
        </div>

        <SectionTitle>{t('settings.management')}</SectionTitle>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          {MANAGEMENT_LINKS.map((item, index) => (
            <div key={item.key}>
              <SettingRow
                icon={item.icon}
                title={t(item.titleKey)}
                description={t(item.descKey)}
                value={counts[item.key] == null ? undefined : t('settings.count', { count: counts[item.key] })}
                onClick={() => onNavigate(item.key)}
                trailing={<ChevronRight className="size-4 text-muted-foreground/70" />}
              />
              {index < MANAGEMENT_LINKS.length - 1 ? <Divider /> : null}
            </div>
          ))}
        </div>

        <SectionTitle>{t('settings.records')}</SectionTitle>
        <div className="overflow-hidden rounded-lg border border-border bg-card">
          <SettingRow
            icon={Trash2}
            title={t('settings.clearRecords')}
            description={t('settings.clearRecordsDesc')}
            onClick={() => setClearOpen(true)}
            destructive
          />
        </div>
      </div>
    </div>
  );
}

function SectionTitle({ children }: { children: ReactNode }) {
  return <div className="mb-3 mt-7 text-sm font-semibold text-foreground first:mt-0">{children}</div>;
}

function Divider() {
  return <div className="ml-12 h-px bg-border" />;
}

function SettingRow({
  icon: Icon,
  title,
  description,
  value,
  onClick,
  trailing,
  destructive,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  value?: string;
  onClick: () => void;
  trailing?: ReactNode;
  destructive?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex min-h-14 w-full items-center gap-3 px-4 py-3 text-left transition hover:bg-muted/65"
    >
      <span
        className={[
          'flex size-8 shrink-0 items-center justify-center rounded-md bg-muted group-hover:text-foreground',
          destructive ? 'text-destructive' : 'text-muted-foreground',
        ].join(' ')}
      >
        <Icon className="size-4" />
      </span>
      <span className="min-w-0 flex-1">
        <span className={['block truncate text-sm font-medium', destructive ? 'text-destructive' : 'text-foreground'].join(' ')}>{title}</span>
        <span className="block truncate text-xs text-muted-foreground">{description}</span>
      </span>
      {value ? <span className="shrink-0 text-xs text-muted-foreground">{value}</span> : null}
      {trailing}
    </button>
  );
}
