# Phase 1.1.5 Independent Final Review

审查对象：`CaohaTanvirCh/chilia_fish_ability_extension`。

- 基线：`5842fe0a278c26d3a1941e2e3a952cc745a09c73`
- Phase 1.1.4 独立验收：`b234b26d7aedac71c1cddba17218443ad6fa997b`
- Phase 1.1.5 实现：`8a4d5c7f75950da5892ac1d74786a5cd4006f275`
- Phase 1.1.5 修复报告：`0c49e0424aa03fb6f32c89e78c78c9a073d771cf`
- 审查日期：2026-11-10（Asia/Hong_Kong）
- 环境：Windows 原生，未使用 WSL

审查性质：只读代码审查、独立反例、测试复验和提交范围核对；未修改生产代码、测试实现、Store schema、ACP transport 或配置，未接入任何 bot，未进入 Phase 2。

## 最终结论

**CONDITIONAL PASS。**

N05-E1 的 `dispatchQueued` 修复本身通过：`assertTaskProjection()` 完整检查八个字段和三个类型约束；`dispatchQueued()` 在 `launch()` 之前调用守卫；独立包装 Store 反例在两种入口、八个字段和三个类型反例上全部 fail-closed，`commit=0`、`transportFactory=0`、`operations.size=0`，Task/Execution 不变。

但按本轮交付约束，仍有一个**交付卫生问题**：

- `logs/phase1.1.5-before-probe.txt` 是新增日志，却包含 7 处本机绝对路径/账户名；
- `docs/phase-1.1.5-fix-report.md:163` 也包含本机仓库绝对路径；
- 任务明确要求“本轮只提交独立验收报告和必要的脱敏测试日志”。

这不影响运行逻辑，但使本轮不能无条件判为 PASS。若把验收范围限定为“代码/测试路径”，N05-E1 目标可以通过；若按本轮完整交付要求，必须先把这两个新增文件脱敏。

## 1. 代码审查

### 1.1 共享投影守卫

`packages/dsh-acp-v2/index.mjs:11-12` 新增模块内共享定义：

```js
const requiredTaskProjection = [
  'status',
  'latestExecutionId',
  'activeExecutionId',
  'unresolvedExecutionIds',
  'sessionId',
  'result',
  'duplicateExecutionRisk',
  'integrityAlerts'
];

function assertTaskProjection(t) {
  for (const key of requiredTaskProjection) {
    if (!Object.hasOwn(t, key)) {
      throw fault(
        'INVALID_TASK_PROJECTION',
        `Task is missing required projection field ${key}`
      );
    }
  }
  if (
    !Array.isArray(t.unresolvedExecutionIds) ||
    !Array.isArray(t.integrityAlerts) ||
    typeof t.duplicateExecutionRisk !== 'boolean'
  ) {
    throw fault('INVALID_TASK_PROJECTION', 'Task projection has invalid field types');
  }
}
```

实际代码是紧凑写法，语义完整：

- 八个字段全部在列表中；
- 缺失字段抛 `INVALID_TASK_PROJECTION`；
- `unresolvedExecutionIds` 和 `integrityAlerts` 必须为数组；
- `duplicateExecutionRisk` 必须为布尔值；
- 没有用默认值、空字符串或 `??` 补齐缺失字段；
- 该 helper 只在 Executor 内部使用，没有改变 Store schema。

### 1.2 `startExecution()` 复用

`packages/dsh-acp-v2/index.mjs:63` 使用 `assertTaskProjection(t)`，替换了原来的两段内联检查。

与 Phase 1.1.4 对比：

- 必填字段仍然是 8 个；
- 类型检查仍然是 unresolved/integrityAlerts 数组、duplicateExecutionRisk 布尔；
- 错误码和错误消息相同；
- 调用时点仍在 `newExecution()`、`project()`、Store commit、transport 之前；
- 未改变 requestKey 幂等、unknown acknowledgement、integrity alert、concurrency 等后续逻辑。

### 1.3 `dispatchQueued()` 顺序

`packages/dsh-acp-v2/index.mjs:76-85`：

```js
async dispatchQueued(executionId) {
  await this.start();
  const e = this.execution(executionId);
  return this.gate(e.taskId, () => {
    const t = this.task(e.taskId);
    assertTaskProjection(t);
    if (this.operations.size >= this.maxConcurrent) throw fault('BUSY', ...);
    if (e.status !== 'queued' || e.submission !== 'not_started') throw fault('NOT_QUEUED', ...);
    if (t.lifecycle !== 'open') throw fault('TASK_CLOSED', ...);
    if ([...this.operations.values()].some(o => o.taskId === e.taskId)) throw fault('BUSY', ...);
    this.launch(executionId);
    return e;
  });
}
```

实际顺序：

1. `await this.start()`；
2. 读取 queued Execution（为了知道 taskId）；
3. 进入 Task gate；
4. 读取 Task；
5. `assertTaskProjection(t)`；
6. 并发限制；
7. `queued/not_started` 检查；
8. lifecycle 检查；
9. Task busy 检查；
10. `launch(executionId)`。

因此投影守卫在任何 `launch()`、transport 创建和 Store commit 之前。Execution 读取早于 Task 读取，但 Task 守卫和 `launch()` 都在 gate 内，且从 `assertTaskProjection(t)` 到 `launch()` 没有 `await`，不存在异步插入窗口。

### 1.4 异步/异常/并发绕过检查

- 守卫是同步函数，抛错直接向 `gate` 和调用方传播，没有被 `catch` 吞掉。
- `dispatchQueued` 的 `assertTaskProjection(t)` 与 `launch()` 之间没有 `await`；JS 单线程下不能在中间插入另一个 Task 修改。
- `e` 在进入 gate 前读取，这是一个既有的提前快照；它不影响投影守卫（守卫使用 gate 内当前 Task），也不是本轮引入的守卫绕过。Execution 状态是否过期属于既有的 queued 状态竞态，本轮没有改变。
- 未发现 `dispatchQueued` 在 guard 前 commit 或创建 transport 的路径。
- 未发现异常处理吞掉 `INVALID_TASK_PROJECTION`。

### 1.5 幂等重放与 context transport 边界

代码与任务书边界一致：

- `startExecution()` 的 requestKey 重放仍在投影检查之前；匹配的已有请求直接返回原 Execution，不创建新 Execution、不 commit、不创建 transport。
- `resumeTask()`、`reconcileTask()`、`closeSession()` 等 context transport 没有接入该 helper；它们不创建新 Execution，仍作为本轮明确排除的范围。
- `dispatchQueued()` 没有改变 requestKey 语义；它只处理已有 queued Execution。

## 2. 独立反例

### 2.1 反例构造

使用包装 Store，不依赖真实 `ExecutionStore` 对非法快照的拒绝：

- Task：`queued`，`activeExecutionId: e1`，`latestExecutionId: e1`，`unresolvedExecutionIds: []`，`result: ''`，`sessionId: null`，`duplicateExecutionRisk: false`，`integrityAlerts: []`；
- Execution：`queued`，`submission: not_started`，`bindingId: null`；
- Binding：空；
- 仅删除目标字段或设置非法类型；
- 包装 Store `commit()` 计数后抛错；
- `transportFactory()` 计数后抛错。

### 2.2 结果

独立探测 2 个入口 × 11 个反例：

- 8 个入口各自缺少一个必填字段；
- 3 个入口分别为 `unresolvedExecutionIds: null`、`integrityAlerts: 'not-array'`、`duplicateExecutionRisk: 'yes'`。

合计 22 个反例，全部结果一致：

```text
error.code = INVALID_TASK_PROJECTION
commits = 0
transports = 0
operations.size = 0
tasks 未变化
executions 未变化
executions.length 未变化
```

其中包含任务书要求的：

- `result` 缺失；
- 其他七个字段完整；
- Task queued；
- Execution queued/not_started；
- activeExecutionId 指向 e1；
- Binding 为空；
- 公开 `dispatchQueued(executionId)` 调用；
- `dispatchQueued` 返回 `INVALID_TASK_PROJECTION`。

同时复验 Phase 1.1.4 的 `startExecution()` 缺失 `result` 反例，仍通过。

### 2.3 正常 dispatch 仍可工作

完整 `npm test` 中的既有 defer/dispatch 测试通过，说明守卫没有把所有 queued dispatch 都误拒绝；只有投影不完整时才会在 launch 前失败。

## 3. 测试审查与复验

### 3.1 新增测试

`test/n05-store.test.mjs:93-116` 新增：

```text
Executor dispatchQueued refuses a task projection missing result before commit or transport
```

测试：

- 从真实 Store 生成合法快照，关闭后使用包装 Store；
- 调整为 queued Task / queued not_started Execution / 空 Binding；
- 删除 `result`，断言 `Object.hasOwn(task, 'result') === false`；
- 包装 `commit` 计数后抛错；`transportFactory` 计数后抛错；
- 通过公开 `DshAcpExecutor.dispatchQueued('e1')` 触发；
- 断言错误码 `INVALID_TASK_PROJECTION`；
- 断言 `commit=0`、`transports=0`、`operations.size=0`；
- 断言 Task、Execution 深度相等，Execution 数量不变。

没有调用私有 validator；如果守卫缺失，流程会进入 `launch()` 并调用 `transportFactory()`，错误会是 `must not launch` 而不是 `INVALID_TASK_PROJECTION`，因此不会误判为通过。

### 3.2 测试覆盖不足

- 新增测试只覆盖 `result` 缺失；独立反例补了其余 7 个字段和 3 个类型。
- 新增测试没有覆盖 requestKey 重放和 context transport；这两项是任务书明确保留的边界，不应视为缺陷。
- 没有断言 `newExecution`/`project` 计数；`dispatchQueued` 本来不创建新 Execution，该断言不是必需。

### 3.3 复跑结果

本机独立运行：

| 命令 | 结果 | 退出码 |
| --- | --- | --- |
| `npm run test:unit` | 78 passed / 0 failed / 0 skipped | 0 |
| `npm run test:simulated` | 37 passed / 0 failed / 0 skipped | 0 |
| `npm test` | 115 passed / 0 failed / 0 skipped | 0 |
| `node --test test/n05-store.test.mjs` × 3 | 每次 13 passed / 0 failed；3 次全通过 | 0 |
| `dispatchQueued` 聚焦测试 | 1 passed / 0 failed | 0 |
| `startExecution` + `dispatchQueued` 聚焦测试 | 2 passed / 0 failed | 0 |

时间（Asia/Hong_Kong）：

- unit：15:44:35–15:44:37；
- simulated：15:44:37–15:44:41；
- full `npm test`：15:44:41–15:44:46；
- N05 3 次：15:44:48–15:44:51。

环境：

- Node.js `v24.18.0`
- npm `11.16.0`
- ACP SDK `1.4.0`
- 项目版本 `0.1.3`

提交中的 `phase1.1.5` 日志计数与独立复跑一致：

- unit 78；
- simulated 37；
- all 115；
- repeat 3 × 13 tests，39 checks，0 fail；
- before-probe 1 failed（预期失败）；after-probe 1 passed。

本轮没有运行 `npm run test:integration`；任务书不要求，且本轮改动不涉及 ACP transport。不能把上述 Fake/Simulated 结果称为真实 DSH 集成证据。

## 4. 提交与范围审查

### 4.1 实际范围

从 1.1.5 的直接父提交 `b234b26` 到实现 `8a4d5c7`：

- 1 个生产文件：`packages/dsh-acp-v2/index.mjs`；
- 1 个测试文件：`test/n05-store.test.mjs`；
- 6 个日志文件；
- 没有 Store schema、状态机、ACP transport、package scripts 或配置改动。

从实现 `8a4d5c7` 到报告 `0c49e04`：

- `README.md`；
- `DEVELOPMENT.md`；
- `docs/phase-1.1.5-fix-report.md`。

注意：`5842fe0..8a4d5c7` 的 `--stat` 还会显示 Phase 1.1.4 的 `docs/phase-1.1.4-final-review.md` 和 `docs/phase-1.1.4-fix-report.md`，它们属于中间提交 `b234b26`，不是 1.1.5 实现新增内容。实际 1.1.5 生产代码只有 helper 和 `dispatchQueued` 顺序变化。

### 4.2 分支与远端

审查开始时：

- 工作区干净；
- 本地 `master` HEAD 为 `0c49e04`；
- `origin/master` 也为 `0c49e04`；
- `git ls-remote origin refs/heads/master` 返回 `0c49e04`。

说明实现和报告提交已推送到 GitHub。独立验收报告将作为单独提交，不混入实现或修复报告提交；若该审查提交未推送，应在最终交付状态中明确。

### 4.3 文档与日志一致性

- 修复报告的 78/37/115、3×13 与仓库日志和独立复跑一致；
- before-probe 是预期的修复前失败，不是当前回归失败；
- after-probe 通过；
- 1.1.5 的 `.txt` 日志是 UTF-8、无 NUL；比此前 1.1.3 的 UTF-16 日志更适合公开审查；
- `git diff --check b234..8a4d` 仅报告 `logs/phase1.1.5-before-probe.txt` 中捕获 TAP 输出有两处尾随空格；这是日志格式，不是业务代码问题。

## 5. 新发现问题与严重程度

| 编号 | 严重程度 | 发现 |
| --- | --- | --- |
| PUB-1 | P2（交付卫生） | 新增 `logs/phase1.1.5-before-probe.txt` 含 7 处本机绝对路径/账户名；`docs/phase-1.1.5-fix-report.md:163` 也含本机仓库绝对路径，违反本轮“必要的脱敏测试日志”要求。不影响运行。 |
| LOG-1 | P3 | 同一 before-probe 日志有 TAP 输出尾随空格，`git diff --check` 失败；不影响功能。 |
| DOC-1 | P3 | 既有 README/DEVELOPMENT/部署文档/旧日志仍有本机路径；不是本轮新引入，但公开前仍应清理。 |
| EVID-1 | P3（证据边界） | 本轮没有真实 DSH 集成；真实 ACP 证据仍停留在既有 1.1.4 之前的范围，不能把本轮 Fake/Simulated 结果称为真实 DSH。 |
| CONC-1 | P3（既有） | `dispatchQueued` 的 `e` 在进入 gate 前读取；guard 本身没有绕过，且从 guard 到 launch 无 await。该过期快照问题与本次改动无关，未作为新回归。 |

没有发现新的 P0/P1/P2 代码缺陷。唯一 P2 是新增日志/报告的脱敏问题。

## 6. 真实 DSH 证据边界

- 本轮没有执行 `npm run test:integration`；
- `dispatchQueued` 反例使用包装 Store + Fake transport，不是真实 DSH；
- Store 单元、N05 反例、N05 迁移测试使用真实文件系统/Store，但不是 ACP；
- 既有真实 DSH 的结论仍是：`dispatch_intent` 后 kill 只证明本地持久化后中断，不证明远端执行或工具副作用；
- 本轮代码改动不涉及 ACP transport，因此没有新增真实 DSH 证据是符合范围的，但不能把模拟测试写成真实 DSH 结果。

## 7. 最终判定与 Phase 2 建议

| 维度 | 结论 |
| --- | --- |
| `assertTaskProjection` 八字段 | 通过 |
| 三个类型约束 | 通过 |
| `dispatchQueued` 守卫位置 | 通过；在 launch/commit/transport 前 |
| `startExecution` 复用 helper | 通过；语义未变 |
| 独立 8 字段 + 类型反例 | 22 个全部 `INVALID_TASK_PROJECTION`，0 commit、0 transport、0 operation |
| 新增测试 | 通过；公开入口，非私有 validator |
| 测试复跑 | 78/37/115 全部通过；3×13 通过 |
| 范围 | 生产代码仅 helper + dispatch 顺序；无 Store/transport/schema 改动 |
| 分支/远端 | 审查开始时本地与远端均为 `0c49e04` |
| 交付卫生 | before-probe 日志和修复报告含本机绝对路径，P2 |
| 真实 DSH | 未运行；不宣称 |

**最终：CONDITIONAL PASS。**

- **代码/测试层面：PASS。** `dispatchQueued` 的投影守卫已完整覆盖八个字段和类型约束，且在 launch/commit/transport 之前执行；`startExecution` 复用 helper 后语义不变；所有独立反例和测试通过。
- **交付层面：CONDITIONAL PASS。** 新增 `logs/phase1.1.5-before-probe.txt` 和 `docs/phase-1.1.5-fix-report.md:163` 含本机绝对路径，未满足“必要的脱敏测试日志”要求。只需脱敏这两个新增文件，不需要修改生产代码；脱敏后可重新评估为 PASS。

Phase 2 建议：N05-E1 的代码修复已经达到进入下一阶段设计讨论的条件；但在进入 Phase 2 实现前，应先完成本轮日志/报告脱敏，并继续保留真实 DSH、工具副作用、N01/N03 等既有未验证边界。

本轮不进入 Phase 2，不修改生产代码、测试实现、Store schema、ACP transport 或配置。
