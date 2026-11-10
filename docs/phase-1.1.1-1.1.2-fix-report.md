# Phase 1.1.1 + Phase 1.1.2 修复报告

日期：2026-11-10（Asia/Hong_Kong）。版本：0.1.2。范围：仅 Windows 原生 DSH ACP Companion Hub；未接入 Cyrene、AstrBot、QQ/NapCat、Bilibili，未进入 Phase 2。

结论：N01–N09 均已实现修复并有对应测试；其中 N01/N02/N06 的故障注入使用模拟 ACP 或注入执行器，N09 的真实 DSH 回归已重新运行并修正证据表述。仍存在未验证项，见第 6 节。

---

## 1. 修复总览

| 问题 | 修复状态 | 主要测试 | 证据类型 |
| --- | --- | --- | --- |
| N01 Hub stop 失败无法重试 | 已修复 | `hub-lifecycle.test`、`hub-stop.test` | 单元 + 真实 Hub 子进程（注入 fake executor） |
| N02 终态后 active Binding 崩溃窗口 | 已修复 | `crash-v2.test` 的 `post-terminal crash...` | 真实 Node 子进程退出 + 模拟 ACP |
| N06 cleanupFailed 后 closeTask 无法重试 | 已修复 | `executor-v2-races.test` 的 `closeTask retries...` | Fake transport |
| N03 失败终态丢失 stopReason | 已修复 | `executor-v2.test` 的 `failed terminal...` | Fake ACP |
| N04 defer 未进入幂等哈希 | 已修复 | `executor-v2.test` 的 defer / legacy 用例 | Fake + 直接 Store 种子 |
| N05 Store 语义投影校验不足 | 已修复 | `store-v2.test` 的语义反例 | Store 单元 |
| N07 完整性警报无解除路径 | 已修复 | `executor-v2.test` 的 acknowledged integrity... | Fake ACP |
| N08 cancel 返回值语义不明确 | 已修复 | 取消确认/超时/自然完成用例 | Fake ACP |
| N09 真实 kill 证据过度声明 | 已修正 | `integration-v2` + 文档 | 真实 Windows DSH ACP |

---

## 2. N01：Hub stop 失败后无法重试

### 修复

- 新增 `apps/companion-hub/lifecycle.mjs` 的 `createStopController`：
  - 成功 stop 记忆化，重复调用返回同一成功 Promise。
  - 失败 stop 在拒绝前清空 `stopPromise`，允许同一实例重新清理。
  - 并发 stop 共享同一 in-flight Promise。
  - `onStop` 只执行一次，用于设置 stopping、暂停 stdin。
- `apps/companion-hub/main.mjs` 改用该控制器；顶层 `finally` 在第一次 stop 失败后再尝试一次，覆盖“命令触发 stop 时 finally 已开始等待”的时序。
- 新增可选 `executorModule` 注入点，用于 Hub 级故障测试和替换执行器；默认仍使用内置 `DshAcpExecutor`。

### 测试

- `test/hub-lifecycle.test.mjs`：并发 stop 共享、首次 cleanup 拒绝、同一控制器第二次成功、成功后不重复 cleanup。
- `test/hub-stop.test.mjs`：启动真实 Hub 子进程，通过 `executorModule` 注入 fake executor；fake 的 `stop()` 第一次抛 EIO、第二次成功，验证：
  - 同一 Hub 进程完成第二次清理；
  - 退出码为 0；
  - `stops.log` 恰为 `1, 2`；
  - 第一次错误通过 stdout 返回。
- 现有 `hub.test.mjs` 的正常 stop/health 仍通过。

### 未验证

- 没有构造“真实 DSH 子进程无法在 Windows 上被 taskkill 终止”的 Hub 级故障；N01 的停止失败注入使用 fake executor。Transport/Executor 的失败重试有单独的模拟终止测试，但不是真实 OS 级不可杀进程。

---

## 3. N02：completed Execution + active SessionBinding 崩溃窗口

### 修复

- `ExecutionStore.open()` 在恢复时识别“Execution 已终态但 Binding 仍 active”：
  - 不伪造 closed；
  - Binding 置为 `unknown`，加 `recoveryRequired=true`；
  - Execution 追加 `TERMINAL_SESSION_UNSETTLED` 诊断，保留原始终态、结果、完成证据；
  - 事件仍记录恢复。
- `startExecution` 的 `SESSION_UNSETTLED` 错误文案明确要求 `reconcileTask` 或 `closeSession`；恢复路径本身会验证 resume/close 后再标记 closed。
- `resumeTask`/`reconcileTask` 已能对 completed Task 的未知 Binding 执行 resume+close，不需要伪造新 Execution。

### 测试

- `test/crash-v2.test.mjs` 新增：
  - 运行 `afterTerminalCommit` 崩溃 fixture（真实 Node 进程退出，模拟 ACP）；
  - 重开 Store 断言 Binding 为 `unknown`、`recoveryRequired=true`、Execution 有 `TERMINAL_SESSION_UNSETTLED`；
  - 新 Executor `resumeTask` 成功关闭 Binding；
  - 随后 `startExecution` 使用新 Execution 完成。
- 这覆盖“终态已提交、Binding 未关闭”窗口，但没有用真实 DSH 进程复现该窗口。

### 未验证

- 真实 DSH 的 session/close 行为在进程崩溃后的边界未单独验证；本测试的 ACP 恢复使用模拟 transport。

---

## 4. N06：cleanupFailed 后 closeTask 无法重试

### 修复

- `DshAcpExecutor` 新增 `retryCleanup(op)`：
  - 对保留的 cleanupFailed operation 再次调用 `transport.stop()`；
  - 成功后才清除标记、更新 Binding：`op.sessionClosed` 为 true 时 closed，否则仍 unknown；
  - 失败保留 `cleanupFailed` 和错误。
- `closeSession` 在检查 `CLEANUP_FAILED` 前先重试这些 operation；`closeTask` 因而可在同一实例重试。
- `stop()` 对 cleanupFailed operation 使用同一重试逻辑；只有全部成功后才释放 Store。
- 失败时仍不把 Binding 标记 closed。

### 测试

- `test/executor-v2-races.test.mjs` 新增 `closeTask retries a failed transport cleanup...`：
  - 第一次 transport.stop 抛 `SHUTDOWN_TIMEOUT`；
  - 第一次 closeTask 返回 `CLEANUP_FAILED`，Binding 仍 unknown；
  - 清除故障后第二次 closeTask 成功，`cleanupFailures` 清空，Binding closed。
- 原 `failed transport stop retains ownership...` 仍验证整体 stop 的可重试性。

### 未验证

- 使用 Fake transport；没有在真实 Windows 进程上制造一次失败、一次成功的 cleanup。

---

## 5. N03/N04/N05/N07/N08 修复

### N03 失败终态保留 stopReason

- `run()` 对 `failed` 终态追加 `ACP_STOP_REASON` 诊断，含 `stopReason` 和时间；completed/cancelled 仍使用 `completionEvidence`，failed 不伪造完成证据。
- 测试：fake ACP 返回 `max_tokens`，断言 `status=failed`、`completionEvidence=null`、诊断含 `ACP_STOP_REASON/max_tokens`。
- 覆盖其他非 end_turn stopReason 的映射逻辑；没有为每一种未来 stopReason 单独枚举。

### N04 defer 幂等哈希

- `createTask` 的 inputHash 增加 `defer: input.defer === true`。
- 旧版本不含 defer 的 requestHash 仍可匹配并返回原记录，避免升级改变已提交请求的语义。
- 测试：
  - 同 key 同 defer 返回原 Task；
  - 同 key 改变 defer 抛 `IDEMPOTENCY_CONFLICT`；
  - 直接 Store 种子的 legacy hash 仍可重放，且不发送 Prompt。
- 局限：旧记录无法知道原 defer 值，因此按旧行为直接返回原记录；这是有意的兼容策略，不推断历史意图。

### N05 Store 语义投影校验

- `ExecutionStore.#validate` 新增：
  - `latestExecutionId` 必须指向最后创建的 Execution；
  - `Task.result` 必须与最新 Execution.result 一致；
  - `Task.sessionId` 必须与最新 Binding.sessionId 一致；
  - `lifecycle`、`submission`、`binding.availability` 枚举；
  - `integrityAlerts` 必须是数组，条目有 code，确认时间为字符串；
  - unresolved 或 integrityAlerts 存在时 `duplicateExecutionRisk` 必须为 true。
- 不一致快照以 `VALIDATION` 拒绝，不静默修复。
- 测试：`store-v2.test` 新增“semantic projection rejects inconsistent result, pointer, and enum snapshots”；更新既有 fixtures 以包含最新指针、result、session。
- 影响：测试/迁移/直接 Store 调用必须提交语义一致快照；正常 Executor 路径已适配。

### N07 完整性警报人工确认

- 新增 `acknowledgeIntegrityAlerts(taskId,{acknowledgedBy,note})`：
  - 不删除原警报，保留 `executionId/code/time`；
  - 为每条未确认警报追加 `acknowledgedAt/acknowledgedBy/note`；
  - 事件 `integrity.acknowledged`；
  - 确认后不证明结果完整；`duplicateExecutionRisk` 仍为 true；
  - 新 Execution 不复用受影响 Session，使用新 Session；
  - 仍有未确认警报时 `startExecution` 继续抛 `INTEGRITY_ALERT`。
- 测试：Fake 迟到通知产生警报 → startExecution 拒绝 → 人工确认 → 新 Session 完成 → 原警报与确认人仍在，风险仍为 true。
- 局限：没有“隔离到此 Task 之外”的独立对象；确认是人工动作，审计只存在 Task 事件和条目中。

### N08 取消返回结构

- `cancelExecution` 返回：
  ```ts
  { execution, cancelRequested, cancelConfirmed }
  ```
- `cancelConfirmed` 只在 `status=cancelled` 且 `completionEvidence.stopReason` 为 `cancelled`/`local_not_submitted` 时为 true。
- 保留 requestedAt/sentAt/confirmedAt；超时、断连、自然完成均不为 confirmed。
- `cancelTask` 仍返回 Task；调用方需检查活动 Execution。
- 测试：确认取消、end_turn 赢得取消竞态、取消超时三条路径。
- 局限：这是公共接口的破坏性变更；现有内部调用已适配，外部调用方必须改用 `.execution`。

---

## 6. N09：真实 Runtime kill 证据修正

### 修改

- `scripts/integration-v2.mjs`：
  - `waitRunning` 改名 `waitDispatchIntent`，错误信息改为 `dispatch intent deadline`；
  - 日志类型改为 `runtime-kill-after-dispatch-intent`；
  - 记录 `note: "local dispatch intent, not proof the DSH prompt was executing"`；
  - PASS 检查文案改为“real Runtime killed after durable dispatch intent (remote execution not proven)”。
- `docs/phase-1.1-acceptance.md` 修正相关表述：不再声称“执行中 kill”或“已证明工具副作用中断”。
- `docs/phase-1.1-independent-review.md` 顶部加后续注，指向本报告；原始独立审查内容保留。
- 旧日志不修改；本次真实回归生成新日志。

### 证据边界

- 测试在本地 Store 写入 `running/dispatch_intent` 后立即 kill DSH 子进程；
- 日志中该 Execution 没有输出或工具事件；
- 因此只证明“dispatch intent 后中断并保持 unknown”，**不证明 DSH 收到/执行了 Prompt，也不证明工具副作用**；
- 若要证明远程执行中 kill，需要服务端可观察事件（如 tool_call/agent_message_chunk）或其他可信证据；本阶段没有实现该增强，明确列为未验证。

---

## 7. 测试结果

### 7.1 本次最终运行

| 类别 | 命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| Unit/store/migration | `npm run test:unit` | 65 passed / 0 failed / 0 skipped | `logs/phase1.1.1-unit.txt` |
| Simulated ACP/Transport/Hub/fault | `npm run test:simulated` | 35 passed / 0 failed / 0 skipped | `logs/phase1.1.1-simulated.txt` |
| Real Windows DSH ACP | `npm run test:integration` | PASS；8 组检查 | `logs/phase1.1.1-real-console.txt`、`logs/real-v2-2026-11-10T05-59-41-670Z.jsonl` |
| 关键竞态重复运行 | 三次循环 | 3 次 × 25 项，全部通过、0 失败 | `logs/phase1.1.1-repeat.txt` |
| 合并全量本地测试 | `npm test` | 100 passed / 0 failed / 0 skipped | `logs/phase1.1.2-all.txt` |

本地自动化合计 100 项（65 + 35），但测试数量不等于覆盖率；真实 DSH 只有一条流程、8 组检查，不混算为 100 项。

### 7.2 分类说明

- **Unit tests**：Store/TaskStore/迁移/路径/Executor fake；不启动真实 DSH。
- **Fake/mock ACP tests**：大部分 executor 竞态和取消测试使用 FakeTransport。
- **Simulated ACP integration tests**：使用官方 SDK 子进程 fixture、真实 Node 退出/杀进程、注入 Hub executor；仍不是 DSH。
- **Real Windows DSH ACP**：使用已安装 DSH 0.2.2-rc.1 和真实模型；prompt 均要求不调用工具。

### 7.3 本次新增/修改测试

- `test/hub-lifecycle.test.mjs`（2）
- `test/hub-stop.test.mjs`（1，真实 Hub 子进程 + 注入 executor）
- `test/crash-v2.test.mjs` 新增终态崩溃恢复（1）
- `test/executor-v2-races.test.mjs` 新增 cleanup 重试（1）
- `test/executor-v2.test.mjs` 新增失败 stopReason、defer、legacy、完整性确认、取消确认/超时（6）
- `test/store-v2.test.mjs` 新增语义反例（1）
- 既有测试 fixture 更新以适配 Store 语义校验。

---

## 8. 未解决问题与剩余风险

1. **真实 OS 级 cleanup 失败**：N01/N06 使用注入 executor/fake transport；没有真实 Windows 不可杀进程的验证。
2. **真实 DSH 终态崩溃窗口**：N02 的崩溃注入使用真实 Node 退出但模拟 ACP；未在真实 DSH 进程上复现“终态已提交、close 未完成”。
3. **真实工具副作用**：所有真实 prompt 不调用工具，未验证工具副作用后的中断、重试和孙进程回收。
4. **长时间运行**：没有数小时真实浸泡；Store 全快照 commit 的长期性能未测量。
5. **Desktop UI 同步**：仍未知 ACP Session 与桌面 UI 是否同步。
6. **多客户端**：单 stdio、单 Store；没有身份、权限、重连路由；不可据此说 Cyrene/AstrBot 可同时接入。
7. **完整通知归属**：独立连接隔离跨 Execution，但同 Execution 内无远端 turnId 的重复/迟到文本不能完全识别；确认警报不等于结果完整。
8. **N09**：真实 kill 仍不是“远端执行中”证据；这是明确未验证，不是修复遗漏。
9. **Hub executorModule**：本地可信代码注入点；不应指向不可信路径。

---

## 9. 结论

- N01–N09 的代码修复已完成，并有针对性测试；没有通过放宽安全约束来换取通过。
- N01 有真实 Hub 子进程 + 注入失败执行器的测试；N02/N06 是模拟 ACP/故障注入，已在表中区分。
- 真实 Windows DSH 回归重新运行通过，但 N09 的证据边界已按实际可观察事实收窄。
- 建议将本版作为 Phase 1.1.1/1.1.2 修复完成版本接受；是否进入 Phase 2 由用户决定。本次停止，不开始 Phase 2，不进行 bot/Cyrene 集成。

---

## 10. 主要修改文件

- `apps/companion-hub/main.mjs`
- `apps/companion-hub/lifecycle.mjs`（新增）
- `packages/dsh-acp-v2/index.mjs`
- `packages/task-store-v2/index.mjs`
- `packages/contracts/v2.d.ts`
- `scripts/integration-v2.mjs`
- `test/hub-lifecycle.test.mjs`（新增）
- `test/hub-stop.test.mjs`（新增）
- `test/crash-v2.test.mjs`
- `test/executor-v2.test.mjs`
- `test/executor-v2-races.test.mjs`
- `test/store-v2.test.mjs`
- `package.json`、`package-lock.json`（0.1.2）
- `README.md`、`DEVELOPMENT.md`、`docs/contracts.md`、`docs/architecture.md`、`docs/deployment-windows.md`、`docs/phase-1.1-acceptance.md`、`docs/phase-1.1-independent-review.md`（后续注）
