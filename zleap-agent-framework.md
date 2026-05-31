# Zleap Agent Framework

> 基于 Workspace 的注意力分区型 Agent 架构

> **核心理念：** LLM 的注意力是稀缺资源。Agent 框架不应该把所有工具、记忆、历史和策略一次性塞给模型，而应该通过 workspace 把任务空间拆开，让模型在正确上下文里做正确事情。

---

## 一、传统 Agent 框架的根本问题

### 传统设计

```text
Agent = LLM + 所有 tools + 所有 memory + 所有 skills + 所有 context
```

- **对模型能力要求过高**：需要同时理解任务、筛选工具、筛选记忆、规划步骤。
- **注意力浪费严重**：大量无关工具和记忆挤占上下文窗口。
- **记忆容易污染**：用户信息、任务过程、技能经验边界模糊。
- **编排和执行混在一起**：高层目标和低层操作频繁切换。
- **难以成长**：经验没有被明确积累成可复用方法论。

### Zleap 解决方案

```text
Agent = Stable Identity + Dynamic Workspace State
```

- **注意力分区**：不让模型在无关工具、无关记忆中消耗注意力。
- **稳定身份**：workspace 切换不改变 LLM、系统提示词、人格提示词和 agent self impression。
- **Workspace 即能力边界**：每个 workspace 类似一个软件或工作台。
- **记忆分层**：impression 记人和自我认知，event 记事情，skill 记方法。
- **多租户优先**：从第一天开始把 userId、agentId、workspaceId 作为隔离边界。

---

## 二、核心概念模型

### 2.1 Agent 的组成

```text
Agent
├── Stable Identity（跨 workspace 不变）
│   ├── LLM / model profile
│   ├── System Prompt（系统提示词）
│   ├── Personality Prompt（人格提示词）
│   └── Agent Self Impression Memory
│
└── Dynamic Workspace State（随 workspace 切换）
    ├── Active Workspace Contract
    ├── Callable Tools（当前 workspace 暴露的 function call）
    ├── Cross-workspace User Impression Memory
    ├── Event Memory（userId + workspaceId scoped）
    ├── Skill Memory（workspace scoped, shared）
    └── Local Task / History / Tool Evidence
```

### 2.2 Workspace 不是子 Agent

Zleap 的 workspace 切换不是传统意义上的多 agent 或子 agent：

- 切换 workspace 时，agent 的 system prompt 不变。
- 切换 workspace 时，agent 的 personality prompt 不变。
- 变化的是当前可见工具、workspace 记忆、局部任务和局部上下文；同一 conversation 内回到同一个 workspace 时，它应该能看到该 workspace 之前的本地记录。
- 始终是同一个 agent，只是进入了不同能力边界。

> **类比：** 人使用电脑时，人没有变，人格没有变，只是打开了不同软件。不同软件中，可见对象、可用工具和当前上下文不同。

---

## 三、Workspace Runtime 架构

### 3.1 Workspace 类型

**Main Workspace（编排层）**

职责：接收用户输入、理解目标、选择 workspace、整合结果。Main 不直接拥有所有子 workspace 的工具。

- Main 和子 workspace 都会通过 runtime 注入的 workspace manifest 清单知道有哪些可用工作空间。
- 这份清单是跨 workspace 共享的环境记忆 / 能力地图：就像一个人在使用某个软件时仍然知道还有别的软件存在。
- Main 不需要、也不应该调用 `listWorkspaces` 工具。
- Main-only 编排工具包括 `enterWorkspace`、`askUser`、`finishTask`。
- `exitWorkspace` 是 child workspace 退出回 main 的工具，不是 main 的普通工具。
- 子 workspace 可以在 `suggestedNextSteps` 中告诉 main 需要哪个 sibling workspace 的能力，但不能直接进入 sibling workspace。
- 子 workspace 看见 sibling manifest 不等于获得 sibling tools；它只获得“知道有哪些能力存在”的认知，不获得直接调用权。
- 子 workspace 还有产物责任边界：它只能交付自己工具真实产生、或自身说明明确支持的结果。搜索类 workspace 搜索完应返回搜索结果、来源、可信度、缺口和下一步建议，然后退出给 main；生成网页、写文件、运行本地命令等下游产物任务，应由 main 再调度到开发/文件类 workspace。`artifacts` 只能声明当前 workspace 工具实际创建、修改或导出的产物，不能靠自然语言伪造。

**Capability Workspaces（执行层）**

| Workspace | 第一版用途 | 工具来源 |
| --- | --- | --- |
| **Dev Workspace** | 文件搜索、代码检查、命令行任务 | 内置 runtime 工具 `searchFiles` + `runCommand`；高风险命令仍需审批 |
| **MCP Workspaces** | 外部或用户提供能力 | 绑定本地 stdio / 远程 Streamable HTTP MCP Server 后发现并挂载工具 |
| **Browser Workspace** | 浏览器验证与页面检查 | 未来方向，不属于第一版内置范围 |

### 3.2 Workspace 切换流程

1. **Main Workspace 接收任务**：理解用户目标，读取 runtime 注入的可用 workspace manifest。
2. **构造 WorkspaceTask**：包含 `objective`、`constraints`、`expectedOutput`、`parentContextSummary`。
3. **进入子 Workspace**：runtime 创建 workspace session，召回 memory，恢复同 workspace 的本地记录，绑定当前 workspace 工具。
4. **执行 Workspace 任务**：模型在当前 workspace 的上下文里循环调用允许的工具，只完成当前能力切片，不代做 sibling workspace 的产物任务。
5. **退出 Workspace**：子 workspace 调用 `exitWorkspace`，返回结构化 `WorkspaceResult`；runtime 同时生成有限的结果型 handoffContext。
6. **Hook 提取记忆**：runtime 根据 workspace session、工具证据和结果提取 event，并谨慎生成 skill。
7. **Main Workspace 整合结果**：决定继续进入其他 workspace、询问用户，或生成最终答复。

### 3.3 Workspace 输入输出契约

子 workspace 不是把内部上下文整包交还给 main，但也不能只交一条摘要导致信息损失。交叉上下文由 runtime 程序化控制。

- **输入**：用户请求或 main 转移过来的结构化 `WorkspaceTask`。
- **输出**：结构化 `WorkspaceResult`，字段为 `status`、`summary`、`artifacts`、`observations`、`errors`、`suggestedNextSteps`。
- **进入 handoff**：runtime 自动带总体要求、当前用户请求和少量用户原话参考进入子 workspace。用户原话是相对原始的任务参考，不是子 workspace 的本地对话；不携带父级 assistant 执行记录、`enterWorkspace` 协议结果、父级工具证据或 sibling workspace 记录。
- **返回 handoff**：runtime 自动把完整 `WorkspaceResult`、子 workspace AI 回复摘要、最后助手结论和关键工具结果带回 main。AI 回复摘要只整理子 workspace 已经产生的自然语言 assistant 内容，防止 main 在继续编排时忽略这些已表达的关键判断；它不是完整本地对话，也不是工具执行过程日志。类比软件工程中的产物交付：在 Photoshop 完成图片后放进 PPT，需要的是完整结果图片和必要导出信息，而不是 P 图历史。
- **忠于结果**：main 整合时必须把子 workspace 的 `WorkspaceResult` 和结果上下文当成权威证据，不能再随意删减、改写或遗漏关键事实。
- **隔离**：完整 tool call 参数、冗长中间过程、召回的 event/skill、局部证据保留在 trace/debug UI、tool_calls、audit_logs、workspace_sessions 中，不直接污染 main context。子 workspace 的本地对话片段也必须只来自同一个 workspace；main 的编排对话、sibling workspace 的执行记录和 main-only 工具协议消息不能作为普通 history 混进来，只能通过 handoffContext 的受控结果包出现。

---

## 四、三层 Memory 模型

### 4.1 Memory 分类

**Impression（对人或 agent 自我的记忆）**

- User Impression：对当前用户的长期偏好、背景、约束的认知。
- Agent Self Impression：agent 对自己的定位和身份，由 creator 控制。
- 跨 workspace。
- User impression 按 userId 隔离；agent self impression 按 agentId 隔离。

**Event（对事情的记忆）**

- Process Event：过程记忆。
- Result Event：结果记忆。
- workspace scoped。
- user scoped。
- 当前第一版召回使用 SQLite FTS + relationId/version 最新行过滤。

**Skill（对执行经验的记忆）**

- 从 event 中总结的方法论。
- 可复用的执行经验。
- workspace scoped。
- 跨用户共享。
- 必须脱敏、泛化，并包含可复用 procedure、适用条件、避免条件和 confidence。

### 4.2 Memory 隔离边界表

| Memory 类型 | 跨 workspace | 按 userId 隔离 | 跨用户共享 | 主要用途 |
| --- | --- | --- | --- | --- |
| **Impression: user** | 是 | 是 | 否 | 记住用户偏好、背景、长期约束 |
| **Impression: agent self** | 是 | 否 | 由 creator 控制 | 记住 agent 对自己的定位和身份 |
| **Event** | 否 | 是 | 否 | 记住某人在某 workspace 做过什么 |
| **Skill** | 否 | 否 | 是 | 让 workspace 从所有用户经验中学习 |

### 4.3 Event 的 SQLite FTS + relationId/version 机制

当前第一版不启用真实 vector recall。Vector 是未来扩展方向。

**写入 Event**

1. 从 conversation window 或 workspace exit hook 提取 event。
2. 按 `userId + workspaceId + relationId` 建立事件关系。
3. 新版本写入同一个 relationId 下的最新 version。
4. 审计日志记录来源 conversation、workspace session、tool evidence。

**召回 Event**

1. runtime 根据当前任务文本发起 memory recall。
2. Impression 固定召回当前 user / agent scope 下最新有效的前 20 条，不按当前 query 选择。
3. Result event 在 `userId + workspaceId` 范围内召回最新有效约 50 条，形成较早任务的结果时间线。
4. Process event 在 `userId + workspaceId` 范围内用 SQLite FTS 命中当前任务相关候选行，只注入少量相关过程。
5. Skill 按当前 workspace 召回少量高质量、已脱敏、可复用经验。
6. 通过 relationId/version 过滤到最新版本，并在注入前转成 compact projection，避免把原始 detail / metadata / evidence 整包放回上下文。

> **Relation ID 机制：** 多条 event 通过 relationId 表达同一类事情的连续记录或版本演进。召回旧记录时，也要通过 relationId 找到最新结论。

### 4.3.1 长对话 Memory 召回与上下文注入

长对话不能通过“把原始数据再塞回上下文”来解决。原始对话、完整工具输出、完整 `metadataJson` 和证据数组应留在 SQLite、workspace session、tool call 与 audit/debug 视图里；模型上下文只接收投影后的 compact memory view。

原始数据有自己的表：`messages` 保存对话消息，`llm_calls` 保存 provider 请求/响应快照，`context_segments` 保存上下文堆栈，`tool_calls` 保存 function call 参数和结果，`workspace_sessions` 保存工作空间任务与结果，`audit_logs` 保存生命周期审计。Memory row 只保存语义化的标题、摘要、详情和来源引用，例如 `sourceRefs: [{ table, ids }]`。它不应该复制 `windowMessages`、`toolCalls`、`workspaceSessions`、`argumentsJson`、`resultJson`、`messagesJson`、`responseJson`、`rawJson` 或 `finalMessages` 这类原始 JSON；同一批证据 id 也不应该在 `sourceRefs` 外再重复保存一份顶层数组。需要追溯时从引用回查原始表。

- **最近原始对话**：保留最近 20 条最详细的本地对话片段，用来维持当前任务连续性。
- **Impression**：不做 query 选择性召回，固定载入当前 user / agent scope 下最新有效的前 20 条投影视图。Impression 是对人和 agent 自我的稳定印象，天然有上限，不应该像事件日志一样无限增长。
- **Result Event**：载入当前 user + workspace 下最新有效的约 50 条结果事件，作为较早任务的结果时间线。
- **Process Event**：只用 SQLite FTS / 未来向量检索召回与当前任务相关的少量过程事件索引/摘要投影。无关过程不进入上下文，相关过程也不直接注入 detail；需要过程细节时由模型调用 `readMemory(memoryId)`。
- **Skill**：按当前 workspace 召回近 N 条高质量、已脱敏、可复用经验的名称和简介。完整经验不自动进上下文，只有当 agent 判断某条简介与当前任务高度相关时，才通过 `readSkill` 主动读取详情。

因此，`runtime_context.memory` 不是原始 memory 表的 dump，而是一个分区投影：

```json
{
  "crossWorkspaceImpressionMemory": [],
  "currentWorkspaceResultEvents": [],
  "currentWorkspaceRelevantProcessEvents": [],
  "currentWorkspaceSkillMemory": []
}
```

这个结构对应 Zleap 的核心原则：不是让 LLM 看到更多，而是让 LLM 看到正确、压缩、可追溯的内容。

### 4.4 Skill 生成机制

Skill 采用渐进式披露：

1. 第一层：上下文只显示当前 workspace 最近的 skill `id/title/summary/confidence`，让模型知道“有哪些经验可能有用”。
2. 第二层：模型判断某条 skill 与当前任务高度相关时，调用 `readSkill(skillId)` 读取完整 `detail/procedure/appliesWhen/avoidWhen`。
3. 第三层：原始事件证据、完整工具输出和更长的调试材料仍保留在 SQLite、tool_calls、audit_logs、workspace_sessions 中，不直接进入普通 prompt。

这个设计借鉴 Claude Skills 的 progressive disclosure：先给最小索引，相关时再加载详细说明，从而节省 token，同时保持专业经验可用。

Skill 有三种生成路径：

- **Hook 自动生成**：workspace exit event extraction 后，判断是否有可沉淀的经验。
- **Agent 主动生成**：agent 在执行过程中认为某个经验值得沉淀，或用户明确要求总结经验。
- **人工维护**：creator 在 Memory UI/API 中维护高质量共享经验。

Hook 自动生成必须非常保守：workspace 完成任务或返回结果本身不等于 skill。只有事件证据里出现了明确可复用的方法，例如失败后找到稳定替代路径、已验证的能力工具流程、可迁移的命令/文件/浏览器操作规律，才允许生成 skill。生成时只保存泛化后的方法、工具类别、适用条件和避免条件；原始 function call 参数、工具输出、用户身份、任务原文、私有项目内容和路径都只能留在 evidence id、tool_calls、audit_logs、workspace_sessions 里。

为了避免污染，skill 写入还需要去重：同一 workspace 中语义相近、流程相近的 skill 应复用已有记录，而不是因为相似任务重复创建多条长期经验。

**适合生成 skill 的情况**

- 同类问题重复出现。
- 某次失败带来明确教训。
- 失败若干次之后找到可复用的成功路径，例如某种命令写入方式失败后改用更稳定的脚本/API 方式。
- 某个流程被验证有效。
- 某个 workspace 的工具使用方式有稳定规律。
- 能降低未来同类任务失败率，且可以脱离具体用户和私有项目复用。

**不适合生成 skill 的情况**

- 只是一条普通事实。
- 只适用于某个用户的私密上下文。
- 结果不确定或没有验证过。
- 包含未脱敏的用户、项目、路径、账号或业务细节。
- 只是任务结果摘要，缺少可复用 procedure。
- 与已有 skill 高度相似，只是换了任务内容或用户内容。
- 只是“认真检查”“合理使用工具”“保持上下文”这类空泛提醒。

### 4.5 记忆写入来源与 Workspace 边界

记忆不作为独立 Memory Workspace 存在。模型可见的 runtime memory tools 只包括 `searchMemory`、`readMemory`、`readSkill`、`writeUserImpression`、`writeAgentSelfImpression`、`writeSkillMemory`。

- Impression Memory 主要是 agentic，也有保守 hook 兜底：当模型判断用户表达、纠正或通过用户授权搜索/工具结果确认了当前用户的稳定长期偏好、背景、身份、称呼、工作习惯、约束或长期项目时，应该主动请求写入；如果模型漏掉，`afterAgentTurn` 可以在明确稳定信息存在时自动写入紧凑 user impression。没有稳定信息就跳过，不能为了写记忆而硬写。写入不能保存原始搜索结果、一次性任务细节、未经确认的猜测或敏感隐私。agent self impression 需要 creator 权限。
- Event Memory 是 programmatic：由 runtime hook 按会话窗口、workspace 退出等时机自动提取，模型没有 event 写入工具。
- Skill Memory 同时有 agentic 和 programmatic 来源：模型或用户可以主动请求沉淀经验；hook 也可以从成功且有泛化价值的事件中保守提取，但必须脱敏，且不能为了写记忆而强行总结经验。
- `readMemory` 是普通记忆的渐进式披露工具。自动召回和 `searchMemory` 只暴露紧凑投影，并明确标出 `summary_only`、`detailInjected=false` 与可读取详情的 id；当用户主动要求回忆、摘要不足以回答、或需要核对某条 impression/event 的完整内容时，模型用 `readMemory(memoryId)` 读取详情。如果用户在摘要回答后追问“详细说说”“展开讲讲”“具体一点”等，模型必须先读详情，而不是把摘要扩写成事实。
- `readSkill` 是读取完整 skill 详情的渐进式披露工具。模型不能把 skill 简介当成完整操作手册；只有高度相关时读取详情，再根据完整 procedure 执行。
- 模型调用 skill 记忆工具时，workspaceId 由当前 active workspace 代码绑定。
- 模型不能通过传入 `workspaceId` 操作其他 workspace 的 event/skill。
- 记忆演化以追加新记录、读取最新有效记录为主；更新和删除不作为模型可调用工具。
- User impression 的 userId、agent self impression 的 agentId 也由 runtime 绑定或 creator policy 控制。
- 跨 workspace 的筛选、人工编辑、删除和调试属于 Web UI/API 管理层能力，不属于普通 agent runtime。

scope 判断必须显式：user impression 是 `memoryType=impression + userId 有值 + agentId 为空 + workspaceId 为空`；agent self impression 是 `memoryType=impression + agentId 有值 + userId 为空 + workspaceId 为空`。不能把“没有 userId”直接当成 self-impression，因为无 scope 或歧义 scope 本身就是错误状态。

---

## 五、多租户隔离设计

### 5.1 为什么多租户是底层设计

Zleap 从第一天开始考虑多租户，因为 agent 的 memory 会长期积累。如果后期才补 userId 隔离，容易出现：

- 用户 A 的事件被用户 B 召回。
- 用户 A 的偏好影响用户 B 的回答。
- 某个用户的私密任务被总结成共享 skill。
- creator、普通 user、runtime system 的权限混淆。

**因此，userId 不是业务层可选字段，而是 conversation、workspace session、memory、tool call 和 audit 的基础隔离字段。**

### 5.2 数据隔离矩阵

| 数据 | userId 隔离 | workspaceId 隔离 | 可跨用户共享 | 说明 |
| --- | --- | --- | --- | --- |
| Conversation | 是 | 不一定 | 否 | 原始对话属于用户和 agent |
| Workspace Session | 是 | 是 | 否 | 每次进入 workspace 的执行记录 |
| User Impression | 是 | 否 | 否 | 跨 workspace 的用户记忆 |
| Agent Self Impression | 由 creator 控制 | 否 | 是 | Agent 自我认知 |
| Event Memory | 是 | 是 | 否 | 某用户在某 workspace 的事情 |
| Skill Memory | 否 | 是 | 是 | Workspace 经验，必须脱敏 |
| Tool Call Log | 是 | 是 | 默认否 | 审计和调试用 |

### 5.3 Creator 与普通用户

**Creator（创建者/管理员）**

- 修改 agent identity 和 agent self impression。
- 安装、编辑、删除 workspace。
- 修改 workspace manifest、memory policy、risk policy。
- 管理共享 skill。
- 审批高风险 workspace/tool 请求。
- 查看系统级审计日志。

**普通 User**

- 与 agent 对话。
- 触发自己的 user impression 写入请求。
- 产生自己的 event memory。
- 在权限允许时请求总结 skill。
- 使用已安装并被 policy 允许的 workspace 和工具。

### 5.4 Skill 脱敏原则

Skill 是共享的，但共享前必须脱敏。不能把以下内容直接写入 skill：

- 用户姓名、账号、邮箱、手机号。
- 用户项目的私有路径。
- 用户业务数据。
- 用户未公开代码或文档细节。
- 某个用户的具体错误日志，除非已经泛化。

**示例**

- 不应该写：`用户 jomy 的 G:\Jomy\Documents\Zleap-Agent 项目需要先运行 pnpm install`
- 应该写：`在 Node 项目中，如果存在 pnpm-lock.yaml，优先使用 pnpm 安装依赖和运行脚本`

---

## 六、Hooks 和生命周期

### 6.1 核心生命周期

1. **User Message**：用户输入消息。
2. **beforeAgentTurn**：校验 conversation ownership、加载 agent/workspace、准备初始 context。
3. **Main Workspace Planning**：理解任务，决定回答、询问、进入 workspace 或结束。
4. **beforeWorkspaceEnter**：检查权限，构造 WorkspaceTask，召回 event/skill/impression，创建 workspace session。
5. **Execute Workspace Task**：模型循环执行，调用 tools；runtime 记录 beforeToolCall / afterToolCall。
6. **beforeWorkspaceExit**：校验 `WorkspaceResult` 结构和状态。
7. **afterWorkspaceExit**：保存 workspace result，触发 event extraction 和 skill candidate extraction。
8. **Return to Main Workspace**：main 整合结果，决定下一步。
9. **afterAgentTurn**：最终 assistant message 持久化后，运行 conversation-window event extraction 等生命周期逻辑。

### 6.2 Hook 类型与职责

| Hook | 触发时机 | 主要职责 |
| --- | --- | --- |
| **beforeAgentTurn** | 模型响应前 | 校验 ownership、加载配置、准备 context、审计 recall |
| **afterAgentTurn** | 模型响应后 | 基于已保存的 user/assistant 窗口提取 event，并保守兜底写入明确稳定的 user impression |
| **beforeWorkspaceEnter** | 进入 workspace 前 | 检查权限、构造 WorkspaceTask、检索 memory、创建 session |
| **afterWorkspaceEnter** | 进入 workspace 后 | 记录 audit log、暴露 trace |
| **beforeToolCall** | tool 调用前 | 检查 tool 是否属于当前 workspace、检查权限、参数校验 |
| **afterToolCall** | tool 调用后 | 保存 tool result、标记成功/失败、加入 workspace local context |
| **beforeWorkspaceExit** | 退出 workspace 前 | 校验结构化 WorkspaceResult |
| **afterWorkspaceExit** | 退出 workspace 后 | 保存结果、触发 event extraction、触发 skill candidate extraction |
| **afterConversationWindow** | 对话窗口结束 | 从近期对话提取 event，维护 relationId/version |

### 6.3 Event 和 Skill 提取

Event 提取主要由程序 hook 自动触发，输入包括 workspace session、最近 N 条消息、tool call history、workspace result 和已召回 memory。

Skill 提取更克制，来源包括：

- Event hook 自动判断。
- 用户明确要求。
- Agent 主动调用 skill 生成工具。

> **设计原则：** 模型负责判断和行动，runtime 负责边界和生命周期。Workspace 进入时召回局部 memory，退出时沉淀局部 event。Event 以事实为主，skill 以方法为主。

---

## 七、上下文窗口堆栈与 Prompt 契约

### 7.1 为什么需要上下文窗口堆栈

Zleap 的核心不是让模型获得更多上下文，而是让模型获得正确上下文。

如果没有契约，workspace 设计会退化成普通大上下文 agent：所有 system rules、personality、tools、memory、history 全部混在一起塞给模型。

### 7.2 Context 堆栈一级类别

当前实现使用少量稳定一级类别，每个类别内部再分二级内容：

1. **system**：基础系统提示词、人格提示词、内部运行策略和 workspace 决策契约合并在一个 system message 中。
2. **workspace**：当前 workspace 的说明、manifest、memory policy；main 额外获得可用 workspace manifest 清单。
3. **tools**：本次 LLM 调用实际暴露的 function call 工具、参数 schema、risk level、runtime/MCP binding。
4. **memory**：记忆投影，不是原始 memory 表 dump。二级分区包括 `crossWorkspaceImpressionMemory`、`currentWorkspaceResultEvents`、`currentWorkspaceRelevantProcessEvents`、`currentWorkspaceSkillMemory`，并携带 `summary_only`、`detailInjected=false`、`detailAvailable=true`、`readMemory` 或 `readSkill` 这类渐进披露提示。
5. **本地对话片段**：UI 展示时使用这个中文概念，内部 `segmentType` 仍为 `history`。它包含同 workspace 本地消息、当前 WorkspaceTask、同 workspace 已完成 WorkspaceResult、交接上下文和近期工具证据；子 workspace 的历史按 workspace 持续，不因切回 main 而删除，但只保留同一 workspace 的本地记录。跨 workspace 内容只能作为 `crossWorkspaceHandoffContext` 出现，其中进入子 workspace 时可包含总体要求、当前用户请求和少量用户原话参考，不能把 assistant/tool 执行记录混成一个全局 history。
6. **user**：干净用户消息，不混入系统策略和记忆。
7. **tool_result**：工具执行后返回给后续 LLM 调用的工具结果。

memory 分区必须在概念介绍和上下文检查 UI 中展开呈现，而不是只显示一行“记忆”。在概念介绍里，这些二级分区应直接嵌入上下文窗口堆栈的 `memory` 层内部，而不是在堆栈外另开一个分离板块。具体含义如下：

- `crossWorkspaceImpressionMemory`：跨 workspace 身份层记忆，包括当前用户印象和 agent self impression。固定注入最新有效 20 条投影，不做 query 选择性召回；详情未注入，必要时用 `readMemory(memoryId)`。
- `currentWorkspaceResultEvents`：当前 workspace 的结果事件时间线，保留过去约 50 条“完成了什么 / 失败了什么 / 产出了什么”的摘要。
- `currentWorkspaceRelevantProcessEvents`：当前 workspace 里与当前任务相关的过程事件索引，通过 FTS / 未来向量少量召回，只注入 id、title、summary 和读取提示，不注入 detail/detailSnippet。
- `currentWorkspaceSkillMemory`：当前 workspace 的共享经验索引，默认展示近 N 条名称和简介；只有当简介与当前任务高度相关时，模型才调用 `readSkill(skillId)` 读取完整 procedure、appliesWhen 和 avoidWhen。

`final_messages` 不是上下文堆栈的一层，而是 UI/trace 里的原始 messages 快照：它记录 prompt assembly 后发给 OpenAI-compatible provider 的 messages，用于调试和验收，不会被再次注入下一次 LLM 请求。

上下文堆栈是给人验收和排查用的界面，不应该把可解析 JSON 直接当原始文本倾倒出来。`tools`、`memory`、`history`、`tool_result` 等结构化内容应被解析成表格或字段视图；尤其是 `tools` 数组，要能清楚看到每次 LLM 调用实际暴露了哪些 function、参数 schema、绑定来源和风险信息。原始日志模式不是额外追加的一栏，也不是把 1/2/3/4/5/6/7 分区逐个 raw 化，而是隐藏结构化编号堆栈，直接展示当前选中 `llmCallId` 对应的原始 LLM request/response 日志：messages、tools、状态、endpoint/model 和 response。它不做结构化表格渲染，也不需要再次展开；长行必须在面板内自动换行，不能依赖 X 轴滚动。

### 7.3 Prompt 装配顺序

```text
system message:
  system segment

request tools array:
  tools segment 的真实来源
  OpenAI-compatible function call schemas

synthetic tool result:
  runtime_context.workspace
  runtime_context.memory
  runtime_context.local_conversation

user message:
  clean user message

follow-up calls:
  assistant tool_calls
  tool results
  clean continuation messages
```

`workspace`、`memory`、`history` 这些结构化上下文通过 synthetic tool result 注入，让模型能看到分区后的运行上下文，但不把大段 JSON 混进 system message。`tools` 在 context stack 中是为了可观察和可追溯；真正让模型可调用 function 的入口，是 OpenAI-compatible 请求体里的顶层 `tools` 数组，不是把完整工具 schema 写进 system prompt。

### 7.4 注意力预算

Zleap 把上下文窗口当成预算，而不是仓库。

- System 和 personality 稳定但尽量短。
- Workspace 说明必须准确，避免重复字段。
- Tools 单独展示和预算，便于确认模型到底看到了哪些 function call。
- Impression memory 固定注入最新有效 20 条投影视图，不做 query 选择性召回。
- Event memory 分两层注入：约 50 条 result event 保留旧结果时间线，少量 process event 通过 FTS / 未来向量按当前任务相关性召回，但只注入 id/title/summary/readMemory 等投影，不注入 detail/detailSnippet。
- Memory 注入使用 compact projection，不回灌完整原始对话、完整 `metadataJson`、完整 evidence 数组或长 detail。
- Skill memory 数量要少，优先高置信度和高相关度。
- Tool result 长输出必须摘要；原始证据保留在日志、artifact 或 workspace session。
- Local history 只保留当前 workspace 的必要片段。

---

## 八、Runtime 不变量

这些规则是 Zleap 框架的核心约束，后续都应该写成测试：

### Invariant 1: Identity Stable

Workspace 切换不能改变：

- LLM model identity。
- System Prompt。
- Personality Prompt。
- Agent self impression。

### Invariant 2: Tools Scoped

模型只能调用 active workspace 中暴露的 tools。即使模型输出了其他 tool call，runtime 也必须拒绝。

### Invariant 3: Event Memory Scoped

Event memory 召回必须满足：

```text
event.userId == currentUserId
event.workspaceId == activeWorkspaceId
```

### Invariant 4: Skill Memory Workspace Scoped

Skill memory 召回必须满足：

```text
skill.workspaceId == activeWorkspaceId
```

Skill 不按普通 userId 隔离，但必须经过脱敏和泛化。

### Invariant 5: Main Workspace is Not All-tools Workspace

Main workspace 负责实际调度。子 workspace 可以看到 workspace manifest 以便建议 handoff，但不能直接拥有 sibling workspace tools，也不能调用 `enterWorkspace`。

### Invariant 6: Child Workspace Returns Structured Result

子 workspace 退出时必须返回 `WorkspaceResult`。Main 不应该依赖解析大段自然语言来理解子任务状态。

### Invariant 7: Memory Writes are Policy-gated

模型可以提出写 memory 的请求，但最终 scope、权限、证据和写入由 runtime policy 决定。

---

## 九、七大设计原则

1. **注意力分区**：不让模型在无关工具、无关记忆、无关上下文中消耗注意力。
2. **稳定人格**：workspace 切换不改变 agent 身份。变化的是工具、局部记忆和局部上下文。
3. **Workspace 即能力边界**：main 类似桌面，负责看到有哪些能力并编排任务；子 workspace 类似软件，负责具体执行。
4. **记忆分层**：Impression 记人和自我认知，Event 记过程和结果，Skill 记执行经验和方法论。
5. **多租户优先**：用户相关记忆必须隔离，可共享经验必须明确建模。
6. **可成长**：Agent 不只是调用工具，还会从 event 中沉淀 skill。Skill 是 workspace 变聪明的主要机制。
7. **可运行**：最终目标是完整可运行的 TypeScript agent framework，包含 runtime、SQLite 记忆、workspace 管理、工具调用、MCP 扩展和 Web UI。

---

## 十、TypeScript 实现路线图

### 10.1 当前核心模块

- **AgentRuntime**：对话总入口，驱动 main workspace 与工具循环。
- **WorkspaceRuntime / workspace session**：表示 workspace task、local context、result 和生命周期。
- **ToolRegistry**：管理 runtime tools、memory tools、MCP tools 的可见性和执行。
- **MemoryService**：记忆召回、写入、提取和 policy enforcement。
- **Policy boundary**：权限、安全、租户隔离、高风险审批。
- **ContextBuilder / PromptAssembler**：生成上下文堆栈和真实 OpenAI-compatible messages。
- **SQLite repositories**：Raw SQL 持久化 agents、workspaces、tools、messages、llm_calls、context_segments、tool_calls、memories、audit_logs。
- **React/Vite Web UI**：对话、工作空间、记忆、日志、数据表和概念介绍。数据表 tab 是 creator-only 的只读 SQLite 表浏览器，用来验收原始对话与运行证据是否真的落库。

### 10.2 推荐逻辑分层

```text
src/
  core/        runtime、context、LLM、tool execution、memory lifecycle
  db/          SQLite schema、migration、repositories、seed
  server/      HTTP API、streaming endpoint、static web serving
  web/         React Web UI
  tests/       runtime、memory、policy、context、MCP、UI contract tests
```

### 10.3 分阶段实施

**Stage 1: 文档确认**

- 确认 agent/workspace/memory 理念、术语、MVP 边界。
- 产物：`ZLEAP_MASTER_PLAN.md`、`zleap-agent-framework.md`。

**Stage 2: Core Runtime Skeleton**

- 实现 AgentRuntime、WorkspaceSession、main 到 child workspace 切换、结构化 WorkspaceTask/WorkspaceResult。

**Stage 3: Tool System**

- 实现 runtime tool registry、File/CLI 内置工具、MCP server 绑定和发现、tool call policy hook。

**Stage 4: Memory MVP**

- 实现 impression/event/skill 单表 SQLite 存储、FTS 召回、relationId/version 最新行机制、memory 工具。

**Stage 5: Hook System**

- 实现 before/after agent turn、workspace enter/exit、tool call hooks、workspace exit event extraction、skill candidate extraction。

**Stage 6: Web UI**

- 对话三栏、workspace 管理、workspace-scoped tool/MCP 管理、memory inspector、logs、context stack、concept intro。

**Stage 7: Vector and Production Hardening**

- 未来接入真实 embedding/vector store、完善权限和审计、支持 workspace package/manifest、加强多用户部署。

### 10.4 MVP 范围

第一阶段不要一次实现所有理想功能。当前第一版范围：

- 单进程 TypeScript runtime。
- Main workspace、File workspace、CLI workspace。
- SQLite Raw SQL 持久化。
- Memory service 的 impression/event/skill MVP。
- SQLite FTS 召回，Vector 暂不启用。
- MCP 作为外部能力扩展机制，不用于内置 dev 基础能力；文件搜索和命令行执行默认合并在同一个开发工作空间里。
- Web UI 支持：聊天、工作空间、工作空间工具/MCP、记忆、日志、上下文堆栈、概念介绍。

---

## 总结

**Zleap Agent Framework 的核心创新在于：**

- 将 agent 理解为稳定身份 + 动态 workspace 状态，而不是一个装满所有能力的对象。
- 通过 workspace 切换实现注意力分区，让模型在正确上下文里做正确事情。
- 通过 impression / event / skill 三层记忆实现人、事、方法的清晰分层。
- 从第一天开始考虑多租户隔离，确保用户数据安全和经验共享边界。
- 通过 hook 和生命周期让 runtime 负责边界，让模型负责判断和行动。
- 通过 context stack 和 prompt assembly 确保模型获得正确上下文，而不是更多上下文。
- 最终目标是构建一个可运行的 TypeScript framework 和 Web UI，让这些理念真正落地。

> **这不是一个让 LLM 看到更多的框架，而是一个让 LLM 看到正确内容的框架。**

---

*Zleap Agent Framework - 设计文档*

*以 `ZLEAP_MASTER_PLAN.md` 为最高优先级更新。*
