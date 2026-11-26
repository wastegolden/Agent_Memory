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

插件可直接用 Node 启动。开发用的 `npm install` 仅用于 J2 基线测试。

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
| `MEMORY_API_MODEL`、`MEMORY_API_KEY` | 模型名，以及服务需要时使用的凭据。通过本地环境提供。A 会向该服务发送批次证据、相关事实的摘要、相关程序的完整步骤及最近三条回执。 |

## 工具

| 调用方 | 工具 | 返回 |
|---|---|---|
| 主对话 | `short_term_list`、`short_term_read({id})` | 目录版本与四个索引字段，或指定 ID 的正文与来源。 |
| 主对话 | `search({text, scope?, context?})`、`read({handle})` | 在会话绑定范围内搜索。例：`{"text":"DB_PORT","context":"staging"}`。按返回的句柄读取同一情境的有效版本。多词查询优先匹配全部词，未命中时按匹配词数排序。超过四条时返回 `REFINE_QUERY`，可按单个主题重查。零命中时返回停止信号。 |
| 主对话、工作子代理 | `report_outcome({handle, status, failedStep?, outwardDone?, detail?})` | 用执行时的程序句柄报告 `ok`、`failed` 或 `fallback`。步骤从 1 起算，详情最多 240 字。回执不触发清单更新。 |
| 整理子代理 | `organizer_pull_batch`、`organizer_commit` | 带租约的批次、现有版本和提案契约，以及事务回执。宿主提供的身份决定调用权限。 |

程序的 `read` 响应附带最近一次回执 `lastOutcome`、当前版本累计失败次数 `recentFailures`。仅当最近回执属于当前版本、执行失败且尚未触达外部副作用步骤时，`fallbackVersion` 才可指向有成功回执的旧版本。触达副作用步骤后，应先核实外部状态。

## 开发验证

```sh
npm install
npm run test:j2
node --test tests/*.test.mjs
agy plugin validate --strict --json .
```

Windows 可使用 `npm.cmd`。J2 基线含 21 个 Vitest 套件、226 个用例；新增测试使用原生 Node 测试运行器，临时 SQLite、独立写进程、真实 stdio/Hook 和本地 HTTP 模型夹具。[架构、目录与提交语义](./DESIGN.md)
