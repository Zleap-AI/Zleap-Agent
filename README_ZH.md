<p align="center">
  <img src="./assets/logo.png" alt="Zleap-Agent" width="420">
</p>

<p align="center">
  <strong>Workspace Is All Agents Need</strong>
</p>

<p align="center">
  <a href="./README.md">English</a> | 简体中文
</p>

> Preview 状态
>
> Zleap-Agent 目前仍是早期预览版本。公开仓库主要用于源码阅读、本地开发和反馈收集。稳定版发布前，API、UI、打包和发布流程都可能继续调整。

## Zleap-Agent 是什么？

Zleap-Agent 是一个 workspace-first 的 Agent Harness，面向本地模型和 OpenAI-compatible 模型。

它的核心判断是：

> Agent 不应该每一步都看到所有工具、记忆、规则和历史消息。它应该先知道自己在哪个 Workspace，再只拿到这个 Workspace 真正需要的上下文。

Zleap-Agent 不把上下文当作一段越来越长的大 prompt，而是把运行时拆成不同 Workspace。每个 Workspace 可以拥有自己的提示词、工具、技能、记忆、模型和执行历史。

这对本地小模型、企业内网部署，以及需要权限和数据边界的工作流尤其重要。

## Workspace 演示

这段视频展示了 Zleap-Agent 如何从 Main 理解目标、进入聚焦的 Workspace、
只携带当前任务需要的工具上下文，并把执行结果带回对话。

https://github.com/user-attachments/assets/59d12c59-ed48-46b0-8c10-3bb7dac01423

## 亮点

- Workspace 隔离提示词、工具、技能、模型、记忆和历史。
- Web UI 支持对话、空间、助手、模型、工具、MCP、技能、记忆、任务、网关配置和产物管理。
- CLI 与 Web UI 共用同一套运行时。
- 基于 PostgreSQL 的记忆和运行时持久化。
- 内置文件、命令、系统和 MCP 工具支持。
- 支持请求审批和完全访问两种权限模式。
- 具备任务 Worker 和 IM 网关基础能力，适合长任务和外部渠道接入。
- 支持 OpenAI-compatible 模型提供方，仓库中也包含 Anthropic provider 代码。

## 核心概念

### Workspace

Workspace 不只是工具分组，而是 Agent 可见上下文和可执行动作的隔离边界。

常见例子：

- `Main`：和用户沟通、理解目标、路由任务。
- `Cli`：读写文件、运行命令、在项目目录里执行开发任务。
- `Web Search`：搜索并读取公开网页。
- 自定义 Workspace：研发、研究、运营、财务、客服或其他领域工作台。

### Context Layout

Zleap-Agent 把上下文当作运行时布局：

```text
Context = System Prompt + Workspace Prompt + Tools + Memory + History
```

运行时不会把所有工具、记忆和执行记录都塞进每一轮对话，而是通过 Workspace 让模型聚焦当前任务。

### Memory

记忆不是一个泛化的长期记忆桶，而是分区管理：

- 对人的记忆：用户偏好和稳定事实。
- 对事的记忆：和用户、任务或 Workspace 相关的事件和状态。
- 经验记忆：从已完成任务中沉淀出的可复用方法。

记忆使用 PostgreSQL，因为它参与 Agent 每一轮运行，需要检索、隔离、审计和回滚能力。

### Skill

Skill 是可复用能力包，通常以 `SKILL.md` 为入口。工具更像 API，Skill 更像一套工作流、说明、示例和配套资源。

## 从源码快速启动

![Zleap-Agent Web UI 预览](./assets/webui-preview.png)

### 环境要求

- Node.js 20+
- pnpm 9.x
- Docker Desktop，或一个可连接的 PostgreSQL + pgvector 数据库

### 安装依赖

```bash
git clone https://github.com/Zleap-AI/Zleap-Agent.git
cd Zleap-Agent

corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install
```

### 启动 Web UI

```bash
pnpm dev:web
```

这个命令会执行本地开发路径：

1. 读取仓库根目录环境变量文件。
2. 启动或连接 PostgreSQL。
3. 构建必要的 workspace packages。
4. 执行数据库迁移。
5. 启动 Next.js Web UI。

打开：

```text
http://localhost:3000
```

如果已经有自己的 PostgreSQL：

```bash
ZLEAP_DATABASE_URL=postgres://user:password@127.0.0.1:5432/zleap pnpm dev:web
```

### 配置模型

进入 Web UI 后，在设置里添加 OpenAI-compatible 模型提供方。
CLI 实验也可以使用环境变量：

```bash
ZLEAP_MODEL_BASE_URL=https://api.example.com/v1
ZLEAP_MODEL_API_KEY=sk-...
ZLEAP_MODEL_NAME=qwen3.6-flash
```

## CLI 使用

启动 CLI：

```bash
pnpm cli
```

一次性运行：

```bash
ZLEAP_MODEL_BASE_URL=https://api.example.com/v1 \
ZLEAP_MODEL_API_KEY=sk-... \
ZLEAP_MODEL_NAME=qwen3.6-flash \
ZLEAP_DATABASE_URL=postgres://zleap:zleap@127.0.0.1:5433/zleap \
pnpm --filter @zleap/cli start -- "总结这个仓库"
```

一次性模式允许高风险工具自动执行：

```bash
pnpm --filter @zleap/cli start -- --yes "在当前目录生成 README 草稿"
```

## 常用命令

```bash
pnpm dev:web       # Web UI 开发循环
pnpm dev           # Web UI + task worker + gateway 开发循环
pnpm dev:tasks     # 仅启动任务 worker
pnpm dev:gateway   # 仅启动 IM gateway worker
pnpm cli           # 启动 CLI
pnpm build         # 构建所有 packages
pnpm check         # 构建并执行类型检查
pnpm test          # 运行 package tests
```

## 环境变量

| 变量 | 说明 |
| --- | --- |
| `ZLEAP_DATABASE_URL` | PostgreSQL 连接串，用于持久化、记忆、技能和任务。 |
| `ZLEAP_MODEL_BASE_URL` | OpenAI-compatible LLM base URL。 |
| `ZLEAP_MODEL_API_KEY` | LLM API key。 |
| `ZLEAP_MODEL_NAME` | 默认 LLM 模型名。 |
| `ZLEAP_EMBED_BASE_URL` | Embedding provider base URL。 |
| `ZLEAP_EMBED_API_KEY` | Embedding provider API key。 |
| `ZLEAP_EMBED_MODEL` | Embedding 模型名。 |
| `ZLEAP_EMBED_DIM` | Embedding 向量维度。 |
| `ZLEAP_FILE_WORKSPACE_ROOT` | 未选择项目时的默认文件工作区根目录。 |
| `ZLEAP_WEB_SKILLS_ROOT` | Web UI 扫描的本地技能目录。 |

## 仓库结构

```text
assets/            README 公开资源
packages/ai        模型提供方和模型调用抽象
packages/agent     Agent 运行时、Workspace、Skill、Tool、Memory 逻辑
packages/avatar    inbound、scheduled、web chat 运行组装
packages/cli       终端 UI 和 CLI 入口
packages/core      共享类型和策略基础
packages/gateway   飞书、微信和长连接网关 worker
packages/host      本地 supervisor、Postgres bootstrap、安装/更新辅助
packages/runtime   面向运行时的 workspace 和 conversation API
packages/store     PostgreSQL 存储、迁移和召回逻辑
packages/tasks     定时任务服务和 worker
packages/web       Next.js Web UI
scripts/           源码开发和包构建辅助脚本
```

## 公开仓库说明

GitHub 公开仓库只保留源码、README 资源，以及从源码运行和构建所需的辅助脚本。维护者内部使用的 release 打包、签名、镜像同步工具、内部规划、本地 agent 文件、生成产物和密钥不进入公开树。

## 项目状态

Zleap-Agent 正在快速开发中，近期仍会持续变化的部分包括：

- Workspace 和模型路由。
- 记忆抽取和召回质量。
- Skill 兼容性。
- 网关配置流程。
- 桌面端和发布打包。
- UI 细节和端到端测试。

欢迎反馈、提 issue 和提交聚焦的贡献。

## License

预览版本的 License 尚未最终确定。在仓库发布 license 文件前，请不要默认假设具备生产再分发授权。
