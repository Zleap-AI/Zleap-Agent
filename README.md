<p align="center">
  <img src="./assets/logo.png" alt="Zleap-Agent" width="420">
</p>

<p align="center">
  <strong>Workspace Is All Agents Need</strong>
</p>

<p align="center">
  English | <a href="./README_ZH.md">简体中文</a>
</p>

> Preview status
>
> Zleap-Agent is an early preview. The public repository is intended for source
> review, local development, and feedback. APIs, UI details, packaging, and
> release flows may change before a stable release.

## What Is Zleap-Agent?

Zleap-Agent is a workspace-first agent harness for local and OpenAI-compatible
models. It is built around one practical idea:

> An agent should not see every tool, memory, rule, and previous message on
> every step. It should first know which workspace it is in, then receive only
> the context needed for that workspace.

Instead of treating context as one large prompt, Zleap-Agent separates the
agent runtime into workspaces. Each workspace can have its own prompt, tools,
skills, memory, model, and execution history.

This makes the system easier to reason about when running smaller local models,
enterprise-local deployments, or workflows where permissions and data boundaries
matter.

## Workspace Demo

See how Zleap-Agent routes a task from Main into a focused workspace, keeps the
tool context narrow, and brings the result back to the conversation.

https://github.com/user-attachments/assets/e9bac9e8-88f0-4c8c-9ad9-d2588c6dae17

## Highlights

- Workspace isolation for prompts, tools, skills, models, memory, and history.
- Web UI for chat, workspaces, assistants, models, tools, MCP servers, skills,
  memory, tasks, gateway configuration, and artifacts.
- CLI powered by the same runtime as the Web UI.
- PostgreSQL-backed memory and runtime persistence.
- Built-in file, command, system, and MCP tool support.
- Approval-required and full-access permission modes.
- Task worker and IM gateway foundations for long-running or external-channel
  workflows.
- OpenAI-compatible model provider support, with Anthropic provider code also
  present in the workspace packages.

## Concepts

### Workspace

A workspace is not just a tool group. It is an isolation boundary for the
context the agent sees and the actions it can take.

Common examples:

- `Main`: talks to the user, understands the goal, and routes work.
- `Cli`: reads and writes files, runs commands, and works inside a project.
- `Web Search`: searches and reads public web pages.
- Custom workspaces: engineering, research, operations, finance, support, or
  any other domain-specific workbench.

### Context Layout

Zleap-Agent treats context as a runtime layout:

```text
Context = System Prompt + Workspace Prompt + Tools + Memory + History
```

The runtime avoids loading every available tool, memory, and trace into every
turn. Workspaces keep the model focused on the current job.

### Memory

Memory is partitioned instead of being stored in one generic bucket:

- Person memory: user preferences and stable user facts.
- Event memory: facts and state related to a user, task, or workspace.
- Experience memory: reusable methods learned from completed work.

PostgreSQL is used because memory participates in the agent loop and needs
retrieval, isolation, auditability, and rollback.

### Skill

Skills are reusable capability packages, usually centered around a `SKILL.md`
entry file. Tools are APIs; skills are workflows, instructions, examples, and
supporting resources that help an agent perform a class of work.

## Quick Start From Source

![Zleap-Agent Web UI preview](./assets/webui-preview.png)

### Requirements

- Node.js 20+
- pnpm 9.x
- Docker Desktop, or a reachable PostgreSQL database with pgvector

### Install

```bash
git clone https://github.com/Zleap-AI/Zleap-Agent.git
cd Zleap-Agent

corepack enable
corepack prepare pnpm@9.15.0 --activate
pnpm install
```

### Start the Web UI

```bash
pnpm dev:web
```

This command starts the local development path:

1. Loads environment from the repo root when present.
2. Starts or connects to PostgreSQL.
3. Builds the required workspace packages.
4. Runs database migrations.
5. Starts the Next.js Web UI.

Open:

```text
http://localhost:3000
```

If you already have PostgreSQL available:

```bash
ZLEAP_DATABASE_URL=postgres://user:password@127.0.0.1:5432/zleap pnpm dev:web
```

### Configure a Model

In the Web UI, open settings and add an OpenAI-compatible model provider.
For CLI experiments you can also use environment variables:

```bash
ZLEAP_MODEL_BASE_URL=https://api.example.com/v1
ZLEAP_MODEL_API_KEY=sk-...
ZLEAP_MODEL_NAME=qwen3.6-flash
```

## CLI Usage

Start the CLI through the workspace package:

```bash
pnpm cli
```

Or run a one-shot prompt:

```bash
ZLEAP_MODEL_BASE_URL=https://api.example.com/v1 \
ZLEAP_MODEL_API_KEY=sk-... \
ZLEAP_MODEL_NAME=qwen3.6-flash \
ZLEAP_DATABASE_URL=postgres://zleap:zleap@127.0.0.1:5433/zleap \
pnpm --filter @zleap-ai/cli start -- "Summarize this repository"
```

Allow high-risk tools in one-shot mode:

```bash
pnpm --filter @zleap-ai/cli start -- --yes "Create a README draft in the current directory"
```

## Common Commands

```bash
pnpm dev:web       # Web UI development loop
pnpm dev           # Web UI + task worker + gateway development loop
pnpm dev:tasks     # Task worker only
pnpm dev:gateway   # IM gateway worker only
pnpm cli           # Start the CLI
pnpm build         # Build all packages
pnpm check         # Build and type-check all packages
pnpm test          # Run package tests
```

## Environment Variables

| Variable | Description |
| --- | --- |
| `ZLEAP_DATABASE_URL` | PostgreSQL connection string for persistence, memory, skills, and tasks. |
| `ZLEAP_MODEL_BASE_URL` | OpenAI-compatible LLM base URL. |
| `ZLEAP_MODEL_API_KEY` | LLM API key. |
| `ZLEAP_MODEL_NAME` | Default LLM model name. |
| `ZLEAP_EMBED_BASE_URL` | Embedding provider base URL. |
| `ZLEAP_EMBED_API_KEY` | Embedding provider API key. |
| `ZLEAP_EMBED_MODEL` | Embedding model name. |
| `ZLEAP_EMBED_DIM` | Embedding vector dimension. |
| `ZLEAP_FILE_WORKSPACE_ROOT` | Default file workspace root when no project is selected. |
| `ZLEAP_WEB_SKILLS_ROOT` | Local skill directory scanned by the Web UI. |

## Repository Layout

```text
assets/            public README assets
packages/ai        model providers and model-call abstraction
packages/agent     core agent runtime, workspace, skill, tool, and memory logic
packages/avatar    inbound, scheduled, and web-chat run assembly
packages/cli       terminal UI and CLI entrypoint
packages/core      shared types and policy primitives
packages/gateway   Feishu, WeChat, and long-connection gateway workers
packages/host      local supervisor, Postgres bootstrap, install/update helpers
packages/runtime   runtime-facing workspace and conversation APIs
packages/store     PostgreSQL storage, migrations, and recall logic
packages/tasks     scheduled task service and worker
packages/web       Next.js Web UI
scripts/           source-development and package build helper scripts
```

## Public Repository Notes

The public GitHub repository keeps source code, README assets, and the helper
scripts needed to run and build from source. Maintainer-only release packaging,
signing, mirror-sync tooling, internal planning notes, local agent files,
generated output, and secrets are kept out of the public tree.

## Project Status

Zleap-Agent is under active development. Areas still moving quickly include:

- workspace and model routing,
- memory extraction and retrieval quality,
- skill compatibility,
- gateway setup flows,
- desktop and release packaging,
- UI polish and end-to-end tests.

Feedback, issues, and focused contributions are welcome.

## License

The license has not been finalized for the preview release. Please do not assume
production redistribution rights until a license file is published.
