# Phase 1.1.5 修复报告：dispatchQueued 投影守卫补全

日期：2026-11-10（Asia/Hong_Kong）。版本：0.1.3（本轮未变更版本号）。基线：`5842fe0a278c26d3a1941e2e3a952cc745a09c73`；独立验收报告提交：`b234b26d7aedac71c1cddba17218443ad6fa997b`。实现提交：`8a4d5c7f75950da5892ac1d74786a5cd4006f275`。范围：Windows 原生 DSH ACP Companion；未接入 Cyrene、AstrBot、QQ/NapCat、Bilibili，未进入 Phase 2。

结论：`dispatchQueued()` 现在与 `startExecution()` 共用同一 Task 投影防御检查；缺失 `result`（或其他必填投影字段）时，在 `launch()` 之前抛 `INVALID_TASK_PROJECTION`，不创建 transport、不 commit、不创建新 Execution，原 Task/Execution 不变。当前仍为 **CONDITIONAL PASS**，等待独立测试会话复验。

---

## 1. 修复前绕过路径

`packages/dsh-acp-v2/index.mjs` 的 `dispatchQueued()` 直接从 queued Execution 调用 `launch()`，没有经过 `startExecution()` 的 Task 投影检查。它只检查了并发上限、Execution 是否 `queued/not_started`、Task 是否 open、Task 是否 busy。

新增回归测试先构造合法 queued 快照：

- Task：`status: queued`、`activeExecutionId: e1`、`unresolvedExecutionIds: []`、`result: ''`、`duplicateExecutionRisk: false`、`integrityAlerts: []`；
- Execution：`status: queued`、`submission: not_started`、`bindingId: null`；
- Binding 为空；
- 仅删除 Task 的 `result`，其余 7 个必填字段完整。

包装 Store 的 `commit()` 计数后抛错，`transportFactory()` 计数后抛错。修复前聚焦测试实际失败（退出码 1）：

```text
expected:
  code: 'INVALID_TASK_PROJECTION'
actual:
  error: 'must not launch'
```

调用栈：

```text
DshAcpExecutor.transportFactory (test/n05-store.test.mjs:104)
DshAcpExecutor.launch (packages/dsh-acp-v2/index.mjs:77)
dispatchQueued 的 launch 调用 (packages/dsh-acp-v2/index.mjs:75)
```

这说明缺失 `result` 没有触发投影拒绝，而是进入了 `launch()` 并尝试创建 transport。该探针因 `transportFactory` 主动抛错而没有继续到 commit；独立验收报告使用可工作的 Fake transport 观察到 `transports=1`、`commits=4`，并最终完成 Execution。两者结论一致：`dispatchQueued` 路径的防御缺失。

证据：`logs/phase1.1.5-before-probe.txt`。

## 2. 修复后的守卫位置

`packages/dsh-acp-v2/index.mjs:11-12` 增加模块内共享定义：

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

实际代码保持仓库原有的紧凑风格；上面为可读性展开。

`startExecution()` 和 `dispatchQueued()` 都调用该 helper。`dispatchQueued()` 的顺序为：

1. `await this.start()`；
2. 读取 queued Execution；
3. 在 Task 门内读取 Task；
4. `assertTaskProjection(t)`；
5. 并发、`queued/not_started`、lifecycle、Task busy 检查；
6. 最后才 `this.launch(executionId)`。

因此缺失 `result` 时：

- 在 `launch()` 之前抛 `INVALID_TASK_PROJECTION`；
- 不创建 transport；
- 不发生 Store commit；
- 不创建新 Execution；
- 不改变已有 queued Execution 或 Task。

未使用默认值、空字符串或 `??` 补齐任何缺失字段。

## 3. 新增回归测试

`test/n05-store.test.mjs:93`：

```text
Executor dispatchQueued refuses a task projection missing result before commit or transport
```

测试通过公开的 `DshAcpExecutor.dispatchQueued(executionId)` 触发，断言：

- 错误码为 `INVALID_TASK_PROJECTION`；
- `commit === 0`；
- `transportFactory === 0`；
- `x.operations.size === 0`，不存在后台异步 launch；
- 包装 Store 返回的 Task 与调用前完全一致；
- Execution 列表深度相等且长度不变。

修复后聚焦测试通过：`logs/phase1.1.5-after-probe.txt`。

Phase 1.1.4 的 `startExecution` 缺失 `result` 反例保留在 `test/n05-store.test.mjs:71`，本轮继续通过。

## 4. 幂等 requestKey 重放：有意保留

`startExecution()` 的幂等重放仍发生在投影检查之前：

- 已存在且 `inputHash` 匹配的 requestKey，返回原 Execution；
- 不创建新 Execution；
- 不 commit；
- 不创建 transport。

因此，Task 投影缺字段时，幂等重放仍可能返回已有 Execution，而不会硬拒绝。这是**有意保留的既有幂等语义**，不是本轮遗漏。理由是该路径不启动新工作，不创建 transport，也不写 Store；把它改为先拒绝会改变 requestKey 的幂等契约，超出 N05-E1/`dispatchQueued` 的范围。

本轮未修改 requestKey 哈希、冲突判断或返回顺序。

## 5. Context transport：明确排除

`resumeTask()`、`reconcileTask()`、`closeSession()` 等上下文操作本轮不纳入统一投影守卫：

- 它们负责恢复或关闭 Session，不负责启动新的 Execution；
- 它们不创建新 Execution；
- 本轮要求限定为 `dispatchQueued()` 的 launch 路径，避免扩大到全 Executor 重构；
- 未修改这些方法的 transport 创建逻辑。

如果未来要求“任何 transportFactory 调用前都必须拒绝不完整 Task 投影”，应作为单独设计项处理，而不是在本轮顺带修改。

## 6. 测试结果

| 测试 | 结果 | 日志 |
|---|---|---|
| `npm run test:unit` | 78 passed / 0 failed / 0 skipped | `logs/phase1.1.5-unit.txt` |
| `npm run test:simulated` | 37 passed / 0 failed / 0 skipped | `logs/phase1.1.5-simulated.txt` |
| `npm test` | 115 passed / 0 failed / 0 skipped | `logs/phase1.1.5-all.txt` |
| N05 关键反例重复 3 次 | 3 × 13 tests，39 checks，全部通过 | `logs/phase1.1.5-repeat.txt` |
| 修复前聚焦探针 | 1 failed（预期失败） | `logs/phase1.1.5-before-probe.txt` |
| 修复后聚焦探针 | 1 passed | `logs/phase1.1.5-after-probe.txt` |

N05 重复运行同时覆盖：

- `dispatchQueued` 缺失 `result` 反例；
- Phase 1.1.4 的 `startExecution` 缺失 `result` 反例；
- 既有 N05 Store/迁移测试。

测试环境：

- Windows 原生，未使用 WSL；
- Node.js `v24.18.0`，npm `11.16.0`；
- 仓库：`C:\Users\26648\fish_abil_ext`；
- 测试日期：2026-11-10（Asia/Hong_Kong）。

本轮未运行 `npm run test:integration`。改动仅涉及 Executor 的投影防御和 `dispatchQueued` 调用顺序，未修改 ACP transport、Store schema 或状态机；因此不新增真实 DSH 证据，也不把 Fake/Simulated 结果表述为真实 DSH 集成结果。

## 7. 范围与兼容性

- 未修改 Store schema；
- 未修改 Task/Execution 状态机；
- 未修改 ACP transport；
- 未修改持久化格式；
- 未处理 N01、N03 或其他 P3；
- 未重构 requestKey 幂等语义；
- 未接入 Cyrene、AstrBot、QQ/NapCat 或 Bilibili；
- 未进入 Phase 2；
- 不承诺 exactly-once；
- unknown Execution 不自动重发。

共享 helper 只抽取了原本 `startExecution()` 内的字段/类型校验，供 `dispatchQueued()` 复用；`startExecution()` 的行为、错误码和检查时点保持不变。Phase 1.1.4 的 `startExecution` 测试继续通过。

## 8. 尚未验证的真实 DSH 风险

- 本轮没有真实 DSH 集成回归；Fake/Simulated 测试不构成真实 ACP 证据。
- 真实 DSH 终态崩溃窗口、OS 级不可杀进程、真实工具副作用及孙进程仍未验证。
- `dispatchQueued` 的缺投影绕过只在包装 Store 上验证；正常 `ExecutionStore` 会拒绝该快照，因此这不是已落盘 Store 的常规 fail-open。
- Store 与 Executor 仍各自维护必填投影字段；Executor 内部已通过共享 helper 收敛 `startExecution`/`dispatchQueued`，但与 Store 的列表仍需人工保持一致。
- 仍需独立测试会话复验；开发者不自行宣布最终 PASS，也不开始 Phase 2。

## 9. 提交

- 实现提交：`8a4d5c7f75950da5892ac1d74786a5cd4006f275`
  `fix: phase 1.1.5 guard dispatchQueued task projection`
- 基线：`5842fe0a278c26d3a1941e2e3a952cc745a09c73`
- 独立验收报告提交：`b234b26d7aedac71c1cddba17218443ad6fa997b`

实现提交包含代码、测试和日志；本报告与 README/DEVELOPMENT 更新按既有习惯单独提交，不混入独立验收报告。
