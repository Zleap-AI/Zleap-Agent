# Zleap Agent Framework 设计文档

这组文档用于沉淀 Zleap Agent Framework 的核心理念、运行时模型、记忆系统、多租户隔离和后续 TypeScript 实现路线。

当前项目已经进入实现阶段。`ZLEAP_MASTER_PLAN.md` 是长期主计划；本目录文档用于解释核心理念和约束。每次重大实现调整都必须同步更新主计划和相关 docs，旧文档如果与最新决策冲突，以主计划和最新用户确认的规则为准。

## 核心判断

现在很多 agent 框架把 tools、memory、skills、context、planning、execution 全部塞进同一个 agent，让模型在一个巨大的上下文里自己决定一切。这种方式实现简单，但对模型能力和注意力要求极高。

Zleap 的核心思想是：

> LLM 的注意力是稀缺资源，agent 框架应该通过 workspace 把任务空间拆开，让模型在正确的上下文里做正确的事情。

因此，Zleap 不把 agent 理解成一个无限装载工具和记忆的对象，而是理解成一个稳定人格和稳定系统规则之上的运行时实体。它可以进入不同 workspace，在每个 workspace 中获得不同的工具、局部记忆和上下文。

## 概念总览

```text
Agent = LLM
      + System Prompt
      + Personality Prompt
      + Tools
      + Memory
      + Conversation Context
```

但在 Zleap 中，tools、部分 memory 和 conversation context 不应该全部挂在同一个全局 agent 上，而应该被 workspace 管理。

```text
Workspace = Tools
          + Event Memory
          + Skill Memory
          + Workspace-local Context
```

跨 workspace 保持稳定的是：

```text
Stable Agent Identity = LLM
                      + System Prompt
                      + Personality Prompt
                      + Cross-workspace Impression Memory
```

## 文档结构

- [01-agent-philosophy.md](./01-agent-philosophy.md)
  - agent 的定义、当前框架的问题、Zleap 的核心理念。
- [02-workspace-runtime.md](./02-workspace-runtime.md)
  - workspace 模型、主 workspace、子 workspace、切换机制、为什么这不是子 agent。
- [03-memory-model.md](./03-memory-model.md)
  - impression、event、skill 三类记忆的定义、隔离边界、生成机制和召回流程。
- [04-multi-tenant-isolation.md](./04-multi-tenant-isolation.md)
  - userid、多用户隔离、跨用户共享 skill、权限和安全边界。
- [05-hooks-and-lifecycle.md](./05-hooks-and-lifecycle.md)
  - 对话生命周期、hook、自动提取记忆、手动生成记忆、workspace 进入退出流程。
- [06-typescript-implementation-roadmap.md](./06-typescript-implementation-roadmap.md)
  - 后续 TypeScript 框架的模块划分、MVP 范围和 Web UI 路线。
- [07-context-and-prompt-contracts.md](./07-context-and-prompt-contracts.md)
  - prompt/context 装配顺序、注意力预算、runtime 不变量和模型循环契约。

## 设计原则

1. 注意力分区
   - 不让模型在无关工具、无关记忆、无关上下文中消耗注意力。

2. 稳定人格
   - agent 切换 workspace 时，不改变系统提示词和人格提示词。
   - workspace 切换改变的是工具、局部记忆和局部上下文。

3. workspace 即能力边界
   - 每个 workspace 类似一个软件或工作台。
   - 主 workspace 类似桌面，只负责看到有哪些能力，并编排任务。
   - 子 workspace 负责具体任务执行。

4. 记忆分层
   - impression 记人和自我认知。
   - event 记事情过程和结果。
   - skill 记执行经验和方法论。

5. 多租户优先
   - 框架从第一天开始考虑 userid。
   - 用户相关记忆必须隔离。
   - 可共享经验必须明确建模，不能隐式混淆。

6. 可成长
   - agent 不只是调用工具，还会在 event 中沉淀 skill。
   - skill 是 agent 在某个 workspace 中变聪明的主要机制。

7. 可运行
   - 最终目标不是只写理念文档，而是构建一个完整可运行的 TypeScript agent framework。
   - 需要包含基础 runtime、记忆存储、workspace 管理、工具调用和可体验的 Web UI。

## Runtime 不变量

后续实现时必须守住几个不变量：

1. 同一次 agent 运行中，system prompt 和 personality prompt 不随 workspace 切换而变化。
2. tool call 只能发生在当前 active workspace 内。
3. event memory 召回必须同时受 `userId` 和 `workspaceId` 约束。
4. skill memory 召回必须受 `workspaceId` 约束，但不受普通 `userId` 限制。
5. main workspace 只能看到 workspace manifest，不应该直接看到所有子 workspace tools。
6. workspace 退出必须返回结构化 result，而不是只返回自然语言。
7. 长期 memory 写入必须经过 runtime policy，而不是完全由模型自由决定。
8. memory 不是独立 workspace；memory tools 由 runtime 挂载到每个 workspace。
9. main workspace 通过 runtime 注入的 manifest 了解所有 workspace，不通过 `listWorkspaces` 工具发现。
10. 代码负责身份、scope、权限、工具可见性和持久化边界；模型只在当前暴露的边界内做选择。
11. 上下文只注入真实需要的投影视图：impression 固定最新 20 条，旧对话通过约 50 条 result event 和少量相关 process event 承接，原始明细留在日志和数据库。
12. `final_messages` 是原始 provider payload 日志，不是正常结构化上下文堆栈的一层；Web UI 的“显示原始日志”应把整个堆栈切换成原始文本模式，而不是额外追加一个 raw 日志栏。
