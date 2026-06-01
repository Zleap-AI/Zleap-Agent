# Zleap User UI Guide

本文档是 Zleap 用户级 UI 的产品、交互、视觉、接口和验收规格。实现 `/` 新用户 UI 和保留 `/dev` 旧调试台时，必须以本文档为准。

## 1. 产品目标

Zleap 的默认界面必须像一个成熟的 Agent 产品，而不是 runtime 调试控制台。

- 用户打开 `/` 后，第一屏就是可用聊天界面。
- 用户不需要理解 workspace、memory、trace、database table、JSON schema 等内部概念，也能完成对话。
- 默认界面只暴露真实用户需要的能力：新建会话、切换会话、发送消息、停止生成、重试、基础设置。
- 复杂能力采用渐进披露：设置弹窗、会话菜单、深度用户管理区、开发者模式、`/dev` 调试台。
- 旧 UI 不能删除。旧 UI 是开发者调试工具，必须完整保留在 `/dev`。

### 用户默认能完成的任务

- 新建一个空会话。
- 输入消息并发送。
- 在生成中停止。
- 出错后重试上一条消息。
- 从左侧会话栏切换历史会话。
- 重命名、删除、复制当前会话 ID。
- 配置 Agent、模型、接口地址和 API Key。
- 创建、切换、编辑自己的 Agent。
- 创建和编辑易懂的工作空间说明、能力清单和审批偏好。
- 为工作空间配置 MCP Server，并查看由 MCP 挂载的专属工具。
- 查看、搜索、补充和修正自己的记忆。

### 默认隐藏的调试概念

以下内容不得出现在普通用户默认界面的一屏主路径中：

- 记忆表、长期记忆写入、memory policy。
- 日志、audit log、LLM raw messages、context segment。
- 数据表、SQLite 表名、schema。
- 原始 tool binding、JSON schema。
- workspace manifest、workspace handoff、context window stack。

开发者模式开启后，可以显示轻量入口和运行过程摘要，但完整调试能力仍然跳转到 `/dev`。

深度用户功能不是调试概念。Agent、工作空间和记忆可以在设置弹窗中出现。工作空间允许通过 MCP Server 增加专属工具，但必须用用户能理解的语言呈现，不暴露 JSON schema、raw log、数据库字段或内置 runtime 工具。

## 2. 路由与入口

### `/`

`/` 是新用户 UI，是默认产品入口。它展示左侧会话栏和右侧聊天界面。

### `/dev`

`/dev` 是旧调试台入口。旧调试台必须保留现有 tab：

- 对话
- 工作空间
- 记忆
- 日志
- 数据表
- 配置
- 概念介绍

旧调试台允许继续暴露 context stack、LLM log、工具日志、数据库表、工作空间工具编辑等开发者功能。

### `/dev?conversationId=...`

从新 UI 进入开发者调试时，应携带当前 `conversationId`。旧调试台打开后应优先使用 query 中的 `conversationId`，方便直接查看当前会话 trace。

### 未知路由

未知前端路由应回退到 `/` 的新用户 UI。静态资源和 API 404 不受此规则影响。

## 3. 信息架构

### 页面骨架

桌面端布局：

```text
┌──────────────────────────────────────────────────────────────┐
│ Sidebar                         Chat Area                    │
│ ┌ New chat ┐                    ┌ Header ┐                   │
│ Search/filter                   │ Messages │                 │
│ Conversation list               │          │                 │
│                                  │ Composer │                 │
│ Settings / Developer mode                                      │
└──────────────────────────────────────────────────────────────┘
```

### 左侧 Sidebar

Sidebar 包含：

- 顶部：新建会话按钮、折叠按钮。
- 搜索/筛选入口：v1 可以只实现本地标题筛选。
- 会话列表：按 `updatedAt DESC` 排序。
- 底部：设置按钮、开发者模式开关或入口。

会话项显示：

- 标题。
- 更新时间。
- 当前会话选中状态。
- hover 后出现 `...` 菜单。

会话菜单包含：

- 重命名。
- 删除。
- 复制会话 ID。
- 在开发者模式打开。

空状态文案：

- `开始一个新对话`

空状态不得展示技术说明。

### 主聊天区

主聊天区包含：

- Chat Header。
- Message List。
- Composer。

Chat Header：

- 左侧显示当前 Agent 名称。
- 右侧显示模型选择、设置按钮、开发者模式入口。
- 不做 hero，不显示大标题，不出现营销文案。

Message List：

- 用户消息右对齐。
- 助手消息左对齐。
- 普通模式显示轻量运行过程面板，说明 Agent 正在搜索、切换工作空间或调用工具。
- 运行过程面板必须放在对应助手最终消息上方，而不是消息下方。
- 运行过程面板使用与助手消息一致的头像列和内容列，右侧内容宽度必须与助手正文对齐。
- 本轮运行中默认展开显示最近进展；`done` 后自动折叠。
- 切换历史会话回来时，运行过程必须可从 trace 重建，并保持可展开查看。
- 完成、失败或阻塞的步骤使用静态灰点；只有真实运行中的步骤可以使用绿色跳动点。
- 开发者模式开启后，可以显示更详细的可展开运行过程，但仍不能把原始 JSON 作为主要展示。
- `askUser` 必须渲染为用户可点击的选项按钮；点击选项后自动作为用户回复发送。

Composer：

- 固定在主聊天区底部。
- 最大宽度与消息列一致。
- 输入框支持多行。
- 发送/停止按钮状态清晰。
- 模型选择靠近输入区域，而不是放到远离聊天动作的位置。
- 左侧工具菜单必须提供可执行入口，不能是无反馈的空按钮。
- v1 工具菜单至少包含工作空间与工具、记忆、Agent、当前会话调试台入口。
- 工具菜单项点击后应直接打开对应设置区或 `/dev?conversationId=...`，不展示“即将支持”类死入口。

### 设置弹窗和深度用户管理区

设置弹窗分为基础设置、Agent、工作空间、记忆和高级设置。

基础设置：

- Agent。
- Model。
- Base URL。
- API Key。

Agent：

- 切换当前 Agent。
- 新建 Agent。
- 编辑 Agent 名称、默认模型、服务地址。
- 编辑“它应该怎样帮助我”的自然语言说明。
- 不直接暴露 system prompt/personality prompt 字段名；可以将其包装为“核心指令”和“表达风格”。

工作空间：

- 列出工作空间。
- 新建工作空间。
- 编辑名称、用途说明、能力清单、是否需要确认。
- 配置 MCP Server，用来为当前工作空间增加外部专属工具。
- 展示当前工作空间可用的专属工具列表。
- 内置文件工具不得默认操作项目根目录，也不得使用项目内 `.codex` 目录；每个会话必须使用专属工作目录，默认目录名形如 `<tmp>/zleap-agent/conversations/<conversationId>-<hash>/`。
- 服务部署方可以通过环境变量 `ZLEAP_FILE_WORKSPACE_ROOT` 指向自选基础目录；UI 后续可在高级设置中暴露为“文件工作目录”。
- 不暴露系统内置工具、工具 JSON、参数 schema、memoryPolicyJson。
- 手动编辑工具 schema、runtime binding 和底层 manifest 仍跳转 `/dev`。

记忆：

- 搜索和筛选记忆。
- 查看记忆标题、摘要、详情。
- 新增或编辑用户事实、项目经历、可复用经验。
- 删除错误或过期记忆。
- 不暴露 relationId、metadataJson、version 等内部字段。

高级设置：

- userId。
- userRole。
- conversationId 只读或复制入口。

保存策略：

- API Key 只存浏览器本地缓存，不写数据库。
- Base URL、model、developerMode、sidebarCollapsed、当前 conversationId 存 localStorage。
- 会话、消息、标题以数据库为准。

### 开发者模式

开发者模式默认关闭。

开启后可以显示：

- 当前 conversationId。
- 打开 `/dev?conversationId=...`。
- 显示本轮隐藏的运行过程。
- 打开当前会话 trace/log 的调试入口。

开发者模式不重新实现旧调试台全部功能。完整功能仍在 `/dev`。

## 4. ChatGPT 风格参考规则

设计目标是高度相似的信息架构和产品质感，但不能造成品牌混淆。

### 可以模仿

- 左侧会话列表、右侧主聊天区。
- 低对比中性色背景。
- 底部圆角 composer。
- 模型选择靠近 composer。
- 细腻的 hover 菜单和选中态。
- 助手消息以阅读为主，不使用重边框卡片。
- 常用工具收进 composer 附近菜单。

### 不可模仿

- OpenAI Logo。
- ChatGPT 名称。
- OpenAI 专有图标组合。
- 精确品牌文案。
- 任何会让用户误以为这是 ChatGPT 官方产品的标识。

### 公开参考

- OpenAI ChatGPT Release Notes 提到 Web 端 composer 内模型选择、Library/sidebar、recent files、pinned chats 等交互更新。
- TechRadar 的 ChatGPT interface guide 公开描述了 ChatGPT Web 的基础结构：侧边会话列表和聊天区域。

## 5. 视觉规格

### 色彩 token

```css
:root {
  --bg-app: #f7f7f5;
  --bg-sidebar: #f3f3ef;
  --bg-surface: #ffffff;
  --bg-hover: #ececea;
  --text-primary: #202123;
  --text-secondary: #6b6b6b;
  --border-subtle: #e3e3df;
  --accent: #10a37f;
  --danger: #d92d20;
}
```

颜色使用规则：

- App 背景使用 `--bg-app`。
- Sidebar 使用 `--bg-sidebar`。
- 输入框、弹窗、菜单使用 `--bg-surface`。
- hover 使用 `--bg-hover`。
- 主文本使用 `--text-primary`。
- 时间、说明、辅助信息使用 `--text-secondary`。
- 主要动作使用 `--accent`。
- 删除、错误、停止等风险动作使用 `--danger`。

### 尺寸

- Sidebar desktop 宽度：`280px`。
- Sidebar 折叠宽度：`0`。
- 主消息列最大宽度：`768px`。
- Composer 最大宽度：`768px`。
- 普通按钮圆角：`8px`。
- Composer 圆角：`24px`。
- 卡片圆角：不超过 `8px`。
- 消息列表底部 padding 必须大于 composer 高度，避免最后消息被遮挡。

### 字体

- 使用系统 sans-serif 字体栈。
- 主体字号：`14px` 到 `16px`。
- Sidebar 字号：`14px`。
- 辅助信息：`12px` 到 `13px`。
- 不允许使用随 viewport 宽度缩放的字号。
- 字间距保持 `0`。

### 动效

- hover/focus：背景或边框轻微变化。
- Sidebar drawer：`120ms` 到 `180ms`。
- 菜单和设置弹窗：`120ms` 到 `180ms`。
- Streaming 消息允许逐字或增量更新，但不能导致主要布局跳动。

## 6. 组件规格

### Sidebar

必须支持：

- 新建会话。
- 折叠/展开。
- 当前会话选中态。
- 会话标题本地筛选。
- 会话菜单。
- 空状态。

会话项交互：

- 点击会话项切换会话。
- hover 显示菜单按钮。
- 菜单按钮点击后不触发切换会话。
- 删除当前会话后，切到最近会话；没有历史时生成空会话。

### Chat Header

必须显示：

- 当前 Agent 名称。
- 当前模型。
- 设置按钮。
- 开发者模式入口。

禁止：

- 大面积营销文案。
- 复杂 runtime 状态。
- 顶部调试 tab。

### Message List

消息显示规则：

- `user`：右侧浅灰气泡。
- `assistant`：左侧自然文本，无重边框。
- `process` / `workspace`：普通模式合并进轻量运行过程面板，开发者模式可展开查看更详细条目。
- 轻量运行过程面板必须出现在本轮助手消息上方。
- 轻量运行过程面板折叠态只显示摘要，例如“运行过程 · 6 次搜索 / 19 个步骤”。
- 展开态显示步骤列表，每个步骤可继续展开查看详情。
- 搜索工具结果必须解析成标题、摘要、来源链接和结果数量，不得只显示工具名或原始 JSON。
- 长搜索 query、摘要、URL、错误信息必须在容器内截断或换行，页面不得出现横向滚动。
- `askUser` 事件必须在消息流中显示为选项按钮。如果助手文本已经包含问题，选项卡片只显示按钮，避免重复问题。

Markdown 支持：

- 段落。
- 粗体、斜体、行内代码。
- 列表。
- 引用。
- 代码块。
- HTTP/HTTPS 链接。

### Composer

输入规则：

- Enter 发送。
- Shift+Enter 或 Ctrl+Enter 换行。
- IME composing 时不得误发送。
- 空白输入不能发送。

状态规则：

- 空闲：显示发送按钮。
- 生成中：显示停止按钮，发送按钮 disabled 或替换为停止。
- 错误：显示重试入口。
- 停止后：助手消息显示已停止或保留已生成内容。
- 工具菜单打开后应显示可点击菜单项；发送消息、新建会话或点击菜单项后应关闭。

### Settings Modal

基础字段：

- Agent select。
- Model input/select。
- Base URL input。
- API Key password input。

高级字段：

- userId。
- userRole。
- 当前 conversationId。

交互：

- 保存后关闭弹窗。
- API Key 提示必须说明“只保存在当前浏览器”。
- Base URL blur 时做现有 normalize。

### Developer Mode

开启后：

- Header 或 Sidebar 底部显示明显但克制的开发者入口。
- 当前会话可一键打开 `/dev?conversationId=...`。
- Message List 显示隐藏的运行过程。

关闭后：

- 显示轻量运行过程摘要，但不显示内部原始上下文。
- 不显示 trace/context/memory/log/database 字样。

## 7. 深度用户功能取舍

旧 `/dev` 的功能分为三类：

- 必须进入用户 UI：Agent 创建/切换/编辑、工作空间创建/编辑、记忆查看/编辑。
- 用户 UI 只展示轻量状态：工具调用、工作空间切换、搜索进展、`askUser` 选项按钮。
- 用户 UI 的工作空间高级区可以配置 MCP Server、发现并挂载 MCP 工具、展示非内置工具列表。
- 继续留在 `/dev`：日志、数据表、原始上下文、原始工具 JSON Schema、runtime config。

### Agent 管理

用户 UI 中的 Agent 管理目标是“我想让这个 Agent 以什么身份和方式帮助我”，而不是“编辑底层 prompt”。

必须提供：

- 当前 Agent 切换。
- 新建 Agent。
- 名称。
- 默认模型。
- 默认接口地址。
- 核心指令：这个 Agent 负责什么、应该如何行动。
- 表达风格：语气、偏好、回答方式。

必须隐藏：

- 原始字段名 systemPrompt/personalityPrompt。
- 数据库时间戳。
- 审计日志。

### 工作空间管理

用户 UI 中的工作空间管理目标是“告诉 Agent 有哪些专业场景，并给这个场景接入必要的外部工具”，而不是“编辑底层 runtime 配置”。

必须提供：

- 工作空间列表。
- 新建工作空间。
- 名称。
- 用途说明。
- 能力清单，使用每行一条自然语言。
- 是否在进入或使用前需要用户确认。
- 风险等级可用“普通 / 谨慎 / 高风险”表达。
- MCP Server 列表，显示名称和连接类型摘要；远程地址、请求头等敏感或冗长配置只在编辑详情中展示。
- MCP Server 新增/编辑，字段使用“本地命令”“参数”“工作目录”“远程地址”“环境变量”“请求头”等用户可理解标签。
- 检测 MCP Server 能提供哪些工具。
- 挂载检测到的工具。
- 工作空间专属工具列表，显示工具名、描述、来源和风险等级。
- 删除不再需要的专属工具。

必须隐藏：

- 系统内置工具和 runtime 工具。
- 原始 tool binding。
- JSON schema。
- inputKinds/outputKinds。
- memory policy JSON。

MCP Server 交互要求：

- 普通用户身份不能保存、检测或导入 MCP 时，必须显示友好提示，引导切换到创建者身份或打开 `/dev`，不能只显示后端英文错误。
- 参数、环境变量、请求头可以用 JSON 文本暂存实现，但标签和错误提示不能使用 `argsJson`、`envJson`、`headersJson` 等字段名。
- 检测结果只显示工具名称和描述，不显示 input schema。
- 工具列表必须过滤 `bindingType === "runtime"` 和系统工具名，例如 `enterWorkspace`、`askUser`、`finishTask`、memory 工具等。

### 记忆管理

用户 UI 中的记忆管理目标是“让我知道 Agent 记住了什么，并能修正它”，而不是“管理向量库或审计记录”。

必须提供：

- 搜索。
- 类型筛选：关于我、项目/事件、可复用经验。
- 标题、摘要、详情。
- 新增、编辑、删除。
- 空状态和保存失败的用户友好提示。

必须隐藏：

- relationId。
- metadataJson。
- evidence ids。
- version。
- deletedAt/deletedBy。

## 8. 数据与接口规格

### 新增类型

```ts
export type ConversationSummary = {
  id: string;
  agentId: string;
  userId: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
  lastMessagePreview?: string;
};

export type StoredChatMessage = {
  id: string;
  conversationId: string;
  role: string;
  content: string;
  createdAt: string;
  rawJson: string;
};
```

如果已有 `StoredMessage` 类型，应复用或 alias，避免重复定义冲突。

### `GET /api/conversations`

Query：

- `actorId`
- `actorRole`
- `agentId`
- `userId`
- `limit`

行为：

- 普通用户只能看到自己的会话。
- creator 可以按 `agentId` 或 `userId` 过滤。
- 默认 limit 为 `50`。
- 返回 `updatedAt DESC`。

Response：

```json
{
  "conversations": []
}
```

### `GET /api/conversations/:id/messages`

Query：

- `actorId`
- `actorRole`
- `limit`

行为：

- owner 或 creator 可读。
- 按创建时间升序返回。
- 默认 limit 为 `200`。

Response：

```json
{
  "messages": []
}
```

### `PATCH /api/conversations/:id`

Body：

```json
{
  "title": "新标题",
  "actorId": "user",
  "actorRole": "user"
}
```

行为：

- owner 或 creator 可改。
- 标题 trim 后不能为空。
- 标题最大长度 80 字符。

Response 返回更新后的会话摘要。

### Repository 调整

- 新增会话列表查询方法。
- 新增会话消息读取方法，带 actor 校验。
- 新增会话标题更新方法。
- `ensureConversation` 新建会话时可以先使用 conversation id 作为临时标题。
- `addMessage` 写入消息后必须更新 conversation `updatedAt`。
- 首条 user message 写入后，如果标题仍等于 conversation id，则自动生成标题。

标题生成规则：

- 压缩所有空白为一个空格。
- 去掉首尾空白。
- 截断到 48 个字符。
- 空内容回退到 conversation id。

## 9. 前端状态

### 数据来源

- 会话列表来自 `GET /api/conversations`。
- 当前会话消息来自 `GET /api/conversations/:id/messages`。
- 新消息发送继续使用 `/api/agent/run/stream`。
- trace 只在开发者模式或 `/dev` 使用。

### LocalStorage

新用户 UI 使用独立 key，例如：

```ts
zleap.user.ui.state.v1
```

可保存：

- 当前 conversationId。
- Base URL。
- model。
- API Key。
- developerMode。
- sidebarCollapsed。
- selectedAgentId。
- userId。
- userRole。

不可保存为唯一事实来源：

- 会话标题。
- 历史消息。
- 数据库记录。
- trace/log/memory 数据。

旧调试台继续使用原有 `zleap.web.state.v2`。

## 10. 行为细节

### 新建会话

- 点击新建会话后立即生成本地 `conv-${Date.now()}`。
- 未发送消息的新会话不进入数据库历史列表。
- 如果用户在空会话中切换到其他会话，空会话可被丢弃。

### 发送消息

流程：

1. 校验输入非空。
2. 生成 run id、user message id、assistant message id。
3. 立即在 UI 中追加用户消息和空助手消息。
4. 调用 `/api/agent/run/stream`。
5. `start`：记录当前 turn 的上下文 id，开发者模式可用。
6. `delta`：更新助手消息文本。
7. `workspace`：普通模式收集为轻量运行过程面板，不插入为普通聊天消息；开发者模式可展开查看更详细条目。
8. `askUser` 工具结果：解析 `question` 和 `choices`，在消息流中渲染为可点击选项；点击选项后自动调用发送流程。
9. 搜索工具结果：解析网页结果列表，显示结果数量、标题、摘要和链接；禁止把原始 JSON 作为普通用户主视图。
10. `done`：用最终 assistantMessage 覆盖助手消息，刷新会话列表，并自动折叠运行过程面板。
11. 刷新或切换历史会话：拉取 trace，重建运行过程面板，默认折叠但允许展开。
12. `error`：移除失败中的 assistant 占位或标记失败，显示重试入口。

### 停止生成

- 停止时 abort 当前请求。
- 已生成文本保留。
- loading 状态必须恢复。
- 不显示技术异常堆栈。

### 重试

- 重试使用上一条失败请求的原始文本。
- 重试前清理失败占位，避免重复错误消息。

### 切换会话

- 切换前不强制保存空会话。
- 切换后加载数据库消息。
- 当前 running 请求存在时，切换会话前应停止或忽略旧请求结果。

### 删除会话

- 调用现有 `DELETE /api/conversations/:id`。
- 删除成功后刷新会话列表。
- 如果删除的是当前会话，选择最近会话；没有历史则创建空会话。

### 刷新页面

- 读取 localStorage 当前 conversation id。
- 加载会话列表。
- 如果当前 id 存在，加载其消息。
- 如果当前 id 不存在，选择最近会话。
- 如果没有会话，创建空会话。

## 11. 响应式规格

### Desktop `>= 900px`

- Sidebar 固定左侧，宽 `280px`。
- Sidebar 默认展开，即使 localStorage 里保存过折叠状态也不应让宽屏第一屏默认收起。
- 用户仍可通过折叠按钮临时收起 sidebar；当窗口从窄屏切回宽屏时，sidebar 应恢复展开。
- 主聊天区占剩余空间。
- 消息列和 composer 居中，最大 `768px`。

### Tablet `640px-899px`

- Sidebar 可折叠。
- 默认显示 sidebar。
- 主区自适应剩余宽度。

### Mobile `< 640px`

- Sidebar 变为 drawer。
- Header 左侧显示菜单按钮。
- 打开 drawer 时显示遮罩。
- Composer sticky bottom。
- 消息列表底部 padding 避开 composer。
- 菜单项单行截断。
- 按钮文本不得溢出。

## 12. 旧 UI 保留

- 旧 `App` 迁移或包装为 `LegacyDevApp`。
- `/dev` 使用 `LegacyDevApp`。
- 旧 UI 原有能力不降级。
- 新 UI 可以复用旧 UI 的 markdown renderer、API helper、SSE 处理逻辑，但不直接暴露旧 UI 的三栏调试布局。
- 构建产物继续输出到 `dist/web`。
- 同一个 Node server 继续提供静态资源和 API。

## 13. 验收标准

### 产品验收

- 普通用户打开 `/` 后，看不到顶层调试 tab。
- 普通模式下看不到“日志、数据表、上下文窗口堆栈、JSON schema”等调试概念；MCP 只在工作空间高级区作为“外部工具来源”出现。
- 用户可以完成新建、发送、停止、重试、切换、删除、重命名会话。
- `askUser` 选择题能显示为可点击选项，点击后自动发送对应用户回复。
- 普通模式能看到轻量运行过程，位置在对应助手消息上方，完成后自动折叠。
- 历史会话重新打开后仍能展开查看已完成运行过程。
- 搜索工具结果能展示标题、摘要和链接，不显示原始 JSON。
- 设置弹窗能配置 Agent、model、Base URL、API Key。
- 深度用户能在不进入 `/dev` 的情况下创建/切换/编辑 Agent。
- 深度用户能创建/编辑工作空间，并配置 MCP Server 来增加专属工具。
- 工作空间工具列表只展示非内置工具，不展示 runtime/system 工具。
- 深度用户能查看、搜索、编辑和删除记忆。
- 开发者模式能打开 `/dev?conversationId=...`。
- `/dev` 旧功能仍能访问。

### 技术验收

- `npm run typecheck` 通过。
- `npm run test` 通过。
- `npm run build` 通过。
- `/` 刷新后能恢复当前会话。
- `/dev?conversationId=...` 会使用 query 中的会话。
- 桌面和移动端无明显重叠、溢出、空白死区。
- Message List 不出现横向滚动。
- Composer 不遮挡最后一条消息。

## 14. v1 非目标

- 不做账号登录。
- 不做云同步。
- 不做文件 Library，只预留工具菜单位置。
- 不做精确像素级复刻。
- 不重写 runtime。
- 不在新用户 UI 中重建全部调试台功能。
- 不在用户 UI 中提供原始工具 schema、runtime binding 和底层 manifest 编辑。
