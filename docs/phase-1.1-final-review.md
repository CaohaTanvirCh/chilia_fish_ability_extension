# Phase 1.1 Final Review 独立最终验收报告

审查对象：`chilia_fish_ability_extension`，`master` 分支提交 `c14a717fffbab8d1084914096a35f7252a579363`（`docs/fix: phase 1.1.1 and 1.1.2`）。

比较基线：`0ae5b8821df23b66622b607f6ca569a896e46d15`（`docs: test result for phase 1.1`），同时确认父提交与远端 `origin/master` 均指向 `c14a717`。

审查日期：2026-11-10（Asia/Hong_Kong）。审查性质：只读审查、独立复跑、故障探针和证据核对；未修改业务源码、Contracts、测试实现或配置，未接入 Cyrene、AstrBot、QQ/NapCat、Bilibili，未进入 Phase 2，未承诺 exactly-once，未自动重发 unknown Execution。

## 最终结论

**CONDITIONAL PASS。**

本轮没有发现 P0 级数据损坏，也没有在正常 Executor 路径发现“确定执行过的 Prompt 被自动重发”或“无收据伪造 completed”的情况。终态原子提交、独立 ACP 连接、重启 unknown、显式承认未知执行等核心约束仍然成立；N01、N03、N04、N06、N07、N08、N09 的主要修复也可复现。

但当前版本不能无条件判定为 PASS：

1. **N02 的恢复标志未完成闭环，P2。** `reconcileTask()` 成功后 Binding 已是 `closed`，却仍保留 `recoveryRequired=true`；随后 `closeSession()` 又会因为 Binding 已经是 `closed` 而跳过修复，导致该矛盾状态只能等到下一次 Execution 完成时才被清除。
2. **N05 的 Store 语义校验仍有缺口，P2。** `Task.unresolvedExecutionIds` 等投影字段可以省略；一个含 unknown Execution 的快照仍可能通过校验，而 `startExecution` 会把省略的字段当成空数组，从而不要求显式承认 unknown。另有 `resultIntegrity` 枚举和 `integrityAlerts.executionId` 未校验。
3. **N03 的失败诊断只覆盖 `failed` 终态；quarantine 使终态为 `unknown` 时仍丢失 `stopReason`，P3。**
4. **N01 控制器对“同步抛错”的 cleanup 不能重试，P3 潜在问题；当前 Hub 的 async cleanup 路径不受影响。**
5. **N01/N06 的故障注入仍未在真实 OS 不可杀进程、真实 Store 锁与真实 Hub 组合上验证；N02 的真实 DSH 崩溃窗口也仍是模拟 ACP 证据。**
6. **公开仓库含 Windows 账户路径/用户名，测试日志为 UTF-16LE，Git 视为二进制；不影响运行，但不适合作为公开证据直接发布。**

因此建议：**可以有条件开始 Phase 2 的接口设计讨论，但不应在关闭上述 P2 前开始 Phase 2 实现或接入任何 bot。** 若把“可进入 Phase 2”定义为“可以开始设计”，当前基础足够；若定义为“可以开始实现”，当前判定不通过。

## 1. 提交、工作区与变更核对

### 1.1 提交身份

| 项目 | 结果 |
| --- | --- |
| 当前 `HEAD` | `c14a717fffbab8d1084914096a35f7252a579363` |
| `origin/master` | 同一个 `c14a717` |
| 父提交 | `0ae5b8821df23b66622b607f6ca569a896e46d15` |
| 分支 | `master`，与远端一致 |
| 审查开始时工作区 | 干净，无已跟踪文件修改 |
| 审查后新增 | 仅新增本次真实回归 JSONL；报告文件本身也是新增未提交文件 |

审查前执行的 `git status --short` 为空。独立真实回归又生成了一个未跟踪文件：

`logs/real-v2-2026-11-10T06-12-37-480Z.jsonl`

本次审查没有修改任何业务源码、Contracts、测试实现或 `config/windows.json`。

### 1.2 与基线的实际差异

`git diff --stat 0ae5b88..c14a717`：

- 30 个文件变更；
- 761 行新增；
- 73 行删除；
- 新增 `apps/companion-hub/lifecycle.mjs`；
- 新增 `test/hub-lifecycle.test.mjs`、`test/hub-stop.test.mjs`；
- 修改 `apps/companion-hub/main.mjs`、`packages/dsh-acp-v2/index.mjs`、`packages/task-store-v2/index.mjs`、`packages/contracts/v2.d.ts`；
- 修改 6 个既有测试文件；
- 增加修复报告、验收文档段落、运行日志和两个真实 JSONL。

这是一次聚焦 N01–N09 的修复提交，没有发现隐藏的 Phase 2 接入代码、网络监听、bot 依赖或凭据提取逻辑。

### 1.3 文档、日志与报告声明

独立核对结果：

| 声明 | 核对结果 |
| --- | --- |
| 本地自动化 100 passed | 独立运行 `npm test` 得到 100 passed / 0 failed / 0 skipped |
| 65 unit/store/migration | 独立运行 `npm run test:unit` 得到 65 passed / 0 failed |
| 35 simulated ACP/Transport/Hub/fault | 独立运行 `npm run test:simulated` 得到 35 passed / 0 failed |
| 关键竞态重复 3 × 25 | 仓库日志确认为 3 轮、每轮 25 项、0 失败 |
| 真实 Windows DSH 8 组检查 | 独立运行 `npm run test:integration` 得到 PASS；检查项为 8 组 |
| 日志缺失/空文件 | 未发现空日志；65/35/100 与修复报告一致 |
| 日志与报告不一致 | 计数一致；但 `phase-1.1-acceptance.md` 与修复报告使用“N01–N09 已修复”的总结，和本轮 N02/N05 的残余缺口不完全一致 |

`phase1.1.1-real-console.txt` 只有一个 `"type":"PASS"`，没有 `"type":"FAIL"`；`phase1.1.1-repeat.txt` 为 3 个 `=== run ===`、共 75 个 `✔`、0 个 `✖`。

**日志编码问题：** 仓库内所有 `.txt` 测试日志是 UTF-16LE（BOM `FF FE`，含 NUL），Git 的 `diff --numstat` 将它们显示为 `- -`（binary）。它们不是空文件，内容也可由 PowerShell/Node 解码，但在 GitHub/PR diff 中不可读，无法作为可审查的文本证据。建议后续转换为 UTF-8；本轮不修改。

### 1.4 公开仓库个人信息核对

未发现真实 API key、DeepSeek 凭据、密码或 `.env` 内容。`test/task-store.test.mjs` 中的 `sk-store-test-` 是明显测试值，不是凭据。`config/windows.json` 被 `.gitignore:14` 忽略，未进入仓库；这是正确的。

但公开树中存在本机账户信息：

| 位置 | 内容 | 建议 |
| --- | --- | --- |
| `README.md:6` | 本机仓库绝对路径 | 改为 `C:\path\to\fish_abil_ext` 或相对路径 |
| `DEVELOPMENT.md:7` | 本机桌面绝对路径 | 改为占位路径，或说明这是本机记录 |
| `DEVELOPMENT.md:18` | 本机用户目录下的 DSH CLI 路径 | 从配置读取，不在文档硬编码 |
| `docs/deployment-windows.md:10,35` | 本机用户目录/用户名 | 改为通用示例 |
| `scripts/probe-acp.mjs:4` | 硬编码本机用户目录下的 DSH 安装路径 | 改为读取 `config/windows.json` 或参数 |
| `logs/*.jsonl`、`logs/*.txt` | JSON 转义后的本机用户绝对路径、CLI 路径 | 公开前脱敏或只保留摘要 |
| Git 提交元数据 | 作者显示名和邮箱是公开提交信息 | 若公开仓库需要匿名，需重写历史，不能只改文件 |

这不是运行可靠性缺陷，但属于公开仓库发布卫生问题。尤其是日志已经包含绝对路径，后续若把日志作为公开验收证据，应先脱敏。

## 2. 独立测试结果

### 2.1 本地自动化

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npm run test:unit` | 65 passed / 0 failed / 0 skipped | Store、Executor fake、迁移、路径 |
| `npm run test:simulated` | 35 passed / 0 failed / 0 skipped | 官方 SDK fixture、Hub/Transport 子进程、故障注入 |
| `npm test` | 100 passed / 0 failed / 0 skipped | 合并套件 |

测试数量是 65 + 35 = 100；真实 DSH 是另一条流程，不把 8 组检查混算成 8 个 `node:test`。

### 2.2 重复运行日志

`logs/phase1.1.1-repeat.txt` 可解码为：

- 3 个 run；
- 每个 run 25 项；
- 合计 75 项；
- 0 失败；
- 与修复报告“3 次 × 25 项”一致。

### 2.3 真实 Windows DSH ACP

独立运行 `npm run test:integration` 成功，8 组检查为：

1. create；
2. atomic receipt；
3. list；
4. new-process restore same Session/context；
5. parallel Sessions；
6. cancel actual terminal；
7. real Runtime killed after durable dispatch intent（remote execution not proven）；
8. restart unknown not resent。

本次新日志 51 行，最后一条是 `PASS`。日志中该 kill Execution 为 `unknown`、`completionEvidence=null`、`resultIntegrity=uncertain`，没有工具事件或输出；这与 N09 修正后的证据边界一致：**只证明本地持久化 dispatch intent 后中断，不证明 DSH 收到/执行了 Prompt，也不证明工具副作用**。

### 2.4 证据分类

- **真实 DSH**：只有一条集成流程、8 组检查；真实模型 prompt 均要求“不调用工具”。
- **真实 Node 子进程**：crash fixture 有真实进程退出，但 ACP 是模拟的。
- **模拟 ACP / Fake transport**：N01 Hub 注入 executor、N02 终端恢复、N06 cleanup 重试的大部分断言。
- **Store 真实文件系统/锁**：Store 单元测试和迁移测试使用真实文件，但不是 DSH。

这些证据不能互相替代。修复报告已经区分，但“N01–N09 均已实现修复”这一总结仍应按 N02/N05 的实际残余收窄。

## 3. N01–N09 逐项独立复核

### N01：Hub stop 失败后重试

**检查点与结果**

- `createStopController` 在 `apps/companion-hub/lifecycle.mjs:10-29`：
  - 并发 stop 共享同一 in-flight Promise；
  - 成功后记忆化；
  - 异步拒绝时清空 `stopPromise`；
  - `onStop` 只执行一次。
- `apps/companion-hub/main.mjs:14-21` 的 cleanup 捕获 `executor?.stop()`，先等待 startup，再等待 executor 清理。
- `main.mjs:115-120` 在顶层 `finally` 中先等当前 stop；若失败，再调用一次 stop。
- `test/hub-lifecycle.test.mjs:7-31` 覆盖并发共享、首次异步拒绝、同一控制器第二次成功、成功后不重复 cleanup。
- `test/hub-stop.test.mjs:21-61` 启动真实 Hub 子进程，用 `executorModule` 注入 fake executor：第一次 `stop()` 抛 EIO，第二次成功；断言退出码 0、`stops.log` 为 `1,2`、第一次错误出现在 stdout。
- `test/executor-v2-races.test.mjs:101-108` 另验证 Executor + 真实 Store 的 transport 失败重试；第二次 stop 后 health 正常。

**判断：当前 Hub 的异步失败路径通过；不构成之前审查中的 P1。**

**残余问题（P3，非当前生产路径）：**

`createStopController` 的 rejection 清空逻辑只覆盖 `await cleanup()` 的异步拒绝。若 `cleanup` **同步抛错**，async IIFE 会在 `stopPromise = operation` 赋值之前进入 catch，`stopPromise === operation` 为假，随后赋值仍会缓存 rejected Promise。独立探针结果：

```json
{"calls":1,"same":true,"status":"rejected"}
```

当前 Hub 的 cleanup 是 async，`DshAcpExecutor.stop()` 也是 async，因此不会触发这个分支；但控制器作为公共单元，其“失败可重试”契约并不完整。建议把 cleanup 调用放进 `Promise.resolve().then(() => cleanup())`，或在赋值后统一 catch 清空。

**证据边界：**

- `hub-stop` 使用 fake executor，不拥有真实 Store 锁和真实 DSH 子进程；
- 没有构造“真实 Windows 进程无法 taskkill”的 Hub 级失败；
- 顶层只自动重试一次；第二次失败时进程退出并留下可被下一次启动恢复的锁；
- 未对 SIGINT/SIGTERM 失败路径做独立注入，只覆盖了命令 stop + stdin EOF 的基本时序。

### N02：终态 Execution + active SessionBinding

**修复行为**

- `packages/task-store-v2/index.mjs:109-120` 在 `open()` 恢复时识别“Execution 已终态、Binding 仍 active”：
  - 不伪造 closed；
  - Binding 置 `unknown`；
  - `recoveryRequired=true`；
  - Execution 追加 `TERMINAL_SESSION_UNSETTLED` 诊断；
  - 保留原始终态、结果、`completionEvidence`。
- `packages/dsh-acp-v2/index.mjs:69` 对 `availability !== 'closed'` 的 Binding 拒绝下一轮，并提示 `reconcileTask`/`closeSession`。
- `reconcileTask` 在 `packages/dsh-acp-v2/index.mjs:144-154` 使用新 transport 执行 `session/resume`、`session/close`，然后 committed closed。
- `test/crash-v2.test.mjs:43-65` 用真实 Node 退出 + 模拟 ACP 覆盖 afterTerminalCommit，验证重开后 Binding 为 unknown、有诊断、`resumeTask` 后可以启动下一 Execution。

**判断：状态识别和不伪造 closed 的核心修复成立；N02 仍未完全闭环，P2。**

**确认的缺口：`reconcileTask()` 成功后没有清除 `recoveryRequired`。**

`packages/dsh-acp-v2/index.mjs:153` 的提交是：

```js
this.commit({bindings:[{...b,availability:'closed'}], ...});
```

`b` 从 Store 恢复时已经带有 `recoveryRequired:true`；展开 `...b` 后只覆盖 `availability`，所以该标志仍为 true。

更严重的是，`closeSession` 在 `packages/dsh-acp-v2/index.mjs:162-167` 只有当 `b.availability !== 'closed'` 时才尝试 resume/close 并提交；当 Binding 已经是 `closed` 时直接返回，**不会修复已经存在的 stale 标志**。因此一旦 `reconcileTask` 留下 `closed + recoveryRequired=true`，`reconcileTask` 再调用也不会清，`closeSession` 也不会清，只有之后某个新 Execution 完成、`run` 的 finally 在 `dsh-acp-v2:124` 重新提交 Binding 时才会变成 false。

独立探针使用 afterTerminalCommit fixture，然后执行 `resumeTask`、`closeSession`、`startExecution`，输出：

```json
before {"availability":"unknown","recoveryRequired":true,"diagnostics":["TERMINAL_SESSION_UNSETTLED"]}
after {"availability":"closed","recoveryRequired":true,"diagnostics":["TERMINAL_SESSION_UNSETTLED"]}
after-closeSession {"availability":"closed","recoveryRequired":true}
next {"execution":"completed","bindings":[{"availability":"closed","recoveryRequired":false}]}
```

**行为影响：**

- 不直接阻止 `startExecution`，因为 `startExecution:69` 只看 `availability`，所以不会产生 P0；
- 会造成 `availability=closed` 与 `recoveryRequired=true` 的自相矛盾状态；
- 任何 future 代码、health/UI 或 Phase 2 调用方如果把 `recoveryRequired` 当成“仍需清理”的门禁，会错误阻塞或错误展示；
- `closeSession` 不修复，意味着“恢复后清理临时状态”这一验收点没有完成。

**测试缺口：** `test/crash-v2.test.mjs:59-61` 只断言 `availability === 'closed'`，随后直接启动下一 Execution，没有断言 `recoveryRequired === false`；因此现有测试会在该缺陷存在时继续通过。

**其他边界：**

- 真实 DSH 的“终态已提交、session/close 未完成”窗口仍未用真实 DSH 复现，只使用真实 Node 退出 + 模拟 ACP；
- `reconcileTask` 没有清理 `recoveryRequired` 的通用路径，也没有测试 Binding 已经 closed 但标志仍 true 的修复。

### N06：cleanupFailed 后 closeTask 重试

**检查点与结果**

- `packages/dsh-acp-v2/index.mjs:155-160` 的 `retryCleanup(op)` 重新调用同一 `op.transport.stop()`；
- 失败时保留 `cleanupFailed=true` 和 `cleanupError`；
- 成功后才删除 operation；`sessionClosed` 为 true 时 Binding 置 closed，否则 unknown；
- `closeSession:162` 先重试 cleanupFailed operation；
- `closeTask:172` 先持久化 lifecycle closed，再调用 closeSession；失败保留 closed 并允许再次调用；
- `stop:183` 在释放 Store 前重试 cleanupFailed operation；
- `test/executor-v2-races.test.mjs:69-81` 第一次 stop 抛 `SHUTDOWN_TIMEOUT`，第一次 closeTask 返回 `CLEANUP_FAILED`，Binding 仍 unknown；清除故障后第二次 closeTask 成功，cleanupFailures 清空，Binding closed；
- `test/executor-v2-races.test.mjs:101-108` 验证整体 `stop()` 失败后保留 ownership，第二次成功。

**判断：在 Fake transport 与真实 Store 的范围内通过；没有发现之前 N06 的永久 CLEANUP_FAILED 行为。**

**残余边界：**

- 没有真实 Windows 不可杀进程的失败/成功序列；
- `closeTask` 测试没有直接断言 Store 锁文件在失败后仍存在、成功后释放；Store 锁行为主要由 Store 单元测试和整体 stop 测试间接覆盖；
- `retryCleanup` 在 `transport.stop()` 成功后、Binding commit 失败时会先把 `cleanupFailed` 置 false，然后因 commit 抛错而未删除 operation；这是低概率边界，未构造测试。正常 Store 路径不应出现，但严格来说仍是清理状态机的边角。

### N03：失败终态 stopReason

**检查点与结果**

- `packages/dsh-acp-v2/index.mjs:110-113`：
  - `end_turn` → completed；
  - `cancelled` → cancelled；
  - 其他 `stopReason` → failed；
  - failed 时 `completionEvidence=null`；
  - `terminalDiagnostics` 追加 `ACP_STOP_REASON`，保留 `stopReason`；
  - 不伪造 completed 证据。
- `test/executor-v2.test.mjs:34` 用 `max_tokens` 验证 `failed`、无 completionEvidence、诊断含 `ACP_STOP_REASON/max_tokens`。

**判断：失败终态的主要修复成立；仍有 P3 诊断缺口。**

独立探针让 Fake 先发出一个错误 session 的 notification（触发 quarantine），再返回 `max_tokens`，得到：

```json
{
  "status":"unknown",
  "diagnostics":[{"code":"UNASSOCIATED_NOTIFICATION", "...":"..."}],
  "resultIntegrity":"uncertain",
  "completionEvidence":null
}
```

因为 `op.bad` 为 true，status 变成 `unknown`，而 `ACP_STOP_REASON` 只在 `status==='failed'` 时加入。此时调用方仍不知道远端以 `max_tokens` 结束。它不是数据完整性问题，但属于“unknown 失败原因不可见”的诊断缺口。建议无论 status 是 failed 还是因 quarantine 变 unknown，都把已观察到的 stopReason 作为诊断保留，或明确将其排除在 N03 范围外。

### N04：defer 幂等哈希

**检查点与结果**

- `packages/dsh-acp-v2/index.mjs:46` 的 `inputHash` 包含 `defer: input.defer === true`；
- 同时保留不含 defer 的 `legacyHash`；
- 旧记录按旧语义重放，不发送新的 Prompt；
- 新记录同 key 改变 defer 会抛 `IDEMPOTENCY_CONFLICT`；
- `test/executor-v2.test.mjs:35` 覆盖同 defer 重放、defer 冲突；
- `test/executor-v2.test.mjs:36` 直接种子 legacy hash，确认旧记录可重放且 prompts=0；
- `test/executor-v2.test.mjs:29` 覆盖 defer 的初始 queued 状态和 `dispatchQueued`。

**判断：N04 通过。**

旧记录的 `legacyHash` 会接受任意 `defer` 值并返回原 Task，这是兼容策略，不会触发新执行；修复报告已说明旧记录无法推断原始 defer。独立检查没有发现相反行为。

### N05：Store 语义投影校验

**已修复的部分**

`packages/task-store-v2/index.mjs:180-194` 增加了：

- `Task.latestExecutionId` 必须指向最后创建的 Execution；
- `Task.result` 必须等于最新 Execution.result；
- `Task.sessionId` 必须等于最新 Binding.sessionId；
- `Task.lifecycle`、`Execution.submission`、`Binding.availability` 枚举；
- `duplicateExecutionRisk` 在 unresolved 或 integrityAlerts 存在时必须为 true；
- `activeExecutionId` 与状态投影一致性；
- `test/store-v2.test.mjs:56-65` 覆盖结果、指针、部分枚举反例。

**判断：核心结果/指针/会话投影修复成立；N05 仍未完全解决，P2。**

发现三个独立缺口：

1. **`Execution.resultIntegrity` 不在枚举校验内。**  
   `#validate:154-166` 只校验 `status`、`submission`、binding ownership，没有校验 `resultIntegrity`。探针提交 `resultIntegrity:'not-an-enum'` 被接受：

   ```json
   {"enumAccepted":true}
   ```

2. **`integrityAlerts` 条目只校验 `code` 和确认时间类型，不校验 `executionId`/`time` 引用。**  
   探针提交 `integrityAlerts:[{executionId:'missing-execution',code:'X'}]` 被接受，最终 Task 中保留了这个指向不存在 Execution 的警报：

   ```json
   {"alertAccepted":true,"final":[{"executionId":"missing-execution","code":"X"}]}
   ```

   `packages/contracts/v2.d.ts:141-147` 的 `IntegrityAlert` 明确要求 `executionId`；Store 当前没有校验它属于本 Task 的 Execution，也没有校验 `time`。

3. **可选投影字段可以省略，导致 unknown 门禁被绕过。**  
   `#validate:184` 只在 `task.unresolvedExecutionIds != null` 时检查；`projection` 仍从 Execution 算出 unknown。若 Task 有 unknown Execution，但省略 `unresolvedExecutionIds`，同时 `status:'unknown'`、`duplicateExecutionRisk:true`，快照会被接受。随后 `startExecution:62` 使用：

   ```js
   const unknown = t.unresolvedExecutionIds ?? [];
   ```

   于是不需要 `acknowledgeUnknownExecutionIds` 就可以启动新 Execution。独立探针：

   ```json
   {"started":true,"next":"85385d29-0037-4d43-9481-1933ea9ec506","status":"unknown","unresolved":["e1"]}
   ```

   这说明 Store 的语义校验没有完全做到“fail closed”。正常 Executor 的 `project()` 总会写 `unresolvedExecutionIds`，所以正常路径不触发；但 Store 是公共契约，迁移/外部调用/手工构造仍可能产生这种快照。建议将 `unresolvedExecutionIds`、`activeExecutionId`、`status` 在存在对应 Execution 时设为必填，并补一个“省略 unresolved 的 unknown 快照必须被拒绝”的反例测试。

**补充：** `Task.sessionId` 的投影校验代码存在，但现有测试没有单独构造 session mismatch 反例；本轮只做了代码核对。

### N07：完整性警报的人工确认

**检查点与结果**

- `packages/dsh-acp-v2/index.mjs:168-171` 新增 `acknowledgeIntegrityAlerts(taskId,{acknowledgedBy,note})`；
- 不删除原警报，保留 `executionId/code/time`，追加 `acknowledgedAt/acknowledgedBy/note`；
- 只确认未确认条目；
- 事件 `integrity.acknowledged`；
- `startExecution:63-65` 只对未确认警报抛 `INTEGRITY_ALERT`；
- 确认后仍将 `duplicateExecutionRisk` 保持 true；
- 新 Execution 不复用受影响 Session，使用新 Session；
- `test/executor-v2.test.mjs:37` 覆盖“迟到 notification → 拒绝 → 确认 → 新 Session 完成 → 原警报保留”。

**判断：N07 在当前“单 stdio、单本机调用方”范围内通过。**

**范围边界：**

- 任何能写 stdio 的本机客户端都可以调用确认，没有身份/权限模型；这与当前单客户端 Hub 范围一致，但 Phase 2 若接入多个 bot，必须先设计身份、授权和审计归属，不能把本机 `acknowledgedBy` 当成可信身份。
- 确认只保留 Task 事件和条目，不产生独立审计对象；这是当前最小实现的限制，不是本轮新增回归。

### N08：cancelExecution 返回结构

**检查点与结果**

- `packages/dsh-acp-v2/index.mjs:127` 的 `cancelResult` 返回 `{execution,cancelRequested,cancelConfirmed}`；
- `cancelConfirmed` 只在 `status==='cancelled'` 且 `completionEvidence.stopReason` 为 `cancelled`/`local_not_submitted` 时为 true；
- `cancelExecution:128-140` 保留 requestedAt/sentAt/confirmedAt；
- 自然完成/end_turn 赢得取消竞态时 `cancelConfirmed=false`；
- 超时/断连时返回未确认结果，不伪造 cancelled；
- `test/executor-v2.test.mjs:27`、`:38`、`:39` 覆盖竞态、超时、确认取消；
- `packages/contracts/v2.d.ts:149-154`、`docs/contracts.md:16`、`docs/deployment-windows.md:49` 已更新新返回结构。

**判断：N08 通过。**

这是有意的公共 API 破坏性变更；现有仓库调用方已适配，文档也明确 `cancelTask` 仍返回 Task，调用方必须检查活动 Execution。Phase 2 外部调用方需要按新结构实现。

### N09：真实 Runtime kill 证据修正

**检查点与结果**

- `scripts/integration-v2.mjs:13` 将 `waitRunning` 改为 `waitDispatchIntent`；
- `:22` 在本地持久化 `running/dispatch_intent` 后 kill `runtime.child`；
- `:23` 日志类型为 `runtime-kill-after-dispatch-intent`，并写 `note: "local dispatch intent, not proof the DSH prompt was executing"`；
- PASS 检查文案明确“remote execution not proven”；
- `docs/phase-1.1-acceptance.md:40,51` 已收窄表述；
- 本轮真实回归日志中该 Execution 没有 output/tool event，状态为 unknown，completionEvidence 为 null。

**判断：N09 的证据表述已修正，通过。**

仍需保留的限制：

- kill 由 `runtime.child.kill()` 发起，不是对整棵 Windows 进程树的 `taskkill /T` 验证；
- 本地 `dispatch_intent` 早于 `session/prompt` 调用，故该测试甚至不能证明 Prompt 已发送；
- 所有真实 prompt 都要求“不调用工具”，不能证明工具副作用或孙进程回收。

这些限制与本轮日志一致，不能再写成“真实执行中 kill”。

## 4. 其他独立发现

### 4.1 N02 的 stale `recoveryRequired` 是独立 P2

见第 3 节 N02。建议修复：

- `reconcileTask` 成功 commit 时显式 `recoveryRequired:false`；
- `closeSession` 对“availability 已 closed 但 recoveryRequired 仍 true”的 Binding 也做一次清理/归一化；
- 在 `test/crash-v2.test.mjs` 增加 `assert.equal(binding.recoveryRequired,false)`，并增加“再次 reconcile/close 也不残留”的断言。

这是进入 Phase 2 前最应该先修的状态一致性问题。

### 4.2 N05 的投影省略是独立 P2

见第 3 节 N05。它不是正常 Executor 路径的自动重发，但它证明 Store 的“语义快照”仍可 fail-open。建议：

- 对存在 Execution 的 Task，要求 `unresolvedExecutionIds`、`activeExecutionId`、`status` 必填；
- 校验 `Execution.resultIntegrity` 枚举；
- 校验 `IntegrityAlert.executionId` 属于本 Task，`time`/确认字段类型；
- 增加“省略 unresolved 的 unknown 快照必须 VALIDATION”的反例测试。

### 4.3 N03 的 unknown 诊断缺口

见第 3 节 N03。建议把 stopReason 作为 `unknown` 终态的补充诊断，而不是只在 `status==='failed'` 时写。该问题不改变执行安全，但影响人工排查。

### 4.4 N01 控制器的同步抛错路径

见第 3 节 N01。建议修复控制器，而不是只依赖当前 Hub 的 async cleanup；否则未来替换 executor/cleanup 实现时可能重新引入“stop 永久失败”。

### 4.5 公开仓库卫生

见第 1.4 节。建议把路径改为占位符、让脚本读取配置；日志在公开前脱敏；把 UTF-16LE 日志转成 UTF-8。此项不阻塞本地运行，但会降低公开验收证据的可审查性。

### 4.6 仍未验证的能力边界

以下不是本轮新发现的代码缺陷，但应继续保留在 Phase 2 设计输入中：

- 真实工具调用、工具副作用、孙进程硬杀回收；
- 数小时真实 DSH 浸泡、Store 全快照长期性能；
- Desktop UI 与 ACP Session 同步；
- 多客户端身份、授权、路由；
- 真实 Windows 不可杀进程下的 N01/N06 清理；
- 真实 DSH 终态崩溃窗口下的 N02 恢复；
- 任何跨进程 exactly-once 承诺（本阶段明确不承诺）。

## 5. 进入 Phase 2 前的条件

建议按以下顺序处理：

1. **必须（P2）**：修复 `reconcileTask`/`closeSession` 的 `recoveryRequired` 清理，并补回归测试。
2. **必须（P2）**：补齐 N05 的必填投影、`resultIntegrity` 枚举和 `integrityAlerts` 引用校验；至少要让“省略 unresolved 的 unknown 快照”失败关闭。
3. **应当（P2/P3）**：把 `stopReason` 保留到 quarantine 导致的 unknown 终态；补测试。
4. **应当（P3）**：修复 `createStopController` 的同步抛错路径；增加一次真实 Store 锁 + 失败 cleanup 的 Hub 级测试，或明确接受 fake executor 的证据边界。
5. **文档**：把 `docs/phase-1.1.1-1.1.2-fix-report.md:5`、`docs/phase-1.1-acceptance.md:85` 的“N01–N09 已修复”改为“主要修复，N02/N05 有残余”，避免下一轮审查重复发现同一问题。
6. **公开前**：脱敏 Windows 用户名/绝对路径；把 UTF-16LE `.txt` 日志转为 UTF-8，或只提交脱敏摘录。
7. **保留**：N09 的真实 kill 证据边界；真实 DSH 无工具调用、无长任务浸泡、无 Desktop UI 同步等限制继续写入 Phase 2 风险清单。

满足 1–2 后，可以认为 Phase 1.1 的“状态一致性 + Store fail-closed”基础达到进入 Phase 2 接口设计的门槛。3–6 可以在设计阶段并行处理；在它们关闭前，不应开始 bot 接入或宣称 Phase 1.1 无保留通过。

## 6. 最终判定

| 维度 | 结论 |
| --- | --- |
| 提交与工作区 | 目标提交正确，审查前工作区干净，审查仅新增证据日志 |
| 自动化测试 | 65 + 35 = 100 通过；重复 3×25 通过 |
| 真实 DSH | 8 组检查 PASS；证据边界正确收窄 |
| N01 | 当前 Hub 异步路径通过；同步 cleanup 抛错为 P3 |
| N02 | 识别/恢复主体成立；`recoveryRequired` 未闭环，P2 |
| N03 | failed 终态通过；quarantine→unknown 丢失 stopReason，P3 |
| N04 | 通过 |
| N05 | 主要投影校验通过；必填字段/枚举/警报引用仍有缺口，P2 |
| N06 | Fake transport + 真实 Store 范围通过；真实 OS 未验证 |
| N07 | 单客户端范围通过；Phase 2 需授权模型 |
| N08 | 通过；破坏性 API 已文档化 |
| N09 | 通过；只证明 dispatch intent 后中断 |
| 公开仓库 | 有本机路径/用户名和二进制日志，需发布前清理 |

**最终：CONDITIONAL PASS。**

核心架构仍可作为 Phase 1.1 的基础，但不能把本提交视为“N01–N09 全部无保留修复”。在 N02 的恢复标志和 N05 的 fail-closed 语义关闭前，不建议开始 Phase 2 实现或 bot 集成；可以先进行 Phase 2 接口设计，但设计文档必须把上述状态/校验缺口列为前置条件。

本次审查结束，等待用户审阅；不进入 Phase 2，不修改业务源码。
