# Agent Memory 架构

## 模块与数据流

```text
会话 → Hook 采集边界 → 待整理证据 → 子代理 B / daemon A
                                     ↓ 提案
                              CommitService
                              ├─ 短期清单、正文与归档
                              └─ 长期记录、修订与检索索引
会话 ← 只读 MCP ← 按短期 ID 直读 / 长期 search → read
```

| 位置 | 职责 |
|---|---|
| `src/core/`、`tests/j2-upstream/` | 成对保存迁入的独立 J2 和离线回归，包括单文件发布、证据、纠错、整理恢复与子进程崩溃夹具。 |
| `src/storage/` | 打开数据库、短期目录和正文、长期修订、提案校验、权限和原子提交。 |
| `src/retrieval/` | 默认 SQLite 索引器和检索器、可见性检查、会话句柄。 |
| `src/organizer/` | 配置、采集游标、证据队列、批次租约、共用提案契约和 API daemon。 |
| `src/antigravity/` | Hook、stdio JSON-RPC 服务、会话登记与角色绑定。 |
| `plugin.json`、`hooks.json`、`mcp_config.json` | 宿主发现、事件订阅与服务命令。 |
| `agents/memory-organizer.md`、`rules/AGENTS.md` | B 模式整理代理及主会话使用规范。 |
| `tests/*.test.mjs`、`tests/helpers/` | 原生契约、SQLite 多进程、宿主协议、模型传输和独立安装目录测试。 |

J2 基线中的正文使用文件保存，读取时可以修复索引，旧检索也会保存 selection。插件的正式写入与只读打开走独立的原生模块。运行时无需安装 Zod、Vitest 或模型 SDK。Zod 4.4.3 和 Vitest 4.1.8 仅在开发依赖中。

## 短期与长期

每个范围保存一份单调递增的 `list_rev`。目录投影为 `id | title | status | updatedAt`，正文与证据单独存表。同范围、同标题和正文的重复项可合并来源。未过期的开放承诺合入已完成或已过期目标时返回 `UNFINISHED`。晋升在同一事务内保存长期记录及短期归档引用。满额时按更新时间在授权范围内淘汰可退出项，回执列出所有受影响的 ID。无可退出项时返回 `CAPACITY_REACHED`。

| 长期类型 | 内容与可见性 |
|---|---|
| `fact` | `subject`、`key`、`value`，以及范围、情境、起止时间。每个范围及情境内以 NFKC 规范化、去除首尾空白并转小写后的主题和键标识事实。使用已有 ID 和预期版本纠错，保留各版来源。 |
| `procedure` | `conditions`、`steps`、`parameters`。存复用条件、步骤与参数名。具体环境取值写入对应事实。例如程序要求查询 `DB_PORT`，端口值随对应环境事实修订。 |

首次可写打开 v1 数据库时，在同一事务内升级至 v2，补齐规范键和队列重试字段，重建检索词。若旧事实归一化后重名，保留来源权限最高的一条作为当前记录；同级优先最近更新，再按版本及 ID 确定。其余记录追加含 `supersededBy` 的归档修订，保留原值及证据。SessionStart 和 daemon 均可触发升级。

## 权限、队列与事务

原始事件记录 `authorRole`、`sourceSessionId`、`sourceId`、`scope`。同一来源幂等入队。提交权限取自已认领的证据。owner 可变更三个等级的记录，worker 可变更 worker 和 external，external 仅可变更 external。该检查同样适用于重复项合并、容量淘汰和事实规范键冲突。B 子代理与 A daemon 共用批次读取、提案契约和提交器。

每个范围同一时刻只允许一个有效批次。先领普通事件，再领已到重试时间的事件，同一优先级内按 ID 排序，并按来源等级分批。A 模式在模型失败或需修订提案时释放租约，持久化下一次可领取时间，退避从 30 秒翻倍至一小时。B 模式可在原租约内修订容量受限的提案。两个入口均在事务外生成提案，在 `BEGIN IMMEDIATE` 中复核租约、证据、权限及版本，同步更新正文、历史、索引和回执。数据库启用 WAL 与 `busy_timeout`。同一消费者重放同一提案可取回原回执。[SQLite 事务](https://sqlite.org/lang_transaction.html)

| 提交结果 | 调用方行为 |
|---|---|
| `COMMITTED` | 保留回执；对应事件已完成。 |
| `VERSION_CONFLICT`、`PROPOSAL_CONFLICT` | 重新核对目标版本；更改提案内容时使用新的提案 ID。 |
| `CAPACITY_REACHED`、`UNFINISHED` | 保留原证据，整理可退出项或等待状态变化。 |
| `FORBIDDEN`、`INVALID_PROPOSAL` | 检查授权来源或修正提案。 |
| `LEASE_LOST`、`BUSY` | 重新领取，或待锁释放后用原提案重试。 |

## 检索与宿主

索引器实现 `upsert(record)`、`remove(id, scope)`，同步参与写事务。检索器实现 `search(query)`，可同步或异步返回含范围、ID 和版本的候选。当前 SQLite 实现对短标题、标签、事实主题与参数名做 Unicode 规范化和字面／分词匹配，支持中文短词。替换检索器可接入向量候选；检索服务始终从正式记录复核范围、版本、删除状态和有效时间。外部服务的异步索引动作须另设提交后机制。

多词查询先匹配完整短语或全部词。若无命中，再按任一词匹配，依次按命中词数降序、完整短语优先和 ID 升序返回。公开搜索只发短标题与随机 UUID。`search` 的可选 `context` 覆盖默认情境，仅在当前范围内生效。`read` 按句柄签发时的会话、范围、情境和版本重新校验。每个 MCP 进程保留最近使用的 2,000 个句柄，失效或被淘汰的句柄返回 `INVALID_HANDLE`。具体查询无有效证据时返回 `NO_EVIDENCE`、`stop: true`、`overview` 和 `next`。泛词或超过四个可见命中时返回 `REFINE_QUERY`。

整理器用证据词元匹配同范围的标题、标签、事实主题／键和程序参数名，最多读取 32 条有效长期记录的元数据。批次携带配置情境提示。仅当证据明确指定环境时才给事实设置情境。

SessionStart 首次发送清单。PreInvocation 先读版本，发生变化时才注入一行差量，变动较多时给出计数及清单工具。首次登记遇锁时，下一次调用可补登。

Stop 在数据目录的 `pending-stops/` 下原子发布本轮的文件标识、字节上限和采集时的来源权限。后台按字节位置推进游标，系统时钟回拨仍能识别同一文件的新增长度。损坏的标记保留为 `.corrupt`，其他标记继续处理。后台只解析已完成的 JSONL 行。

四个主会话只读工具由宿主预加载。A 模式通过主会话读取确认 owner，要求代理名和父会话均为空、当前会话等于根会话。遇写锁时先返回读取结果，以后可再次确认。B 模式也可在整理子代理通过认证时，从其宿主元数据确认父会话为根会话。无工作区时，先启动的 reader 子会话可在尚无自身入队事件时绑定父范围，整理器后续 Stop 跳过采集。两个整理工具按需加载。Hook 按清单指定的事件分发，异常时返回空响应并向 stderr 记一条诊断。[Antigravity Hooks](https://antigravity.google/docs/hooks) · [MCP 工具加载](https://antigravity.google/docs/mcp)

自动化测试使用合成会话与本地模型服务，分别检查数据语义、真实进程通信和插件清单。CLI／App 界面内的真实模型调度需在各自宿主会话中验证。[安装与验收步骤](./README.md)
