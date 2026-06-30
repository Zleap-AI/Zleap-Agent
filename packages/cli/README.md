# @zleap-ai/cli

Zleap 命令行客户端：Codex 风格 TUI、一次性脚本模式、IM 频道连接与配置管理。

## Golden Path（快速上手）

```bash
# 在项目根目录
pnpm install
pnpm link:cli

zleap init                    # 或直接进入 zleap（内联向导）
zleap serve --gateway         # 或 TUI 内 /serve
zleap                         # /connect wechat · 开聊
zleap doctor                  # 一键体检
```

零前置：`pnpm link:cli && zleap` 在无模型时也会进入 TUI 内联向导，无需先读文档。

## 子命令

| 命令 | 说明 |
|------|------|
| `(default)` | 交互 TUI 或 `zleap "prompt"` 一次性模式 |
| `serve` | 启动本地栈（Postgres + Web + Worker，可选 `--gateway`） |
| `status` | 查看服务健康状态（含 IM 频道） |
| `stop` | 停止 `zleap serve` 启动的本地栈 |
| `init` | 交互式首次配置向导（支持 `--force` / `--from-env`） |
| `doctor` | 检查 Node、数据库、模型、302/Web Search、embedding、gateway |
| `config list\|get\|set\|path\|edit` | 管理 `~/.zleap/config.json` |
| `channels list\|status\|connect\|refresh\|logout` | IM 频道（feishu / wechat / feishu-cli） |
| `connect <channel>` | `channels connect` 的别名 |

## 配置优先级

1. TUI `sessionModel` / CLI `--model-config-id`（数据库指定模型）
2. CLI flags（`--base-url` + `--api-key` + `--model`，或 `--model` 名称覆盖）
3. 数据库默认模型（需 `ZLEAP_DATABASE_URL` 且可达）
4. `~/.zleap/config.json` 中的 `model`
5. 环境变量 / 项目 `.env`（`ZLEAP_MODEL_*` / `LLM_*`）

数据库 URL：`ZLEAP_DATABASE_URL` > `config.json` > `.env`

环境加载顺序：自项目根向下 `.env` / `.env.local`，以及 `~/.zleap/.env`。

## IM 频道

```bash
zleap serve --gateway    # 一体化启动（推荐）
zleap channels connect wechat
zleap channels status
```

TUI 内：`/connect` 打开频道选择器，或 `/connect wechat` 直接连接；`/channels` 或 `/status` 查看状态。

## TUI Slash 命令

`/model` `/sessions` `/new` `/abort` `/status` `/serve` `/stop` `/config` `/doctor` `/connect` `/channels` `/spaces` `/memory` `/compact` `/clear` `/resume` `/help` `/exit`

- **Esc / `/abort`**：中断当前生成
- **`/stop`**：停止 `/serve` 启动的本地栈（不是中断生成）

TUI 底部状态栏显示 `DB · ctx% · 栈 · IM` 健康（每 30 秒刷新）。

## 全局 Flags

- `--continue` / `--resume` — 恢复上次会话（默认每次启动为新会话）
- `--fresh` — 与默认相同，强制新会话（可与 `--continue` 组合以取消续聊）
- `--model-config-id <id>` — 使用数据库中的模型配置 id
- `--model` — 覆盖模型名称（TUI 与一次性模式均生效）
- `--yes` — 一次性模式自动批准高风险工具
- `--prompt` — 指定一次性提问

## 冒烟测试

```bash
pnpm --filter @zleap-ai/cli build
bash packages/cli/scripts/smoke.sh
```
