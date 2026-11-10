# Phase 1.1.3 Independent Final Review

审查对象：`CaohaTanvirCh/chilia_fish_ability_extension`，实现提交 `31139e874afa73fc3de3d82427e403b84cb0d031`（`fix: phase 1.1.3 n02 recovery flag and n05 fail-closed store`）。

报告提交：`22018174cc7592d54b1724e7f921b3387d6592bf`（`docs: record phase 1.1.3 implementation sha`）。

基线：`a869496a28919448836544ffc9bacf5f19a12889`（`docs: phase 1.1 final review`）。

审查日期：2026-11-10（Asia/Hong_Kong）。审查性质：只读审查、独立复跑、故障探针和日志核对；未修改业务源码、Contracts、测试实现、`config` 或 `package scripts`，未接入 Cyrene、AstrBot、QQ/NapCat、Bilibili，未进入 Phase 2，未承诺 exactly-once，未自动重发 unknown Execution。

## 最终结论

**CONDITIONAL PASS。**

N02 上一轮指出的 `closed + recoveryRequired:true` 矛盾状态已闭环；Store 的 N05 fail-closed 投影校验也已基本完成。独立复跑的 76 个 unit、37 个 simulated、113 个合并测试全部通过；N02/N05 的 20 项关键反例重复 3 次全部通过；真实 Windows DSH 回归 8 组检查通过。

但仍有需要在 Phase 2 实现前处理的问题：

1. **N05 的 Executor 防御仍漏掉 `result`，P2。** `startExecution` 的必填投影列表包含 7 个字段，却没有 `result`。我用只读包装 Store 构造“Task 缺 result、其他字段完整”的快照，`startExecution` 没有抛 `INVALID_TASK_PROJECTION`，而是创建并完成了一个新 Execution。当前真实 `ExecutionStore` 会在 open/commit 拒绝该快照，所以这不是已落盘 Store 的常规 fail-open，但确实是 Executor 防御列表的检查遗漏。
2. **N02 的 `reconcileTask` 默认调用是本地 no-op，P3 API 语义问题。** `resumeTask` 和 `closeSession` 对 unknown Binding 会执行可信远端 resume/close；直接调用 `reconcileTask(taskId)`（`restoreContext` 默认 false）只返回 Task，不访问远端，也不清除 unknown。若调用方把返回值理解为“已恢复”，会误判。安全上未放宽，但接口语义应明确。
3. **N01 同步 cleanup 抛错仍不能重试，P3。** 上一轮发现的问题未变化；当前 Hub 的 async cleanup 路径不受影响，但 `createStopController` 的单元契约仍不完整。
4. **N03 quarantine 导致 unknown 时仍不保留 `stopReason`，P3。** failed 终态已修复；quarantine 使 status 变 unknown 时，诊断只有 `UNASSOCIATED_NOTIFICATION`，没有 `ACP_STOP_REASON`。
5. **公开仓库卫生问题仍存在。** 现有 README/开发日志/部署文档/脚本和旧日志包含本机账户名、绝对路径；测试日志是 UTF-16LE，Git 视为二进制。本轮新增的真实回归日志已转为 UTF-8 并脱敏。

因此：**N02 可以在本轮测试覆盖范围内接受；N05 的 Store 层可以接受；但当前版本还不能无条件判定 PASS，也不应在修复 N05-E1 前开始 Phase 2 实现或 bot 接入。Phase 2 接口设计可以开始，但必须把上述 P2/P3 列入设计输入。**

## 1. 提交、工作区与变更身份

### 1.1 身份核对

| 项目 | 结果 |
| --- | --- |
| 当前 `HEAD` | `22018174cc7592d54b1724e7f921b3387d6592bf` |
| 实现提交 | `31139e874afa73fc3de3d82427e403b84cb0d031` |
| 报告提交 | `22018174cc7592d54b1724e7f921b3387d6592bf` |
| 实现提交父提交 | `a869496a28919448836544ffc9bacf5f19a12889` |
| `origin/master` | 与当前 `HEAD` 一致，均为 `2201817` |
| 审查开始时工作区 | 干净，无已跟踪修改 |
| 报告提交实际内容 | 只把 `docs/phase-1.1.3-fix-report.md` 的待回填 SHA 改为实现 SHA |
| 当前工作区新增 | 仅本轮独立真实回归的脱敏日志；报告本身也是新增未提交文件 |

实现提交与基线的差异：

- 21 个文件变更；
- 530 行新增、29 行删除；
- 修改 `packages/dsh-acp-v2/index.mjs`、`packages/task-store-v2/index.mjs`；
- 修改 `test/crash-v2.test.mjs`、`test/recovery-v2.test.mjs`、`test/store-v2.test.mjs`；
- 新增 `test/n05-store.test.mjs`；
- 修改 package/测试脚本、README、开发日志、验收文档；
- 新增修复报告、测试日志和真实 JSONL。

报告提交 `2201817` 只使用 1 行文档修改；没有在“报告回填”提交中混入代码、测试或配置改动。

### 1.2 审查边界

- 只使用当前 checkout 的代码和独立探针；
- 没有把开发修复报告中的“已修复”当作证据；
- 没有修改任何源码、Contracts、测试实现、配置或 package scripts；
- 没有启动 WSL；
- 没有接入任何 bot；
- 没有进入 Phase 2；
- 没有承诺 exactly-once；
- 没有自动重发 unknown Execution。

## 2. N02 独立复验

### 2.1 结论摘要

| 检查点 | 独立结论 |
| --- | --- |
| `reconcileTask` 成功后 `closed + recoveryRequired:false` | 通过；`crash-v2` 与独立探针均确认 |
| `closeSession` 归一化 `closed + recoveryRequired:true` | 通过；不创建远端 transport；`crash-v2` 测试覆盖 |
| `unknown + recoveryRequired:true` 是否要求可信远端 resume/close | `resumeTask` / `closeSession` 通过；裸 `reconcileTask` 不访问远端，P3 语义问题 |
| 本地归一化 commit 失败 | 通过；拒绝、保留 `closed + true`、storageFault、重启后可重试 |
| 远端 resume 成功、close 失败 | 通过；拒绝、保持 unknown/recoveryRequired=true、诊断保留 |
| 远端 close 成功、transport stop 失败 | 状态正确保持 unknown/recoveryRequired=true；第一次 `stop` 失败并保留 Store 锁，transport 停止恢复后第二次 `stop` 释放锁 |
| 远端 close 成功、本地 commit 失败后重启 | 失败被正确拒绝；重启后由新 Executor 重试；官方 DSH 的 close 后 resume 由真实集成继续流程证实 |
| 历史 `TERMINAL_SESSION_UNSETTLED` 是否保留 | 通过；恢复后诊断仍在 |
| 新 Executor 从持久化 unknown 状态恢复 | 通过；官方可 resume 场景下可恢复；真实 DSH 终态崩溃窗口仍未单独复现 |

### 2.2 实现核对

`packages/dsh-acp-v2/index.mjs`：

- `reconcileTask:149-153`：`restoreContext` 为 false 时只做本地归一化；
- `reconcileTask:154-156`：unknown unresolved 必须显式处理；已 closed 的 Binding 只归一化本地标志，不再远端 resume；
- `reconcileTask:158-161`：unknown Binding 使用新 transport 做 `session/resume`、`session/close`，成功后显式提交 `availability:'closed', recoveryRequired:false`；
- `closeSession:170-180`：closed Binding 同样本地归一化；unknown 仍走可信远端路径；
- `run:126`：正常终态清理失败时保留 `unknown/recoveryRequired:true`；
- `retryCleanup:163-168`：cleanupFailed 重试成功后按 `sessionClosed` 决定 closed/unknown。

`packages/task-store-v2/index.mjs:109-120` 仍在 open 时识别“终态 Execution + active Binding”，不伪造 closed。

### 2.3 探针证据

#### A. 本地归一化 commit 失败

构造 `closed + recoveryRequired:true` 的合法完成快照，包装 Store 在写入 `recoveryRequired:false` 时抛 EIO：

```json
{"name":"A-local-normalization-commit-failure","err":{"code":"EIO","message":"injected local normalization commit failure"},"health":{"healthy":false,"store":{"healthy":true,"revision":1},"storageFault":"injected local normalization commit failure","activeExecutions":0,"cleanupFailures":[]},"binding":{"availability":"closed","recoveryRequired":true}}
{"name":"A-restart-normalized","binding":{"availability":"closed","recoveryRequired":false}}
```

结论：失败不会被报告为成功；Binding 保持 closed/true；health 降级；新 Executor 可重试并归一化。通过。

#### B. 远端 resume 成功、close 失败

```json
{"name":"B-close-failure","err":{"message":"remote close failed"},"starts":1,"stops":1,"binding":{"availability":"unknown","recoveryRequired":true},"diagnostics":["TERMINAL_SESSION_UNSETTLED"]}
```

结论：`resumeTask` 拒绝；Binding 不被标 closed；历史诊断保留；transport 被停止。通过。

#### C. 远端 close 成功、transport stop 失败

```json
{"name":"C-stop-failure","err":{"code":"EIO","message":"transport stop failed"},"starts":1,"stops":3,"binding":{"availability":"unknown","recoveryRequired":true},"stopErr":{"code":"EIO","message":"transport stop failed"},"lockExists":true}
```

第一次 `x.stop()` 失败并保留 `store-v2.lock`，这是“失败保留所有权”的安全行为；把 transport 改成可停止后第二次 `x.stop()`：

```json
{"lockAfterFirst":true,"second":null,"lockAfterSecond":false,"stops":5}
```

结论：状态没有被误报为 closed；资源所有权保留；瞬时失败重试后释放 Store 锁。通过，但**提交的 N02 测试没有覆盖 `stop` 失败路径**，这是测试覆盖缺口（不是本轮新增代码回归）。

#### D. 远端 close 成功、本地 commit 失败后重启

独立探针第一次得到：

```json
{"first":{"code":"EIO","message":"injected commit after remote close"},"failedBinding":{"availability":"unknown","recoveryRequired":true}}
```

官方 DSH 的 `session/close` 保留可 resume 记录：真实集成中首轮 close 后，续接流程用 `session/resume` 成功恢复同一 Session。因此，使用可 resume 的测试 transport 时，新 Executor 重试是符合官方语义的。若人为模拟“close 后不可 resume”的运行时，`reconcileTask`/`closeSession` 都会得到 `SESSION_CLOSED` 并保持 unknown；这是**运行时语义假设**，不是当前官方 DSH 已证明的行为。

**结论：** 本地 commit 失败时不报告成功、保持 unknown/recoveryRequired=true；官方可 resume 场景下新 Executor 可以重试。真实 DSH 的“终态已提交、Binding 未关闭”崩溃窗口仍未单独复现，属于证据边界。

#### E. 裸 `reconcileTask` 的语义

对 `afterTerminalCommit` 的 unknown Binding（recoveryRequired=true）直接调用：

```json
{"afterDefault":{"starts":0,"availability":"unknown","recoveryRequired":true},"afterResume":{"starts":1,"availability":"closed","recoveryRequired":false}}
```

- `resumeTask`/`closeSession` 会访问远端；
- `reconcileTask(taskId)` 默认 `restoreContext:false`，不访问远端，只返回当前 Task；
- 这符合“仅本地归一化”的内部实现，但公共方法名容易被理解为已恢复。建议文档明确，或在 unknown + recoveryRequired=true 且未请求 restore 时返回明确状态，而不是静默成功。

### 2.4 N02 测试质量

- `test/crash-v2.test.mjs:43-73` 覆盖 afterTerminalCommit、closed/false、诊断保留、再次 reconcile/close、下一 Execution；
- `:75-105` 覆盖 closed + stale 本地归一化且不新增 transport；
- `:107-142` 覆盖远端 close 后本地 commit EIO、health 降级、新 Executor 重试；
- 这些使用真实 Node 子进程退出的 crash fixture，但 ACP 是模拟 transport；
- 真实 DSH 终态崩溃窗口未验证；
- `stop` 失败路径没有提交测试，独立探针补充了“第一次失败、第二次释放锁”。

## 3. N05 独立复验

### 3.1 Store 层结论

独立用直接 JSON 快照和真实 Store 构造反例，结果如下：

```json
{
  "valid-unknown":"ok",
  "missing-status":"VALIDATION",
  "missing-latest":"VALIDATION",
  "missing-active":"VALIDATION",
  "missing-unresolved":"VALIDATION",
  "missing-session":"VALIDATION",
  "missing-result":"VALIDATION",
  "missing-risk":"VALIDATION",
  "missing-alerts":"VALIDATION",
  "empty-unresolved":"VALIDATION",
  "ghost-unresolved":"VALIDATION",
  "duplicate-unresolved":"VALIDATION",
  "cross-unresolved":"VALIDATION",
  "invalid-resultIntegrity":"VALIDATION",
  "alert-missing-execution":"VALIDATION",
  "alert-cross-task":"VALIDATION",
  "alert-invalid-time":"ok",
  "latest-cross":"VALIDATION",
  "active-cross":"VALIDATION",
  "commit-missing-unresolved":"VALIDATION"
}
```

结论：

- 含 Execution 的 Task 缺少任一必填投影字段均拒绝；
- `unresolvedExecutionIds` 缺失、空数组、幽灵 ID、跨 Task ID、重复 ID 均拒绝；
- 正确的 unknown unresolved 可加载，但 `startExecution` 仍要求显式 acknowledge；
- 显式 acknowledge 后旧 unknown Execution 保留，`duplicateExecutionRisk` 保持 true（由 `n05-store` 测试与重复运行确认）；
- closed Binding 不能掩盖 unresolved unknown；
- 非法 `resultIntegrity` 拒绝；
- `integrityAlerts` 缺失/跨 Task/幽灵 Execution 拒绝；
- active/latest 指针缺失、错误、跨 Task 拒绝；
- Store `open` 与 `commit` 使用同一严格校验；
- v1→v2 迁移快照仍可加载。

### 3.2 一个残余小问题：alert 的 `time`

`integrityAlerts:[{executionId:'e1',code:'X',time:'not-a-time'}]` 被接受。Store 校验了 `acknowledgedAt`、`acknowledgedBy`、`note`，但没有校验可选的 `time`。这不是本轮任务明确要求的 fail-open 项，且 `time` 在 Contracts 中是可选字段；若它用于审计排序，应校验为可解析时间。严重程度 P3。

### 3.3 Executor 必填投影：`result` 仍是检查遗漏

这是本轮最重要的新发现。

`packages/dsh-acp-v2/index.mjs:61` 的必填字段列表是：

```js
['status','latestExecutionId','activeExecutionId','unresolvedExecutionIds','sessionId','duplicateExecutionRisk','integrityAlerts']
```

没有 `result`。我用包装 Store 对 `snapshot()` 删除 Task 的 `result`，其他字段完整；`startExecution` 没有抛 `INVALID_TASK_PROJECTION`，而是创建并完成了一个新 Execution：

```json
{"started":true,"executionId":"520036ab-ad03-471a-993d-2397d97db6cc","status":"completed","commits":5}
```

判断：**这是检查遗漏，不是有意设计。** 理由：

- Store 在 `packages/task-store-v2/index.mjs:191` 已把 `result` 列入含 Execution 的 Task 必填字段；
- `Task.result` 是公共投影的一部分，缺失后 Executor 会通过 `project()` 合成新值，可能掩盖不完整状态；
- 其他 7 个必填字段都有对应检查，只有 `result` 被遗漏，行为不一致；
- 正常 `ExecutionStore` 会拒绝该快照，因此这不是当前已落盘 Store 的常规 fail-open，但 Executor 的防御层不应依赖调用方一定使用真实 Store。

建议：把 `result` 加入 `startExecution` 必填字段列表，并补一个“Task 缺 result 时抛 `INVALID_TASK_PROJECTION`、不 commit、不启动 transport”的测试。

### 3.4 N05 测试质量

`test/n05-store.test.mjs` 覆盖：

- unknown + 缺失/空 unresolved；
- correct unresolved 仍要求 acknowledge；
- 显式 acknowledge 后 unknown/risk 保留；
- closed Binding 不掩盖 unknown；
- 非法 resultIntegrity；
- alert 缺失/跨 Task；
- active/latest 缺失、错误、跨 Task；
- unresolved 幽灵/跨 Task/重复；
- completed/failed/cancelled 正常快照；
- v1→v2 迁移；
- Store commit 缺失 unresolved；
- Executor 缺失 unresolved。

不足：

- 没有“Task 缺 result、其他字段齐全”的 Executor 测试；
- 没有 alert `time` 校验反例；
- `Task.sessionId` 的单独 mismatch 反例未直接构造，但代码检查已存在；
- 测试 `Executor refuses...` 使用 fake Store 只缺 unresolved，证明不了 `result` 的防御。

## 4. 完整回归结果

### 4.1 环境

| 项目 | 值 |
| --- | --- |
| 平台 | Windows 原生，非 WSL |
| Node | `v24.18.0` |
| ACP SDK | `@agentclientprotocol/sdk@1.4.0` |
| DSH CLI | `0.2.2-rc.1`（独立执行 `--version` 确认） |
| 项目版本 | `0.1.3` |
| 真实模型 | 已配置；所有真实 prompt 均要求不调用工具 |

### 4.2 本地测试

按 Asia/Hong_Kong 记录本次顺序执行：

| 命令 | 开始 | 结束 | 结果 |
| --- | --- | --- | --- |
| `npm run test:unit` | 2026-11-10 14:47:06 | 2026-11-10 14:47:07 | 76 passed / 0 failed / 0 skipped |
| `npm run test:simulated` | 2026-11-10 14:47:07 | 2026-11-10 14:47:11 | 37 passed / 0 failed / 0 skipped |
| `npm test` | 2026-11-10 14:47:11 | 2026-11-10 14:47:16 | 113 passed / 0 failed / 0 skipped |
| N02/N05 关键反例 3 次 | 2026-11-10 14:49:19 | 2026-11-10 14:49:22 | 每次 20 passed / 0 failed；3 次全部通过 |

本次没有失败测试，因此没有失败测试完整输出可记录。

### 4.3 真实 DSH

| 项目 | 结果 |
| --- | --- |
| 命令 | `npm run test:integration` |
| 开始/结束 | 2026-11-10 14:47:19 / 14:47:32 |
| 结果 | PASS |
| 检查项 | 8 组 |
| 证据 | `logs/phase1.1.3-review-real-sanitized.jsonl` |
| 日志格式 | UTF-8，无 BOM，50 行 |
| 路径脱敏 | 已将 `<repo>` / `<user-home>` 替换，未保留本机绝对路径 |

8 组检查：

1. create；
2. atomic receipt；
3. list；
4. new-process restore same Session/context；
5. parallel Sessions；
6. cancel actual terminal；
7. real Runtime killed after durable dispatch intent（remote execution not proven）；
8. restart unknown not resent。

本轮真实回归日志中的 kill Execution：

- `status=unknown`；
- `completionEvidence=null`；
- `resultIntegrity=uncertain`；
- 没有工具事件或输出；
- 日志明确写有“local dispatch intent, not proof the DSH prompt was executing”。

因此仍不能把它描述为“真实执行中 kill”，也不能证明工具副作用。

### 4.4 提交内日志一致性

| 日志 | 核对 |
| --- | --- |
| `logs/phase1.1.3-unit.txt` | 76 tests / 76 pass / 0 fail / 0 skip |
| `logs/phase1.1.3-simulated.txt` | 37 tests / 37 pass / 0 fail / 0 skip |
| `logs/phase1.1.3-all.txt` | 113 tests / 113 pass / 0 fail / 0 skip |
| `logs/phase1.1.3-repeat.txt` | 3 个 run；每 run 20 tests；共 60 个 check；0 fail |
| `logs/phase1.1.3-real-console.txt` | 1 个 PASS，0 个 FAIL；8 组检查 |

这些计数与开发报告一致，且与本轮独立复跑一致。没有发现空日志。

## 5. 模拟 ACP 与真实 DSH 的证据边界

- **真实 DSH**：只有一条集成流程，8 组检查；包含真实 Session/resume、并行、取消、dispatch intent 后 kill；没有工具调用，没有真实终态崩溃窗口。
- **真实 Node 子进程**：`crash-v2` 使用真实 Node 退出，但 ACP 是模拟 transport；不是 DSH 崩溃。
- **模拟 ACP/Fake transport**：N02 的 close 失败、commit 失败、stop 失败、Store 校验反例、Executor 投影探针均不启动 DSH。
- **Store 单元/迁移**：真实文件系统和锁，但不是 DSH。
- **v1→v2 迁移**：合法旧数据可加载；旧 v2 缺少必填投影会被拒绝，没有自动迁移。

不能把 N02 的模拟恢复、N05 的 Store 反例或 N01 的 fake executor 结果描述为“真实 DSH 崩溃验证”。

## 6. N01 与 N03 遗留复核

### N01：同步 cleanup 抛错

`apps/companion-hub/lifecycle.mjs` 的 `createStopController` 仍只覆盖 `await cleanup()` 的异步拒绝。同步抛错的独立探针：

```json
{"calls":1,"same":true,"firstCode":"EIO","secondCode":"EIO"}
```

结论：同步 cleanup 抛错后，rejected Promise 被缓存，同一控制器不能重试。当前 Hub 的 cleanup 是 async，`DshAcpExecutor.stop()` 也返回 Promise，因此不是当前 Hub 的生产路径；但控制器作为公共单元仍不完整。严重程度 P3，建议把 cleanup 调用包装成 `Promise.resolve().then(...)` 或在赋值后统一清空。

### N03：quarantine 导致 unknown 的 stopReason

独立探针让 Fake 先发错 Session 的 notification（quarantine），再返回 `max_tokens`：

```json
{"status":"unknown","diagnostics":[{"code":"UNASSOCIATED_NOTIFICATION","...":"..."}],"codes":["UNASSOCIATED_NOTIFICATION"]}
```

结论：failed 终态的 `ACP_STOP_REASON` 修复有效；但 quarantine 使 status 变 unknown 时仍丢失 stopReason。安全语义正确（unknown、无 completionEvidence），只是诊断不完整。严重程度 P3。

## 7. 新发现与严重程度

| 编号 | 严重程度 | 发现 |
| --- | --- | --- |
| N05-E1 | P2（防御层） | `startExecution` 必填投影列表缺 `result`；缺 result 的快照可绕过 Executor 检查并启动新 Execution。正常 Store 会拒绝该快照，但防御层不应依赖真实 Store。 |
| N02-A1 | P3（API 语义） | 裸 `reconcileTask(taskId)` 对 unknown Binding 不访问远端、不清除 recoveryRequired，却返回 Task；调用方可能误以为已恢复。 |
| N05-A1 | P3 | `integrityAlerts[].time` 为非法时间时仍被接受；`acknowledgedAt` 已校验，但可选 alert time 未校验。 |
| N01-S1 | P3 | stop controller 对同步 cleanup 抛错仍缓存 rejected Promise，无法重试。 |
| N03-Q1 | P3 | quarantine 导致 unknown 时没有保留 stopReason 诊断。 |
| N02-E1 | P3（证据） | 真实 DSH 终态崩溃窗口未复现；N02 使用真实 Node 退出 + 模拟 ACP。 |
| N02-T1 | P3（测试） | N02/N06 的 transport stop 失败、Store 锁保留/重试释放没有进入提交测试；本轮独立探针确认可重试释放。 |
| PUB-1 | P2/P3（发布卫生） | 公开树仍含本机账户名、绝对路径；`.txt` 日志为 UTF-16LE，Git 视为二进制。 |

没有发现 P0 级数据损坏，也没有发现正常路径下 unknown Execution 被自动重发，或没有收据伪造 completed 的情况。

## 8. 发布卫生

### 8.1 本机路径/用户名

静态扫描当前跟踪文件，匹配本机账户名/绝对路径的行有约 99 处，主要集中在：

- `README.md:6`：本机仓库路径；
- `DEVELOPMENT.md:7,18`：桌面文件、DSH CLI 绝对路径；
- `docs/deployment-windows.md:10,35`：示例命令/JSON 中的本机路径；
- `scripts/probe-acp.mjs:4`：硬编码 DSH 安装目录；
- `logs/*.jsonl` 与 UTF-16 控制台日志：JSON 转义后的 `C:\\Users\\<user>\\...`；
- 上一轮报告和本报告之外的文档也可能包含路径。

建议公开前统一替换为 `C:\Users\<user>`、`<repo>` 或从配置读取；不要把真实账户名写入示例。

### 8.2 编码

- 提交中的 `logs/phase1.1.3-*.txt` 和 `logs/phase1.1.3-real-console.txt` 都是 UTF-16LE（BOM `FF FE`，含 NUL），Git `diff` 视为 binary；
- `logs/*.jsonl` 是 UTF-8 文本；
- 本轮新增 `logs/phase1.1.3-review-real-sanitized.jsonl` 是 UTF-8、无 BOM、无 NUL，且不含本机绝对路径；
- 独立真实回归的原始含路径日志已删除，避免误提交。

建议把公开的 `.txt` 测试日志转成 UTF-8，或只提交脱敏摘要。

### 8.3 凭据

未发现真实 API key、DSH 凭据、密码或 `.env` 内容。`test/task-store.test.mjs` 中的 `sk-store-test-` 是测试值。`config/windows.json` 仍被 `.gitignore` 忽略，未进入仓库。

## 9. 最终判定与 Phase 2 建议

| 维度 | 结论 |
| --- | --- |
| 提交/工作区 | 实现、报告、远端身份一致；审查开始干净；仅新增脱敏证据日志和报告 |
| N02 状态闭环 | 通过；closed/false、诊断保留、失败拒绝、重试路径成立 |
| N02 真实 DSH 崩溃 | 未验证；模拟 ACP |
| N05 Store fail-closed | 通过；必填字段、unresolved 集合、指针、枚举、alert 引用均严格 |
| N05 Executor 防御 | 仍缺 `result`；P2 |
| 测试 | 76/37/113 全部通过；3×20 反例通过 |
| 真实 DSH | 8 组 PASS；证据边界正确 |
| N01/N03 | 既往 P3 仍在；不影响本轮 Store/N02 结论 |
| 发布卫生 | 存在路径/用户名和二进制日志问题 |

**最终：CONDITIONAL PASS。**

- N02 的上一轮 P2 已关闭到可接受程度；在官方 DSH 可 resume 的语义下，`closed + recoveryRequired=false`、诊断保留、失败拒绝和重启重试均成立。真实 DSH 终态崩溃窗口仍是模拟证据。
- N05 的 Store 层已 fail-closed，不能为了通过测试放宽；但 Executor 的 `result` 检查遗漏是明确的 P2 防御缺口，建议在 Phase 2 实现前修复。
- N01/N03 和 alert `time` 是 P3；可在 Phase 2 设计阶段并行处理。
- 公开仓库路径/用户名和 UTF-16 日志应在公开或提交前清理。

**Phase 2 建议：** 可以开始接口设计讨论；不建议在 N05-E1 修复前开始 Phase 2 实现或接入 bot。N02 的真实 DSH 崩溃窗口、N01/N06 的真实 OS 级清理、真实工具/孙进程、长时间浸泡、Desktop UI 同步和多客户端授权仍应保留为 Phase 2 风险项。

本轮审查结束；未进入 Phase 2，未修改业务源码、Contracts、测试或配置。
