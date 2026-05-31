# 记忆模型

## 总览

Zleap 的 memory 不应该是一个扁平的“长期记忆”集合。

不同记忆有不同用途、隔离边界、生成方式和召回方式。

Zleap 将 memory 分为三类：


```text
1. Impression / 印象
   - 对人的记忆
   - 包含对用户的认知和 agent 对自己的认知

2. Event / 事件
   - 对事情的记忆
   - 包含过程记忆和结果记忆

3. Skill / 经验
   - 对执行经验的记忆
   - 从 event 中总结出来的方法论
```

记忆召回必须可观察。即使 SQLite FTS 没有返回任何结果，每次进入工作空间也要记录 `memory_recall_requested` 审计日志，包含当前 `conversationId`、`workspaceId`、`taskId`、query 文本、算法名、`vectorEnabled: false`、各分区上限、原始命中数量、注入分区数量和注入 memory ids。

这让日志页能回答两个问题：

1. runtime 这一轮是否尝试召回记忆。
2. 当前 SQLite FTS + relation/version 算法是否召回到了值得注入的内容。

首个产品版本使用 SQLite FTS，不使用向量语义搜索。类似“我叫什么名字”这种问题，如果已有名字记忆的 title/summary/detail 没有可匹配的 FTS token，可能召回失败。这是算法限制，不是权限判断本身；召回审计日志应该把这件事暴露出来。

Impression 写入规则必须出现在系统提示词里，而不是藏在单独的 UI-only 策略分类里。系统提示词应该告诉模型：只有稳定的长期用户偏好、背景、身份或约束才调用 `writeUserImpression`；短期任务事实应保留在本地对话或 event memory 中。

## 记忆隔离总表

| 记忆类型 | 是否跨 workspace | 是否按 userid 隔离 | 是否跨用户共享 | 主要用途 |
| --- | --- | --- | --- | --- |
| Impression: user | 是 | 是 | 否 | 记住用户偏好、背景、长期约束 |
| Impression: agent self | 是 | 通常不按普通 userid 隔离 | 由创建者控制 | 记住 agent 对自己的定位和身份 |
| Event | 否 | 是 | 否 | 记住某人在某 workspace 做过什么 |
| Skill | 否 | 否 | 是 | 让 workspace 从所有用户经验中学习 |

## 印象记忆

impression 是对人的记忆。

它包括两类：

1. user impression
   - agent 对某个用户的认知。
   - 通过 userid 隔离。
   - 跨 workspace 可用。

2. agent self impression
   - agent 对自己的认知。
   - 只有 agent 创建者有权限要求 agent 写入或修改。
   - 跨 workspace 可用。

### 用户印象

user impression 记录的是和用户长期相关的信息。

例子：

```text
用户偏好：
  - 喜欢中文沟通。
  - 喜欢先写文档再写代码。
  - 不喜欢过早进入实现。

用户背景：
  - 正在设计 TypeScript agent framework。
  - 关注多租户和记忆系统。

长期约束：
  - 希望框架最终有可运行 Web UI。
  - 希望 workspace 类似软件，而不是子 agent。
```

user impression 不应该记录短期任务细节。短期任务细节应该进入 event memory。

user impression 是 agentic 写入，但不应该被动到只有用户说“记住”才写。只要当前上下文中出现了可信、稳定、长期可复用的当前用户信息，模型就应该主动考虑 `writeUserImpression`。典型触发包括：用户自述或纠正自己的姓名、称呼、身份、背景、长期偏好、约束、工作习惯或长期项目；用户问“我是谁”“你知道我是谁吗”；用户授权搜索关于自己的信息，并且搜索/工具/工作空间结果确认了当前用户的稳定公开身份或背景。

主动并不等于乱写。写入内容必须是紧凑投影：标题和摘要记录可长期复用的结论，详情说明来源是用户陈述、用户纠正，还是用户授权的搜索/工具结果。不要把整段搜索结果、网页原文、一次性任务事实、未经确认的猜测、敏感隐私、账号路径或原始日志塞进 impression。若信息只是本轮任务素材或不确定是否属于当前用户，应留在本地对话/event memory，而不是写成 user impression。

### Agent 自我印象

agent self impression 记录 agent 对自己的长期身份认知。

例子：

```text
我是一个以 workspace 为核心组织能力的 agent。
我的目标不是把所有工具塞进一个上下文，而是把任务切到正确的 workspace。
我需要尊重 userid 隔离。
我应该主动沉淀 event，并在合适时提炼 skill。
```

这个部分风险较高，因为它会影响 agent 的长期行为。

因此规则是：

- 普通用户不能随意修改 agent self impression。
- 只有 agent 创建者可以授权 agent 写入。
- 修改 self impression 应该有审计记录。

scope 判断必须显式，而不是靠“没有 userId”猜测：

```text
User Impression:
  memoryType = impression
  userId 有值
  agentId 为空
  workspaceId 为空

Agent Self Impression:
  memoryType = impression
  agentId 有值
  userId 为空
  workspaceId 为空
```

如果一条 impression 同时没有 userId 和 agentId，或者同时有 userId 与 agentId，都是无效/歧义 scope。系统提示词也必须明确告诉模型：用户偏好、用户身份、用户称呼写 `writeUserImpression`；agent 自己的名字、身份、职责、长期原则只有 creator 明确授权时才写 `writeAgentSelfImpression`。

## 事件记忆

event 是对事情的记忆。

event memory 记录的是某个用户在某个 workspace 中发生过的任务过程和任务结果。

event 具有以下隔离规则：

```text
事件记忆:
  workspace scoped
  user scoped
  conversation/task related
```

这意味着：

- 用户 A 在 File workspace 的事件，不应该被用户 B 看到。
- 用户 A 在 CLI workspace 的事件，不应该直接进入 Browser workspace。
- 同一个用户在同一个 workspace 的历史事件，可以在未来相似任务中召回。

### Event 类型

event 可以分为两类：

1. process event
   - 事情过程的记忆。
   - 记录做了什么、试了什么、遇到什么问题、如何调整。

2. result event
   - 事情结果的记忆。
   - 记录最终完成了什么、产出了什么、是否失败、失败原因。

实际存储时可以用一个 event 表，通过 `eventKind` 区分。

```ts
type EventMemory = {
  id: string;
  relationId: string;
  userId: string;
  workspaceId: string;
  conversationId: string;
  taskId: string;
  eventKind: "process" | "result";
  summary: string;
  detail: string;
  outcome?: "success" | "failure" | "blocked" | "partial";
  occurredAt: string;
  createdAt: string;
  version: number;
  supersedesId?: string;
  metadata: Record<string, unknown>;
};
```

event memory 是压缩后的事实投影，不是原始日志仓库。完整消息、provider 请求、上下文堆栈、工具参数/结果、workspace session 和审计记录分别保存在 `messages`、`llm_calls`、`context_segments`、`tool_calls`、`workspace_sessions` 和 `audit_logs`。event 的 `metadataJson` 只允许保存小型生命周期字段和可追溯引用，例如 `conversationId`、`eventKind`、`outcome`、`workspaceSessionId`、`taskId`，以及统一的 `sourceRefs: [{ table, ids }]`。同一批证据 id 不应同时作为多个顶层数组和 `sourceRefs` 重复保存；`sourceRefs` 是回查原始表的规范入口。Memory 不应该复制 `windowMessages`、`toolCalls`、`workspaceSessions`、`argumentsJson`、`resultJson`、`messagesJson`、`responseJson`、`rawJson` 或 `finalMessages` 这类原始 JSON。未来如果需要从记忆回查证据，应通过这些引用回到原始表，而不是把原始数据塞进 memory row。

## 事件的 SQLite FTS + Relation/Version 召回

首版 event 存储和召回以 SQLite 为主：结构化字段进入 `memories`，全文检索进入 `memories_fts`，最新版本判断由同一 scope 分区内的 `relationId + version` 决定。

SQL 的作用：

- 保存结构化字段。
- 支持 userid、workspaceId、时间、taskId 查询。
- 支持 version 和 relationId。
- 支持审计和调试。
- 支持 SQLite FTS 关键词/全文召回。

Embedding/vector store 是未来可选增强，不是当前实现依赖。除非 `ZLEAP_MASTER_PLAN.md` 更新，否则 runtime 和测试都应按 SQLite FTS + relation/version 设计。

推荐流程：

```text
写入 event:
  1. 从当前对话或 workspace session 中提取新 event。
  2. 在同一 userId + workspaceId 范围内按 relationId/version 和 FTS 查询相似记录。
  3. 判断召回结果是否与新 event 表达同一类事情。
  4. 如果相关，复用或生成 relationId。
  5. 将新 event 写入 SQLite，并更新 FTS。
```

召回 event:

```text
读取 event:
  1. 用当前任务生成 FTS query。
  2. 在 userId + workspaceId 范围内召回候选。
  3. 从召回结果中读取 relationId。
  4. 在同一 scope 分区内找到每个 relationId 最新版本的 event。
  5. 按相关度、时间、新旧关系排序。
  6. 注入 workspace context。
```

这个设计解决一个常见问题：召回可能命中旧记忆，但框架最终应该使用同一 scope 分区内的最新版本。

## 关系 ID

relationId 用来表达多条 event 之间是同一类事情的连续记录或版本演进。

例子：

```text
event-001:
  relationId: rel-project-test-command
  summary: 用户在某项目中运行 npm test 失败。

event-002:
  relationId: rel-project-test-command
  summary: 后来发现该项目需要 pnpm test。

event-003:
  relationId: rel-project-test-command
  summary: 最新结论是先 pnpm install，再 pnpm test。
```

召回时，即使向量库命中 event-001，也应该通过 relationId 找到 event-003。

latest version 的判断必须先限定同一个记忆分区。也就是说，比较 version 时至少要同时匹配 `memoryType`、`userId`、`agentId` 和 `workspaceId` 这些 scope 字段。其他用户、其他 workspace、其他 agent self scope，或其他 memory type 下的同名 `relationId`，不能隐藏当前分区自己的最新记忆。

同样的规则也适用于直接 relation lookup 和写入去重。runtime 或 repository 判断“这条 relation 是否已经存在”时，不能只按 `memoryType + relationId` 做全局查询，而必须带上完整 scope 分区。否则一个用户、workspace 或 agent self scope 里的同名 relation 会错误阻挡另一个分区的记忆写入或版本演进。

## 经验记忆

skill 是执行中的经验。

skill 不是单次事件，而是从事件中总结出来的可复用方法论。

skill 的隔离规则：

```text
经验记忆:
  workspace scoped
  shared across users
```

这意味着：

- CLI workspace 的 skill 只用于 CLI workspace。
- File workspace 的 skill 只用于 File workspace。
- 不同用户的 event 可以共同贡献 skill。
- skill 不应该泄露具体用户隐私。

### Skill 示例

CLI workspace skill：

```text
在 Node 项目中运行测试前，优先检查 package.json 中的 scripts 和 lockfile。
如果存在 pnpm-lock.yaml，默认优先使用 pnpm，而不是 npm。
```

File workspace skill：

```text
修改已有代码前，先搜索相关调用点和测试文件。
如果同一文件有用户未提交改动，不要覆盖或回滚。
```

Browser workspace skill（未来扩展）：

```text
前端视觉修改完成后，需要至少检查桌面和移动视口。
如果页面依赖 canvas 或 WebGL，不能只检查 DOM，需要截图或像素验证。
```

### Skill 数据结构

```ts
type SkillMemory = {
  id: string;
  workspaceId: string;
  title: string;
  summary: string;
  procedure: string[];
  appliesWhen: string[];
  avoidWhen: string[];
  evidenceEventIds: string[];
  confidence: number;
  usageCount: number;
  successCount: number;
  failureCount: number;
  createdAt: string;
  updatedAt: string;
  metadata: Record<string, unknown>;
};
```

## 经验记忆的渐进式披露与生成机制

经验记忆不应该把完整经验一次性塞进 prompt。第一版采用渐进式披露：

1. 进入 workspace 时，runtime 只按 `workspaceId` 召回最近 N 条 skill 的 `id/title/summary/confidence`。
2. 如果 agent 判断某条简介和当前任务高度相关，或能减少失败/指导工具流程，就调用 `readSkill(skillId)` 读取完整 `detail/procedure/appliesWhen/avoidWhen`。
3. 原始事件证据、完整工具输出、完整 metadata 仍留在 SQLite、tool_calls、audit_logs 和 workspace_sessions 中。

skill 有三种生成路径：

1. hook 自动生成
   - 每次 event 提取时，判断是否有可沉淀的经验。
   - 只有出现明确可复用的方法、能力工具流程或失败恢复路径时，才生成或复用 skill。
   - 普通任务结果、workspace 完成状态、用户内容摘要都不能单独变成 skill。

2. agent 主动生成
   - agent 在执行过程中认为某个经验值得沉淀。
   - 或用户明确要求“总结经验”。

3. creator 人工维护
   - 通过 Memory UI/API 管理高质量共享 skill。

主动触发的 skill memory 也必须绑定当前 active workspace。runtime 可以从用户/agent 的触发文本里提炼 title、summary、procedure、appliesWhen 和 avoidWhen，但不能根据文本里的“命令行”“文件”“测试”等关键词猜测另一个 workspace。若经验应属于某个子 workspace，agent 需要先进入该 workspace，或由人工 Memory UI/API 在权限层进行调试维护。
中文产品表达里的“总结一下经验”“沉淀经验”“提炼经验”“把这个经验记下来”等只作为触发语，不应该原样成为 skill 内容。保存时要去掉触发口令，只保留可复用经验本身。
   - agent 调用 skill 写入工具。

好的 skill 应该记录可迁移的方法、失败后找到的稳定规避方式、经过验证的工具流程，或能降低同类任务失败率的经验。比如“某种 shell 写入方式失败后，改用脚本 API 明确写入内容和编码”。“认真检查”“合理使用工具”“保持上下文”这类泛泛提醒不应写入 skill。

自动生成 skill 的触发频率应该低于 event。

Hook 生成的 skill 必须使用脱敏后的投影视图。`detail` 不能复制 process/result event 原文、function call 参数、工具输出、用户身份、任务原文、私有项目内容、账号或路径；这些内容只能作为 evidence id 和调试日志保存在 SQLite 的事件、tool_calls、audit_logs、workspace_sessions 中。为了避免重复污染，同一 workspace 的相似 skill 应使用稳定 fingerprint 和 relation/version 去重，复用旧记录而不是重复创建。

skill 如果来自 event 证据，也只保存 event id 或 `sourceRefs` 这类引用。Skill 的价值在泛化后的方法、适用条件和避免条件，不在复刻一次原始任务过程。

原因：

- event 是事实记录，应该相对完整。
- skill 是抽象经验，质量要求更高。
- 过度生成 skill 会污染未来上下文。

## 记忆注入策略

不同 memory 注入方式不同。

### Impression 注入

impression 是跨 workspace 的。

在每次 agent 响应前，可以注入当前用户相关 impression 和 agent self impression。

但需要控制长度。

推荐只注入：

- 与当前用户最相关的 top impressions。
- 明确标记为长期有效的偏好。
- agent self 的稳定身份原则。

### Event 注入

event 是 workspace 内召回。

进入 workspace 时，根据 workspace task 查询：

```text
userId + workspaceId + semantic query
```

然后注入最新相关事件。

### Skill 注入

skill 是 workspace 内召回，但不按 userid 限制。

进入 workspace 时，根据 workspaceId 读取最近 N 条 skill 简介：

```text
workspaceId + maxSkillMemories
```

然后只注入 skill 索引视图。完整步骤必须通过 `readSkill(skillId)` 按需读取。

event/skill 的召回开关由当前 active workspace 的 `memoryPolicyJson` 控制。Event recall 不再使用单一 `maxEventMemories` 作为统一上限，而是采用固定分层策略：结果事件最多约 50 条，过程事件最多约 8 条并按当前任务文本做 SQLite FTS 相关性筛选。Skill recall 由 `maxSkillMemories` 控制，并暂时使用最近 N 条；未来可以升级成 RAG 选择简介。

长对话上下文注入遵循“原始近邻 + 事件投影”的策略：最近 20 条本地对话保留详细文本；更早的上下文通过 result event 时间线和相关 process event 投影视图进入 prompt。召回 memory 注入模型前必须转为 compact projection，不把完整 `detail`、完整 `metadataJson`、证据数组、完整 skill procedure 或原始对话窗口重新塞回上下文。

Impression recall 不做 query 选择性筛选，固定载入当前 user / agent scope 下最新有效的前 20 条投影视图。Impression 表达对人和 agent 自我的稳定认知，预期数量有自然上限，不像 event log 一样无限增长。

`final_messages` 不属于 memory，也不属于 prompt context 的一层。它只是原始 LLM 请求日志，用于在 Web UI 中核对最终 provider payload；memory 召回逻辑不能从这个日志反向再注入上下文。

## 记忆写入权限

### Impression 写入权限

user impression：

- agent 可以主动写入。
- 系统提示词中需要明确什么时候写入。
- 应避免写入敏感信息，除非用户明确表达长期偏好或长期事实。

agent self impression：

- 只有 agent 创建者可以要求写入。
- 普通用户不能直接改变 agent 自我认知。

### Event 写入权限

event 主要由 hook 写入。

agent 也可以请求写入，但最终应该通过 runtime policy 判断。

### Skill 写入权限

skill 可以由 hook 写入，也可以由 agent 或用户请求写入。

但 skill 写入前应该经过质量判断：

- 是否真的可复用。
- 是否过度依赖某个用户隐私。
- 是否只适用于某个 workspace。
- 是否有足够 event 证据。

## 记忆与注意力

memory 不是越多越好。

Zleap 的 memory 系统要解决的不是“无限记住”，而是“在正确的 workspace 中召回正确的记忆”。

因此需要几个原则：

1. 记忆先分类，再召回。
2. 召回先过滤租户和 workspace，再做语义匹配。
3. 同一 relationId 使用同一 scope 分区内的最新版本。
4. skill 要少而精。
5. impression 只保存长期稳定信息。
6. event 保存事实，skill 保存方法。

## 记忆工具与工作空间边界

记忆不再作为独立 `Memory Workspace` 存在。模型可见的 memory 工具只包括 `searchMemory`、`readSkill`、`writeUserImpression`、`writeAgentSelfImpression` 和 `writeSkillMemory`，并挂载在每个 workspace 中。`writeEventMemory`、`updateMemory` 和 `deleteMemory` 不是模型可调用工具。

运行时模型调用这些工具时，event/skill 记忆必须被当前 active workspace 约束：在默认 `dev` workspace 中只能搜索、写入或读取 `dev` 的 event/skill 记忆，不能越权操作其他 MCP workspace 的 event/skill。user impression 和 agent self impression 仍然是跨 workspace 的身份层记忆，但写入和管理继续受 userId/creator policy 限制。

runtime memory tool 的归属由代码绑定，不由 AI 自己传参决定。function-call schema 不应暴露 `userId`、`agentId`、`workspaceId` 这类 scope 字段；`readSkill` 和 `writeSkillMemory` 的 `workspaceId` 必须来自当前 active workspace，`writeUserImpression` 的 `userId` 必须来自当前 run，`writeAgentSelfImpression` 的 `agentId` 必须来自当前 agent。模型如果幻觉传入这些 scope 字段，runtime 必须拒绝该 tool call。

跨 workspace 的全局调试、筛选、人工编辑和迁移属于 Web UI/API 的 Memory 管理层能力，不属于普通模型 tool use。

### runtime 搜索不是 creator 全局调试

`searchMemory` 作为 runtime function-call 工具仍然受模型控制，所以即使当前 run 具有 `creator` role，它也必须保持同一套 runtime 读取边界。它可以搜索当前 run 用户自己的 user impression/event，以及 active workspace 中的共享 skill，但不能暴露其他用户的 event/impression，也不能暴露 creator 控制的 agent self impression。creator 全局检查属于直接 Memory Web UI/API 能力，不属于 prompt/tool 能力。

### 代码绑定的 impression scope

Runtime impression 写入工具遵循和 event/skill 工具相同的代码绑定 scope 规则。`writeUserImpression` 的 `userId` 只能来自当前 run，`writeAgentSelfImpression` 的 `agentId` 只能来自当前 agent。如果模型在任意 impression 工具调用里传入 `userId`、`agentId` 或 `workspaceId`，runtime 必须拒绝该调用，而不是忽略这些参数或把它们当成可信路由提示。

Runtime 请求写入的 impression 仍然是跨工作空间身份记忆，不是工作空间记忆。不过 metadata 和 audit logs 应尽量保留紧凑的来源执行证据：`activeWorkspaceId`、`workspaceSessionId` 和 `taskId`。这些字段用于 Web UI 调试“agent 在哪里决定写入 impression”，不会变成 memory 的 scope，也不需要再保存一份重复数组。

直接 Memory Web UI/API 的 update 流程可以为了 creator 调试和迁移暴露 scope 字段，但每次更新都必须用同一套写入策略校验最终 patched row。只检查 actor 能编辑原始 row 是不够的；patched result 仍然必须是合法的 impression/event/skill 形状，并且不能在没有对应角色的情况下跨越 user、agent 或 workspace 边界。

直接 Memory Web UI/API 的 create/update/delete 调用可以携带 operation-level `conversationId`，但它只用于 trace linking。对于普通用户，这个 id 必须属于其已有 conversation，才能继续执行操作或写入 audit log。这个请求字段和 runtime memory tools 是分离的；runtime 工具里的 `conversationId` 只能来自当前 run。

## 绝对事件窗口

自动 event memory 提取基于完整已存 conversation 的绝对消息窗口。受限的 recent history slice 只是 prompt context，不能决定正在提取第几个 event window。例如窗口大小为 20 时，已存消息 501-520 是 `window:26`；不能因为只加载了最新 500 条消息就把它误标成 `window:1` 或跳过。

## 直接 skill 管理与 runtime skill 生成

直接 Memory Web UI/API 创建 skill 是 creator-only 操作，因为它直接编辑共享工作空间知识。这个调试/维护层可以暴露更宽的字段用于检查和迁移，但仍必须通过同一套 memory policy 和 skill quality gates。

Runtime skill 生成是另一条路径：普通用户或 agent 可以通过 active workspace 的 `writeSkillMemory` 显式触发可复用经验提取。在这条路径里，`workspaceId` 由 runtime 代码注入，不由模型提供；只有当前工作空间记忆策略允许写 skill，且候选内容可复用、已脱敏、有结构、证据安全，写入才会被接受。

Runtime `writeSkillMemory` 还会携带来自 runtime state 的 trace 证据。持久化 metadata 应在可用时包含 `activeWorkspaceId`、当前 `workspaceSessionId` 和当前 `taskId`，让 Web UI 能显示哪次工作空间执行产生或请求了这条共享 skill。模型仍然不能提供这些 id，也不应该重复生成等价的证据数组。
