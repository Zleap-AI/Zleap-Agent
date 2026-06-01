# 工作空间运行时

## 当前实现口径

当前实现以 `ZLEAP_MASTER_PLAN.md` 为准：首版内置工作空间是 `main` 和统一的 `dev`，没有独立的 `memory workspace`，Browser workspace 只作为未来扩展示例。记忆能力以通用 runtime tools 的形式挂载到每个工作空间中。

`main` 工作空间不通过 `listWorkspaces` 工具发现能力。runtime 会把所有可用工作空间的 manifest（名称、描述、能力、输入输出协议、风险等级和审批标记）直接注入 `main` 的上下文。`main` 可以在这些 manifest 中做选择，但不能自由枚举数据库，也不能直接调用子工作空间的底层工具。

模型自由决定的是：是否直接回答、是否通过 `askUser` 询问用户、是否通过 `finishTask` 结束当前轮、是否调用当前工作空间暴露的工具、是否通过 `enterWorkspace` 请求进入某个 manifest 中的工作空间。

代码强制决定的是：当前 active workspace、可见工具集、记忆 scope、租户归属、审批、MCP executor 是否已连接，以及所有持久化和审计行为。

用户继续输入时，runtime 还要强制判断是否存在可续跑的子工作空间会话。如果同一 conversation 中最后一个非 `main` session 仍处于 `running`、`failed`、`blocked`、`needs_user_input` 或 `needs_approval`，下一条用户消息会直接恢复这个工作空间，而不是重新创建 main 编排 session。这样手动停止、工具失败、审批等待或用户补充信息之后，都能接着原来的能力边界、局部上下文和工具证据继续推进。只有子工作空间通过 `exitWorkspace` 返回结构化结果后，控制权才回到 main。

用户在 Web UI 中看到的工作空间管理是能力安装/配置界面。实际创建、编辑、删除工作空间属于 creator/operator 级操作；普通模型 tool call 不能注册新工作空间，也不能自行绑定工具或修改记忆策略。

## 工作空间上下文类别

在上下文展示和 prompt 装配中，工作空间信息是一个顶层类别。它包含当前工作空间说明、manifest、记忆策略和本次可调用工具定义。

`main` 和子工作空间都可以看到可用工作空间 manifest 清单，把它作为共享能力地图；区别是只有 `main` 收到 `enterWorkspace`，子工作空间只能通过 `exitWorkspace.suggestedNextSteps` 建议由 `main` 调度到其他工作空间。

工作空间信息还必须表达产物责任边界。子工作空间不是“理解了最终目标就可以继续代做”的自由 agent，而是当前能力切片的执行环境。它只能交付自己工具和说明真实支持的结果；如果下一步需要别的能力，就把已完成内容、证据、缺口和建议写入 `WorkspaceResult`，然后退出给 `main`。例如搜索工作空间完成搜索后应交付搜索结果、来源、可信度和下一步建议，而不是直接生成网页或写文件；网页生成和文件写入应由 `main` 再调度到开发/文件类工作空间完成。

## 工作空间优先的工具注册与 MCP 执行

MCP 配置是 server-first，不是 tool-first。一个工作空间拥有一个或多个 MCP Server 定义。每个 server 可以是本地 stdio（`command`、`args`、`env`、`cwd`），也可以是远程 Streamable HTTP（`url`、`headers`）。UI 先保存 server，再对选中的 server 调用 `client.listTools()` 做发现，然后让 creator 选择把哪些发现到的工具挂载到同一个工作空间中。

导入的工具需要保存发现到的名称、说明、输入 schema、`mcpServerId`、`mcpToolName` 和生成出来的执行绑定快照。用户不应该逐个工具决定“来自哪个 MCP Server”；这个来源由当前正在发现的 server 决定。

工具安装的产品心智是先有 workspace，再把工具注册进这个 workspace。底层 SQLite 仍可用 `tool_definitions` 和 `workspace_tools` 做规范化存储，但非 runtime 工具必须带有明确的 workspace 归属；UI 不应该把工具表现成一个所有 workspace 共享的全局池。

workspace 工具管理需要支持：

- 在当前 workspace 内新增工具。
- 编辑当前 workspace 内工具的名称、说明、参数 JSON Schema、风险等级和绑定配置。
- 删除当前 workspace 内的非系统工具。
- 从 MCP server 发现工具，并把发现到的工具导入当前 workspace。

Runtime MCP 执行不是占位概念。MCP-bound tool 使用官方 TypeScript SDK：stdio server 通过 `StdioClientTransport` 启动进程，远程 server 通过 `StreamableHTTPClientTransport` 连接；发现工具使用 `client.listTools()`，执行工具使用 `client.callTool()`。连接失败、配置缺失、超时或工具执行错误都应作为结构化失败工具结果写入 `tool_calls`，不能静默失败。

## 子工作空间退出和交付边界

进入子 workspace 只表示 runtime 创建了 `WorkspaceTask`、召回了局部 memory、绑定了当前工具，并开始一个 `running` 的 `WorkspaceSession`。这时子 workspace 还没有向 main workspace 交付结果。

进入子 workspace 的交接上下文不是空的，也不是把父级执行过程整包塞过去。Runtime 会带上总体要求、当前用户请求和少量用户原话参考，让子 workspace 理解任务背景；这些原话只作为参考，不属于子 workspace 本地对话。交接包不得携带父级 assistant 执行记录、`enterWorkspace` 协议 tool result、父级 recent tool evidence 或 sibling workspace 记录。

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

交付给 main workspace 的核心内容是可编排的结果：状态、摘要、产物引用、关键观察、错误和下一步建议。但只交摘要会造成信息损失，所以 runtime 会额外生成有上限的 `handoffContext`：返回 main 时带上完整 `WorkspaceResult`、子 workspace AI 回复摘要、最后助手结论和关键工具结果。AI 回复摘要由 runtime 从当前子 workspace 已产生的自然语言 assistant 内容中整理出来，用来让 main 看到子 workspace 已经表达过的关键判断；它不是父 workspace 历史回放，也不是把所有执行过程塞回 main。完整工具调用参数、冗长中间过程、召回的 event/skill、局部证据、recent tool calls、调试细节和后续 event/skill 提取证据，应保留在 `WorkspaceSession`、`tool_calls`、`audit_logs` 和 memory metadata 中供 Web UI 检查，而不是全部塞回 main workspace。main 整合时必须忠于这个结果上下文，不应二次删减掉关键事实。

`running` 是 runtime 内部 session 状态，不是可交付的 `WorkspaceResult.status`。如果模型试图用 `running` 退出，runtime 必须拒绝该 tool call，并保持子 workspace 仍处于 active/running 状态。

`exitWorkspace` 只能提交当前仍然 `running` 的 active child `WorkspaceSession`。如果同一个 assistant tool-call batch 里重复发出 `exitWorkspace`，第一次合法退出会提交结果，后续重复退出必须作为 failed tool result 记录，不能覆盖已经交付给 main workspace 的 `WorkspaceResult`。

如果子 workspace 直接返回自然语言 assistant content，而没有调用 `exitWorkspace`，这段内容不能作为最终用户回答。runtime 必须把它作为内部 trace/debug 证据保存，追加内部提醒要求模型调用 `exitWorkspace`，并继续执行 tool loop。达到最大轮次仍未退出时，runtime 记录 `workspace_exit_missing`，子 workspace 继续保持 running，不能被静默标记为完成。

## 工作空间定义

workspace 是 Zleap 中最重要的运行时边界。

一个 workspace 表示 agent 当前所处的能力空间。

```text
工作空间 = 工具
          + 事件记忆
          + 经验记忆
          + 工作空间局部上下文
```

它不是子 agent，也不是简单的工具集合。workspace 同时定义：

- 当前能调用哪些工具。
- 工具应该如何被使用。
- 当前 workspace 内有哪些相关事件记忆。
- 当前 workspace 内有哪些可复用技能经验。
- 当前 workspace 的对话上下文如何组织。

进入 workspace 时，runtime 召回的是可注入的 memory 投影视图，不是原始 memory 表 dump。Impression 固定取最新 20 条；event 分为 result timeline 和相关 process event；原始工具输出、完整 metadata 和 provider `final_messages` 快照留在 trace/debug 日志里。

## 为什么需要工作空间

LLM 在执行任务时，不是看到越多越好。

一个复杂 agent 可能拥有几十个甚至上百个工具。如果这些工具全部暴露给模型，模型需要在每一步都做额外判断：

- 当前任务需要哪个工具？
- 这个工具和另一个工具有什么区别？
- 哪些工具描述与当前任务无关？
- 哪些记忆值得参考？
- 哪些历史上下文可以忽略？

workspace 的作用是提前替模型缩小搜索空间。

主 workspace 负责选择“打开哪个软件”，子 workspace 负责在“软件内部完成具体操作”。

## 工作空间类型

### 1. 主工作空间

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

`askUser` 和 `finishTask` 是当前轮的主工作空间终止型编排出口。任意一个工具成功后，runtime 都会把 `WorkspaceResult` 提交到主 `WorkspaceSession`，记录 `main_workspace_result_committed`，把工具调用写入 trace，并直接返回工具提供的用户可见消息。runtime 不应该为了把这些工具结果“再翻译一遍”而进行第二次 LLM 调用。

主 workspace 不通过 `listWorkspaces` 工具发现 workspace。runtime 会把可用 workspace manifest 清单直接注入 main workspace 的 context。`exitWorkspace` 只在子 workspace 中可用，用于把结构化 `WorkspaceResult` 交回 main。

`enterWorkspace`、`askUser`、`finishTask` 也只属于 main workspace。这个限制由 runtime 强制执行，而不是只靠 prompt：即使这些工具被错误绑定到子 workspace，子 workspace 的 callable tools 里也不能出现它们；如果模型强行调用，必须失败。子 workspace 想请求用户输入、建议切换 sibling workspace、或表示任务完成时，都应该通过 `exitWorkspace` 的 `status` 和 `suggestedNextSteps` 交给 main 决定。

workspace session 的 `localContext.availableTools` 必须和这套 runtime 可见性保持一致。它不是数据库绑定表的原样拷贝，而是“这一轮模型实际可调用工具”的调试快照：子 workspace 应包含 `exitWorkspace` 和通用 memory tools，但不能显示 `enterWorkspace`、`askUser` 或 `finishTask`。

主 workspace 的 memory 和 skill 也应该围绕编排能力：

- 用户通常如何表达任务。
- 哪些任务适合哪些 workspace。
- 某类任务的拆分方式。
- workspace 切换的成功或失败经验。

### 2. 领域工作空间

领域 workspace 负责具体能力。

例如：

```text
开发工作空间
  工具:
    - searchFiles
    - readFile
    - writeFile
    - runCommand
  事件记忆:
    - 某项目中过去执行过的命令
    - 某次文件搜索、代码检查或构建失败的过程和结果
  经验记忆:
    - 运行测试前应该先检查 package manager
    - 修改代码前先搜索相关调用点
    - Windows PowerShell 下某些命令需要特殊处理
```

`dev` 工作空间里的基础工具要像一套开发软件，而不是一个万能终端。内置 `searchFiles`、`readFile`、`writeFile` 和 `runCommand` 的默认根目录不是项目根目录，而是当前会话的专属工作目录：默认目录名形如 `~/Documents/Zleap/conversations/<conversationId>-<hash>/`，Windows 下对应用户文档目录里的 `Documents\Zleap\conversations\<conversationId>-<hash>\`，服务部署方可用 `ZLEAP_FILE_WORKSPACE_ROOT` 指向另一个基础目录。模型先用 `searchFiles` 定位候选文件或关键词，再用 `readFile` 查看需要的文件片段，用 `writeFile` 写入完整 UTF-8 文件；只有测试、构建、脚本运行、环境诊断或用户明确要求命令行操作时，才使用 `runCommand`。每一次工具调用参数都要包含 `reason`，说明这次调用为什么必要、预期获得什么证据或产物。这个 reason 给 runtime、日志和 UI 调试使用，不应该写进最终给用户看的自然语言回答。

```text
浏览器工作空间
  工具:
    - navigate
    - click
    - type
    - screenshot
    - inspectDom
  事件记忆:
    - 某个页面的测试过程
    - 某次 UI 验证的结果
  经验记忆:
    - 修改前端后需要桌面和移动视口都截图验证
    - canvas 页面不能只看 DOM，需要检查像素
```

### 3. 创建者注册工作空间

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

## 工作空间注册表

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

## 工作空间会话

一次进入 workspace 会创建一个 workspace session。

```text
工作空间会话 = workspace id
              + user id
              + conversation id
              + task id
              + local context
              + 已召回事件记忆
              + 已召回经验记忆
              + 工具调用历史
```

workspace session 的作用：

- 记录本次子任务的执行过程。
- 限制上下文不污染其他 workspace。
- 生成 event memory。
- 为 skill 提取提供材料。
- 返回结构化结果给主 workspace。

## 工作空间切换

workspace 切换可以理解为一个栈。

```text
主工作空间
  -> 进入开发工作空间
     -> 开发工作空间搜索文件或运行命令
     -> 开发工作空间返回结果
  -> 主工作空间整合最终答复
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

## 工作空间输入输出

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

## 上下文组织

每个 workspace 都有自己的 context 策略。

推荐分层：

```text
全局上下文
  - system prompt
  - personality prompt
  - active user impression
  - agent self impression

主工作空间上下文
  - current user request
  - workspace registry summary
  - orchestration memory
  - orchestration skill
  - workspace results

子工作空间上下文
  - workspace task
  - workspace tool instructions
  - recalled event memory
  - recalled skill memory
  - local tool call history
```

核心目标是避免把所有历史对话传给每个 workspace。

## 工作空间与权限

workspace 是权限控制的自然边界。

例如：

- `dev` 工作空间风险较高，可能涉及文件读写、命令执行和测试运行，需要明确权限边界。
- 未来 Browser workspace 风险可能较低，但涉及外部网站时仍可能需要网络权限。
- Memory 不是独立 workspace；memory 工具挂载在每个 workspace 中，仍然需要严格 userid、workspaceId 和 creator policy 隔离。

每个 workspace manifest 应该声明风险级别和权限需求。

## 工作空间示例：参考 Codex

当前可以参考 Codex 本身的工作方式来设计初始 workspace：

### 主工作空间

负责任务编排。

```text
可见：
  - dev workspace
  - 其他由 creator 注册的 workspace manifest
```

### 开发工作空间

负责本地开发执行面：文件搜索、代码检查、命令运行和测试诊断。文件与命令经常连续使用，所以默认不再拆成两个 workspace。

```text
tools:
  - search files
  - run command
memory:
  - 项目结构
  - 修改过的文件
  - 命令执行历史
skill:
  - 如何在大型项目中先搜索再修改
  - 如何运行测试
  - 如何识别 sandbox/network 错误
  - 如何避免覆盖用户改动
```

### 浏览器工作空间（未来扩展示例）

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
