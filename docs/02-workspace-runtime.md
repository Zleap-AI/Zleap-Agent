# Workspace Runtime

## 2026-05-31 update: workspace context category

In context display and prompt assembly, workspace information is one top-level category. It contains the active workspace description, instructions, tool instructions, manifest, memory policy, and current callable tool definitions. Only the main workspace includes the available workspace manifest list inside this workspace contract. Child workspaces do not receive sibling workspace lists.

## 2026-05-31 update: workspace-first tool registration and MCP execution

2026-05-31 clarification: MCP setup is server-first, not tool-first. A workspace owns one or more MCP Server definitions. Each server is either local stdio (`command`, `args`, `env`, `cwd`) or remote Streamable HTTP (`url`, `headers`). The UI saves the server, runs discovery against that selected server with `client.listTools()`, then lets the creator choose which discovered tools to mount into the same workspace. Imported tools store the discovered name, description, input schema, `mcpServerId`, `mcpToolName`, and a generated execution binding snapshot. Users should not have to decide per tool which MCP Server it came from; that is derived from the server being discovered.

工具安装的产品心智是先有 workspace，再把工具注册进这个 workspace。底层 SQLite 仍可用 `tool_definitions` 和 `workspace_tools` 做规范化存储，但非 runtime 工具必须带有明确的 workspace 归属；UI 不应该把工具表现成一个所有 workspace 共享的全局池。

workspace 工具管理需要支持：

- 在当前 workspace 内新增工具。
- 编辑当前 workspace 内工具的名称、说明、参数 JSON Schema、风险等级和绑定配置。
- 删除当前 workspace 内的非系统工具。
- 从 MCP server 发现工具，并把发现到的工具导入当前 workspace。

Runtime MCP 执行已经不是占位概念。MCP-bound tool 使用官方 TypeScript SDK：stdio server 通过 `StdioClientTransport` 启动进程，远程 server 通过 `StreamableHTTPClientTransport` 连接；发现工具使用 `client.listTools()`，执行工具使用 `client.callTool()`。连接失败、配置缺失、超时或工具执行错误都应作为 structured failed tool result 写入 `tool_calls`，不能静默失败。

## 2026-05-31 更新：代码边界与当前实现口径

当前实现以 `ZLEAP_MASTER_PLAN.md` 为准：首版内置 workspace 是 `main`、`file`、`cli`，没有独立 `memory workspace`，Browser workspace 只作为未来扩展示例。memory 能力以通用 runtime tools 的形式挂载到每个 workspace 中。

main workspace 不通过 `listWorkspaces` 工具发现能力。runtime 会把所有可用 workspace 的 manifest（名称、描述、capabilities、input/output kinds、risk、approval flag）直接注入 main 的 context。main 可以在这些 manifest 里做选择，但不能自由枚举数据库、也不能直接调用子 workspace 的底层工具。

模型自由决定的是：是否直接回答、是否通过 `askUser` 询问用户、是否通过 `finishTask` 结束当前轮、是否调用当前 workspace 暴露的工具、是否通过 `enterWorkspace` 请求进入某个 manifest 中的 workspace。代码强制决定的是：当前 active workspace、可见工具集、memory scope、tenant ownership、approval、MCP executor 是否已连接、以及所有 persistence/audit 行为。

用户在 Web UI 中看到的 workspace 管理是能力安装/配置界面。实际创建、编辑、删除 workspace 属于 creator/operator 级操作；普通模型 tool call 不能注册新 workspace，也不能自行绑定工具或修改 memory policy。

## 2026-05-30 更新：子 workspace 退出和交付边界

进入子 workspace 只表示 runtime 创建了 `WorkspaceTask`、召回了局部 memory、绑定了当前工具，并开始一个 `running` 的 `WorkspaceSession`。这时子 workspace 还没有向 main workspace 交付结果。

同样，进入 main workspace 也只表示主编排 session 开始运行。main session 不应在 LLM 产出前被标记为 completed；只有 `askUser`、`finishTask` 或 main 的最终自然语言答复形成后，runtime 才提交 main `WorkspaceResult` 并记录审计事件。

子 workspace 退出到 main workspace 的唯一正常路径是调用 `exitWorkspace`，并提交完整的 `WorkspaceResult`：

```ts
type WorkspaceResult = {
  status: "completed" | "failed" | "blocked" | "needs_user_input" | "needs_approval";
  summary: string;
  artifacts: Array<{ kind: string; ref: string; description?: string }>;
  observations: string[];
  errors: string[];
  suggestedNextSteps: string[];
};
```

交付给 main workspace 的内容应该是可编排的结果：状态、摘要、产物引用、关键观察、错误和下一步建议。子 workspace 的原始工具输出、召回的 event/skill、局部证据、recent tool calls、调试细节和后续 event/skill 提取证据，应保留在 `WorkspaceSession`、`tool_calls`、`audit_logs` 和 memory metadata 中供 Web UI 检查，而不是全部塞回 main workspace。

`running` 是 runtime 内部 session 状态，不是可交付的 `WorkspaceResult.status`。如果模型试图用 `running` 退出，runtime 必须拒绝该 tool call，并保持子 workspace 仍处于 active/running 状态。

`exitWorkspace` 只能提交当前仍然 `running` 的 active child `WorkspaceSession`。如果同一个 assistant tool-call batch 里重复发出 `exitWorkspace`，第一次合法退出会提交结果，后续重复退出必须作为 failed tool result 记录，不能覆盖已经交付给 main workspace 的 `WorkspaceResult`。

如果子 workspace 直接返回自然语言 assistant content，而没有调用 `exitWorkspace`，这段内容不能作为最终用户回答。runtime 必须把它作为内部 trace/debug 证据保存，追加内部提醒要求模型调用 `exitWorkspace`，并继续执行 tool loop。达到最大轮次仍未退出时，runtime 记录 `workspace_exit_missing`，子 workspace 继续保持 running，不能被静默标记为完成。

## Workspace 的定义

workspace 是 Zleap 中最重要的运行时边界。

一个 workspace 表示 agent 当前所处的能力空间。

```text
Workspace = Tools
          + Tool Usage Instructions
          + Event Memory
          + Skill Memory
          + Workspace-local Context
```

它不是子 agent，也不是简单的工具集合。workspace 同时定义：

- 当前能调用哪些工具。
- 工具应该如何被使用。
- 当前 workspace 内有哪些相关事件记忆。
- 当前 workspace 内有哪些可复用技能经验。
- 当前 workspace 的对话上下文如何组织。

## 为什么需要 workspace

LLM 在执行任务时，不是看到越多越好。

一个复杂 agent 可能拥有几十个甚至上百个工具。如果这些工具全部暴露给模型，模型需要在每一步都做额外判断：

- 当前任务需要哪个工具？
- 这个工具和另一个工具有什么区别？
- 哪些工具描述与当前任务无关？
- 哪些记忆值得参考？
- 哪些历史上下文可以忽略？

workspace 的作用是提前替模型缩小搜索空间。

主 workspace 负责选择“打开哪个软件”，子 workspace 负责在“软件内部完成具体操作”。

## Workspace 类型

### 1. Main Workspace

主 workspace 是默认入口。

它的职责：

- 接收用户输入。
- 理解目标。
- 拆分任务。
- 读取 runtime 注入的可用 workspace manifest。
- 选择进入某个 workspace。
- 接收 workspace 返回结果。
- 整合结果并决定下一步。

主 workspace 应该拥有的工具很少，主要是编排工具：

- `enterWorkspace`
- `askUser`
- `finishTask`

`askUser` and `finishTask` are terminal main-workspace orchestration exits for the current turn. When either tool succeeds, runtime commits a `WorkspaceResult` to the main `WorkspaceSession`, records `main_workspace_result_committed`, writes the tool call to trace, and returns the tool-provided user-facing message directly. Runtime must not make a second LLM call just to translate these tool results back to the user.

主 workspace 不通过 `listWorkspaces` 工具发现 workspace。runtime 会把可用 workspace manifest 清单直接注入 main workspace 的 context。`exitWorkspace` 只在子 workspace 中可用，用于把结构化 `WorkspaceResult` 交回 main。

`enterWorkspace`、`askUser`、`finishTask` 也只属于 main workspace。这个限制由 runtime 强制执行，而不是只靠 prompt：即使这些工具被错误绑定到子 workspace，子 workspace 的 callable tools 里也不能出现它们；如果模型强行调用，必须失败。子 workspace 想请求用户输入、建议切换 sibling workspace、或表示任务完成时，都应该通过 `exitWorkspace` 的 `status` 和 `suggestedNextSteps` 交给 main 决定。

workspace session 的 `localContext.availableTools` 必须和这套 runtime 可见性保持一致。它不是数据库绑定表的原样拷贝，而是“这一轮模型实际可调用工具”的调试快照：子 workspace 应包含 `exitWorkspace` 和通用 memory tools，但不能显示 `enterWorkspace`、`askUser` 或 `finishTask`。

主 workspace 的 memory 和 skill 也应该围绕编排能力：

- 用户通常如何表达任务。
- 哪些任务适合哪些 workspace。
- 某类任务的拆分方式。
- workspace 切换的成功或失败经验。

### 2. Domain Workspace

领域 workspace 负责具体能力。

例如：

```text
CLI Workspace
  Tools:
    - runCommand
    - readTerminal
  Event Memory:
    - 某项目中过去执行过的命令
    - 某次构建失败的过程和结果
  Skill Memory:
    - 运行测试前应该先检查 package manager
    - Windows PowerShell 下某些命令需要特殊处理
```

```text
File Workspace
  Tools:
    - readFile
    - writeFile
    - searchFiles
    - parseDocument
  Event Memory:
    - 用户过去处理过哪些文件
    - 某次文件转换的过程和结果
  Skill Memory:
    - 处理大文件时先读取目录和摘要
    - 修改配置文件前先确认 schema
```

```text
Browser Workspace
  Tools:
    - navigate
    - click
    - type
    - screenshot
    - inspectDom
  Event Memory:
    - 某个页面的测试过程
    - 某次 UI 验证的结果
  Skill Memory:
    - 修改前端后需要桌面和移动视口都截图验证
    - canvas 页面不能只看 DOM，需要检查像素
```

### 3. Creator-registered Workspace

creator/operator 可以根据已注册 tools 组合创建 workspace。

这类似于给 agent 安装新软件。

workspace 创建后：

- workspace 注册到 registry。
- 主 workspace 可以看到它。
- 主 workspace 可以根据描述决定是否进入它。
- workspace 拥有自己的 event memory 和 skill memory。

创建 workspace 时至少需要提供：

- workspace id。
- workspace name。
- workspace description。
- tools 列表。
- 工具使用说明。
- 是否允许共享 skill。
- memory 策略。

## Workspace Registry

框架需要一个 workspace registry。

registry 是主 workspace 看到的“桌面图标列表”。

每个 workspace 在 registry 中应该有一个轻量描述：

```ts
type WorkspaceManifest = {
  id: string;
  name: string;
  description: string;
  capabilities: string[];
  inputKinds: string[];
  outputKinds: string[];
  riskLevel: "low" | "medium" | "high";
  requiresApproval?: boolean;
};
```

主 workspace 不需要看到每个 workspace 的全部工具细节，只需要知道：

- 它能做什么。
- 什么时候应该进入它。
- 输入输出大概是什么。
- 是否有风险或需要确认。

## Workspace Session

一次进入 workspace 会创建一个 workspace session。

```text
Workspace Session = workspace id
                  + userid
                  + conversation id
                  + task id
                  + local context
                  + recalled event memories
                  + recalled skill memories
                  + tool call history
```

workspace session 的作用：

- 记录本次子任务的执行过程。
- 限制上下文不污染其他 workspace。
- 生成 event memory。
- 为 skill 提取提供材料。
- 返回结构化结果给主 workspace。

## Workspace 切换

workspace 切换可以理解为一个栈。

```text
Main Workspace
  -> enter CLI Workspace
     -> CLI Workspace returns result
  -> enter File Workspace
     -> File Workspace returns result
  -> Main Workspace summarizes final answer
```

切换时保持不变：

- LLM provider。
- Agent identity。
- System prompt。
- Personality prompt。
- Cross-workspace impression memory。

切换时发生变化：

- tool set。
- tool instructions。
- workspace event memory。
- workspace skill memory。
- workspace-local conversation context。

## Workspace 输入输出

主 workspace 进入子 workspace 时，不应该把所有对话历史塞进去，而应该提供一个结构化任务包。

```ts
type WorkspaceTask = {
  taskId: string;
  userId: string;
  conversationId: string;
  workspaceId: string;
  objective: string;
  constraints: string[];
  relevantUserRequest: string;
  expectedOutput: string;
  parentContextSummary: string;
};
```

子 workspace 返回结果时，也应该结构化：

```ts
type WorkspaceResult = {
  taskId: string;
  workspaceId: string;
  status: "completed" | "failed" | "blocked" | "needs_user_input" | "needs_approval";
  summary: string;
  artifacts: Array<{
    kind: string;
    ref: string;
    description?: string;
  }>;
  observations: string[];
  errors: string[];
  suggestedNextSteps: string[];
};
```

这样主 workspace 不需要解析一大段自然语言才能理解发生了什么。

## Context 组织

每个 workspace 都有自己的 context 策略。

推荐分层：

```text
Global Context
  - system prompt
  - personality prompt
  - active user impression
  - agent self impression

Main Workspace Context
  - current user request
  - workspace registry summary
  - orchestration memory
  - orchestration skill
  - workspace results

Child Workspace Context
  - workspace task
  - workspace tool instructions
  - recalled event memory
  - recalled skill memory
  - local tool call history
```

核心目标是避免把所有历史对话传给每个 workspace。

## Workspace 与权限

workspace 是权限控制的自然边界。

例如：

- CLI workspace 风险高，需要命令执行权限。
- File workspace 可能需要文件写入权限。
- 未来 Browser workspace 风险可能较低，但涉及外部网站时仍可能需要网络权限。
- Memory 不是独立 workspace；memory 工具挂载在每个 workspace 中，仍然需要严格 userid、workspaceId 和 creator policy 隔离。

每个 workspace manifest 应该声明风险级别和权限需求。

## Workspace 示例：参考 Codex

当前可以参考 Codex 本身的工作方式来设计初始 workspace：

### Main Workspace

负责任务编排。

```text
可见：
  - CLI workspace
  - File workspace
  - 其他由 creator 注册的 workspace manifest
```

### CLI Workspace

负责命令行执行。

```text
tools:
  - shell command
  - read terminal
memory:
  - 某项目的命令执行历史
  - 不同操作系统 shell 的经验
skill:
  - 如何运行测试
  - 如何识别 sandbox/network 错误
```

### File Workspace

负责文件处理。

```text
tools:
  - read file
  - write file
  - search files
  - apply patch
memory:
  - 项目结构
  - 修改过的文件
skill:
  - 如何在大型项目中先搜索再修改
  - 如何避免覆盖用户改动
```

### Browser Workspace（未来扩展示例）

负责 Web UI 验证。

```text
tools:
  - open page
  - screenshot
  - inspect DOM
  - click/type
memory:
  - 页面验证记录
skill:
  - 前端修改后需要多视口检查
```
