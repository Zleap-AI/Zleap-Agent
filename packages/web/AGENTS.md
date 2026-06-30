# AGENTS.md — packages/web (Zleap Web)

Next.js 16 (App Router) + React 19 + Tailwind CSS v4 + shadcn/ui + radix-ui 的 AI agent 聊天前端。

## 设计原则（对标 codex）

- 中性克制骨架 + 铜金/琥珀单一强调色；cardless 优先，用分区/分隔/列表/留白替代堆卡片。
- 两种字体封顶：Inter (sans) + JetBrains Mono (mono)，经 `next/font` 加载（见 `app/layout.tsx`）。
- 克制动效，统一从设计 token 取值。

## 单一真源

- 设计 token 全在 `app/globals.css`（颜色 / 圆角 / 阴影 / 字号 / 动效）。组件零硬编码。
- UI 原语在 `components/ui/*`，跨域复合原语在 `components/shared/*`。
- 数据访问在 `lib/services/*`；React 状态 hooks 在 `lib/` / `hooks/`。

## 硬性规范

- 禁止：className 内硬编码颜色 / 任意像素 / 裸 `<button>`/`<input>`/`<textarea>` / 组件内 `fetch` / 硬编码文案。
- 必须：走 token、走 `components/ui`、走 `lib/services`、走 `t()` i18n（key 在 `lib/i18n/resources.ts`）。
- 详见 `.cursor/rules/frontend.mdc`。

## 常用命令

```bash
pnpm --filter @zleap/web dev:next   # 本地开发
pnpm --filter @zleap/web check      # tsc 类型检查
pnpm --filter @zleap/web test       # vitest 回归
pnpm --filter @zleap/web build      # 生产构建
```

## 验收

每次改动后跑 `check` + `test`；关键视图过 dark mode 与三档响应式断点。
