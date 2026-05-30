# Workspace Runtime

## 2026-05-30 更新：子 workspace 退出和交付边界

进入子 workspace 只表示 runtime 创建了 `WorkspaceTask`、召回了局部 memory、绑定了当前工具，并开始一个 `running` 的 `WorkspaceSession`。这时子 workspace 还没有向 main workspace 交付结果。

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
- 查看可用 workspace 列表。
- 选择进入某个 workspace。
- 接收 workspace 返回结果。
- 整合结果并决定下一步。

主 workspace 应该拥有的工具很少，主要是编排工具：

- `enterWorkspace`
- `askUser`
- `finishTask`

主 workspace 不通过 `listWorkspaces` 工具发现 workspace。runtime 会把可用 workspace manifest 清单直接注入 main workspace 的 context。`exitWorkspace` 只在子 workspace 中可用，用于把结构化 `WorkspaceResult` 交回 main。

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

### 3. User-created Workspace

用户可以根据 tools 组合创建自己的 workspace。

这类似于给 agent 安装新软件。

用户创建 workspace 后：

- workspace 注册到 registry。
- 主 workspace 可以看到它。
- 主 workspace 可以根据描述决定是否进入它。
- workspace 拥有自己的 event memory 和 skill memory。

用户创建 workspace 时至少需要提供：

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
  status: "completed" | "failed" | "blocked" | "needs_user_input";
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
- Browser workspace 风险较低，但涉及外部网站时可能需要网络权限。
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
  - Browser workspace
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

### Browser Workspace

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
