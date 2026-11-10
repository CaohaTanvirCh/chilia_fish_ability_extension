# Phase 1.1 独立验收审查报告

审查对象：`chilia_fish_ability_extension`，`master` 分支提交 `7475857`（`docs/feat: phase 0->1.1`），与 `origin/master` 一致。

审查日期：2026-11-10（Asia/Hong_Kong）。审查性质：只读代码审查、测试复核和有限故障探针；未修改业务源码，未接入任何 bot，未开始 Phase 2。

> 后续注：Phase 1.1.1/1.1.2 已按本报告 N01–N09 修复，处理结果与证据见 `docs/phase-1.1.1-1.1.2-fix-report.md`。本报告保留审查当时的状态与证据，不作为修复后的验收结论。

**最终结论：CONDITIONAL PASS。** 核心 Task/Execution/Session 架构和主要故障语义成立，但存在一个 P1 关闭可靠性问题及若干需要在 Phase 2 设计前明确处理的 P2 问题。没有发现 P0 级数据损坏或自动重发确定执行的情况，因此不判定 FAIL。

---

## 1. 审查范围与环境

### 1.1 代码范围

- `packages/dsh-acp-v2/index.mjs`
- `packages/task-store-v2/index.mjs`
- `packages/acp-transport/index.mjs`
- `packages/contracts/index.d.ts`、`packages/contracts/v2.d.ts`
- `apps/companion-hub/main.mjs`
- `test/` 全部测试与 fixture
- `scripts/integration-v2.mjs`、`scripts/migrate-v1.mjs`
- `docs/phase-1.1-audit.md`、`design.md`、`clarifications.md`、`acceptance.md`、`architecture.md`、`contracts.md`
- `logs/` 中仓库已有日志，以及本次复核新生成的日志

### 1.2 环境

| 项目 | 值 |
| --- | --- |
| OS | Windows 11 10.0.26200 |
| Node | v24.18.0 |
| DSH CLI | 0.2.2-rc.1（已安装桌面版，ACP profile 实测可用） |
| 官方 ACP SDK | 1.4.0（锁定） |
| Store | 本地单所有者 JSON 快照，`state-v2.json` |
| 协议 | 官方 ACP v1，stdio；未使用私有 DSH 控制协议 |

### 1.3 明确未覆盖

本次没有验证：数小时真实长任务、真实 DSH 工具及其孙进程回收、ACP Session 与 Desktop UI 同步、两个 bot 同时接入、B 站、WSL、真实断电/磁盘损坏。以上均不能从本报告推断为已通过。

---

## 2. 审查方法和实际执行过的命令

### 2.1 命令

```powershell
git status --short
git log --oneline --decorate -3
git branch -vv
git ls-remote --heads origin

npm run test:unit
npm run test:simulated
npm run test:integration
```

另外执行了只读/临时目录探针（不修改仓库源码）：

- 让模拟 ACP 返回 `stopReason: "max_tokens"`，检查失败终态诊断。
- 用 `afterTerminalCommit` 崩溃 fixture 重开 Store，检查 binding 状态，再尝试下一 Execution。
- 用同一 `requestKey` 先 `defer: true`、再 `defer: false`，检查幂等结果。
- 直接向 Store 提交“Task.result 与最新 Execution.result 不一致”的快照，检查校验。
- 构造 transport `stop()` 失败，检查 `closeTask` 是否能重试。

### 2.2 证据分类

| 类别 | 本次是否重新运行 | 说明 |
| --- | --- | --- |
| 单元/内存 Fake/Store/迁移 | 是 | 57 passed，见 `logs/review-unit.txt` |
| 模拟 ACP、真实子进程、Hub/Transport、故障注入 | 是 | 31 passed，见 `logs/review-simulated.txt` |
| 真实 Windows DSH ACP | 是 | 一条流程，8 组检查通过，见 `logs/review-real-console.txt` 与 `logs/real-v2-2026-11-10T04-21-22-559Z.jsonl` |
| 仓库已有历史日志 | 仅核对，不当作本次运行 | `logs/phase1.1-*.txt`、`logs/real-v2-2026-11-09T15-39-58-168Z.jsonl` |
| 仅源码推理、未实际运行 | 已标注 | 见各问题“复现/依据” |

本次新日志不改变仓库源码；它们只是运行产物，尚未提交。

---

## 3. A01～A14 逐项复核

> 结论标准：已解决 = 代码路径和针对性测试均成立；部分解决 = 主路径成立但存在明确未覆盖边界；未解决 = 原问题仍可直接触发；未验证 = 没有足够代码或运行证据。

| ID | 原始问题摘要 | 当前实现（路径/行） | 测试/证据 | 结论 | 遗留风险 |
| --- | --- | --- | --- | --- | --- |
| A01 | 没有独立 Execution，续接覆盖当前 prompt/result | `dsh-acp-v2:43-68` 创建新 Execution；`59-68` 新建历史记录，Task 只更新投影；`contracts/v2.d.ts` 定义 Execution | `executor-v2.test:24` 断言旧 Execution 不变；`:32` 区分 Task 关闭 | 已解决 | 旧 Task 的 `result` 是最新投影，不是所有历史汇总；调用方必须查 `listExecutions` |
| A02 | 取消请求被误当取消确认 | `dsh-acp-v2:121-134` 记录 requested/sent/confirmed；`106-108` 以实际 stopReason 裁决；`executor-v2.test:26` 让 end_turn 赢得取消竞态 | 已解决（状态层） | `cancelExecution` 返回的 Execution 可能是 running/unknown，见 N08；API 容易误读 |
| A03 | 取消未结算时启动下一轮，误伤旧任务 | `cancelGates` 在 `121-134` 保持到 cancelPromise 结束；`startExecution:58`、`reconcileTask:138` 检查 gate；`races:30-45` 延迟 notify 测试 | 已解决 | 取消确认失败时会停 transport，影响该 Execution；没有共享 Runtime 的跨任务影响（每 Execution 独立进程） |
| A04 | close 与 session/new 并发导致泄漏 Session | `closeTask:154` 先持久化 closed；`closeSession:148-153` 等操作并重新读取 binding；`run:91-98` 在 session/new 后检查 `cancelRequested` | 部分解决 | 没有专门“延迟 session/new 后 close”的回归测试；session/new 响应丢失仍可能留下孤立 Session（A06） |
| A05 | 迟到/重复通知进入新 Execution | `acp-transport:42-51` generation 守卫；`dsh-acp-v2:80-86` phase/session 归属；`88-119` 独立连接；`races:76-86` 隔离测试 | 部分解决 | ACP 没有 turn ID；同一 prompt 内无法识别所有重复/迟到文本。现有 late 测试使用 Fake，不验证真实 Transport 的迟到帧；跨 Execution 已由独立连接隔离 |
| A06 | 崩溃窗口误判/丢失远端结果 | `run:99-108` 先落 `dispatch_intent` 再发 prompt；`store-v2:92-100` 重启把 running/dispatch 变 unknown；`crash-v2.test:27-39` 覆盖四个退出点 | 部分解决（接受限制） | 无法取回未落盘的远端结果；session/new 后绑定前崩溃会产生孤立 Session；终态后清理前崩溃会残留 active binding（N02） |
| A07 | 重试不幂等，重复提交 Prompt | `createTask:44-45` 与 `startExecution:56-57` 持久化 requestKey/inputHash；同 key 返回原记录；`executor-v2.test:24` 断言只发一次 | 部分解决 | `createTask` 的 hash 未包含 `defer`（N04）；本地幂等不等于远端 exactly-once；null/空响应仍可能让调用方误判 |
| A08 | 持久化失败导致 running/清理不一致 | `commit:33-37` 设置 storageFault 并拒绝后续；`run:110-119` 失败路径；`recovery-v2.test:45-53` 注入终态提交失败；`store-v2:193-219` 原子提交 | 部分解决 | `receive` 内输出提交失败主要依赖 SDK 回调传播，缺少专用测试；清理/健康状态仍有边界（N06） |
| A09 | stop/start 并发遗留 Runtime | `acp-transport:19-27` 拒绝停机期间 start；`96-140` 代际清理/重试；`transport.test:15-32` 覆盖双向竞态 | 已解决（模块级） | Executor/Hub 的上层准入仍有竞态（N10）；没有真实 DSH 的双向竞态实测 |
| A10 | 恢复/关闭污染已完成终态 | `store-v2:28-34` 终态证据规则；`:211` 终态不可变；`dsh-acp-v2:106-108` 原子终态；`recovery-v2.test:30-44` | 部分解决 | 终态后崩溃留下 active binding 会阻塞下一轮（N02）；`closeSession` 对 cleanupFailed 无法重试（N06） |
| A11 | Store 未校验最终快照/引用关系 | `store-v2:118-166` 校验 ID、引用、Session 唯一、active 唯一、状态投影、事件序列；`store-v2.test:79-86` | 部分解决 | 未校验 `Task.result` 与最新 Execution、`Task.sessionId` 与 binding、`duplicateExecutionRisk`、lifecycle/submission/availability 枚举；探针可提交“Task.result 被篡改但 Execution 不变”的合法形状快照（N05） |
| A12 | 长任务超时溢出、I/O 放大、缓冲失控 | `dsh-acp-v2:15-19` 校验组合 timer；`76-86` 批量输出；`:165` 停止；`races:106-131` 低速/容量测试；`store-v2:167-183` 硬上限 | 部分解决 | 每次 commit 仍对全状态做 `JSON.stringify`/校验/持久化，O(store) I/O 随历史增长；`maxOutputBytes`/`flushBytes`/`maxConcurrent` 未校验；没有数小时浸泡（N12） |
| A13 | Hub 无事件续读/无有界准入 | `hub/main.mjs:38-58` 方法表；`59-85` 字节解析；`15-20` 16 条准入；`hub.test:15-37` 覆盖游标/UTF-8/洪泛 | 部分解决（单客户端范围） | 单 stdio、单 Store 所有者；没有身份、权限、多调用方路由；只按用户范围实现最低限度 |
| A14 | 上层 stop 等待启动、关闭失败不可重试 | `dsh-acp-v2:163-166` stop 有界清理并在失败时清空 stopPromise；`acp-transport:126-140` 可重试 | **未完全解决** | Executor 层可重试，但 Hub 永久缓存 rejected `stopPromise`（N01）；`closeSession` 对 cleanupFailed 不能重试（N06） |

### 3.1 对 A01～A14 的总体判断

- 原先的“Task 覆盖 Execution”“取消请求等于确认”“同 Session 复用导致迟到污染”“stop/start 遗留 Runtime”这几类核心错误，在 v2 主路径上已经被实质修复。
- 但“部分解决”不是措辞上的保留：A04、A05、A06、A10、A11、A12、A14 都有可指出的具体边界，详见第 8 节。
- A05 的根本限制仍然存在：没有远端 turn ID，不能把本地 Execution ID 当作远端通知归属证明。当前用独立连接和 generation 隔离，解决的是跨执行污染，不是同一执行内的重复/迟到识别。

---

## 4. Execution / Task / Session 状态机审查

### 4.1 成立的部分

1. **Execution 不可覆盖。** `newExecution()` 每次生成新 UUID；`Store.commit` 对终态 Execution 的 `status`、`result`、`prompt`、`completionEvidence`、`resultIntegrity`、`bindingId` 做不可变检查（`store-v2:9,211`）。`executor-v2.test:24` 实际比较旧执行对象前后相等。
2. **active/latest 指针有约束。** Store 校验 `activeExecutionId` 必须对应活动 Execution，Task 状态必须符合投影；同一 Task 只能有一个 active，同一 Session 不能被两个 Task 共用（`store-v2:133-153`）。投影代码在 `dsh-acp-v2:28-32` 与 `store-v2:35-41`。
3. **dispatch_intent 先于发送。** `run:99` 先提交 `running/dispatch_intent`，`run:101` 才调用 `session/prompt`；`crash-v2` 的 `beforePrompt` 崩溃点证明此时已持久化但尚未发送。
4. **不确定执行不自动重发。** `store-v2:92-100` 将重启后的 running/dispatch 改为 unknown；`startExecution:60` 要求逐个承认旧 unknown；`startExecution:65` 对未确认清理的 binding 拒绝复用。`crash-v2` 与 `executor-v2.test:29` 有对应断言。
5. **终态原子性。** `run:106-108` 的 result、completionEvidence、status、Task 投影和事件在一次 `changeExecution` 中提交；`store-v2.test:26-35` 验证同一事务。
6. **取消与完成竞态。** `executor-v2.test:26` 让延迟 notify 期间 prompt 返回 `end_turn`，最终为 completed、`cancel.confirmedAt` 为空，证明“请求取消”不会覆盖真实完成。

### 4.2 状态机缺口

- **失败终态没有原因。** `run:106` 把非 `end_turn`/`cancelled` 的 stopReason 归为 `failed`，但 `:108` 只写 `diagnostics: op.quarantine`，不写 stopReason。探针返回 `max_tokens` 时得到：
  ```json
  {"status":"failed","diagnostics":[],"completionEvidence":null,"resultIntegrity":"partial"}
  ```
  调用方无法区分模型 token 上限、服务端错误或其他结束原因。见 N03。
- **历史 unknown 永久压制 Task 状态。** `dsh-acp-v2:28-32` 与 `store-v2:35-41` 只要存在 unknown/interrupted 或 integrityAlerts，Task 就为 unknown；即使新的 Execution 已完成。这个设计有意保留风险，但调用方必须使用 `activeExecutionId`/`latestExecutionId`/`listExecutions`，不能把 `Task.status` 当作“当前尝试状态”。这是 Phase 2 必须写进接口使用约定的事项。
- **完整性警报没有解决路径。** `quarantine:77-79` 在终态后写入 `integrityAlerts`，`startExecution:61` 永久拒绝新执行；代码中没有清除或确认 API。`executor-v2.test:27` 明确断言继续执行会抛 `INTEGRITY_ALERT`。这不是错误地继续执行，但会让 Task 成为不可恢复对象，见 N07。
- **取消返回值语义偏弱。** `cancelExecution:121-134` 返回当前 Execution；取消未确认时可能仍是 `running` 或 `unknown`。状态字段是正确的，但方法名和返回类型没有显式“未确认”结果，见 N08。

---

## 5. Store 与崩溃恢复审查

### 5.1 成立的部分

- 快照采用临时文件 `wx` 写入、`fsync`、`rename`，失败不发布内存状态（`store-v2:171-183,193-219`）；`store-v2.test:105-108` 用目录替换文件的方式验证失败回滚。
- `expectedRevision` 检查（`:195`）阻止并发写入覆盖。
- 引用校验覆盖 Task/Execution/Binding/Request 的存在性、Session 跨 Task 唯一、active Execution 唯一、Task 投影、事件 sequence/identity（`:118-166`）。
- 重启恢复只把可能提交的 `running`/`dispatch_intent` 改为 `unknown`，不自动发送；`queued/not_started` 保持 queued。`crash-v2.test:27-39` 的 `afterCreate` 与 `beforePrompt` 分别验证这两点。
- 终态完成必须有 `completionEvidence.stopReason === "end_turn"` 且 `resultIntegrity === "observed_complete"`；取消必须有 `cancelled`/`local_not_submitted`。`store-v2:28-34` 与 `store-v2.test:26-64` 覆盖。
- 迁移保留原始 v1 字节备份，所有旧结果标为 unknown/uncertain，不伪造完成收据（`migrate-v1.mjs:45-58`；`migration-v2.test:23-40`）。

### 5.2 具体缺口

1. **终态后崩溃残留 active binding（N02）。** `store-v2:92-100` 只处理 running/dispatch；如果 Execution 已经是 completed，binding 仍是 `active`。实际运行 `test/fixtures/crash-v2.mjs afterTerminalCommit` 后得到：
   ```json
   {"task":"completed","execution":"completed","binding":"active"}
   ```
   随后新的 Executor 调用 `startExecution` 得到 `SESSION_UNSETTLED: Previous Session cleanup not confirmed`。这不是数据损坏，但 Task 在人工 `resumeTask`/`closeSession` 之前无法继续；没有诊断说明需要协调。
2. **Store 语义校验不完整（N05）。** 直接提交一个合法形状的 Task，将其 `result` 改为 `TAMPERED`，而最新 Execution 仍为 `old`，Store 接受了该快照。`#validate` 检查了状态投影和引用，没有检查 `result`、`sessionId`、`latestExecutionId` 是否与 Execution/Binding 一致；也没有校验 `duplicateExecutionRisk`、lifecycle/submission/availability 的枚举。正常 Executor 不这样写，但 Store 是公共契约，迁移和外部调用可能绕过。
3. **迁移不导入原始 v1 事件。** `migrate-v1.mjs:39` 保存备份，`:50-52` 每个旧任务只生成一条 `legacy.imported` 事件；v2 `getEvents` 看不到旧事件流。原始信息没有丢失，但审计查询被降级为备份文件，见 N10。
4. **大快照 I/O。** 每次 commit 都 `JSON.stringify` 全状态用于校验、容量和持久化；这避免了状态分裂，但历史增长后是 O(store) 写放大。默认 32 MiB 上限下不是无界，但没有基准或长跑证据，见 A12/N12。
5. **恢复事件只归一个 Task。** `store-v2:112` 只把 `store.recovered` 事件挂在 `changed[0].taskId`，多个任务同时恢复时其他任务只有 Execution 诊断，没有独立恢复事件。P3 可观测性问题。

### 5.3 对“本地无结果 ≠ 远端没执行”的判断

实现是正确的：重启将 `dispatch_intent`/`running` 变 unknown，没有将其当作失败或成功；`resumeTask` 只协调上下文，不取回结果；`startExecution` 需要显式承认 unknown，且不复用旧 Session。这个语义应当保留。当前 ACP 没有结果回放，任何“恢复 Session 即恢复结果”的说法都不成立。

---

## 6. Transport / Hub 生命周期审查

### 6.1 Transport

- 并发 `start` 共享 `this.starting`，`start()` 在 `stopPromise` 存在时拒绝；`stop()` 先停当前 generation，再等待启动，再停可能新建的 generation（`acp-transport:19-27,126-140`）。测试 `transport.test:10,15-32` 覆盖。
- 请求超时会在 `request` 中关闭连接并清理子进程（`:72-90`）；超时值上限校验（`:73`）；测试 `transport.test:8,33-39`。
- stdout 关闭但子进程存活时，generation 保留所有权直到真正退出；测试 `transport.test:11`。
- 无法终止时抛 `SHUTDOWN_TIMEOUT`，保留 `generation/child` 供重试；测试 `:13,24-31`。
- 这些测试使用真实 Node 子进程和官方 SDK fixture，但不是真实 DSH；`failed termination` 用例还手工注入 fake child，属于模拟。

### 6.2 Hub

- 有界 UTF-8 字节解析、16 条命令准入、4 MiB 输出、事件游标、单 Store 锁，均有测试（`hub.test:15-41`）。
- Hub 不创建任务就不启动 DSH（`hub.test:41`），符合 lazy per-execution 设计。
- **Hub stop 失败不可重试（N01）。** `hub/main.mjs:12-20` 使用 `stopPromise??=` 缓存；如果 `executor.stop()` 拒绝，`stopPromise` 永久是 rejected，后续 stop 命令/SIGINT/finally 都返回同一个失败。Executor 自身在 `dsh-acp-v2:163-166` 会清空失败 promise，Transport 也能重试，但 Hub 把这层可恢复性丢掉了。这是 A14 的实质性未解决项，虽然本次没有构造出 Hub 级真实故障复现（需要注入失败执行器或真实 kill 失败）。
- 只有单 stdio 客户端、单 Store 所有者；没有身份/权限/多调用方路由。这是已声明的范围，不是本阶段缺陷，但它是 Phase 2 的前置条件。

---

## 7. 测试覆盖与证据可信度

### 7.1 本次重新运行结果

| 命令 | 结果 | 证据 |
| --- | --- | --- |
| `npm run test:unit` | 57 passed / 0 failed / 0 skipped | `logs/review-unit.txt` |
| `npm run test:simulated` | 31 passed / 0 failed / 0 skipped | `logs/review-simulated.txt` |
| `npm run test:integration` | PASS；8 组检查 | `logs/review-real-console.txt`；`logs/real-v2-2026-11-10T04-21-22-559Z.jsonl` |

该结果与仓库既有 `logs/phase1.1-unit.txt`、`phase1.1-simulated.txt`、`real-v2-2026-11-09T15-39-58-168Z.jsonl` 一致，但本次是重新执行，不能把旧日志当作本次运行。

### 7.2 各分类的真实含义

- **单元/内存 Fake（57）：** 包含 v1 的 9 个 Store、7 个 Executor、2 个路径测试，v2 Store/Executor/竞态/恢复/迁移测试。大部分不启动子进程；迁移使用真实临时文件和锁，但不是 DSH。
- **模拟 ACP/子进程（31）：** `crash-v2` 使用真实 Node 子进程退出/被杀，但 ACP 执行器是 fake；`simulated-acp-v2` 使用官方 SDK 子进程 fixture；`transport` 使用真实 Node 子进程但非 DSH；`hub` 启动真实 Hub 子进程，fixture ACP。不能称为真实 DSH 崩溃验证。
- **真实 DSH（本次 1 条流程）：** `integration-v2.mjs` 调用已安装 DSH CLI、官方 ACP SDK、真实模型。覆盖创建、完成收据、list、跨进程恢复同一 Session、并行 Session、取消、Runtime kill、重启 unknown。prompt 均要求“不调用工具”，因此没有工具副作用验证。

### 7.3 断言强度问题

1. **`waitRunning` 只证明本地 `running`。** `scripts/integration-v2.mjs:13` 等待 `execution.status === 'running'`；这是 `dispatch_intent` 后的本地状态，由 `run:99` 写入，`run:101` 才请求 prompt。`:22` 随后立刻 kill。日志中该执行只有 `execution.dispatch_intent`，没有 `execution.output` 或服务端确认；因此不能证明“DSH 正在执行时被 kill”。验收报告 `docs/phase-1.1-acceptance.md:51` 的“证明已发送阶段中断处理”属于过度声明，见 N09。
2. **迟到通知测试使用 Fake。** `executor-v2.test:27` 直接调用 Fake 的 `emit`，不经过 `AcpTransport` 的 generation 守卫；真正“旧连接迟到帧被丢弃”没有独立测试。`transport.test:11` 只验证旧连接不能断开 replacement，不验证迟到的 session/update。
3. **A04 没有专门时序测试。** 现有测试覆盖终态后 close、close 失败重试、stop 竞态，但没有“session/new 延迟响应时 closeTask”的专项断言。
4. **Hub stop 失败没有测试。** 只有正常 health/stop；没有注入 executor.stop 失败或 cleanup 失败。N01 因此未被现有测试发现。
5. **真实 DSH 只有一条流程。** 没有真实工具调用、长任务、并发压力、Desktop UI 同步或重复运行统计。
6. **测试数量不应被当作覆盖率。** 57 + 31 表示用例数，不表示所有竞态或真实行为都被覆盖；本报告按具体断言而非数量判断。

---

## 8. 新发现的问题

### 8.1 分级汇总

| 编号 | 级别 | 标题 | 状态 |
| --- | --- | --- | --- |
| N01 | P1 | Hub 关闭失败后永久缓存 rejected stopPromise，无法重试 | 静态确认，未构造 Hub 级故障 |
| N02 | P2 | 终态后崩溃残留 active binding，下一轮被 `SESSION_UNSETTLED` 阻塞 | 用崩溃 fixture + 探针确认 |
| N03 | P2 | 非 end_turn 的失败终态丢失 stopReason/诊断 | 探针确认 |
| N04 | P2 | `createTask` 幂等哈希不含 `defer` | 探针确认 |
| N05 | P2 | Store 语义投影校验不完整，可接受自相矛盾快照 | 探针确认 |
| N06 | P2 | transport cleanup 失败后 `closeTask` 无法重试，只能 `stop()` | 探针确认 |
| N07 | P2 | 完整性警报没有确认/解决路径，Task 永久不可继续 | 源码与现有测试确认 |
| N08 | P2 | `cancelExecution` 返回值不明确区分“已确认取消” | 源码与现有测试确认 |
| N09 | P2（证据） | 真实 Runtime kill 证据只证明 dispatch intent 后 kill，验收措辞过度 | 日志与脚本确认 |
| N10 | P3 | 迁移不导入 v1 原始事件流，只保留备份文件 | 源码确认 |
| N11 | P3 | shutdown 准入未完全线性化，并发准入可能留下 queued 记录 | 源码推理 + 人工探针，未证明 Runtime 泄漏 |
| N12 | P3 | `maxOutputBytes`/`flushBytes`/`maxConcurrent` 未校验；ACP 入站帧无大小上限 | 源码推理 |

### N01 / P1：Hub 关闭失败后永久缓存 rejected stopPromise

- **触发条件：** Hub 调用 `executor.stop()` 时，Transport 无法在时限内终止子进程（`SHUTDOWN_TIMEOUT`）、Store close 失败，或其他清理异常。
- **实际影响：** `stopPromise` 被赋值为 rejected Promise 后不再清空；后续 `stop` 命令、SIGINT/SIGTERM、顶层 `finally` 都拿到同一个拒绝。进程可能保留 DSH 子进程和 Store 锁，无法通过同一 Hub 重试关闭。Transport/Executor 层的重试能力被 Hub 浪费。
- **代码位置：** `apps/companion-hub/main.mjs:12-20`；对照 `packages/dsh-acp-v2/index.mjs:163-166`（Executor 在失败时清空 stopPromise）和 `packages/acp-transport/index.mjs:126-140`（Transport 可重试）。
- **复现/依据：** 静态代码路径确认。现有 `test/hub.test.mjs` 只测正常 stop，没有失败注入；因此本次未构造 Hub 级真实复现。
- **建议修复：** 使用显式 stop 状态机；在 cleanup 拒绝时清空 `stopPromise`（或保存最后一次错误但允许 retry），保证后续 stop 能再次调用 executor；为 Hub 注入失败 executor/Transport 增加测试，断言第二次 stop 可成功并释放锁。

### N02 / P2：终态后崩溃残留 active binding

- **触发条件：** Execution 终态事务已提交，但在 `run:116-118` 的 session/close 与 binding 更新之前进程退出（`afterTerminalCommit` 正是这个窗口）。
- **实际影响：** Store 中 Execution 为 completed，Binding 仍为 `active`。重启后 `ExecutionStore.open` 只处理 running/dispatch，不会把该 binding 标成 unknown；`startExecution:65` 看到 `availability !== 'closed'`，抛 `SESSION_UNSETTLED`。Task 无法继续，除非人工调用 `resumeTask`/`closeSession`，且错误没有说明需要协调。
- **代码位置：** `packages/task-store-v2/index.mjs:92-100`；`packages/dsh-acp-v2/index.mjs:62-65`；`packages/dsh-acp-v2/index.mjs:113-119`。
- **复现/依据：** 运行 `test/fixtures/crash-v2.mjs <dir> afterTerminalCommit`，重开 Store 得到 `{"task":"completed","execution":"completed","binding":"active"}`；再用新 Executor 调用 `startExecution` 得到 `SESSION_UNSETTLED`。同一状态也用合法种子快照复现。
- **建议修复：** 在恢复时把“终态 Execution 的 binding 仍 active”标为 `unknown` 并记录诊断（不要伪造 closed），或提供显式的自动协调流程；给恢复后的下一轮加测试。至少应在 Task/Execution 上暴露可读诊断，避免调用方只看到 `SESSION_UNSETTLED`。

### N03 / P2：失败终态丢失 stopReason

- **触发条件：** ACP 返回 `max_tokens`、其他非 `end_turn`/`cancelled` 的 stopReason，或未来新增结束原因。
- **实际影响：** `status` 记为 `failed`，但 `diagnostics` 为空、`completionEvidence` 为 null；调用方无法区分 token 上限、模型错误和协议异常，也无法制定重试策略。
- **代码位置：** `packages/dsh-acp-v2/index.mjs:106-108`；`diagnostics()` 只在 catch 和 quarantine 路径使用。
- **复现/依据：** 探针让 fake 返回 `{stopReason:'max_tokens'}`，得到 `status=failed, diagnostics=[], completionEvidence=null, resultIntegrity=partial`。
- **建议修复：** 对 failed 终态写入 `{code:'ACP_STOP_REASON', stopReason}` 诊断，或增加不可变 `terminalReason` 字段；增加对应测试。Store 允许终态后追加诊断，不需要改变状态架构。

### N04 / P2：`createTask` 幂等哈希不含 `defer`

- **触发条件：** 同一 `requestKey`、相同 cwd/prompt/taskId，但一次 `defer: true`，另一次 `defer: false`。
- **实际影响：** 第二次调用命中第一次的 request 记录，返回 queued Task，但不启动执行；调用方以为提交成功，实际没有 Prompt。输入语义不同却未冲突，破坏幂等键的“相同输入”约定。
- **代码位置：** `packages/dsh-acp-v2/index.mjs:44`（hash 只含 kind/cwd/prompt/taskId）；`:51` 根据 `defer` 决定是否 launch。
- **复现/依据：** 探针先 `defer:true` 再同 key `defer:false`，结果 `sameTask=true, prompts=0, latest=queued`。
- **建议修复：** 把 `defer` 纳入 inputHash，或明确禁止同 key 改变 defer（抛 `IDEMPOTENCY_CONFLICT`）；增加测试。

### N05 / P2：Store 语义投影校验不完整

- **触发条件：** 直接调用公共 `ExecutionStore.commit`（迁移、测试工具、未来适配器），提交形状合法但语义不一致的 Task/Execution。
- **实际影响：** Store 接受 `Task.result` 与最新 Execution.result 不一致、`Task.sessionId` 与 binding 不一致、`duplicateExecutionRisk` 与 unresolved 不一致、lifecycle/submission/availability 非法枚举。`getTask` 会返回错误投影；后续 Executor 依据该投影判断，可能误判状态。正常 Executor 路径通常不会产生，但 Store 作为公共契约并未守住。
- **代码位置：** `packages/task-store-v2/index.mjs:118-166`，尤其 `146-153` 只校验状态/active/unresolved；`35-41` 的投影计算。
- **复现/依据：** 向 Store 提交 completed Task + Execution，再把 Task.result 改为 `TAMPERED`；commit 被接受，Execution.result 仍为 `old`。
- **建议修复：** 增加语义校验：`task.latestExecutionId`/`activeExecutionId` 归属、`task.result` 与 latest Execution、`task.sessionId` 与 latest binding、`duplicateExecutionRisk` 与 unresolved、枚举值；或在契约中明确 Store 是低层 API、调用方必须使用 Executor，但迁移仍需校验。增加反例测试。

### N06 / P2：cleanup 失败后 `closeTask` 无法重试

- **触发条件：** Execution 运行结束后 `run:117` 的 `transport.stop()` 抛 `SHUTDOWN_TIMEOUT`；操作保留 `cleanupFailed=true`，未从 operations 移除。
- **实际影响：** `closeTask` → `closeSession:148` 检查到 `ops.some(cleanupFailed)` 抛 `CLEANUP_FAILED`；即使之后底层进程已经可以终止，第二次 `closeTask` 仍只读旧的 `cleanupFailed` 标记，不重试 `transport.stop()`。Task 可能已处于 lifecycle closed，但 Session 清理一直无法确认；只有 `stop()` 会重试（`dsh-acp-v2:165`）。
- **代码位置：** `packages/dsh-acp-v2/index.mjs:117`、`:148-153`、`:163-166`。
- **复现/依据：** 构造 stop 先失败、后恢复的 transport；`healthCheck` 显示 `cleanupFailures=[executionId]`；连续两次 `closeTask` 都返回 `CLEANUP_FAILED`。
- **建议修复：** 在 `closeSession` 对 `cleanupFailed` 的 operation 显式重试 `transport.stop()`，成功后清除标记；或暴露 `retryCleanup(taskId)`；增加测试。当前“允许重试”的文档承诺只在 Executor 整体 stop 层成立。

### N07 / P2：完整性警报没有确认/解决路径

- **触发条件：** 终态后收到无法归属的 session/update（`quarantine:77-79`），Task 写入 `integrityAlerts`。
- **实际影响：** `startExecution:61` 永久拒绝；代码没有清除警报或“承认并继续”的 API。Task 只能新建，原 Task 无法恢复；对于 Cyrene 集成，一个协议异常就可能让任务对象不可用。
- **代码位置：** `packages/dsh-acp-v2/index.mjs:61,77-79,28-32`；`executor-v2.test:27` 断言继续执行抛 `INTEGRITY_ALERT`。
- **建议修复：** 增加显式 `acknowledgeIntegrityAlert(taskId, alertId)` 或 allow `startExecution({acknowledgeIntegrityAlerts: [...]})`，保留原警报历史并设置 `duplicateExecutionRisk`；或者将受污染 Execution 隔离为独立 Task，不要把整个 Task 永久封锁。必须保留人工确认语义。

### N08 / P2：`cancelExecution` 返回值不明确区分确认

- **触发条件：** `session/cancel` 通知超时，或 transport 拒绝/断开。
- **实际影响：** 方法返回当前 Execution，可能是 `running` 或 `unknown`，而调用方容易把“方法返回”理解为“已取消”。`cancel.confirmedAt` 为空是唯一提示，但没有显式结构。
- **代码位置：** `packages/dsh-acp-v2/index.mjs:121-134`；`executor-v2.test:26` 与 `simulated-acp-v2.test:10` 分别展示已确认和未确认路径。
- **建议修复：** 返回 `{execution, cancelRequested, confirmed}`，或在未确认时抛 `CANCEL_UNCONFIRMED` 并保留可查询记录；至少更新 Contracts 文档，明确调用方必须检查 `status`/`cancel.confirmedAt`。Phase 2 的 Cyrene 工具层不能把返回值直接当“已取消”。

### N09 / P2（证据问题）：真实 Runtime kill 的验收措辞过度

- **触发条件：** 阅读 `scripts/integration-v2.mjs:13,22` 与 `docs/phase-1.1-acceptance.md:40,51`。
- **实际影响：** 测试在本地 `execution.status === 'running'` 后立刻 kill；该状态是 `dispatch_intent` 的事务结果，不代表 DSH 收到或开始处理 Prompt。日志中该执行没有输出/工具事件，只有 dispatch 与 interrupted。因此只能证明“dispatch intent 后 kill 得到 unknown”，不能证明“执行中 kill”或工具副作用中断。
- **代码位置：** `scripts/integration-v2.mjs:13,22`；`docs/phase-1.1-acceptance.md:40,51`；`docs/phase-1.1-acceptance.md:40` 的“真实DSH均覆盖”是过强表述。
- **建议修复：** 将验收文字改为“真实 Runtime 在 dispatch intent 后被 kill”；若要证明执行中，增加一个可观察的 DSH 事件（例如触发工具调用并等待 `tool_call`/`agent_message_chunk`）后再 kill，或在真实 DSH 日志中取得服务端接收证据。不要用本地 status 代替。

### N10 / P3：迁移不导入 v1 原始事件流

- **触发条件：** 使用 `scripts/migrate-v1.mjs` 迁移旧 Store。
- **实际影响：** `getEvents` 只能看到每条旧任务的一条 `legacy.imported`，旧事件保存在 `legacy-v1-backup.json`，不能通过 v2 API 查询；审计和状态追踪被降级为人工读备份。
- **代码位置：** `scripts/migrate-v1.mjs:39,45-52`。
- **建议修复：** 在迁移结果中导入经过验证的旧事件（可保留 `legacy.` 前缀和原始 sequence 映射），或明确文档说明备份是唯一历史来源；不要伪造新的 Execution 边界。

### N11 / P3：shutdown 与并发准入未完全线性化

- **触发条件：** `startExecution`/`dispatchQueued`/`closeSession`/`reconcileTask` 的 `await this.start()`/`initialize()` 与 `stop()` 交错；或 per-task gate 队列中已有操作。
- **实际影响：** `stop()` 在 `dsh-acp-v2:165` 先快照 `operations`，再等待 gates；gate 中的新准入可能在其后提交并 `launch`。探针（人为延迟 start）显示 stop 返回后仍留下一个 `queued` Execution；`run` 在 `:92` 检查 stopping，未发送 Prompt，因此没有证明 Runtime 泄漏，但“停机期间拒绝新工作”并非严格成立。现有 `recovery-v2.test:38-44` 只覆盖已经加入 `contextTransports` 的恢复。
- **代码位置：** `dsh-acp-v2:55-69,137-154,163-166`；`hub/main.mjs:12-20`。
- **建议修复：** 在每个 gate 内重新检查 `stopping`，或在 stop 开始时关闭 admission；stop 结束前再次快照并停止新产生的 operation/context transport；增加“queued gate 期间 stop”测试。不要把“queued 记录保留”误报为已执行。

### N12 / P3：容量参数与入站帧校验不足

- **触发条件：** 直接构造 Executor 时传入非法 `maxOutputBytes`/`flushBytes`/`maxConcurrent`（Hub 当前不暴露这些参数）；或对端发送超大/异常 session/update。
- **实际影响：** 构造函数只校验超时（`dsh-acp-v2:15-19`）。`maxOutputBytes: NaN/负数` 会使 `receive:84` 的比较失效，输出上限可能被绕过；`maxConcurrent` 非法会让所有新执行 BUSY。`AcpTransport` 未设置入站帧大小上限，`quarantine:77` 会先对整个 `params` 做 `JSON.stringify` 再截断，大帧可造成瞬时内存/CPU 压力。
- **代码位置：** `dsh-acp-v2:15-19,77,80-86`；`acp-transport:42-51`。
- **建议修复：** 校验所有容量参数为正安全整数并设合理上限；为入站 ACP 消息设置最大字节数/提前截断策略；增加非法配置和超大帧测试。当前对端是本地可信 DSH，风险低于网络服务，但长期运行仍应设边界。

---

## 9. 尚未验证的风险

1. **真实长任务：** 没有数小时真实 DSH 运行、长时间无通知、上下文压缩或自动恢复测试。现有 `silent` 是 150ms 模拟，`long` 是 fake/缩时。
2. **真实工具副作用与重复执行：** 所有真实 prompt 都要求不调用工具；没有验证工具失败、工具重试、外部副作用和人工重试风险。
3. **DSH 工具子进程及后代：** 没有验证 Windows 进程树在正常关闭、硬杀、Shell 工具、后台工具下的回收。
4. **Desktop UI 同步：** 没有验证 ACP Session 是否出现在桌面 UI、是否会与用户手动操作冲突。
5. **多客户端：** 单 stdio、单 Store；没有身份、权限、并发调用方和重连协议。不能据此说 Cyrene/AstrBot 可同时接入。
6. **长运行容量与性能：** 32 MiB 快照每次提交全量序列化，历史增长后的延迟/磁盘压力未测量；事件/快照无自动归档。
7. **非合规通知：** 独立连接和 generation 能隔离跨执行，但同一执行内重复/迟到文本、无 turn ID 的归属歧义不可完全消除；没有真实异常服务器测试。
8. **真实 Hub stop 失败：** N01 只有静态依据；需要故障注入才能证明影响范围。
9. **迁移后历史：** 旧事件只在备份文件，没有 API 查询验证；迁移真实大型 Store 未测试。
10. **Windows 断电/磁盘损坏：** fsync+rename 不提供跨进程或断电零损失保证。

---

## 10. 最终验收结论

### 10.1 结论

**CONDITIONAL PASS。**

理由：

- 没有发现 P0：v2 主路径没有把不确定执行自动重发，也没有把没有收据的远端结果伪造成 completed；Task/Execution/Session 边界、终态原子提交、未知承认、独立连接隔离和基本并发控制成立。
- 57 项 unit/store/migration、31 项 simulated/subprocess/fault 测试本次重新运行通过；真实 Windows DSH 单流程也通过，且已有日志与本次日志一致。
- 但 A14 在 Hub 层实质上仍未闭合（N01，P1），并且存在多个会影响 Cyrene 集成的 P2：终态后 binding 卡死（N02）、失败原因丢失（N03）、幂等哈希遗漏（N04）、Store 语义校验不足（N05）、cleanup 后 closeTask 不可重试（N06）、完整性警报无解（N07）、取消返回值含混（N08），以及真实 kill 证据过度声明（N09）。
- 因此不能给出 PASS；也不构成 FAIL，因为没有证明“错误地重复执行”或“错误地报告成功”的核心安全失败。

### 10.2 进入 Phase 2 设计前必须完成

按优先级：

1. **N01（P1）**：修复 Hub stop 失败缓存，保证同一 Hub 能重试关闭并释放子进程/Store 锁；增加失败注入测试。
2. **N02（P2）**：处理“completed + active binding”崩溃窗口；至少恢复时标 unknown 并给出诊断，或自动协调；增加 `afterTerminalCommit` 后继续执行的测试。
3. **N06（P2）**：让 `closeTask` 能重试 cleanupFailed 的 transport，或明确将“必须 stop 整个 Executor 后重启”的限制写进 Contracts 并提供操作入口；否则 A14 的“关闭失败可重试”不成立。
4. **N03（P2）**：失败终态持久化 stopReason/诊断，保证调用方能制定重试策略。
5. **N04（P2）**：`defer` 纳入幂等哈希或拒绝冲突。
6. **N09（P2 证据）**：修正真实集成和验收报告的“执行中 kill”表述；如需保留该结论，增加服务端可观察的进度/工具事件后再 kill。
7. **N05（P2）**：补齐 Store 语义投影校验，或在契约中明确 Store 低层限制并把迁移/外部入口限制在 Executor。
8. **N07（P2）**：为完整性警报提供人工确认/隔离路径，避免 Task 永久不可用。
9. **N08（P2）**：把取消确认语义显式化，避免 Cyrene 工具层误解返回值。

### 10.3 可在 Phase 2 设计并行处理

- N10（迁移事件流）、N11（shutdown 准入线性化）、N12（容量参数/入站帧校验）。
- 真实长时间浸泡、工具副作用、孙进程回收、Desktop UI 同步、多客户端身份/授权。
- 长期 Store 归档/压缩策略；不要在本阶段引入大型消息队列或第二套任务系统。

### 10.4 停止点

本次只新增本报告及运行日志，没有修改业务源码、Contracts、测试或配置，没有接入 AstrBot/Cyrene/QQ/NapCat/Bilibili，也没有开始 Phase 2。等待用户审阅结论和是否接受上述条件。
