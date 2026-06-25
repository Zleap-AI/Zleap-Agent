'use client';

import { useMemo, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Brain,
  CheckCircle2,
  ChevronRight,
  Code2,
  Compass,
  FileText,
  Globe2,
  Layers3,
  Play,
  Radio,
  Sparkles,
  TerminalSquare,
  UsersRound,
  Workflow,
} from 'lucide-react';

type ScenarioKey = 'research' | 'build' | 'operate';
type SpaceId = 'explore' | 'browser' | 'create' | 'code';

const scenarios: Record<
  ScenarioKey,
  {
    label: string;
    prompt: string;
    outcome: string;
    active: SpaceId[];
    artifact: string;
  }
> = {
  research: {
    label: '研究到报告',
    prompt: '分析竞争产品，输出可执行的周报与后续动作。',
    outcome: '探索空间和浏览器空间并行读取，创作空间接收蒸馏后的 Artifact。',
    active: ['explore', 'browser', 'create'],
    artifact: 'market-brief.md',
  },
  build: {
    label: '想法到原型',
    prompt: '把产品设想变成一个能点击的 Web 原型。',
    outcome: '创作空间拆信息架构，编码空间生成页面，Kernel 汇聚交付。',
    active: ['create', 'code'],
    artifact: 'prototype-route.tsx',
  },
  operate: {
    label: '入口到执行',
    prompt: '把 Web、飞书、API 的输入接到同一套 Agent 生命周期。',
    outcome: 'SessionSpace 保持用户上下文，WorkSpace 隔离执行上下文。',
    active: ['browser', 'code', 'explore'],
    artifact: 'run-ledger.json',
  },
};

const spaces: Array<{
  id: SpaceId;
  name: string;
  role: string;
  icon: typeof Compass;
  metric: string;
  tone: string;
}> = [
  {
    id: 'explore',
    name: '探索空间',
    role: '检索、对比、验证来源',
    icon: Compass,
    metric: '4 sources',
    tone: 'border-sky-200 bg-sky-50 text-sky-950',
  },
  {
    id: 'browser',
    name: '浏览器空间',
    role: '打开网页并操作 GUI',
    icon: Globe2,
    metric: 'live page',
    tone: 'border-emerald-200 bg-emerald-50 text-emerald-950',
  },
  {
    id: 'create',
    name: '创作空间',
    role: '结构化写作与视觉整理',
    icon: Sparkles,
    metric: 'drafting',
    tone: 'border-amber-200 bg-amber-50 text-amber-950',
  },
  {
    id: 'code',
    name: '编码空间',
    role: '终端、文件与沙箱执行',
    icon: Code2,
    metric: 'tests ready',
    tone: 'border-violet-200 bg-violet-50 text-violet-950',
  },
];

const auditFindings = [
  {
    title: '首屏价值不够前置',
    detail: '现站标题停留在内容社区，无法表达空间隔离、Avatar、Work/Artifact 这些真正差异点。',
  },
  {
    title: '服务端可见内容偏少',
    detail: '抓取到的 / 首屏主要是 Loading SVG 与水合脚本，品牌叙事依赖大量 JS 后置呈现。',
  },
  {
    title: '样式架构偏后台壳',
    detail: '主色大量集中在橙色、灰阶和通用管理后台 token，缺少 Agent 工作现场的状态语言。',
  },
  {
    title: '交互没有产品模型',
    detail: '用户看不到一次 Run 如何调度多个 WorkSpace，也看不到 Artifact 如何汇聚成最终交付。',
  },
];

const interactionUpgrades = [
  '首屏 SSR 直出核心定位、CTA 与产品画面，Loading 只用于局部数据。',
  '把“空间”变成可见的工作台状态：queued / active / producing / exited。',
  '用场景切换替代静态口号，让用户直接理解链式与并发 Work。',
  '信息架构从社区内容流改成 Agent Framework：Run、Space、Avatar、Artifact、Registry。',
  '颜色从单一橙色升级为多状态系统：蓝=探索，绿=浏览器，琥珀=创作，紫=编码。',
];

export default function SitePrototypePage() {
  const [scenarioKey, setScenarioKey] = useState<ScenarioKey>('research');
  const [avatar, setAvatar] = useState<'default' | 'builder'>('default');
  const scenario = scenarios[scenarioKey];
  const activeSet = useMemo(() => new Set<SpaceId>(scenario.active), [scenario.active]);

  return (
    <main className="min-h-screen bg-[#f7f8f5] text-[#111817]">
      <Hero
        scenarioKey={scenarioKey}
        scenario={scenario}
        activeSet={activeSet}
        avatar={avatar}
        onScenarioChange={setScenarioKey}
        onAvatarChange={setAvatar}
      />

      <section id="audit" className="border-y border-[#d9ded8] bg-white">
        <div className="mx-auto grid max-w-7xl gap-10 px-4 py-16 md:grid-cols-[0.78fr_1.22fr] md:px-8">
          <div>
            <p className="text-xs font-semibold uppercase text-[#66716d]">Current site audit</p>
            <h2 className="mt-3 max-w-md text-3xl font-semibold leading-tight md:text-4xl">
              现站更像内容社区壳，优化后要像一个正在工作的 Agent。
            </h2>
            <p className="mt-4 max-w-lg text-sm leading-7 text-[#4f5c57]">
              抓取结果显示，当前页面使用 Next.js + Tailwind/shadcn 风格，主色集中在橙色，初始 HTML
              可见内容很少，且大量文案来自登录、邀请码、报告、助手、知识库等应用后台。新原型把叙事收束到 Agent
              Framework 本身。
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {auditFindings.map((finding) => (
              <article key={finding.title} className="rounded-lg border border-[#dfe4df] bg-[#fafbf8] p-5">
                <CheckCircle2 className="h-5 w-5 text-[#16826a]" aria-hidden="true" />
                <h3 className="mt-4 text-base font-semibold">{finding.title}</h3>
                <p className="mt-2 text-sm leading-6 text-[#5a665f]">{finding.detail}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section id="system" className="bg-[#eef3f1]">
        <div className="mx-auto max-w-7xl px-4 py-16 md:px-8">
          <div className="flex flex-col justify-between gap-6 md:flex-row md:items-end">
            <div>
              <p className="text-xs font-semibold uppercase text-[#66716d]">Style and interaction system</p>
              <h2 className="mt-3 max-w-2xl text-3xl font-semibold leading-tight md:text-4xl">
                用状态化界面替代空泛卖点。
              </h2>
            </div>
            <a
              href="/"
              className="inline-flex w-fit items-center gap-2 rounded-md bg-[#121817] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[#27302d]"
            >
              打开当前 Web App <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>

          <div className="mt-10 grid gap-4 lg:grid-cols-[0.95fr_1.05fr]">
            <div className="rounded-lg border border-[#d5ddd8] bg-white p-5">
              <div className="flex items-center gap-3">
                <div className="flex h-10 w-10 items-center justify-center rounded-md bg-[#121817] text-white">
                  <Layers3 className="h-5 w-5" aria-hidden="true" />
                </div>
                <div>
                  <h3 className="font-semibold">信息架构</h3>
                  <p className="text-sm text-[#68736f]">从社区流改成 Agent 工作台叙事。</p>
                </div>
              </div>
              <div className="mt-6 grid gap-3">
                {['SessionSpace', 'Kernel planning', 'Parallel Work', 'Artifact delivery'].map((item, index) => (
                  <div key={item} className="flex items-center gap-3 rounded-md border border-[#e1e6e1] p-3">
                    <span className="flex h-7 w-7 items-center justify-center rounded-sm bg-[#eff4f2] text-xs font-semibold">
                      {index + 1}
                    </span>
                    <span className="text-sm font-medium">{item}</span>
                    {index < 3 ? <ChevronRight className="ml-auto h-4 w-4 text-[#87908c]" aria-hidden="true" /> : null}
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-lg border border-[#d5ddd8] bg-[#111817] p-5 text-white">
              <div className="flex items-center justify-between gap-4">
                <div>
                  <h3 className="font-semibold">优化动作</h3>
                  <p className="text-sm text-[#b8c2bd]">从样式、性能到交互的落地清单。</p>
                </div>
                <Radio className="h-5 w-5 text-[#67d8c0]" aria-hidden="true" />
              </div>
              <div className="mt-5 grid gap-2">
                {interactionUpgrades.map((item) => (
                  <div key={item} className="flex gap-3 rounded-md bg-white/6 p-3 text-sm leading-6 text-[#ecf4f0]">
                    <span className="mt-2 h-1.5 w-1.5 shrink-0 rounded-full bg-[#67d8c0]" />
                    <span>{item}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}

function Hero({
  scenarioKey,
  scenario,
  activeSet,
  avatar,
  onScenarioChange,
  onAvatarChange,
}: {
  scenarioKey: ScenarioKey;
  scenario: (typeof scenarios)[ScenarioKey];
  activeSet: Set<SpaceId>;
  avatar: 'default' | 'builder';
  onScenarioChange: (key: ScenarioKey) => void;
  onAvatarChange: (value: 'default' | 'builder') => void;
}) {
  return (
    <section className="relative min-h-[92svh] overflow-hidden border-b border-[#d9ded8] bg-[#f7f8f5]">
      <div className="absolute inset-x-0 top-0 z-20 border-b border-[#d9ded8]/80 bg-[#f7f8f5]/88 backdrop-blur">
        <nav className="mx-auto flex h-16 max-w-7xl items-center gap-4 px-4 md:px-8">
          <a href="#top" className="flex items-center gap-2 font-semibold">
            <span className="flex h-8 w-8 items-center justify-center rounded-md bg-[#121817] text-white">Z</span>
            Zleap
          </a>
          <div className="ml-auto hidden items-center gap-5 text-sm text-[#53605b] md:flex">
            <a href="#audit" className="transition hover:text-[#111817]">
              诊断
            </a>
            <a href="#system" className="transition hover:text-[#111817]">
              优化系统
            </a>
            <a href="/" className="transition hover:text-[#111817]">
              当前应用
            </a>
          </div>
          <a
            href="#system"
            className="ml-auto inline-flex items-center gap-2 rounded-md border border-[#cdd6d1] bg-white px-3 py-2 text-sm font-semibold transition hover:border-[#9ca9a3] md:ml-0"
          >
            查看方案 <ArrowRight className="h-4 w-4" aria-hidden="true" />
          </a>
        </nav>
      </div>

      <ProductScene activeSet={activeSet} scenario={scenario} avatar={avatar} onAvatarChange={onAvatarChange} />

      <div className="relative z-10 mx-auto flex min-h-[92svh] max-w-7xl flex-col justify-end px-4 pb-10 pt-24 md:px-8">
        <div className="max-w-3xl pb-[34vh] md:pb-[28vh]">
          <p className="inline-flex items-center gap-2 rounded-md border border-[#c9d2cd] bg-white/80 px-3 py-1 text-xs font-semibold uppercase text-[#58645f] backdrop-blur">
            <Bot className="h-4 w-4 text-[#16826a]" aria-hidden="true" />
            Agent Framework Website Prototype
          </p>
          <h1 className="mt-5 text-5xl font-semibold leading-[1.02] text-[#111817] md:text-7xl">
            Zleap Agent Framework
          </h1>
          <p className="mt-5 max-w-2xl text-base leading-8 text-[#43504b] md:text-lg">
            一个 Agent，按任务自动打开多个隔离空间；每个 WorkSpace 拥有自己的工具、记忆和执行上下文，
            Kernel 只汇聚 Artifact，不把所有能力塞进同一个模型上下文。
          </p>
          <div className="mt-7 flex flex-wrap gap-3">
            <a
              href="/"
              className="inline-flex items-center gap-2 rounded-md bg-[#121817] px-5 py-3 text-sm font-semibold text-white transition hover:bg-[#27302d]"
            >
              <Play className="h-4 w-4" aria-hidden="true" />
              进入工作台
            </a>
            <a
              href="#audit"
              className="inline-flex items-center gap-2 rounded-md border border-[#cbd4cf] bg-white/82 px-5 py-3 text-sm font-semibold backdrop-blur transition hover:border-[#98a8a0]"
            >
              查看现站优化
            </a>
          </div>
        </div>

        <div className="relative z-20 grid gap-3 rounded-lg border border-[#cbd4cf] bg-white/86 p-2 backdrop-blur md:grid-cols-3">
          {(Object.keys(scenarios) as ScenarioKey[]).map((key) => {
            const item = scenarios[key];
            const selected = scenarioKey === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onScenarioChange(key)}
                className={`rounded-md p-4 text-left transition ${
                  selected ? 'bg-[#111817] text-white' : 'bg-transparent text-[#2e3935] hover:bg-white'
                }`}
              >
                <span className="text-sm font-semibold">{item.label}</span>
                <span className={`mt-2 block text-xs leading-5 ${selected ? 'text-[#c8d4cf]' : 'text-[#65716c]'}`}>
                  {item.prompt}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </section>
  );
}

function ProductScene({
  activeSet,
  scenario,
  avatar,
  onAvatarChange,
}: {
  activeSet: Set<SpaceId>;
  scenario: (typeof scenarios)[ScenarioKey];
  avatar: 'default' | 'builder';
  onAvatarChange: (value: 'default' | 'builder') => void;
}) {
  return (
    <div className="absolute inset-x-0 bottom-0 top-16 z-0 overflow-hidden">
      <div className="absolute inset-0 bg-[linear-gradient(to_right,#dce4df_1px,transparent_1px),linear-gradient(to_bottom,#dce4df_1px,transparent_1px)] bg-[size:72px_72px] opacity-45" />
      <div className="absolute bottom-20 left-1/2 w-[min(1180px,94vw)] -translate-x-1/2">
        <div className="grid gap-4 lg:grid-cols-[0.9fr_1.35fr_0.85fr]">
          <section className="rounded-lg border border-[#cbd5cf] bg-white/92 p-4 shadow-[0_24px_80px_rgba(28,39,35,0.16)] backdrop-blur">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#edf3f0]">
                <Brain className="h-5 w-5 text-[#166e5e]" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase text-[#66716d]">SessionSpace</p>
                <h2 className="text-sm font-semibold">用户目标与连续对话</h2>
              </div>
            </div>
            <div className="mt-5 rounded-md bg-[#f3f6f2] p-4">
              <p className="text-sm leading-6 text-[#2c3834]">{scenario.prompt}</p>
            </div>
            <div className="mt-4 flex items-center gap-2 rounded-md border border-[#dbe2dd] p-3">
              <UsersRound className="h-4 w-4 text-[#66716d]" aria-hidden="true" />
              <span className="text-xs font-medium">{avatar === 'default' ? 'Zleap Agent' : 'Builder Avatar'}</span>
              <button
                type="button"
                onClick={() => onAvatarChange(avatar === 'default' ? 'builder' : 'default')}
                className="ml-auto rounded-sm border border-[#cfd8d2] px-2 py-1 text-xs transition hover:bg-[#eef3f1]"
                title="Switch avatar"
              >
                切换
              </button>
            </div>
          </section>

          <section className="rounded-lg border border-[#cbd5cf] bg-[#111817]/94 p-4 text-white shadow-[0_24px_90px_rgba(18,24,23,0.28)]">
            <div className="flex items-center justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase text-[#8fa19a]">Kernel orchestration</p>
                <h2 className="mt-1 text-lg font-semibold">Run 正在调度隔离 WorkSpace</h2>
              </div>
              <Workflow className="h-5 w-5 text-[#67d8c0]" aria-hidden="true" />
            </div>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              {spaces.map((space) => (
                <SpaceTile key={space.id} space={space} active={activeSet.has(space.id)} />
              ))}
            </div>
            <div className="mt-4 rounded-md border border-white/12 bg-white/6 p-4">
              <div className="flex items-center gap-3 text-sm">
                <TerminalSquare className="h-4 w-4 text-[#67d8c0]" aria-hidden="true" />
                <span className="font-medium">Artifact pipeline</span>
                <span className="ml-auto rounded-sm bg-[#67d8c0]/14 px-2 py-1 text-xs text-[#99ead9]">bounded context</span>
              </div>
              <p className="mt-3 text-sm leading-6 text-[#d9e4df]">{scenario.outcome}</p>
            </div>
          </section>

          <section className="rounded-lg border border-[#cbd5cf] bg-white/92 p-4 shadow-[0_24px_80px_rgba(28,39,35,0.16)] backdrop-blur">
            <div className="flex items-center gap-3">
              <div className="flex h-9 w-9 items-center justify-center rounded-md bg-[#f4efe7]">
                <FileText className="h-5 w-5 text-[#9b5a15]" aria-hidden="true" />
              </div>
              <div>
                <p className="text-xs font-semibold uppercase text-[#66716d]">Delivery</p>
                <h2 className="text-sm font-semibold">Artifact 汇聚</h2>
              </div>
            </div>
            <div className="mt-5 rounded-md border border-[#dbe2dd] p-4">
              <p className="text-xs font-semibold uppercase text-[#66716d]">Generated</p>
              <p className="mt-2 font-mono text-sm text-[#111817]">{scenario.artifact}</p>
              <div className="mt-4 h-2 rounded-full bg-[#e8eee9]">
                <div className="h-2 w-4/5 rounded-full bg-[#16826a]" />
              </div>
            </div>
            <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
              <div className="rounded-md bg-[#eef3f1] p-3">
                <p className="font-semibold">Trace</p>
                <p className="mt-1 text-[#66716d]">run / work / step</p>
              </div>
              <div className="rounded-md bg-[#eef3f1] p-3">
                <p className="font-semibold">Registry</p>
                <p className="mt-1 text-[#66716d]">tool / skill / MCP</p>
              </div>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

function SpaceTile({
  space,
  active,
}: {
  space: (typeof spaces)[number];
  active: boolean;
}) {
  const Icon = space.icon;
  return (
    <div className={`rounded-md border p-3 transition ${active ? space.tone : 'border-white/10 bg-white/5 text-[#9aa8a2]'}`}>
      <div className="flex items-start gap-3">
        <Icon className="mt-0.5 h-5 w-5" aria-hidden="true" />
        <div>
          <p className="text-sm font-semibold">{space.name}</p>
          <p className="mt-1 text-xs leading-5 opacity-80">{space.role}</p>
        </div>
      </div>
      <div className="mt-4 flex items-center gap-2 text-xs">
        <span className={`h-2 w-2 rounded-full ${active ? 'bg-[#16a37f]' : 'bg-[#7c8983]'}`} />
        <span>{active ? 'ACTIVE' : 'IDLE'}</span>
        <span className="ml-auto font-mono">{space.metric}</span>
      </div>
    </div>
  );
}
