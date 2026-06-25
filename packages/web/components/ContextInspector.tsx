'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion } from 'framer-motion';
import { BookText, Brain, ChevronRight, Code2, DatabaseZap, Gauge, Layers, MessagesSquare, RefreshCw, X } from 'lucide-react';
import type { ContextBlock, ContextBlockCategory, ContextBlockSub, ContextSnapshot } from '../lib/engine';
import { cn } from '@/lib/utils';

/**
 * 上下文窗口透明面板。把 engine 每轮装配出的 MAIN 上下文按实际发送层级
 * （系统前缀 / 记忆注入 / 对话历史）可视化：每块标清存放位置、代表意义、
 * 窗口位置（system prompt / 消息前段 / 每轮消息）与 token 统计，并可看完整拼装预览。
 * 数据来自 SSE 的 `context` 快照（conversationRuntime → WorkbenchSnapshot.contextSnapshot）。
 */

type CategoryMeta = { label: string; desc: string; dot: string; bar: string; text: string; Icon: typeof BookText };
type InspectorTab = 'stats' | 'preview';
type ContextInspectorModel = { id?: string; label: string; contextWindow?: number };
type OrderedSection = { key: string; category: ContextBlockCategory; rows: ContextBlock[]; tokens: number };
type BlockDisplayMeta = { label: string; meaning: string; storage: string };

const CATEGORY: Record<ContextBlockCategory, CategoryMeta> = {
  system: {
    label: '系统提示词',
    desc: 'system prompt：角色、主场职责、记忆规则、空间路由与项目快照。',
    dot: 'bg-primary',
    bar: 'bg-primary/70',
    text: 'text-primary',
    Icon: BookText,
  },
  skill: {
    label: '技能',
    desc: '当前模型请求可见的技能索引：工作区挂载、用户选择或 runtime 搜索候选。',
    dot: 'bg-violet-500',
    bar: 'bg-violet-500/70',
    text: 'text-violet-600',
    Icon: Layers,
  },
  memory: {
    label: '记忆注入',
    desc: '用户画像、经验记忆与本轮相关召回，作为消息块注入，不进入稳定 system prompt。',
    dot: 'bg-sky-500',
    bar: 'bg-sky-500/70',
    text: 'text-sky-600',
    Icon: Brain,
  },
  cache: {
    label: '工作缓存',
    desc: 'runtime 自动保存的跨工作区中间结果索引和按需读取内容，不是长期记忆。',
    dot: 'bg-amber-500',
    bar: 'bg-amber-500/70',
    text: 'text-amber-600',
    Icon: DatabaseZap,
  },
  history: {
    label: '对话历史',
    desc: '最近事项、append-only 原始轮次与当前用户轮，按实际入模位置排列。',
    dot: 'bg-emerald-500',
    bar: 'bg-emerald-500/70',
    text: 'text-emerald-600',
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
  persona: {
    label: '角色',
    meaning: '数字员工的身份、口吻与长期行为准则',
    storage: 'Soul · identity / avatar persona',
  },
  sessionPersona: {
    label: '主场职责',
    meaning: '会话空间的职责定位：理解、判断、调度与交付',
    storage: 'DB · main space persona',
  },
  memoryInstruction: {
    label: '记忆规则',
    meaning: '记忆工具的使用边界、写入方式和召回策略',
    storage: '内置常量 · MEMORY_INSTRUCTION',
  },
  listMemory: {
    label: '运行时工具：listMemory',
    meaning: 'runtime 预取的画像、经验、最近事项和 query 召回事项，作为 listMemory tool result 入模',
    storage: 'runtime tool result · listMemory',
  },
  listCache: {
    label: '运行时工具：listCache',
    meaning: 'runtime 注入的工作缓存索引，只包含 id、摘要和来源，完整内容按需读取',
    storage: 'runtime tool result · listCache',
  },
  readCache: {
    label: '运行时工具：readCache',
    meaning: '模型按 id 读取的工作缓存详情，用于恢复前序 workspace 的完整证据或中间结果',
    storage: 'runtime tool result · readCache',
  },
  timeGuidance: {
    label: '时间规则',
    meaning: '涉及今天、最近、最新等时间敏感问题时如何取当前时间',
    storage: 'system prompt · time guidance',
  },
  spaceCatalog: {
    label: '空间路由',
    meaning: '可调度工作空间清单与路由规则',
    storage: 'DB · spaces catalog',
  },
  skillGuide: {
    label: '技能索引',
    meaning: '可用技能索引，完整技能内容按需读取',
    storage: 'Skill registry',
  },
  listSkills: {
    label: '运行时工具：listSkills',
    meaning: 'runtime 合并后的技能索引，包含挂载、手选和自动搜索候选',
    storage: 'runtime tool result · listSkills',
  },
  readSkill: {
    label: '运行时工具：readSkill',
    meaning: 'runtime 自动读取的技能正文，作为 readSkill tool result 入模',
    storage: 'runtime tool result · readSkill',
  },
  workspacePrompt: {
    label: '工作区基础提示词',
    meaning: '当前工作区 system prompt 中除工具说明外的基础提示词；完整原文在预览页查看',
    storage: 'workspace runtime prompt',
  },
  toolGuidance: {
    label: '工具说明',
    meaning: '当前工作区 system prompt 中的工具使用手册：用途、参数和关键规则',
    storage: 'workspace tool prompt',
  },
  activeSkills: {
    label: '挂载技能',
    meaning: '当前工作区已挂载或用户本轮手动选择的技能索引',
    storage: 'workspace capability snapshot',
  },
  suggestedSkills: {
    label: '候选技能',
    meaning: 'runtime 按当前任务搜索得到的候选技能索引',
    storage: 'runtime skill search',
  },
  experiences: {
    label: '经验记忆',
    meaning: 'B 线最近 Agent 级脱敏经验，不进入稳定 system 前缀',
    storage: 'core 事件图 · experience',
  },
  impressions: {
    label: '用户画像',
    meaning: 'A 线长期事实、偏好和关系上下文',
    storage: 'agent_memory · impression',
  },
  projectSnapshot: {
    label: '项目快照',
    meaning: '当前项目目录和运行场景的轻量补充',
    storage: 'workspace · project snapshot',
  },
  loopDiscipline: {
    label: '执行纪律',
    meaning: '工具行动、空轮终答和循环退出条件',
    storage: '内置常量 · LOOP_DISCIPLINE',
  },
  items: {
    label: '最近事项',
    meaning: '已提取的近期事项，按发生时间从旧到新排列',
    storage: 'core 事件图 · 最近事项',
  },
  recall: {
    label: '相关事项召回',
    meaning: '本轮按需召回的相关事项，统一并入运行时记忆结果后进入模型上下文',
    storage: 'core 向量/多跳检索',
  },
  messages: {
    label: '历史消息',
    meaning: '上次事项刷新后继续保留的 append-only 原始轮次',
    storage: '对话转录 · history',
  },
  currentTurn: {
    label: '当前用户轮',
    meaning: '本轮真实输入，落在不缓存的尾部',
    storage: '对话转录 · current turn',
  },
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
  const [internalOpen, setInternalOpen] = useState(false);
  const drawerOpen = open ?? internalOpen;
  const setOpen = onOpenChange ?? setInternalOpen;
  const effectiveSnapshot = snapshot ?? createEmptySnapshot(model);
  const isLiveSnapshot = Boolean(snapshot);
  const ratio = effectiveSnapshot.window.ratio;
  const pct = ratio != null ? Math.round(ratio * 100) : null;
  const remainingPct = pct != null ? Math.max(0, 100 - pct) : null;
  const hot = pct != null && pct >= 80;
  const tokens = fmt(effectiveSnapshot.window.usedTokens);
  const compactUsed = fmtCompact(effectiveSnapshot.window.usedTokens);
  const compactTotal = effectiveSnapshot.window.contextWindow ? fmtCompact(effectiveSnapshot.window.contextWindow) : null;
  const backgroundTitle = `背景信息窗口：${pct != null ? `${pct}% 已用${remainingPct != null ? `（剩余 ${remainingPct}%）` : ''}` : `${compactUsed} 已用`}；当前上下文 ${compactUsed} 标记${compactTotal ? `，模型设置 ${compactTotal}` : ''}${isLiveSnapshot ? '' : '；暂无运行快照'}`;
  const title = isLiveSnapshot
    ? pct != null
      ? `上下文窗口 · ${tokens} tok · ${pct}%`
      : `上下文窗口 · ${tokens} tok`
    : '上下文窗口 · 尚未生成运行快照';

  const button =
    variant === 'composer' ? (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={backgroundTitle}
        aria-label={backgroundTitle}
        className={cn(
          'inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-pill text-muted-foreground transition-colors hover:bg-muted/70 hover:text-ink',
          isLiveSnapshot ? 'text-muted-foreground' : 'text-muted-foreground/60',
          hot && 'text-amber-600 hover:bg-amber-50 hover:text-amber-700',
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
          <span className="absolute inset-[2px] rounded-full bg-surface" />
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
            ? 'border-border bg-surface/95 text-ink hover:border-border-strong hover:bg-surface hover:shadow-sm'
            : 'border-border/60 bg-surface/80 text-muted-foreground/60',
          hot && 'border-amber-400/70 bg-amber-50/95 text-amber-700 hover:border-amber-500/80',
          className,
        )}
      >
        <Gauge className={cn('h-3.5 w-3.5 shrink-0', hot ? 'text-amber-600' : 'text-muted-foreground')} strokeWidth={2} aria-hidden />
        <span className="text-[11px] font-medium leading-none tabular-nums">{tokens}</span>
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

function createEmptySnapshot(model?: ContextInspectorModel): ContextSnapshot {
  return {
    seq: 0,
    createdAt: new Date(0).toISOString(),
    model: {
      id: model?.id ?? 'model',
      label: model?.label ?? '当前模型',
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
        transition={{ type: 'spring', stiffness: 320, damping: 34 }}
        className="absolute inset-y-0 right-0 flex w-full max-w-[620px] flex-col border-l border-border bg-background shadow-xl"
      >
        <div className="flex items-center gap-2 border-b border-border bg-background px-4 py-3">
          <Layers className="h-4 w-4 text-primary" />
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold text-ink">上下文窗口</div>
            <div className="truncate text-xs text-muted-foreground">{snapshot.model.label}</div>
          </div>
          <button type="button" onClick={onClose} className="ml-auto flex h-7 w-7 items-center justify-center rounded-sm text-muted-foreground transition hover:bg-surface-2 hover:text-ink" aria-label="关闭">
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="border-b border-border bg-background px-4 py-2.5">
          <div className="grid grid-cols-2 rounded-lg border border-border bg-muted/45 p-1 text-xs">
            <TabButton active={tab === 'stats'} icon={<Gauge className="h-3.5 w-3.5" />} onClick={() => setTab('stats')}>
              统计
            </TabButton>
            <TabButton active={tab === 'preview'} icon={<Code2 className="h-3.5 w-3.5" />} onClick={() => setTab('preview')}>
              预览
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
        active ? 'bg-background text-ink shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:bg-background/70 hover:text-ink',
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
          <span className="text-muted-foreground">上下文占比</span>
          <span className="tabular-nums text-ink">
            {fmt(win.usedTokens)}
            {win.contextWindow ? <span className="text-muted-foreground"> / {fmt(win.contextWindow)} tok</span> : <span className="text-muted-foreground"> tok</span>}
            {win.ratio != null ? <span className="ml-1 text-muted-foreground">({fmtPct(win.ratio)})</span> : null}
          </span>
        </div>
        <div className="flex h-2 w-full overflow-hidden rounded-full bg-muted">
          {win.contextWindow ? (
            <>
              <div className="h-full bg-primary/70" style={{ width: segmentWidth(systemTokens) }} title={`系统提示词 · ${fmt(systemTokens)} tok`} />
              <div className="h-full bg-violet-500/70" style={{ width: segmentWidth(skillTokens) }} title={`技能 · ${fmt(skillTokens)} tok`} />
              <div className="h-full bg-emerald-500/70" style={{ width: segmentWidth(messageTokens) }} title={`消息 · ${fmt(messageTokens)} tok`} />
              <div className="h-full bg-muted-foreground/15" style={{ width: segmentWidth(freeTokens) }} title={`空闲 · ${fmt(freeTokens)} tok`} />
            </>
          ) : blocks.length > 0 ? (
            <>
              <div className="h-full bg-primary/70" style={{ width: segmentWidth(systemTokens) }} title={`系统提示词 · ${fmt(systemTokens)} tok`} />
              <div className="h-full bg-violet-500/70" style={{ width: segmentWidth(skillTokens) }} title={`技能 · ${fmt(skillTokens)} tok`} />
              <div className="h-full bg-emerald-500/70" style={{ width: segmentWidth(messageTokens) }} title={`消息 · ${fmt(messageTokens)} tok`} />
            </>
          ) : win.ratio != null ? (
            <div className="h-full rounded-full bg-muted-foreground/45" style={{ width: `${Math.max(0, win.ratio * 100)}%` }} />
          ) : null}
        </div>
        {/* legend */}
        {categoryTotals.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-x-3 gap-y-1 text-[11px]">
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-primary" />
              系统
              <span className="tabular-nums text-muted-foreground/70">{fmt(systemTokens)} tok</span>
            </span>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-violet-500" />
              技能
              <span className="tabular-nums text-muted-foreground/70">{fmt(skillTokens)} tok</span>
            </span>
            <span className="inline-flex items-center gap-1 text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              消息
              <span className="tabular-nums text-muted-foreground/70">{fmt(messageTokens)} tok</span>
            </span>
            {win.contextWindow ? (
              <span className="inline-flex items-center gap-1 text-muted-foreground">
                <span className="h-2 w-2 rounded-full bg-muted-foreground/30" />
                空闲
                <span className="tabular-nums text-muted-foreground/70">{fmt(freeTokens)} tok</span>
              </span>
            ) : null}
          </div>
        ) : null}
        <div className="mt-1.5 text-[11px] text-muted-foreground/80">
          {live ? '本地 token 估算；账单以 provider usage 为准。' : '暂无本轮装配快照。'}
        </div>
      </section>

      {live ? (
        <section className="rounded-lg border border-border bg-background px-3 py-2.5 text-xs shadow-xs">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 font-medium text-ink">
                <RefreshCw className="h-3.5 w-3.5 text-muted-foreground" />
                Workspace Summary 压缩
              </div>
              <p className="mt-1 text-[11px] text-muted-foreground">
                触发阈值 {fmt(compaction.triggerTokens)} tok；保留尾部 {fmt(compaction.tailTokens)} tok；最近状态 {compaction.lastStatus}。
              </p>
              {compaction.lastError ? (
                <p className="mt-1 truncate text-[11px] text-destructive" title={compaction.lastError}>{compaction.lastError}</p>
              ) : null}
            </div>
            <div className="shrink-0 text-right tabular-nums text-ink">
              折叠 {fmt(compaction.foldedMessages)} 条
              <div className="mt-1 text-[11px] text-muted-foreground">summary {fmt(compaction.summaryTokens)} tok</div>
            </div>
          </div>
          {compaction.summary?.xml ? (
            <pre className="mt-2 max-h-32 overflow-auto rounded-md bg-muted/50 p-2 text-[11px] leading-relaxed text-muted-foreground">
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
              <span className="text-sm font-semibold tracking-tight text-ink">{meta.label}</span>
              <span className="ml-auto tabular-nums text-[11px] text-muted-foreground">
                {fmt(tokens)} tok{win.usedTokens ? ` · ${fmtPct(tokens / used)}` : ''}
              </span>
            </div>
            <p className="mb-2 text-[11px] leading-relaxed text-muted-foreground">{meta.desc}</p>
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
      <dd className={cn('tabular-nums', hot ? 'font-medium text-amber-600' : 'text-ink')}>{value}</dd>
    </div>
  );
}

function BlockRow({ block, used, open, onToggle }: { block: ContextBlock; used: number; open: boolean; onToggle: () => void }) {
  const meta = CATEGORY[displayCategory(block)];
  const display = blockDisplay(block);
  const ratio = block.tokens / used;
  const widthPct = Math.max(1, ratio * 100);
  const placement = block.kind === 'system' ? 'system prompt' : block.kind === 'semiStable' ? '消息前段' : '每轮消息';
  const matchedRecallCount = block.items?.filter((item) => item.matchedRecall).length ?? 0;
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className={cn(
          'w-full rounded-lg border bg-background px-3 py-2.5 text-left shadow-xs transition hover:border-border-strong hover:bg-muted/35',
          open ? 'border-primary/45 ring-1 ring-primary/15' : 'border-border',
        )}
      >
        <div className="flex items-center gap-2">
          <span className={cn('h-2 w-2 shrink-0 rounded-full', meta.dot)} />
          <span className="truncate text-xs font-medium text-ink" title={display.label}>
            {display.label}
          </span>
          {block.count != null ? <span className="shrink-0 text-[11px] text-muted-foreground">×{block.count}</span> : null}
          {block.line ? <Badge>{block.line}线</Badge> : null}
          {block.kind === 'system' ? null : <Badge tone={block.kind === 'semiStable' ? undefined : 'turn'}>{placement}</Badge>}
          {matchedRecallCount > 0 ? <Badge tone="turn">召回命中×{matchedRecallCount}</Badge> : null}
          <span className="ml-auto shrink-0 tabular-nums text-[11px] text-muted-foreground">
            {fmt(block.tokens)} tok · {fmtPct(ratio)}
          </span>
          <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground transition', open && 'rotate-90')} />
        </div>
        <p className="mt-1 line-clamp-1 text-[11px] leading-4 text-muted-foreground">{display.meaning}</p>
        <div className="mt-1 flex items-center gap-1 text-[10px] text-muted-foreground/70">
          <span className="truncate">{display.storage}</span>
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
        'shrink-0 rounded px-1 py-0.5 text-[10px] leading-none',
        tone === 'cache' && 'bg-primary/10 text-primary',
        tone === 'turn' && 'bg-sky-500/10 text-sky-600',
        !tone && 'bg-muted text-muted-foreground',
      )}
    >
      {children}
    </span>
  );
}

function BlockDetail({ block }: { block: ContextBlock }) {
  return (
    <div className="mt-1 rounded-md border border-border bg-muted/25 px-3 py-2">
      {block.items?.length ? (
        <ul className="space-y-1.5">
          {block.items.map((item, i) => (
            <li key={i} className="text-xs">
              {item.role ? <span className="mr-1.5 rounded bg-background px-1 py-0.5 text-[10px] uppercase text-muted-foreground">{item.role}</span> : null}
              {item.title ? <span className="font-medium text-ink">{item.title}</span> : null}
              {item.createdAt ? <span className="mr-1.5 rounded bg-background px-1 py-0.5 font-mono text-[10px] text-muted-foreground">{item.createdAt}</span> : null}
              {item.id ? <span className="mr-1.5 rounded bg-background px-1 py-0.5 font-mono text-[10px] text-muted-foreground">id {item.id}</span> : null}
              {item.matchedRecall ? <span className="mr-1.5 rounded bg-sky-500/10 px-1 py-0.5 text-[10px] text-sky-600">召回命中</span> : null}
              {item.score != null ? <span className="ml-1.5 tabular-nums text-[10px] text-primary">score {item.score.toFixed(2)}</span> : null}
              {item.recallScore != null ? <span className="ml-1.5 tabular-nums text-[10px] text-sky-600">recall {item.recallScore.toFixed(2)}</span> : null}
              {item.recallPaths?.length ? <span className="ml-1.5 text-[10px] text-muted-foreground">via {item.recallPaths.join(', ')}</span> : null}
              {item.summary || item.preview ? <p className="mt-0.5 whitespace-pre-wrap wrap-break-word text-muted-foreground">{item.summary ?? item.preview}</p> : null}
            </li>
          ))}
        </ul>
      ) : block.text ? (
        <pre className="max-h-64 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-[11px] leading-relaxed text-muted-foreground">{block.text}</pre>
      ) : (
        <div className="text-xs text-muted-foreground/70">（无内容）</div>
      )}
    </div>
  );
}

/** The literal payload sent to the model — system prompt + every message, verbatim. */
function RawPreview({ snapshot }: { snapshot: ContextSnapshot }) {
  const { raw } = snapshot;
  return (
    <section className="space-y-3">
      <div>
        <div className="mb-1 text-[11px] font-medium text-muted-foreground">system prompt</div>
        <pre className="max-h-[42vh] overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-border bg-muted/25 p-3 font-mono text-[11px] leading-relaxed text-muted-foreground">
          {raw.systemPrompt || '（空）'}
        </pre>
      </div>
      <div>
        <div className="mb-1 text-[11px] font-medium text-muted-foreground">messages ({raw.messages.length})</div>
        <div className="space-y-2">
          {raw.messages.map((message, i) => (
            <div key={i} className="rounded-md border border-border bg-muted/25 p-3">
              <div className="mb-1 text-[10px] uppercase tracking-wide text-muted-foreground/80">{message.role}</div>
              <pre className="max-h-72 overflow-auto whitespace-pre-wrap wrap-break-word font-mono text-[11px] leading-relaxed text-muted-foreground">{message.content || '（空）'}</pre>
            </div>
          ))}
          {raw.messages.length === 0 ? (
            <div className="rounded-md border border-border bg-muted/25 p-3 text-xs text-muted-foreground/70">（无 messages）</div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
