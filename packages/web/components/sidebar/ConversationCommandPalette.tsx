'use client';

import { useTranslation } from 'react-i18next';
import {
  Archive,
  BookOpen,
  Bot,
  Box,
  Boxes,
  Clock,
  Cpu,
  FolderPlus,
  Image as ImageIcon,
  type LucideIcon,
  MessageSquare,
  MessageSquarePlus,
  PlugZap,
  Server,
  Settings,
} from 'lucide-react';
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import type { PageKey } from '@/components/manage/pages';
import type { Conversation } from '@/lib/useConversations';

/** Quick-jump targets — the resource pages reachable from the palette. */
const NAV_ITEMS: Array<{ view: PageKey; icon: LucideIcon; labelKey: string; labelDefault: string }> = [
  { view: 'avatar', icon: Bot, labelKey: 'nav.avatar', labelDefault: '助手' },
  { view: 'space', icon: Boxes, labelKey: 'nav.space', labelDefault: '空间' },
  { view: 'skill', icon: BookOpen, labelKey: 'nav.skill', labelDefault: '技能' },
  { view: 'gateway', icon: Server, labelKey: 'nav.gateway', labelDefault: '网关' },
  { view: 'task', icon: Clock, labelKey: 'nav.task', labelDefault: '任务' },
  { view: 'model', icon: Cpu, labelKey: 'nav.model', labelDefault: '模型' },
  { view: 'tool', icon: PlugZap, labelKey: 'nav.tool', labelDefault: '工具' },
  { view: 'memory', icon: Box, labelKey: 'nav.memory', labelDefault: '记忆' },
  { view: 'artifact', icon: ImageIcon, labelKey: 'nav.artifact', labelDefault: '产物' },
];

/** ⌘K-style command palette: fuzzy-search conversations + run quick commands +
 *  jump to any config page, mirroring the Codex search experience. cmdk owns
 *  the filtering. */
export function ConversationCommandPalette({
  open,
  onOpenChange,
  conversations,
  archivedConversations,
  onSelectConversation,
  onNewChat,
  onOpenSettings,
  onNavigate,
  onCreateProject,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: Conversation[];
  archivedConversations: Conversation[];
  onSelectConversation: (id: string) => void;
  onNewChat: () => void;
  onOpenSettings?: () => void;
  onNavigate?: (view: PageKey) => void;
  onCreateProject?: () => void;
}) {
  const { t } = useTranslation();
  const run = (action: () => void) => {
    onOpenChange(false);
    action();
  };

  return (
    <CommandDialog
      open={open}
      onOpenChange={onOpenChange}
      className="sm:max-w-[560px]"
      title={t('search.title', { defaultValue: '搜索' })}
      description={t('search.placeholder', { defaultValue: '搜索聊天或运行命令' })}
    >
      <Command>
        <CommandInput placeholder={t('search.placeholder', { defaultValue: '搜索聊天或运行命令…' })} />
        <CommandList>
          <CommandEmpty>{t('search.empty', { defaultValue: '无匹配结果' })}</CommandEmpty>

          <CommandGroup heading={t('search.commands', { defaultValue: '命令' })}>
            <CommandItem value="new chat 新对话 newchat" onSelect={() => run(onNewChat)}>
              <MessageSquarePlus />
              <span>{t('common.newChat')}</span>
            </CommandItem>
            {onCreateProject ? (
              <CommandItem value="new project 新建项目 folder" onSelect={() => run(onCreateProject)}>
                <FolderPlus />
                <span>{t('project.new', { defaultValue: '新建项目' })}</span>
              </CommandItem>
            ) : null}
            {onOpenSettings ? (
              <CommandItem value="settings 设置 preferences" onSelect={() => run(onOpenSettings)}>
                <Settings />
                <span>{t('account.settings')}</span>
              </CommandItem>
            ) : null}
          </CommandGroup>

          {onNavigate ? (
            <CommandGroup heading={t('search.navigate', { defaultValue: '前往' })}>
              {NAV_ITEMS.map(({ view, icon: Icon, labelKey, labelDefault }) => {
                const label = t(labelKey, { defaultValue: labelDefault });
                return (
                  <CommandItem key={view} value={`${label} ${view}`} onSelect={() => run(() => onNavigate(view))}>
                    <Icon className="opacity-70" />
                    <span>{label}</span>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          ) : null}

          {conversations.length > 0 ? (
            <CommandGroup heading={t('nav.conversation')}>
              {conversations.map((conv) => (
                <CommandItem
                  key={conv.id}
                  value={`${conv.title} ${conv.id}`}
                  onSelect={() => run(() => onSelectConversation(conv.id))}
                >
                  <MessageSquare className="opacity-60" />
                  <span className="truncate">{conv.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {archivedConversations.length > 0 ? (
            <CommandGroup heading={t('chat.archived', { defaultValue: '已归档' })}>
              {archivedConversations.map((conv) => (
                <CommandItem
                  key={conv.id}
                  value={`${conv.title} ${conv.id} archived 归档`}
                  onSelect={() => run(() => onSelectConversation(conv.id))}
                >
                  <Archive className="opacity-60" />
                  <span className="truncate">{conv.title}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}
        </CommandList>
      </Command>
    </CommandDialog>
  );
}
