# Phase 1.1.4 修复报告：N05-E1 Executor Projection Guard

日期：2026-11-10（Asia/Hong_Kong）。版本：0.1.3（本轮未变更版本号）。基线提交：`918da3a04f1a82b119c49bce369d8f84a2496108`。实现提交：`5842fe0a278c26d3a1941e2e3a952cc745a09c73`。范围：Windows 原生 DSH ACP Companion；未接入 Cyrene、AstrBot、QQ/NapCat、Bilibili，未进入 Phase 2。

结论：N05-E1 已按最小范围修复。`startExecution()` 在创建新 Execution、调用 Store commit、创建或启动 transport 之前，检查 Task 投影是否包含 `result`；缺失时抛 `INVALID_TASK_PROJECTION`。未修改 Store 既有严格校验、状态机、持久化格式或 ACP 实现。当前仍为 **CONDITIONAL PASS**，等待独立测试会话复验。

---

## 1. 根因

`packages/dsh-acp-v2/index.mjs` 的 `startExecution()` 原本检查 7 个必填 Task 投影字段：

```text
status, latestExecutionId, activeExecutionId, unresolvedExecutionIds,
sessionId, duplicateExecutionRisk, integrityAlerts
```

遗漏了 `result`。真实 `ExecutionStore` 已把 `result` 列入含 Execution 的 Task 必填字段，因此这不是已落盘 Store 的常规 fail-open，而是 Executor 防御层与 Store 校验列表不一致。

缺失 `result` 时，`startExecution()` 会继续创建新 Execution，并在 `project()` 中用 `latest?.result ?? ''` 合成一个投影值；这会把“调用方返回的投影不完整”掩盖成正常状态。若包装 Store 的 commit 不抛错，流程会继续 commit 并启动 transport。

## 2. 修复前探针

在基线 `918da3a` 的临时 worktree 中运行新增回归测试：

- 使用 `completed`、无 unknown、无 alert 的合法快照；
- 读取 Store 快照后只删除 Task 的 `result`，其余 7 个必填字段完整；
- 包装 Store 的 `commit()` 先计数再抛 `Error('must not commit')`；
- `transportFactory()` 先计数再抛 `Error('must not launch')`；
- 断言 `startExecution()` 拒绝且错误码为 `INVALID_TASK_PROJECTION`，commit/transport 均为 0，Task/Execution 不变。

基线实际结果为失败（退出码 1）：

```text
not ok 1 - Executor refuses a task projection missing result before commit or transport
expected:
  code: 'INVALID_TASK_PROJECTION'
actual:
  error: 'must not commit'
```

调用栈显示已到达：

```text
DshAcpExecutor.commit (packages/dsh-acp-v2/index.mjs:37)
startExecution 的 commit 调用 (packages/dsh-acp-v2/index.mjs:73)
```

这说明缺失 `result` 没有触发投影拒绝，而是继续到达 Store commit。该探针在第一次 commit 处被包装器拦截，因此不重复声称本轮探针观察到了“完整执行完成”；独立审查此前在功能型包装 Store 上观察到 `started:true`、`status:"completed"`、`commits:5`，与本轮“守卫被绕过”的结论一致。

证据：`logs/phase1.1.4-before-probe.txt`。日志中的临时 worktree 绝对路径已替换为 `<baseline-worktree>`。

## 3. 修复

`packages/dsh-acp-v2/index.mjs:61` 在必填字段列表中加入 `result`：

```js
for (const key of [
  'status',
  'latestExecutionId',
  'activeExecutionId',
  'unresolvedExecutionIds',
  'sessionId',
  'result',
  'duplicateExecutionRisk',
  'integrityAlerts'
]) {
  if (!Object.hasOwn(t, key)) {
    throw fault(
      'INVALID_TASK_PROJECTION',
      `Task is missing required projection field ${key}`
    );
  }
}
```

实际代码保持原有紧凑风格，仅增加一个字段，未引入默认值、空字符串或 `??` 补齐。

检查顺序仍在 `newExecution()`、`project()`、`this.commit()` 和 `this.launch()` 之前。生命周期、busy 等既有前置条件可以先拒绝，但不会在投影检查前创建新 Execution、写 Store 或创建 transport。

## 4. 新增测试

`test/n05-store.test.mjs` 新增：

```text
Executor refuses a task projection missing result before commit or transport
```

测试构造：

- 从真实 `ExecutionStore` 读取合法快照，关闭 Store 后使用只读包装 Store；
- 将 Task/Execution 调整为 `completed`，Binding 为 `closed`，`unresolvedExecutionIds: []`；
- 删除 Task 的 `result`，并确认 `Object.hasOwn(task, 'result') === false`；
- 包装 Store 的 `open/close/snapshot/healthCheck/commit`，其中 `commit` 计数后抛错；
- `transportFactory` 计数后抛错。

断言：

- `startExecution()` 以 `INVALID_TASK_PROJECTION` 拒绝；
- `commit` 次数为 0；
- `transportFactory` 次数为 0；
- 包装 Store 返回的 Task 和 Execution 与调用前一致。

修复后该测试通过；日志见 `logs/phase1.1.4-after-probe.txt`。

## 5. 既有 N05 覆盖

以下测试保留并通过：

- 缺少 `unresolvedExecutionIds` 的快照被 Store 拒绝；
- Executor 不会把缺失的 `unresolvedExecutionIds` 当成空数组；
- unknown Execution 仍要求显式 acknowledge；
- acknowledge 后原 unknown Execution 和 `duplicateExecutionRisk` 仍保留；
- closed Binding 不能掩盖 unresolved；
- 非法 `resultIntegrity`、alert 引用、active/latest 指针、跨 Task/幽灵/重复 unresolved 仍拒绝；
- 正常 completed/failed/cancelled 快照仍可加载；
- v1→v2 合法迁移仍可加载。

## 6. 测试结果

| 测试 | 结果 | 日志 |
|---|---|---|
| `npm run test:unit` | 77 passed / 0 failed / 0 skipped | `logs/phase1.1.4-unit.txt` |
| `npm run test:simulated` | 37 passed / 0 failed / 0 skipped | `logs/phase1.1.4-simulated.txt` |
| `npm test` | 114 passed / 0 failed / 0 skipped | `logs/phase1.1.4-all.txt` |
| N05 关键反例重复 3 次 | 3 × 12 tests，36 checks，全部通过 | `logs/phase1.1.4-repeat.txt` |
| 修复前聚焦探针 | 1 failed（预期失败） | `logs/phase1.1.4-before-probe.txt` |
| 修复后聚焦探针 | 1 passed | `logs/phase1.1.4-after-probe.txt` |

测试环境：

- Windows 原生，未使用 WSL；
- Node.js `v24.18.0`，npm `11.16.0`；
- 仓库：`C:\Users\26648\fish_abil_ext`；
- 测试日期：2026-11-10（Asia/Hong_Kong）。

本轮未运行 `npm run test:integration`。改动仅涉及 `startExecution()` 的防御字段列表，未修改 ACP transport、Store schema 或状态机；因此本轮不新增真实 DSH 证据，也不把 simulated/Fake 结果表述为真实 DSH 结果。真实 DSH 回归的既有边界仍是：`dispatch_intent` 后 kill 只证明本地持久化后中断，不证明远端执行或工具副作用。

## 7. 兼容性与约束

- 不修改 `packages/task-store-v2/index.mjs` 的既有严格校验；
- 不修改 Task/Execution 状态机、持久化格式或 ACP 协议；
- 合法快照本来就包含 `result`，无需数据迁移；
- v1→v2 迁移仍可加载；
- 缺失 `result` 的旧 v2 快照仍会被真实 Store 拒绝，没有静默默认修复；
- 未自动重发 unknown Execution，不承诺 exactly-once；
- 未处理 N01、N03 或其他 P3，未进入 Phase 2。

## 8. 残余风险

- 本轮没有真实 DSH 回归；真实终态崩溃窗口、OS 级不可杀进程、真实工具副作用及孙进程仍未验证。
- Store 与 Executor 各自维护必填投影字段列表；本轮只补齐 `result`，未来新增投影字段仍需同时更新两处，存在再次漂移的风险。本轮不在未要求的情况下重构为共享常量。
- `project()` 仍会为合法投影计算 `result`；本修复只保证缺失 `result` 不会进入该路径，不改变既有投影计算。
- 仍需独立测试会话复验本修复并决定是否接受；开发者不自行宣布最终 PASS，也不开始 Phase 2。

## 9. 提交

- 实现提交：`5842fe0a278c26d3a1941e2e3a952cc745a09c73`
  `fix: phase 1.1.4 reject missing task result projection`
- 基线：`918da3a04f1a82b119c49bce369d8f84a2496108`

本报告作为独立文档提交回填；实现提交内容为代码、测试和上述日志，不包含 Phase 2 或 bot 文件。
