# Hooks and Lifecycle

## 总览

Zleap 的 agent runtime 需要通过 hook 把对话、workspace、tool 和 memory 串起来。

hook 的目标不是让模型自己负责所有生命周期，而是由程序在关键节点自动做结构化处理。

核心生命周期：

```text
User Message
  -> Load Global Context
  -> Main Workspace Planning
  -> Enter Workspace
  -> Execute Workspace Task
  -> Exit Workspace
  -> Generate Event Memory
  -> Maybe Generate Skill
  -> Return to Main Workspace
  -> Final Response
```

## Hook 类型

推荐的 hook：

```ts
type RuntimeHook =
  | "beforeAgentTurn"
  | "afterAgentTurn"
  | "beforeWorkspaceEnter"
  | "afterWorkspaceEnter"
  | "beforeToolCall"
  | "afterToolCall"
  | "beforeWorkspaceExit"
  | "afterWorkspaceExit"
  | "afterConversationWindow"
  | "afterEventExtracted"
  | "afterSkillExtracted";
```

## 对话入口流程

用户输入时：

```text
1. runtime 接收 userId、conversationId、message。
2. 加载 agent identity。
3. 加载 user impression。
4. 加载 agent self impression。
5. 进入 main workspace。
6. main workspace 查看 workspace registry。
7. main workspace 决定直接回答、询问用户或进入某个 workspace。
```

## beforeAgentTurn

这个 hook 在模型响应前运行。

职责：

- 校验 userId。
- 加载跨 workspace impression。
- 生成当前轮 context。
- 检查 conversation 是否超过窗口。
- 注入必要的系统规则。

不应该做：

- 不应该召回所有 event。
- 不应该把所有 workspace 的 memory 塞进上下文。
- 不应该写入长期记忆。

## afterAgentTurn

这个 hook 在模型响应后运行。

职责：

- 保存 assistant message。
- 记录 token 使用情况。
- 判断是否需要触发对话窗口级 event 提取。
- 判断 agent 是否调用了记忆写入工具。

## beforeWorkspaceEnter

进入 workspace 前运行。

职责：

- 检查当前 user 是否有权限进入 workspace。
- 构造 `WorkspaceTask`。
- 根据 task 检索 workspace event memory。
- 根据 task 检索 workspace skill memory。
- 创建 workspace session。
- 组装 workspace-local context。

示意：

```text
input:
  userId
  workspaceId
  objective
  parent context summary

load:
  user impression
  agent self impression
  workspace instructions
  event memory scoped by userId + workspaceId
  skill memory scoped by workspaceId
```

## afterWorkspaceEnter

进入 workspace 后运行。

职责：

- 记录 audit log。
- 保存 workspace session start。
- 告知主 workspace 当前已进入的 workspace。

## beforeToolCall

tool 调用前运行。

职责：

- 检查 tool 是否属于当前 workspace。
- 检查 user 权限。
- 检查是否需要人工确认。
- 对参数做基本校验。
- 记录待执行 tool call。

这个 hook 是安全边界的一部分。

## afterToolCall

tool 调用后运行。

职责：

- 保存 tool result。
- 标记成功或失败。
- 将关键信息加入 workspace local context。
- 判断是否出现值得记录的 event 片段。

不建议每次 tool call 都立刻生成长期 memory。可以先积累到 workspace session，再由 event extraction 统一处理。

## beforeWorkspaceExit

退出 workspace 前运行。

职责：

- 要求 workspace 产出结构化 `WorkspaceResult`。
- 对结果做基本校验。
- 生成给主 workspace 的摘要。
- 判断是否 blocked 或需要用户输入。

## afterWorkspaceExit

退出 workspace 后运行。

职责：

- 保存 workspace result。
- 触发 event extraction。
- 触发 skill candidate extraction。
- 将结果返回 main workspace。

## afterConversationWindow

这是一个自动触发的 hook。

触发条件可以是：

- 每隔 N 条对话。
- 每隔 N 个 tool call。
- workspace session 结束。
- conversation token 超过阈值。
- 用户显式结束一个任务。

职责：

- 从近期对话中提取 event。
- 生成对话摘要。
- 压缩 context。
- 维护 relationId。
- 判断是否需要提炼 skill。

## Event Extraction

event 提取主要由程序 hook 自动触发。

输入：

- workspace session。
- 最近 N 条消息。
- tool call history。
- workspace result。
- 已召回 memory。

输出：

- process event。
- result event。
- relationId。
- embedding。
- 是否建议提取 skill。

流程：

```text
1. 收集 workspace session 过程。
2. 判断是否有值得保存的事情。
3. 生成 process event 和 result event。
4. 对 event 做 embedding。
5. 在 userId + workspaceId 内召回相似 event。
6. 决定 relationId。
7. 写入 SQL。
8. 写入 vector store。
9. 触发 skill 判断。
```

## Skill Extraction

skill 提取有三种触发来源：

1. event hook 自动判断。
2. 用户明确要求。
3. agent 主动调用 skill 生成工具。

skill 提取应该更克制。

适合生成 skill 的情况：

- 同类问题重复出现。
- 某次失败带来明确教训。
- 某个流程被验证有效。
- 某个 workspace 的工具使用方式有稳定规律。

不适合生成 skill 的情况：

- 只是一条普通事实。
- 只适用于某个用户的私密上下文。
- 结果不确定。
- 没有验证过。

## Agent 主动记忆工具

除了 hook，agent 也可以主动调用记忆工具。

例如：

```text
writeUserImpression
writeAgentSelfImpression
writeEventMemory
writeSkillMemory
searchMemory
updateMemory
```

但这些工具不是任意可用。

### writeUserImpression

适用：

- 用户表达长期偏好。
- 用户告诉 agent 未来都要遵守某个习惯。
- 用户介绍长期身份或背景。

限制：

- 只能写当前 userId。
- 不应记录敏感信息，除非用户明确要求。

### writeAgentSelfImpression

适用：

- agent 创建者明确要求 agent 更新自我认知。

限制：

- 普通用户不能使用。
- 需要审计。

### writeEventMemory

适用：

- agent 明确知道当前事件非常重要。

限制：

- 默认优先由 hook 写入。
- agent 请求写入时，runtime 仍要检查。

### writeSkillMemory

适用：

- 用户要求总结经验。
- agent 发现某个方法论可以复用。

限制：

- 需要脱敏。
- 需要绑定 workspace。
- 应保存 evidence event。

## Workspace Lifecycle 示例

以“修改项目代码并验证”为例：

```text
1. 用户请求：帮我修复测试失败。
2. Main workspace 判断需要 CLI workspace。
3. 进入 CLI workspace。
4. CLI workspace 运行测试，发现失败。
5. 退出 CLI workspace，返回失败摘要。
6. Main workspace 判断需要 File workspace。
7. 进入 File workspace。
8. File workspace 搜索相关文件并修改。
9. 退出 File workspace，返回修改摘要。
10. Main workspace 再进入 CLI workspace。
11. CLI workspace 运行测试通过。
12. 退出 CLI workspace。
13. hook 提取 event：
    - 过程：先测试失败，再定位文件，再修改，再验证。
    - 结果：测试通过。
14. hook 判断是否生成 skill：
    - 如果发现项目测试命令规律，生成 CLI skill。
15. Main workspace 给用户最终结果。
```

## 生命周期设计原则

1. 模型负责判断和行动，runtime 负责边界和生命周期。
2. workspace 进入时召回局部 memory，退出时沉淀局部 event。
3. event 以事实为主，skill 以方法为主。
4. hook 自动化常规记忆生成，agent 工具用于主动记忆。
5. 所有写入都经过 userid、workspaceId 和权限检查。

