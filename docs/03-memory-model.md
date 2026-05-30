# Memory Model

## 总览

Zleap 的 memory 不应该是一个扁平的“长期记忆”集合。

不同记忆有不同用途、隔离边界、生成方式和召回方式。

Zleap 将 memory 分为三类：

```text
1. Impression
   - 对人的记忆
   - 包含对用户的认知和 agent 对自己的认知

2. Event
   - 对事情的记忆
   - 包含过程记忆和结果记忆

3. Skill
   - 对执行经验的记忆
   - 从 event 中总结出来的方法论
```

## Memory 隔离总表

| Memory 类型 | 是否跨 workspace | 是否按 userid 隔离 | 是否跨用户共享 | 主要用途 |
| --- | --- | --- | --- | --- |
| Impression: user | 是 | 是 | 否 | 记住用户偏好、背景、长期约束 |
| Impression: agent self | 是 | 通常不按普通 userid 隔离 | 由创建者控制 | 记住 agent 对自己的定位和身份 |
| Event | 否 | 是 | 否 | 记住某人在某 workspace 做过什么 |
| Skill | 否 | 否 | 是 | 让 workspace 从所有用户经验中学习 |

## Impression Memory

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

### User Impression

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

### Agent Self Impression

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

## Event Memory

event 是对事情的记忆。

event memory 记录的是某个用户在某个 workspace 中发生过的任务过程和任务结果。

event 具有以下隔离规则：

```text
Event Memory:
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
  embeddingRef?: string;
  metadata: Record<string, unknown>;
};
```

## Event 的 SQL + Vector 双存储

event 需要同时存在 SQL 和向量库里。

SQL 的作用：

- 保存结构化字段。
- 支持 userid、workspaceId、时间、taskId 查询。
- 支持 version 和 relationId。
- 支持审计和调试。

Vector 的作用：

- 支持语义召回。
- 通过相似任务找到相关事件。

推荐流程：

```text
写入 event:
  1. 从当前对话或 workspace session 中提取新 event。
  2. 对新 event 生成 embedding。
  3. 在同一 userId + workspaceId 范围内做向量召回。
  4. 判断召回结果是否与新 event 表达同一类事情。
  5. 如果相关，复用或生成 relationId。
  6. 将新 event 写入 SQL。
  7. 将新 event 写入 vector store。
```

召回 event:

```text
读取 event:
  1. 用当前任务生成 query embedding。
  2. 在 userId + workspaceId 范围内向量召回。
  3. 从召回结果中读取 relationId。
  4. 到 SQL 中找到每个 relationId 最新版本的 event。
  5. 按相关度、时间、新旧关系排序。
  6. 注入 workspace context。
```

这个设计解决一个常见问题：向量库可能召回旧记忆，但框架最终应该使用最新版本。

## Relation ID

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

## Skill Memory

skill 是执行中的经验。

skill 不是单次事件，而是从事件中总结出来的可复用方法论。

skill 的隔离规则：

```text
Skill Memory:
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

Browser workspace skill：

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
  embeddingRef?: string;
  metadata: Record<string, unknown>;
};
```

## Skill 生成机制

skill 有两种生成路径：

1. hook 自动生成
   - 每次 event 提取时，判断是否有可沉淀的经验。
   - 如果有，就生成或更新 skill。

2. agent 主动生成
   - agent 在执行过程中认为某个经验值得沉淀。
   - 或用户明确要求“总结经验”。
   - agent 调用 skill 写入工具。

自动生成 skill 的触发频率应该低于 event。

原因：

- event 是事实记录，应该相对完整。
- skill 是抽象经验，质量要求更高。
- 过度生成 skill 会污染未来上下文。

## Memory 注入策略

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

进入 workspace 时，根据 workspace task 查询：

```text
workspaceId + semantic query
```

然后注入可用技能。

## Memory 写入权限

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

## Memory 与注意力

memory 不是越多越好。

Zleap 的 memory 系统要解决的不是“无限记住”，而是“在正确的 workspace 中召回正确的记忆”。

因此需要几个原则：

1. 记忆先分类，再召回。
2. 召回先过滤租户和 workspace，再做语义匹配。
3. 同一 relationId 使用最新版本。
4. skill 要少而精。
5. impression 只保存长期稳定信息。
6. event 保存事实，skill 保存方法。

## 2026-05-30 更新：记忆工具与 workspace 边界

记忆不再作为独立 `Memory Workspace` 存在。`searchMemory`、`writeUserImpression`、`writeEventMemory`、`writeSkillMemory`、`updateMemory` 和 `deleteMemory` 挂载在每个 workspace 中。

运行时模型调用这些工具时，event/skill 记忆必须被当前 active workspace 约束：在 `file` workspace 中不能通过传入 `workspaceId: "cli"` 去搜索、写入、更新或删除 CLI 的 event/skill 记忆。user impression 和 agent self impression 仍然是跨 workspace 的身份层记忆，但写入和管理继续受 userId/creator policy 限制。

跨 workspace 的全局调试、筛选、人工编辑和迁移属于 Web UI/API 的 Memory 管理层能力，不属于普通模型 tool use。
