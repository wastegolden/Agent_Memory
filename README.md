# Agent Memory

Antigravity CLI / App 的本地记忆插件。开场注入一张短期清单，后续只注入变化。对话按 ID 读取细节；跨会话使用的事实与程序通过短标题和临时句柄检索。

## 安装和验证

让启动 Antigravity 的环境能执行 Node.js 24 或更新版本。在插件根目录运行以下命令。

```sh
node --version
agy plugin validate --strict --json .
agy plugin install .
agy plugin list --json
```

在 CLI 的插件列表或 App 的 **Customizations → Installed** 中确认 `agent-memory` 已启用，打开新会话。开场应出现短期清单及 `list_rev`。调用 `short_term_list` 可重拉清单；在空库用具体主题调用 `search`，应返回 `NO_EVIDENCE`。在 App 中单独检查 MCP、Agents、Rules 和 Hooks 的加载状态。[官方插件安装与管理](https://antigravity.google/docs/marketplace/) · [插件校验](https://antigravity.google/docs/build-plugins/)

插件可直接用 Node 启动。开发用的 `npm install` 仅用于 J2 基线测试。首次可写打开会将 SQLite v1、v2 或 v3 升至 v4，保留清单版本、历史修订和已有程序回执。只读入口遇到旧库会提示升级。

## 整理模式

**B · 子代理（默认）**　主对话调用 `memory-organizer`。子代理通过专用工具逐批领取证据并提交。容量不足时，同一消费者可在原租约内调整提案并立即重提。

**A · 独立 daemon**　在启动宿主及 daemon 的环境中设置相同的 `MEMORY_MODE=daemon` 和数据目录。用本机进程环境提供模型设置，然后在插件目录启动：

```sh
node src/organizer/daemon.mjs
```

`node src/organizer/daemon.mjs --once` 处理最多一个批次。常驻进程可在主会话退出后继续整理。模型调用失败或提案被拒时，daemon 释放该批租约。首次延迟 30 秒，连续失败时延迟翻倍，上限一小时。其余就绪批次可继续处理。切换模式后重启宿主 MCP 进程。

两种模式均按来源权限提交。优先级从高到低为 `owner`、`worker`、`external`，修改、合并、归档、晋升和容量淘汰只能作用于本级或更低级的记录。在 A 模式下，请让顶层会话先调用一次只读工具。宿主提供的当前会话等于根会话、无父会话且代理名为空时，插件登记 owner。B 模式还可由通过认证的整理子代理确认其父会话为根会话。登记前采集的用户输入保留 worker 权限。

| 环境变量 | 含义 |
|---|---|
| `MEMORY_MODE` | `subagent`（默认）或 `daemon` |
| `MEMORY_DATA_DIR` | 本机私有数据目录的绝对路径。默认是当前用户主目录下的 `.agent-memory`。Hook、MCP 和 daemon 须使用同一目录。 |
| `MEMORY_CAPACITY` | 每个范围的短期清单上限，15～20，默认 18。 |
| `MEMORY_SCOPE` | 可选的固定范围。默认按工作区集合生成范围；无工作区时按会话隔离。显式使用同一范围的会话共享该范围的记忆。 |
| `MEMORY_CONTEXT` | 默认检索情境，例如 `staging`。可在单次搜索中指定 `context`。未指定任何情境时，可见全局事实和程序。 |
| `MEMORY_API_STYLE` | A 模式的协议，`openai`（默认）或 `gemini`。 |
| `MEMORY_API_BASE_URL` | A 模式的 API 根地址，含服务所需的版本前缀。OpenAI 兼容模式追加 `chat/completions`，Gemini 原生模式追加 `models/<model>:generateContent`。 |
| `MEMORY_API_MODEL`、`MEMORY_API_KEY` | 模型名，以及服务需要时使用的凭据。通过本地环境提供。A 会向该服务发送批次证据、相关事实的摘要、相关程序的完整步骤、最近三条回执及最多两个失败旧版的步骤与失败详情。 |

## 工具

| 调用方 | 工具 | 返回 |
|---|---|---|
| 主对话 | `short_term_list`、`short_term_read({id})` | 目录版本与四个索引字段，或指定 ID 的正文与来源。 |
| 主对话 | `search({text, scope?, context?})`、`read({handle, version?})` | 在会话绑定范围内搜索。例：`{"text":"DB_PORT","context":"staging"}`。按句柄读取当前记录，或用正整数版本号读取该程序的历史快照。多词查询优先匹配全部词，未命中时按匹配词数排序。超过四条时返回 `REFINE_QUERY`，可按单个主题重查。零命中时返回停止信号。 |
| 主对话、工作子代理 | `report_outcome({handle, status, failedStep?, outwardDone?, detail?})` | 用执行时的程序句柄报告 `ok`、`failed` 或 `fallback`。步骤从 1 起算，详情最多 240 字。回执不触发清单更新。 |
| 整理子代理 | `organizer_pull_batch`、`organizer_commit` | 带租约的批次、现有版本和提案契约，以及事务回执。宿主提供的身份决定调用权限。 |

读取当前程序时，`lastOutcome` 是最近回执，`recentFailures` 是当前版本累计失败次数。`outwardDone` 有三态。显式报告已触达，或失败步骤达到任一 `outwardSteps` 标记时为 `true`。显式报告未触达，或失败发生在首个标记之前时为 `false`。其余为 `null`。已触达的证据优先。

最近回执属于当前版本、状态为 `failed` 且 `outwardDone === false` 时，`fallbackVersion` 才可能有值。取尚未删除、至少成功一次、成功次数多于失败次数且最后回执为 `ok` 或 `fallback` 的最高旧版本。可用同一句柄及该版本号读取旧步骤。执行回执始终归属于句柄绑定的当前版本。

整理器会收到 `failedRevisions` 中最近两个有失败或回退回执的旧版（如有），用于核对旧步骤及失败详情。已有副作用标记的程序仅允许 owner 减少或移除标记。首次 Hook 仍发送短期目录，后续 `PreInvocation` 会用一行列出长期记录的增改删，过长时折叠为计数。纯回执和无变化调用均保持零注入。

## 只读导出

```sh
node src/bridge/export.mjs --scope release --since-outcome-id 42 --db ./memory.sqlite
node src/bridge/export.mjs --workspace ./workspace
```

指定 `--scope` 或 `--workspace` 之一。工作区沿用会话范围配置，`--db` 默认使用插件数据库。命令从已有 v4 库读取一个快照，在标准输出返回 `{schemaVersion:1, scope, exportedAt, procedures, procedureHistory, outcomes, cursors}`。范围内的当前程序和历史包含删除标记。`--since-outcome-id` 仅筛选 ID 大于该值的回执。游标仅含 `sourceSessionId`、`path`、`fileId`、`captured`。事实、短期记录、会话角色和证据队列均不在导出范围内。

## 开发验证

```sh
npm install
npm run test:j2
node --test tests/*.test.mjs
agy plugin validate --strict --json .
```

Windows 可使用 `npm.cmd`。J2 基线含 21 个 Vitest 套件、226 个用例；新增测试使用原生 Node 测试运行器，临时 SQLite、独立写进程、真实 stdio/Hook 和本地 HTTP 模型夹具。[架构、目录与提交语义](./DESIGN.md)
