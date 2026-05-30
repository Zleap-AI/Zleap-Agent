# Agent 理念

## 背景问题

许多现有 agent 框架采用一种直接但粗糙的设计：

```text
Agent = LLM + 所有 tools + 所有 memory + 所有 skills + 所有 context
```

这种设计的优点是简单。开发者可以快速把工具挂到 agent 上，让模型自己判断该调用哪个工具、该参考哪些记忆、该执行哪些步骤。

但这个方式有几个根本问题：

1. 对模型能力要求过高
   - 模型需要同时理解任务、筛选工具、筛选记忆、规划步骤、执行工具、纠错和总结。
   - 工具越多，模型越容易选错工具或在工具描述之间分散注意力。

2. 注意力浪费严重
   - 大量与当前任务无关的工具和记忆会挤占上下文。
   - LLM 的上下文窗口不是等价的数据库，能放进去不代表模型能稳定使用。

3. 记忆容易污染
   - 用户信息、任务过程、技能经验如果没有明确边界，容易互相混淆。
   - 多用户场景下尤其危险，可能把 A 用户的事情带到 B 用户的任务中。

4. 编排和执行混在一起
   - 主 agent 既要决定任务拆分，又要执行具体工具。
   - 这会导致 agent 在高层目标和低层操作之间频繁切换，降低稳定性。

5. 难以成长
   - 如果 skill 只是普通 memory 的一种，那么经验不会被明确积累成可复用方法论。
   - agent 做过很多事，但不一定真的变得更会做事。

## Zleap 的核心假设

Zleap 的核心假设是：

> LLM 的注意力是稀缺资源。优秀的 agent framework 不应该盲目扩大单个 agent 的上下文，而应该主动组织上下文。

这意味着，框架的价值不只是“帮模型调用工具”，而是：

- 控制模型当前能看到什么。
- 控制模型当前能做什么。
- 控制哪些记忆被召回。
- 控制任务在不同能力空间之间如何流转。
- 控制经验如何沉淀，如何被未来任务复用。

## Agent 的定义

在 Zleap 中，agent 可以被定义为：

```text
Agent = LLM
      + System Prompt
      + Personality Prompt
      + Tools
      + Memory
      + Conversation Context
```

这个定义保留了传统 agent 的组成部分，但关键区别是：这些组成部分并不处在同一个平面。

其中，稳定部分是：

```text
Stable Agent Identity = LLM
                      + System Prompt
                      + Personality Prompt
```

动态部分是：

```text
Dynamic Workspace State = Tools
                        + Workspace Memory
                        + Workspace Context
```

因此，agent 不是一个固定装满所有能力的对象，而是一个稳定身份在不同 workspace 中运行的过程。

## 不是“子 agent”

Zleap 的 workspace 切换不是传统意义上的多 agent 或子 agent。

在传统子 agent 模型中，通常会出现：

- 每个子 agent 有自己的 system prompt。
- 每个子 agent 有自己的角色和人格。
- 主 agent 把任务委托给子 agent。
- 子 agent 返回结果。

Zleap 的模型不同：

- 切换 workspace 时，agent 的 system prompt 不变。
- 切换 workspace 时，agent 的 personality prompt 不变。
- 变化的是 tools、workspace memory、workspace context。
- 还是同一个 agent，只是进入了不同的工作空间。

类比到人使用电脑：

- 人没有变。
- 人格没有变。
- 操作系统规则没有变。
- 只是从桌面打开了不同软件。
- 在不同软件中，可见对象、可用工具和当前上下文不同。

这可以减少多 agent 之间人格漂移、目标漂移和重复沟通的问题。

## 分而治之

Zleap 的关键设计哲学是分而治之。

不是让一个 agent 看到所有东西：

```text
Agent
  - CLI tools
  - File tools
  - Browser tools
  - Database tools
  - Search tools
  - User memories
  - Project memories
  - Debug skills
  - Writing skills
  - Coding skills
  - All conversation history
```

而是把能力拆成 workspace：

```text
Main Workspace
  - 只负责理解任务、选择 workspace、编排流程

CLI Workspace
  - 只负责命令行相关工具和经验

File Workspace
  - 只负责文件读写、解析、转换相关工具和经验

Browser Workspace
  - 只负责浏览器操作、页面检查、截图、交互相关工具和经验

Memory Tools
  - 记忆不是独立 workspace；记忆检索、写入、整理、归档工具挂在每个 workspace 内
  - 每个 workspace 只能通过自己的记忆工具操作当前 workspace 的 event/skill 记忆
  - 跨 workspace 的记忆调试和维护属于 Web UI/API 的策略层能力，不属于模型普通 tool use
```

首版实现只包含 `main`、`file`、`cli`。Browser workspace 保留为未来可以通过 workspace manifest/MCP 工具绑定扩展的例子，不属于当前默认工作空间集合。

每次只让模型进入它当前真正需要的能力空间。

## 主 workspace 的定位

主 workspace 类似系统桌面。

它不是一个万能工作区，而是一个编排工作区。

它应该能看到：

- 当前有哪些 workspace。
- 每个 workspace 大概能做什么。
- 当前任务需要哪些 workspace。
- 已经进入过哪些 workspace。
- 每个 workspace 返回了什么结果。

它不应该直接拥有所有子 workspace 的底层工具。否则主 workspace 会退化成传统的大 agent。

主 workspace 的核心能力是：

- 任务理解。
- 任务拆分。
- workspace 选择。
- workspace 切换。
- 结果整合。
- 判断是否继续、停止或询问用户。

## 子 workspace 的定位

子 workspace 类似一个具体软件或专业工作台。

例如：

- CLI workspace
  - 可用工具：执行命令、读取终端输出。
  - 记忆：命令执行经验、项目构建经验、常见错误处理方式。

- File workspace
  - 可用工具：读文件、写文件、搜索文件、解析文件。
  - 记忆：某类文件处理经验、项目结构经验、格式转换经验。

- Browser workspace（未来扩展）
  - 可用工具：打开网页、点击、输入、截图、检查 DOM。
  - 记忆：页面测试经验、交互验证经验、常见前端问题。

每个子 workspace 的任务是完成具体操作，并把结构化结果返回给主 workspace。

## 框架想要解决的问题

Zleap Agent Framework 最终要解决的是：

1. 如何让 agent 在复杂任务中保持注意力集中。
2. 如何让工具能力以 workspace 形式被组织和切换。
3. 如何让 memory 按照人、事、经验分层存储和召回。
4. 如何让多租户从底层就是安全隔离的。
5. 如何让 agent 在执行中沉淀经验。
6. 如何让开发者可以创建新的 workspace，像给系统安装新软件一样扩展 agent 能力。
7. 如何提供一个可运行的基础 runtime 和 Web UI，让用户实际体验这个框架。
