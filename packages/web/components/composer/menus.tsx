'use client';

import { useEffect, useRef, type ReactNode } from 'react';
import {
  ArrowDown,
  ArrowUp,
  Check,
  ChevronDown,
  FolderOpen,
  FolderPlus,
  ListChecks,
  Paperclip,
  Plus,
  Puzzle,
  Shield,
  ShieldCheck,
  Target,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from '../ui/dropdown-menu';
import { Switch } from '../ui/switch';
import { AvatarBadge } from '../AvatarBadge';
import { parseAvatarTheme } from '@/lib/avatars';
import { parseProjectTheme } from '@/lib/projects';
import type { SkillView } from '@/lib/useResources';
import type { RunMode } from '@/lib/runModes';
import { type PermissionMode } from '@/lib/permissions';
import { cn } from '@/lib/utils';
import {
  RUN_MODE_SHORTCUT,
  TOOLBAR_AVATAR_PROPS,
  TOOLBAR_DROPDOWN_CHEVRON,
  TOOLBAR_DROPDOWN_CHIP,
  TOOLBAR_ICON,
  TOOLBAR_ICON_BTN,
  TOOLBAR_ICON_SLOT,
  TOOLBAR_LABEL_CHIP,
} from './toolbar';
import type { AgentOption, ChipOption, ComposerCommand, MentionItem, ProjectOption } from './types';

export function PermissionModeChip({
  mode,
  onChange,
}: {
  mode: PermissionMode;
  onChange?: (mode: PermissionMode) => void;
}) {
  const { t } = useTranslation();
  const fullAccess = mode === 'full_access';
  const Icon = fullAccess ? ShieldCheck : Shield;
  const label = fullAccess ? t('chat.permission.full') : t('chat.permission.approval');

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className={`${TOOLBAR_DROPDOWN_CHIP} max-w-[150px] border border-transparent text-sm ${
            fullAccess
              ? 'bg-warning/10 text-warning hover:bg-warning/15'
              : 'bg-muted/70 text-muted-foreground hover:bg-muted/80 hover:text-foreground'
          }`}
          aria-label={t('chat.permission.aria')}
          title={label}
        >
          <Icon className={TOOLBAR_ICON} strokeWidth={1.9} />
          <span className="truncate font-medium">{label}</span>
          <ChevronDown className={TOOLBAR_DROPDOWN_CHEVRON} strokeWidth={2.5} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-72 p-1.5">
        <PermissionOption
          icon={<Shield className="size-4" strokeWidth={1.9} />}
          title={t('chat.permission.approval')}
          description={t('chat.permission.approvalDesc')}
          selected={!fullAccess}
          onSelect={() => onChange?.('request_approval')}
        />
        <PermissionOption
          icon={<ShieldCheck className="size-4" strokeWidth={1.9} />}
          title={t('chat.permission.full')}
          description={t('chat.permission.fullDesc')}
          selected={fullAccess}
          onSelect={() => onChange?.('full_access')}
        />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function ComposerActionMenu({
  runMode,
  onRunModeChange,
  skills,
  selectedSkill,
  onSkillChange,
  onAddFiles,
}: {
  runMode: RunMode;
  onRunModeChange: (mode: Exclude<RunMode, 'normal'>) => void;
  skills: SkillView[];
  selectedSkill?: SkillView;
  onSkillChange: (id: string | undefined) => void;
  onAddFiles: () => void;
}) {
  const { t } = useTranslation();
  const triggerTitle = `${t('chat.addFile')} / ${t('chat.modeCommand', { defaultValue: '模式' })} · ${RUN_MODE_SHORTCUT} ${t('chat.runModeShortcutHint', { defaultValue: '切换模式' })}`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className={TOOLBAR_ICON_BTN} title={triggerTitle} aria-label={t('chat.addFile')}>
          <Plus className={TOOLBAR_ICON} strokeWidth={1.75} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-48 p-1.5">
        <DropdownMenuItem onClick={onAddFiles} className="gap-2 px-2 py-2">
          <Paperclip className="size-4 text-muted-foreground" strokeWidth={1.75} />
          <span>{t('chat.addPhotoFile', { defaultValue: '添加照片和文件' })}</span>
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <RunModeToggleItem
          icon={<ListChecks className="size-4 text-muted-foreground" strokeWidth={1.75} />}
          label={t('chat.planMode', { defaultValue: '计划模式' })}
          checked={runMode === 'plan'}
          onToggle={() => onRunModeChange('plan')}
        />
        <RunModeToggleItem
          icon={<Target className="size-4 text-muted-foreground" strokeWidth={1.75} />}
          label={t('chat.goalMode', { defaultValue: '追求目标' })}
          checked={runMode === 'goal'}
          onToggle={() => onRunModeChange('goal')}
        />
        <DropdownMenuSeparator />
        <DropdownMenuSub>
          <DropdownMenuSubTrigger className="gap-2 px-2 py-2">
            <Puzzle className="size-4 text-muted-foreground" strokeWidth={1.75} />
            <span className="min-w-0 flex-1 truncate">{t('nav.skill', { defaultValue: '技能' })}</span>
            {selectedSkill ? <span className="max-w-24 truncate text-xs text-muted-foreground">{selectedSkill.label}</span> : null}
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent className="max-h-72 w-56 overflow-y-auto p-1.5">
            {selectedSkill ? (
              <>
                <DropdownMenuItem onClick={() => onSkillChange(undefined)} className="gap-2 px-2 py-2">
                  <X className="size-4 text-muted-foreground" strokeWidth={1.75} />
                  <span>{t('chat.clearSkill', { defaultValue: '不使用技能' })}</span>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
              </>
            ) : null}
            {skills.length > 0 ? (
              skills.map((skill) => (
                <DropdownMenuItem
                  key={skill.id}
                  onClick={() => onSkillChange(skill.id)}
                  className="flex items-start gap-2 px-2 py-2"
                >
                  <Puzzle className="mt-0.5 size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-xs font-medium text-foreground">{skill.label}</span>
                    {skill.description ? <span className="block truncate text-2xs text-muted-foreground">{skill.description}</span> : null}
                  </span>
                  {selectedSkill?.id === skill.id ? <Check className="mt-0.5 size-4 shrink-0 text-foreground" strokeWidth={2.2} /> : null}
                </DropdownMenuItem>
              ))
            ) : (
              <DropdownMenuItem disabled className="px-2 py-2 text-muted-foreground">
                {t('skill.empty', { defaultValue: '还没有技能' })}
              </DropdownMenuItem>
            )}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RunModeToggleItem({
  icon,
  label,
  checked,
  onToggle,
}: {
  icon: ReactNode;
  label: string;
  checked: boolean;
  onToggle: () => void;
}) {
  const { t } = useTranslation();
  return (
    <DropdownMenuItem
      onSelect={(event) => {
        event.preventDefault();
        onToggle();
      }}
      className="flex items-center gap-3 px-2 py-2"
    >
      <span className="flex size-5 shrink-0 items-center justify-center">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-xs font-medium leading-5 text-foreground">{label}</span>
      <Switch
        checked={checked}
        onCheckedChange={onToggle}
        onClick={(event) => event.stopPropagation()}
        aria-label={checked ? t('plan.on', { defaultValue: '已开启' }) : t('plan.off', { defaultValue: '未开启' })}
      />
    </DropdownMenuItem>
  );
}

export function ComposerStatusChip({ icon, label, onClear, title }: { icon: ReactNode; label: string; onClear: () => void; title?: string }) {
  return (
    <span className={`${TOOLBAR_LABEL_CHIP} max-w-[140px] bg-muted/70 text-sm! text-muted-foreground`} title={title}>
      {icon}
      <span className="truncate font-medium">{label}</span>
      <button type="button" onClick={onClear} className="rounded-xs opacity-60 transition hover:opacity-100" aria-label={label}>
        <X className="size-3" />
      </button>
    </span>
  );
}

function PermissionOption({
  icon,
  title,
  description,
  selected,
  onSelect,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <DropdownMenuItem
      onClick={onSelect}
      className="flex items-start gap-3 rounded-md px-2 py-2.5"
    >
      <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center text-muted-foreground">{icon}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-xs font-medium leading-5 text-foreground">{title}</span>
        <span className="block text-2xs leading-4 text-muted-foreground">{description}</span>
      </span>
      {selected ? <Check className="mt-0.5 size-4 shrink-0 text-foreground" strokeWidth={2.2} /> : null}
    </DropdownMenuItem>
  );
}

export function ProjectPickerChip({
  selectedProject,
  projects,
  projectId,
  onProjectChange,
  onCreateProject,
  label,
  variant,
  align,
  className,
}: {
  selectedProject?: ProjectOption;
  projects: ProjectOption[];
  projectId?: string;
  onProjectChange?: (id: string | undefined) => void;
  onCreateProject?: () => void;
  label: string;
  variant: 'icon' | 'label';
  align: 'start' | 'end';
  className?: string;
}) {
  const { t } = useTranslation();
  const projectTheme = selectedProject ? parseProjectTheme(selectedProject) : undefined;
  return (
    <ContextChip
      variant={variant}
      label={label}
      ariaLabel={selectedProject?.name ?? t('chat.selectProject')}
      leading={
        selectedProject ? (
          <AvatarBadge
            name={selectedProject.name}
            emoji={projectTheme?.emoji}
            accent={projectTheme?.accent ?? ''}
            {...TOOLBAR_AVATAR_PROPS}
          />
        ) : (
          <FolderOpen className={`${TOOLBAR_ICON} opacity-70`} strokeWidth={1.75} />
        )
      }
      options={[
        { id: '', name: t('chat.clearProject') },
        ...projects.map((p) => ({ id: p.id, name: p.name, project: p })),
      ]}
      selectedId={projectId ?? ''}
      onSelect={(id) => onProjectChange?.(id || undefined)}
      align={align}
      className={className}
      footer={
        onCreateProject ? (
          <>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={onCreateProject} className="gap-2">
              <FolderPlus className="size-4 text-muted-foreground" strokeWidth={1.75} />
              <span>{t('project.new')}</span>
            </DropdownMenuItem>
          </>
        ) : null
      }
      renderOptionLeading={(option) => {
        if (!option.project) return null;
        const theme = parseProjectTheme(option.project);
        return (
          <AvatarBadge
            name={option.name}
            emoji={theme.emoji}
            accent={theme.accent}
            {...TOOLBAR_AVATAR_PROPS}
          />
        );
      }}
    />
  );
}

export function ContextChip({
  label,
  leading,
  options,
  selectedId,
  onSelect,
  align = 'start',
  className,
  ariaLabel,
  hideChevron,
  variant = 'label',
  renderOptionLeading,
  footer,
}: {
  label: string;
  leading?: ReactNode;
  options: ChipOption[];
  selectedId?: string;
  onSelect: (id: string) => void;
  align?: 'start' | 'end';
  className?: string;
  ariaLabel?: string;
  hideChevron?: boolean;
  variant?: 'icon' | 'label';
  renderOptionLeading?: (option: ChipOption) => ReactNode;
  footer?: ReactNode;
}) {
  const showLabel = label.trim().length > 0;
  const isIcon = variant === 'icon';

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel ?? (showLabel ? label : undefined)}
          className={`${isIcon ? TOOLBAR_DROPDOWN_CHIP : TOOLBAR_LABEL_CHIP} ${className ?? ''}`}
        >
          {isIcon ? <span className={TOOLBAR_ICON_SLOT}>{leading}</span> : leading}
          {showLabel ? <span className="truncate font-normal">{label}</span> : null}
          {hideChevron ? null : <ChevronDown className={TOOLBAR_DROPDOWN_CHEVRON} strokeWidth={2.5} />}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} className="min-w-44">
        {options.map((option) => (
          <DropdownMenuItem
            key={option.id || 'clear'}
            onClick={() => onSelect(option.id)}
            className={option.id === selectedId ? 'font-medium text-foreground' : ''}
          >
            <span className="flex items-center gap-2">
              {renderOptionLeading?.(option)}
              {option.name}
            </span>
          </DropdownMenuItem>
        ))}
        {footer}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function MentionMenu({
  items,
  activeIndex,
  onPick,
  onHover,
}: {
  items: MentionItem[];
  activeIndex: number;
  onPick: (item: MentionItem) => void;
  onHover: (index: number) => void;
}) {
  const { t } = useTranslation();
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="max-h-64 overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-pop backdrop-blur-xl">
      <div className="px-2.5 pb-1 pt-2 text-2xs font-medium leading-none text-muted-foreground/70">
        {t('nav.avatar')}
      </div>
      {items.map((item, index) => (
        <button
          key={item.id}
          ref={(node) => {
            itemRefs.current[index] = node;
          }}
          type="button"
          className={cn(
            'flex min-h-7 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs leading-[18px] transition-colors',
            index === activeIndex ? 'bg-muted/70 text-foreground' : 'text-foreground/90 hover:bg-muted/45',
          )}
          onMouseEnter={() => onHover(index)}
          onMouseDown={(e) => {
            e.preventDefault();
            onPick(item);
          }}
        >
          <AvatarBadge
            name={item.name}
            emoji={parseAvatarTheme(item.agent.metadata).emoji}
            accent={parseAvatarTheme(item.agent.metadata).accent}
            className="size-5"
            letterClassName="text-2xs"
            emojiClassName="text-sm leading-none"
          />
          <span className="truncate text-xs font-normal leading-[18px]">{item.name}</span>
        </button>
      ))}
    </div>
  );
}

export function ComposerCommandMenu({
  items,
  activeIndex,
  onPick,
  onHover,
}: {
  items: ComposerCommand[];
  activeIndex: number;
  onPick: (item: ComposerCommand) => void;
  onHover: (index: number) => void;
}) {
  let lastGroup: string | null = null;
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    itemRefs.current[activeIndex]?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  return (
    <div className="max-h-72 overflow-y-auto rounded-2xl border border-border/70 bg-popover/95 p-1.5 shadow-pop backdrop-blur-xl">
      {items.map((item, index) => {
        const showHeading = item.group !== lastGroup;
        lastGroup = item.group;
        return (
          <div key={item.id}>
            {showHeading ? (
              <div className="px-2.5 pb-1 pt-2 text-2xs font-medium leading-none text-muted-foreground/70">
                {item.group}
              </div>
            ) : null}
            <button
              type="button"
              ref={(node) => {
                itemRefs.current[index] = node;
              }}
              disabled={item.disabled}
              className={cn(
                'flex min-h-7 w-full items-center gap-2 rounded-lg px-2 py-1 text-left text-xs leading-[18px] transition-colors',
                index === activeIndex ? 'bg-muted/70 text-foreground' : 'text-foreground/90 hover:bg-muted/45',
                item.disabled && 'cursor-not-allowed opacity-45 hover:bg-transparent',
              )}
              onMouseEnter={() => onHover(index)}
              onMouseDown={(event) => {
                event.preventDefault();
                onPick(item);
              }}
            >
              <span className="flex size-[18px] shrink-0 items-center justify-center text-muted-foreground/80 [&_svg]:size-3.5">
                {item.icon}
              </span>
              <span className="flex min-w-0 flex-1 items-baseline gap-2">
                <span className="shrink-0 text-xs font-normal leading-[18px] text-foreground/95">{item.label}</span>
                {item.description ? <span className="min-w-0 truncate text-xs leading-[18px] text-muted-foreground/58">{item.description}</span> : null}
              </span>
              {item.trailing ? <span className="max-w-24 truncate text-xs leading-[18px] text-muted-foreground/65">{item.trailing}</span> : null}
              {item.selected ? <Check className="size-3.5 shrink-0 text-foreground/75" strokeWidth={2.25} /> : null}
            </button>
          </div>
        );
      })}
    </div>
  );
}

export type { AgentOption, ChipOption, ComposerCommand, MentionItem, ProjectOption };
