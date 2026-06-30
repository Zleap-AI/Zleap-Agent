'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { AnimatePresence, motion } from 'framer-motion';
import { SPRING_PANEL } from "@/lib/motion";
import { BookText, Brain, ChevronRight, Code2, DatabaseZap, Gauge, Layers, MessagesSquare, RefreshCw, X } from 'lucide-react';
import type { ContextBlock, ContextBlockCategory, ContextBlockSub, ContextSnapshot } from '../lib/engine';
import { cn } from '@/lib/utils';
import { IconButton } from '@/components/ui/icon-button';

/**
 * Context-window transparency panel. Visualizes the MAIN context that the engine
 * assembles each turn, grouped by where it is actually sent (system prefix /
 * memory injection / conversation history): each block shows its storage, meaning,
 * window placement (system prompt / message prefix / per-turn message), and token
 * stats, with a full assembled preview. Data comes from the SSE `context` snapshot
 * (conversationRuntime → WorkbenchSnapshot.contextSnapshot).
 */

type CategoryMeta = { label: string; desc: string; dot: string; bar: string; text: string; Icon: typeof BookText };
type InspectorTab = 'stats' | 'preview';
type ContextInspectorModel = { id?: string; label: string; contextWindow?: number };
type OrderedSection = { key: string; category: ContextBlockCategory; rows: ContextBlock[]; tokens: number };
type BlockDisplayMeta = { label: string; meaning: string; storage: string };

const CATEGORY: Record<ContextBlockCategory, CategoryMeta> = {
  system: {
    label: 'inspector.cat.system.label',
    desc: 'inspector.cat.system.desc',
    dot: 'bg-primary',
    bar: 'bg-primary/70',
    text: 'text-primary',
    Icon: BookText,
  },
  skill: {
    label: 'inspector.cat.skill.label',
    desc: 'inspector.cat.skill.desc',
    dot: 'bg-chart-1',
    bar: 'bg-chart-1/70',
    text: 'text-chart-1',
    Icon: Layers,
  },
  memory: {
    label: 'inspector.cat.memory.label',
    desc: 'inspector.cat.memory.desc',
    dot: 'bg-chart-2',
    bar: 'bg-chart-2/70',
    text: 'text-chart-2',
    Icon: Brain,
  },
  cache: {
    label: 'inspector.cat.cache.label',
    desc: 'inspector.cat.cache.desc',
    dot: 'bg-chart-3',
    bar: 'bg-chart-3/70',
    text: 'text-chart-3',
    Icon: DatabaseZap,
  },
  history: {
    label: 'inspector.cat.history.label',
    desc: 'inspector.cat.history.desc',
    dot: 'bg-chart-4',
    bar: 'bg-chart-4/70',
    text: 'text-chart-4',
    Icon: MessagesSquare,
  },
};

const SYSTEM_BLOCK_ORDER: ContextBlockSub[] = [
  'persona',
  'sessionPersona',
  'workspacePrompt',
  'toolGuidance',
  'memoryInstruction',
  'spaceCatalog',
  'skillGuide',
  'impressions',
  'projectSnapshot',
  'loopDiscipline',
];

const BLOCK_DISPLAY = {
  persona: { label: 'inspector.blk.persona.label', meaning: 'inspector.blk.persona.meaning', storage: 'inspector.blk.persona.storage' },
  sessionPersona: { label: 'inspector.blk.sessionPersona.label', meaning: 'inspector.blk.sessionPersona.meaning', storage: 'inspector.blk.sessionPersona.storage' },
  memoryInstruction: { label: 'inspector.blk.memoryInstruction.label', meaning: 'inspector.blk.memoryInstruction.meaning', storage: 'inspector.blk.memoryInstruction.storage' },
  listMemory: { label: 'inspector.blk.listMemory.label', meaning: 'inspector.blk.listMemory.meaning', storage: 'inspector.blk.listMemory.storage' },
  listCache: { label: 'inspector.blk.listCache.label', meaning: 'inspector.blk.listCache.meaning', storage: 'inspector.blk.listCache.storage' },
  readCache: { label: 'inspector.blk.readCache.label', meaning: 'inspector.blk.readCache.meaning', storage: 'inspector.blk.readCache.storage' },
  timeGuidance: { label: 'inspector.blk.timeGuidance.label', meaning: 'inspector.blk.timeGuidance.meaning', storage: 'inspector.blk.timeGuidance.storage' },
  spaceCatalog: { label: 'inspector.blk.spaceCatalog.label', meaning: 'inspector.blk.spaceCatalog.meaning', storage: 'inspector.blk.spaceCatalog.storage' },
  skillGuide: { label: 'inspector.blk.skillGuide.label', meaning: 'inspector.blk.skillGuide.meaning', storage: 'inspector.blk.skillGuide.storage' },
  listSkills: { label: 'inspector.blk.listSkills.label', meaning: 'inspector.blk.listSkills.meaning', storage: 'inspector.blk.listSkills.storage' },
  readSkill: { label: 'inspector.blk.readSkill.label', meaning: 'inspector.blk.readSkill.meaning', storage: 'inspector.blk.readSkill.storage' },
  workspacePrompt: { label: 'inspector.blk.workspacePrompt.label', meaning: 'inspector.blk.workspacePrompt.meaning', storage: 'inspector.blk.workspacePrompt.storage' },
  toolGuidance: { label: 'inspector.blk.toolGuidance.label', meaning: 'inspector.blk.toolGuidance.meaning', storage: 'inspector.blk.toolGuidance.storage' },
  activeSkills: { label: 'inspector.blk.activeSkills.label', meaning: 'inspector.blk.activeSkills.meaning', storage: 'inspector.blk.activeSkills.storage' },
  suggestedSkills: { label: 'inspector.blk.suggestedSkills.label', meaning: 'inspector.blk.suggestedSkills.meaning', storage: 'inspector.blk.suggestedSkills.storage' },
  experiences: { label: 'inspector.blk.experiences.label', meaning: 'inspector.blk.experiences.meaning', storage: 'inspector.blk.experiences.storage' },
  impressions: { label: 'inspector.blk.impressions.label', meaning: 'inspector.blk.impressions.meaning', storage: 'inspector.blk.impressions.storage' },
  projectSnapshot: { label: 'inspector.blk.projectSnapshot.label', meaning: 'inspector.blk.projectSnapshot.meaning', storage: 'inspector.blk.projectSnapshot.storage' },
  loopDiscipline: { label: 'inspector.blk.loopDiscipline.label', meaning: 'inspector.blk.loopDiscipline.meaning', storage: 'inspector.blk.loopDiscipline.storage' },
  items: { label: 'inspector.blk.items.label', meaning: 'inspector.blk.items.meaning', storage: 'inspector.blk.items.storage' },
  recall: { label: 'inspector.blk.recall.label', meaning: 'inspector.blk.recall.meaning', storage: 'inspector.blk.recall.storage' },
  messages: { label: 'inspector.blk.messages.label', meaning: 'inspector.blk.messages.meaning', storage: 'inspector.blk.messages.storage' },
  currentTurn: { label: 'inspector.blk.currentTurn.label', meaning: 'inspector.blk.currentTurn.meaning', storage: 'inspector.blk.currentTurn.storage' },
} satisfies Record<ContextBlockSub, BlockDisplayMeta>;

const NUMBER_FORMAT = new Intl.NumberFormat('en-US');

function displayCategory(block: ContextBlock): ContextBlockCategory {
  if (block.category === 'skill') {
    return 'skill';
  }
  if (block.kind === 'system') {
    return 'system';
  }
  if (block.category === 'history') {
    return 'history';
  }
  if (block.category === 'cache') {
    return 'cache';
  }
  return 'memory';
}

function buildOrderedSections(blocks: ContextBlock[]): OrderedSection[] {
  const sections: OrderedSection[] = [];
  for (const block of blocks) {
    const category = displayCategory(block);
    const last = sections[sections.length - 1];
    if (!last || last.category !== category) {
      sections.push({ key: `${category}-${sections.length}`, category, rows: [block], tokens: block.tokens });
      continue;
    }
    last.rows.push(block);
    last.tokens += block.tokens;
  }
  return sections.map((section) => ({
    ...section,
    rows: orderRows(section.category, section.rows),
  }));
}

function buildCategoryTotals(blocks: ContextBlock[]): OrderedSection[] {
  const totals: OrderedSection[] = [];
  for (const block of blocks) {
    const category = displayCategory(block);
    const total = totals.find((item) => item.category === category);
    if (total) {
      total.rows.push(block);
      total.tokens += block.tokens;
    } else {
      totals.push({ key: category, category, rows: [block], tokens: block.tokens });
    }
  }
  return totals;
}

function totalForCategory(totals: OrderedSection[], category: ContextBlockCategory): number {
  return totals.find((item) => item.category === category)?.tokens ?? 0;
}

function orderRows(category: ContextBlockCategory, rows: ContextBlock[]): ContextBlock[] {
  if (category !== 'system') {
    return rows;
  }
  return [...rows].sort((a, b) => blockOrderIndex(a.sub) - blockOrderIndex(b.sub));
}

function blockOrderIndex(sub: ContextBlockSub): number {
  const index = SYSTEM_BLOCK_ORDER.indexOf(sub);
  return index === -1 ? SYSTEM_BLOCK_ORDER.length : index;
}

function blockDisplay(block: ContextBlock): BlockDisplayMeta {
  return BLOCK_DISPLAY[block.sub] ?? { label: block.label, meaning: block.meaning, storage: block.storage };
}

function fmt(n: number): string {
  return NUMBER_FORMAT.format(Math.max(0, Math.round(n)));
}

function fmtCompact(n: number): string {
  const rounded = Math.max(0, Math.round(n));
  if (rounded >= 1_000_000) {
    const value = rounded / 1_000_000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}m`;
  }
  if (rounded >= 10_000) {
    return `${Math.round(rounded / 1_000)}k`;
  }
  if (rounded >= 1_000) {
    const value = rounded / 1_000;
    return `${Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1)}k`;
  }
  return fmt(rounded);
}

function fmtPct(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/** Window-usage trigger chip; opens the inspector drawer. */
export function ContextInspectorChip({
  snapshot,
  model,
  variant = 'icon',
  className,
  open,
  onOpenChange,
}: {
  snapshot: ContextSnapshot | null;
  model?: ContextInspectorModel;
  variant?: 'icon' | 'composer';
  className?: string;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const { t } = useTranslation();
  const [internalOpen, setInternalOpen] = useState(false);
  const drawerOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const effectiveSnapshot = snapshot ?? createEmptySnapshot(t('inspector.currentModel', { defaultValue: '当前模型' }), model);
  const isLiveSnapshot = Boolean(snapshot);
  const ratio = effectiveSnapshot.window.ratio;
  const pct = ratio != null ? Math.round(ratio * 100) : null;
  const remainingPct = pct != null ? Math.max(0, 100 - pct) : null;
  const hot = pct != null && pct >= 80;
  const tokens = fmt(effectiveSnapshot.window.usedTokens);
  const compactUsed = fmtCompact(effectiveSnapshot.window.usedTokens);
  const compactTotal = effectiveSnapshot.window.contextWindow ? fmtCompact(effectiveSnapshot.window.contextWindow) : null;
  const usedPart = pct != null
    ? `${t('inspector.bgUsedPct', { defaultValue: '{{pct}}% 已用', pct })}${remainingPct != null ? t('inspector.bgRemaining', { defaultValue: '（剩余 {{pct}}%）', pct: remainingPct }) : ''}`
    : t('inspector.bgUsedTokens', { defaultValue: '{{tokens}} 已用', tokens: compactUsed });
  const backgroundTitle = `${t('inspector.bgPrefix', { defaultValue: '背景信息窗口' })}：${usedPart}；${t('inspector.bgCurrentContext', { defaultValue: '当前上下文 {{tokens}} 标记', tokens: compactUsed })}${compactTotal ? t('inspector.bgModelSetting', { defaultValue: '，模型设置 {{total}}', total: compactTotal }) : ''}${isLiveSnapshot ? '' : t('inspector.bgNoSnapshot', { defaultValue: '；暂无运行快照' })}`;
  const title = isLiveSnapshot
    ? pct != null
      ? t('inspector.titlePct', { defaultValue: '上下文窗口 · {{tokens}} tok · {{pct}}%', tokens, pct })
      : t('inspector.titleNoPct', { defaultValue: '上下文窗口 · {{tokens}} tok', tokens })
    : t('inspector.noSnapshotTitle', { defaultValue: '上下文窗口 · 尚未生成运行快照' });

  const button =
    variant === 'composer' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={backgroundTitle}
        aria-label={backgroundTitle}
        className={cn(
          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-muted-foreground transition-colors hover:bg-muted/70 hover:text-foreground',
          isLiveSnapshot ? 'text-muted-foreground' : 'text-muted-foreground/60',
          hot && 'text-warning hover:bg-warning/10 hover:text-warning',
          className,
        )}
      >
        <span
          className="relative size-3 rounded-full bg-border"
          style={
            pct != null
              ? { background: `conic-gradient(currentColor ${Math.min(100, Math.max(0, pct))}%, var(--border) 0)` }
              : undefined
          }
          aria-hidden
        >
          <span className="absolute inset-[2px] rounded-full bg-card" />
        </span>
      </button>
    ) : (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={title}
        aria-label={title}
        className={cn(
          'inline-flex flex-col items-center gap-0.5 rounded-xl border px-2 py-1.5 shadow-xs backdrop-blur-sm transition',
          isLiveSnapshot
            ? 'border-border bg-card/95 text-foreground hover:border-border hover:bg-card hover:shadow-sm'
            : 'border-border/60 bg-card/80 text-muted-foreground/60',
          hot && 'border-warning/50 bg-warning/10 text-warning hover:border-warning/70',
          className,
        )}
      >
        <Gauge className={cn('h-3.5 w-3.5 shrink-0', hot ? 'text-warning' : 'text-muted-foreground')} strokeWidth={2} aria-hidden />
        <span className="text-2xs font-medium leading-none tabular-nums">{tokens}</span>
      </button>
    );

  return (
    <>
      {button}
      <AnimatePresence>
        {drawerOpen ? <ContextInspectorDrawer snapshot={effectiveSnapshot} live={isLiveSnapshot} onClose={() => setOpen(false)} /> : null}
      </AnimatePresence>
    </>
  );
}

function createEmptySnapshot(defaultModelLabel: string, model?: ContextInspectorModel): ContextSnapshot {
  return {
    seq: 0,
    createdAt: new Date(0).toISOString(),
    model: {
      id: model?.id ?? 'model',
      label: model?.label ?? defaultModelLabel,
      contextWindow: model?.contextWindow,
    },
    window: {
      usedTokens: 0,
      contextWindow: model?.contextWindow,
      ratio: model?.contextWindow ? 0 : undefined,
    },
    blocks: [],
    breakpoints: [],
    compaction: {
      extractedCount: 0,
      itemHistoryActive: false,
      triggerTokens: 0,
      tailTokens: 0,
      foldedMessages: 0,
      summaryTokens: 0,
      lastStatus: 'idle',
    },
    raw: { systemPrompt: '', messages: [] },
  };
}

function ContextInspectorDrawer({ snapshot, live, onClose }: { snapshot: ContextSnapshot; live: boolean; onClose: () => void }) {
  const { t } = useTranslation();
  const [mounted, setMounted] = useState(false);
  const [tab, setTab] = useState<InspectorTab>('stats');
  const [openKey, setOpenKey] = useState<string | null>(null);
  const { window: win, blocks, compaction } = snapshot;
  const used = win.usedTokens || 1;

  useEffect(() => {
    setMounted(true);
  }, []);

  const orderedSections = buildOrderedSections(blocks);
  const categoryTotals = buildCategoryTotals(blocks);

  const drawer = (
    <div className="fixed inset-0 z-100">
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="absolute inset-0 bg-black/20 supports-backdrop-filter:backdrop-blur-xs"
        onClick={onClose}
      />
      <motion.aside
        initial={{ x: 600 }}
        animate={{ x: 0 }}
        exit={{ x: 600 }}
        transition={SPRING_PANEL}
        className="absolute inset-y-0 right-0 flex w-full max-w-[620px] flex-col border-l border-border bg-background shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-3">
          <Layers className="h-4 w-4 text-primary" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-foreground">{t('inspector.window', { defaultValue: '上下文窗口' })}</div>
            <div className="truncate text-xs text-muted-foreground">{snapshot.model.label}</div>
          </div>
          <IconButton onClick={onClose} className="ml-auto text-muted-foreground" aria-label={t('inspector.close', { defaultValue: '关闭' })}>
            <X className="size-4" />
          </IconButton>
        </div>

        <div className="border-b border-border bg-background px-4 py-2.5">
          <div className="grid grid-cols-2 rounded-lg border border-border bg-muted/45 p-1 text-xs">
            <TabButton active={tab === 'stats'} icon={<Gauge className="h-3.5 w-3.5" />} onClick={() => setTab('stats')}>
              {t('inspector.stats', { defaultValue: '统计' })}
            </TabButton>
            <TabButton active={tab === 'preview'} icon={<Code2 className="h-3.5 w-3.5" />} onClick={() => setTab('preview')}>
              {t('inspector.preview', { defaultValue: '预览' })}
            </TabButton>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto bg-background px-4 py-4">
          {tab === 'stats' ? (
            <StatsPanel
              blocks={blocks}
              categoryTotals={categoryTotals}
              compaction={compaction}
              live={live}
              openKey={openKey}
              orderedSections={orderedSections}
              setOpenKey={setOpenKey}
              used={used}
              win={win}
            />
          ) : (
            <RawPreview snapshot={snapshot} />
          )}
        </div>
      </motion.aside>
    </div>
  );

  if (!mounted) {
    return null;
  }
  return createPortal(drawer, document.body);
}

function TabButton({ active, children, icon, onClick }: { active: boolean; children: ReactNode; icon: ReactNode; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'inline-flex h-8 items-center justify-center gap-1.5 rounded-md px-3 font-medium transition',
        active ? 'bg-background text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:bg-background/70 hover:text-foreground',
      )}
      aria-pressed={active}
    >
      {icon}
      {children}
    </button>
  );
}

function StatsPanel({
  blocks,
  categoryTotals,
  compaction,
  live,
  openKey,
  orderedSections,
  setOpenKey,
  used,
  win,
}: {
  blocks: ContextBlock[];
  categoryTotals: OrderedSection[];
  compaction: ContextSnapshot['compaction'];
  live: boolean;
  openKey: string | null;
  orderedSections: OrderedSection[];
  setOpenKey: (key: string | null) => void;
  used: number;
  win: ContextSnapshot['window'];
}) {
  const { t } = useTranslation();
  const totalWindow = win.contextWindow ?? win.usedTokens;
  const freeTokens = win.contextWindow ? Math.max(0, win.contextWindow - win.usedTokens) : 0;
  const systemTokens = totalForCategory(categoryTotals, 'system');
  const skillTokens = totalForCategory(categoryTotals, 'skill');
  const messageTokens = Math.max(0, win.usedTokens - systemTokens - skillTokens);
  const contextBase = totalWindow || used;
  const segmentWidth = (tokens: number) => `${Math.max(tokens > 0 ? 1 : 0, (tokens / contextBase) * 100)}%`;

  return (
    <div className="space-y-3">
      <section className="rounded-lg border border-border bg-background p-3 shadow-xs">
        <div className="mb-1.5 flex items-baseline justify-between text-xs">
          <span className="text-muted-foreground">{t('inspector.contextRatio', { defaultValue: '上下文占比' })}</span>
          <span className="tabular-nums text-foreground">
            {fmt(win.usedTokens)}
            {win.contextWindow ? <span className="text-muted-foreground"> / {fmt(win.contextWindow)} tok</span> : <span className="text-muted-foreground"> tok</span>}
            {win.ratio != null ? <span className="ml-1 text-muted-foreground">({fmtPct(win.ratio)})</span> : null}
          </span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          {win.contextWindow ? (
            <>
              <div className="h-full bg-primary/70" style={{ width: segmentWidth(systemTokens) }} title={`${t('inspector.segSystem', { defaultValue: '系统提示词' })} · ${fmt(systemTokens)} tok`} />
              <div className="h-full bg-chart-1/70" style={{ width: segmentWidth(skillTokens) }} title={`${t('inspector.legendSkill', { defaultValue: '技能' })} · ${fmt(skillTokens)} tok`} />
              <div className="h-full bg-chart-4/70" style={{ width: segmentWidth(messageTokens) }} title={`${t('inspector.legendMessage', { defaultValue: '消息' })} · ${fmt(messageTokens)} tok`} />
              <div className="h-full bg-muted-foreground/15" style={{ width: segmentWidth(freeTokens) }} title={`${t('inspector.legendFree', { defaultValue: '空闲' })} · ${fmt(freeTokens)} tok`} />
            </>
          ) : blocks.length > 0 ? (
            <>
              <div className="h-full bg-primary/70" style={{ width: segmentWidth(systemTokens) }} title={`${t('inspector.segSystem', { defaultValue: '系统提示词' })} · ${fmt(systemTokens)} tok`} />
              <div className="h-full bg-chart-1/70" style={{ width: segmentWidth(skillTokens) }} title={`${t('inspector.legendSkill', { defaultValue: '技能' })} · ${fmt(skillTokens)} tok`} />
              <div className="h-full bg-chart-4/70" style={{ width: segmentWidth(messageTokens) }} title={`${t('inspector.legendMessage', { defaultValue: '消息' })} · ${fmt(messageTokens)} tok`} />
            </>
          ) : win.ratio != null ? (
            <div className="h-full rounded-full bg-muted-foreground/45" style={{ width: `${Math.max(0, win.ratio * 100)}%` }} />
          ) : null}
        </div>
        {/* legend */}
        {categoryTotals.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-2xs">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-primary" />
              {t('inspector.legendSystem', { defaultValue: '系统' })}
              <span className="tabular-nums text-muted-foreground/70">{fmt(systemTokens)} tok</span>
            </span>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-chart-1" />
              {t('inspector.legendSkill', { defaultValue: '技能' })}
              <span className="tabular-nums text-muted-foreground/70">{fmt(skillTokens)} tok</span>
            </span>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-chart-4" />
              {t('inspector.legendMessage', { defaultValue: '消息' })}
              <span className="tabular-nums text-muted-foreground/70">{fmt(messageTokens)} tok</span>
            </span>
            {win.contextWindow ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                {t('inspector.legendFree', { defaultValue: '空闲' })}
                <span className="tabular-nums text-muted-foreground/70">{fmt(freeTokens)} tok</span>
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="mt-1.5 text-2xs text-muted-foreground/80">
          {live
            ? t('inspector.localEstimate', { defaultValue: '本地 token 估算；账单以 provider usage 为准。' })
            : t('inspector.noAssembly', { defaultValue: '暂无本轮装配快照。' })}
        </div>
      </section>

      {live ? (
        <section className="rounded-lg border border-border bg-background px-3 py-2.5 text-xs shadow-xs">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-medium text-foreground">
                <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
                {t('inspector.compactionTitle', { defaultValue: 'Workspace Summary 压缩' })}
              </div>
              <p className="mt-1 text-2xs text-muted-foreground">
                {t('inspector.compactionDetail', {
                  defaultValue: '触发阈值 {{trigger}} tok；保留尾部 {{tail}} tok；最近状态 {{status}}。',
                  trigger: fmt(compaction.triggerTokens),
                  tail: fmt(compaction.tailTokens),
                  status: compaction.lastStatus,
                })}
              </p>
              {compaction.lastError ? (
                <p className="mt-1 truncate text-2xs text-destructive" title={compaction.lastError}>{compaction.lastError}</p>
              ) : null}
            </div>
            <div className="shrink-0 text-right tabular-nums text-foreground">
              {t('inspector.foldedCount', { defaultValue: '折叠 {{count}} 条', count: fmt(compaction.foldedMessages) })}
              <div className="mt-1 text-2xs text-muted-foreground">summary {fmt(compaction.summaryTokens)} tok</div>
            </div>
          </div>
          {compaction.summary?.xml ? (
            <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-2xs leading-relaxed text-muted-foreground">
              {compaction.summary.xml}
            </pre>
          ) : null}
        </section>
      ) : null}

      {orderedSections.map(({ key, category, rows, tokens }) => {
        const meta = CATEGORY[category];
        return (
          <section key={key}>
            <div className="mb-1.5 flex items-center gap-1.5">
              <meta.Icon className={cn('h-4 w-4', meta.text)} />
              <span className="text-sm font-semibold tracking-tight text-foreground">{t(meta.label)}</span>
              <span className="ml-auto tabular-nums text-2xs text-muted-foreground">
                {fmt(tokens)} tok{win.usedTokens ? ` · ${fmtPct(tokens / used)}` : ''}
              </span>
            </div>
            <p className="mb-2 text-2xs leading-relaxed text-muted-foreground">{t(meta.desc)}</p>
            <div className="space-y-1.5">
              {rows.map((block) => (
                <BlockRow key={block.sub} block={block} used={used} open={openKey === block.sub} onToggle={() => setOpenKey(openKey === block.sub ? null : block.sub)} />
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

function Stat({ label, value, hot }: { label: string; value: string; hot?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <dt>{label}</dt>
      <dd className={cn('tabular-nums', hot ? 'font-medium text-warning' : 'text-foreground')}>{value}</dd>
    </div>
  );
}

function BlockRow({ block, used, open, onToggle }: { block: ContextBlock; used: number; open: boolean; onToggle: () => void }) {
  const { t } = useTranslation();
  const meta = CATEGORY[displayCategory(block)];
  const display = blockDisplay(block);
  const ratio = block.tokens / used;
  const widthPct = Math.max(1, ratio * 100);
  const placement = block.kind === 'system'
    ? 'system prompt'
    : block.kind === 'semiStable'
      ? t('inspector.placementSemiStable', { defaultValue: '消息前段' })
      : t('inspector.placementTurn', { defaultValue: '每轮消息' });
  const matchedRecallCount = block.items?.filter((item) => item.matchedRecall).length ?? 0;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'w-full rounded-lg border bg-background px-3 py-2.5 text-left shadow-xs transition hover:border-border hover:bg-muted/35',
          open ? 'border-primary/45 ring-1 ring-primary/15' : 'border-border',
        )}
      >
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', meta.dot)} />
          <span className="truncate text-xs font-medium text-foreground" title={t(display.label)}>
            {t(display.label)}
          </span>
          {block.count != null ? <span className="shrink-0 text-2xs text-muted-foreground">×{block.count}</span> : null}
          {block.line ? <Badge>{t('inspector.lineBadge', { defaultValue: '{{line}}线', line: block.line })}</Badge> : null}
          {block.kind === 'system' ? null : <Badge tone={block.kind === 'semiStable' ? undefined : 'turn'}>{placement}</Badge>}
          {matchedRecallCount > 0 ? <Badge tone="turn">{t('inspector.recallHitCount', { defaultValue: '召回命中×{{count}}', count: matchedRecallCount })}</Badge> : null}
          <span className="ml-auto shrink-0 tabular-nums text-2xs text-muted-foreground">
            {fmt(block.tokens)} tok · {fmtPct(ratio)}
          </span>
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition', open && 'rotate-90')} />
        </div>
        <p className="mt-1 line-clamp-1 text-2xs leading-4 text-muted-foreground">{t(display.meaning)}</p>
        <div className="mt-1 flex items-center gap-1 text-2xs text-muted-foreground/70">
          <span className="truncate">{t(display.storage)}</span>
        </div>
        <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-muted">
          <div className={cn('h-full rounded-full', meta.bar)} style={{ width: `${widthPct}%` }} />
        </div>
      </button>
      {open ? <BlockDetail block={block} /> : null}
    </div>
  );
}

function Badge({ children, tone }: { children: ReactNode; tone?: 'cache' | 'turn' }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded px-1 py-0.5 text-2xs leading-none',
        tone === 'cache' && 'bg-primary/10 text-primary',
        tone === 'turn' && 'bg-info/10 text-info',
        !tone && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function BlockDetail({ block }: { block: ContextBlock }) {
  const { t } = useTranslation();
  return (
    <div className="mt-1 rounded-md border border-border bg-muted/25 px-3 py-2">
      {block.items?.length ? (
        <ul className="space-y-1.5">
          {block.items.map((item, i) => (
            <li key={i} className="text-xs">
              {item.role ? <span className="mr-1.5 rounded bg-background px-1 py-0.5 text-2xs uppercase text-muted-foreground">{item.role}</span> : null}
              {item.title ? <span className="font-medium text-foreground">{item.title}</span> : null}
              {item.createdAt ? <span className="mr-1.5 rounded bg-background px-1 py-0.5 font-mono text-2xs text-muted-foreground">{item.createdAt}</span> : null}
              {item.id ? <span className="mr-1.5 rounded bg-background px-1 py-0.5 font-mono text-2xs text-muted-foreground">id {item.id}</span> : null}
              {item.matchedRecall ? <span className="mr-1.5 rounded bg-info/10 px-1 py-0.5 text-2xs text-info">{t('inspector.recallHit', { defaultValue: '召回命中' })}</span> : null}
              {item.score != null ? <span className="ml-1.5 tabular-nums text-2xs text-primary">score {item.score.toFixed(2)}</span> : null}
              {item.recallScore != null ? <span className="ml-1.5 tabular-nums text-2xs text-info">recall {item.recallScore.toFixed(2)}</span> : null}
              {item.recallPaths?.length ? <span className="ml-1.5 text-2xs text-muted-foreground">via {item.recallPaths.join(', ')}</span> : null}
              {item.summary || item.preview ? <p className="mt-0.5 whitespace-pre-wrap wrap-break-word text-muted-foreground">{item.summary ?? item.preview}</p> : null}
            </li>
          ))}
        </ul>
      ) : block.text ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-2xs leading-relaxed text-muted-foreground">{block.text}</pre>
      ) : (
        <div className="text-xs text-muted-foreground/70">{t('inspector.noContent', { defaultValue: '（无内容）' })}</div>
      )}
    </div>
  );
}

/** The literal payload sent to the model — system prompt + every message, verbatim. */
function RawPreview({ snapshot }: { snapshot: ContextSnapshot }) {
  const { t } = useTranslation();
  const { raw } = snapshot;
  return (
    <section className="space-y-3">
      <div>
        <div className="mb-1 text-2xs font-medium text-muted-foreground">system prompt</div>
        <pre className="max-h-[42vh] overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-border bg-muted/25 p-3 font-mono text-2xs leading-relaxed text-muted-foreground">
          {raw.systemPrompt || t('inspector.empty', { defaultValue: '（空）' })}
        </pre>
      </div>
      <div>
        <div className="mb-1 text-2xs font-medium text-muted-foreground">{t('inspector.messagesLabel', { defaultValue: 'messages ({{count}})', count: raw.messages.length })}</div>
        <div className="space-y-2">
          {raw.messages.map((message, i) => (
            <div key={i} className="rounded-md border border-border bg-muted/25 p-3">
              <div className="mb-1 text-2xs uppercase tracking-wide text-muted-foreground/80">{message.role}</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-2xs leading-relaxed text-muted-foreground">{message.content || t('inspector.empty', { defaultValue: '（空）' })}</pre>
            </div>
          ))}
          {raw.messages.length === 0 ? (
            <div className="rounded-md border border-border bg-muted/25 p-3 text-xs text-muted-foreground/70">{t('inspector.noMessages', { defaultValue: '（无 messages）' })}</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
