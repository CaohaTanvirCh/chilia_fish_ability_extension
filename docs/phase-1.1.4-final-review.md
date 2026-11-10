# Phase 1.1.4 Independent Final Review：N05-E1

审查对象：`CaohaTanvirCh/chilia_fish_ability_extension`。

- 基线：`918da3a04f1a82b119c49bce369d8f84a2496108`
- 实现提交：`5842fe0a278c26d3a1941e2e3a952cc745a09c73`
- 报告提交：`c9675771dce25dceae5443366e31b82404923b41`
- 审查日期：2026-11-10（Asia/Hong_Kong），Windows 原生，未使用 WSL。

审查性质：只读代码审查、测试复验、独立故障探针和提交范围核对；未修改业务源码、Contracts、测试实现、配置或 package scripts，未接入任何 bot，未进入 Phase 2，未承诺 exactly-once。

## 最终结论

**CONDITIONAL PASS。**

`startExecution()` 的 N05-E1 修复本身是正确的：`result` 已加入必填投影字段；缺失时抛 `INVALID_TASK_PROJECTION`；检查发生在 `newExecution()`、`project()`、Store commit 和 transport 创建之前。新增测试通过，独立探针也确认 `newExecution=0`、`project=0`、`commits=0`、`transports=0`。

但“其他路径绕过该检查”仍有两处需要记录：

1. **`dispatchQueued()` 是 P2 的关联防御缺口。** 它不经过 `startExecution` 的投影检查；在 Task 缺 `result`、含 queued Execution 的包装 Store 上，独立探针观察到了 `transports=1`、`commits=4`，并最终完成 Execution。它没有创建新的 Execution，但确实创建 transport 并写入 Store。正常 `ExecutionStore` 会拒绝缺 `result` 的快照，因此这不是已落盘 Store 的常规 fail-open；但它与 N05-E1 的原始防御问题同类。
2. **幂等 requestKey 重放在 guard 之前返回已有 Execution，P3。** 该路径不创建新 Execution、不 commit、不创建 transport，因此不破坏“新工作安全”边界；但它不是对缺 `result` 请求的硬拒绝，若验收要求所有 `startExecution` 调用都拒绝，需要另行明确。

因此：若验收标准只覆盖 `startExecution` 的新工作路径，该项通过；若要求“Executor 的任何 Store commit/transport 创建路径”都先拒绝缺 `result`，则当前修复还不完整，应判定为 CONDITIONAL PASS，而不是 PASS。

## 1. 代码审查

### 1.1 `startExecution` 的 guard

`packages/dsh-acp-v2/index.mjs:61`：

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

实际代码为紧凑单行，但逻辑相同。检查点确认：

- 明确包含 `result`；
- 使用 `Object.hasOwn`，不是用 `t.result ?? ''` 补齐；
- 缺失字段的错误码是 `INVALID_TASK_PROJECTION`；
- 检查位于 `newExecution()`（约 `:70`）、`project()`（约 `:72`）和 `this.commit()` / `this.launch()`（约 `:73`）之前；
- 检查只读 Task，不写 Store、不创建 transport。

### 1.2 独立顺序探针

我用真实 Store 种一个合法 completed 状态，关闭后用只读包装 Store 删除 Task 的 `result`，再 monkeypatch `newExecution` 和 `project` 计数。结果：

```json
{
  "error": {
    "code": "INVALID_TASK_PROJECTION",
    "message": "Task is missing required projection field result"
  },
  "commits": 0,
  "transports": 0,
  "newExecutions": 0,
  "projects": 0
}
```

原 Task 和 Execution 未变化。这个顺序探针比新增测试更直接地证明了“在创建、投影、commit、transport 之前拒绝”。

### 1.3 没有发现 `startExecution` 新工作路径的绕过

对 `startExecution` 的正常新请求，没有发现：

- 在 guard 前调用 `newExecution`；
- 在 guard 前调用 `project`；
- 在 guard 前 commit；
- 在 guard 前创建或启动 transport；
- 用 `??`、空字符串或默认值补齐缺失的 `result`。

`project()` 内部仍有 `latest?.result ?? ''` 的投影计算，但这是对**已存在**的最新 Execution 的合法投影，不是对缺失 Task `result` 的补齐；guard 已先拒绝缺失情况。

### 1.4 其他路径

#### 幂等 requestKey 重放（P3）

`startExecution:59` 在投影 guard 之前先查 `requests`：

```js
const previous = this.state().requests.find(r => r.key === input.requestKey);
if (previous) {
  if (previous.inputHash !== inputHash) throw fault('IDEMPOTENCY_CONFLICT', ...);
  return this.execution(previous.executionId);
}
```

独立探针在 Task 缺 `result`、requestKey 已存在的包装 Store 上调用 `startExecution`：

```json
{"path":"replay","error":null,"result":{"executionId":"e1"},"commits":0,"transports":0}
```

它没有创建新 Execution、没有 commit、没有 transport，安全边界没有被破坏；但它确实没有返回 `INVALID_TASK_PROJECTION`。如果验收标准要求“任何 startExecution 请求都拒绝不完整投影”，这是一个未覆盖的语义分支，建议文档明确“幂等重放优先”。

#### `dispatchQueued`（P2 关联缺口）

`packages/dsh-acp-v2/index.mjs:75` 的 `dispatchQueued()` 直接从 queued Execution 调用 `launch()`，没有复用 `startExecution` 的投影 guard。

独立探针使用“Task 缺 result、Execution 仍 queued/not_started”的包装 Store，并注入完成的 Fake transport：

```json
{"error":null,"commits":4,"transports":1,"taskStatus":"completed","taskResult":"","executionStatus":"completed"}
```

它没有创建新的 Execution，但创建了 transport，并发生 4 次 Store commit。正常 `ExecutionStore` 会拒绝缺 `result` 的快照，因此这不是当前真实 Store 的常规持久化 fail-open；但它说明“Executor 的所有 launch 路径都先拒绝缺 result”这一更强表述尚未成立。

`resumeTask`/`reconcileTask`/`closeSession` 也会创建 context transport，但它们不创建新 Execution、不提交新的执行结果；本轮没有把它们当作 N05-E1 的 `startExecution` 新工作路径，但若验收标准是“任何 transport 创建”，它们也应纳入同一防御检查，或明确排除。

## 2. 测试审查

### 2.1 新增测试是否满足要求

`test/n05-store.test.mjs:71-91` 新增：

`Executor refuses a task projection missing result before commit or transport`

测试构造：

- 用真实 `ExecutionStore` 生成合法快照，关闭后使用只读包装 Store；
- 把 Task/Execution 调整为 completed，Binding 设为 closed，`unresolvedExecutionIds: []`；
- 删除 Task 的 `result`，并断言 `Object.hasOwn(task, 'result') === false`；
- 包装 Store 的 `commit` 计数后抛错；
- `transportFactory` 计数后抛错。

断言：

- `startExecution()` 以 `INVALID_TASK_PROJECTION` 拒绝；
- `commits === 0`；
- `transports === 0`；
- 包装 Store 返回的 Task/Execution 与调用前一致。

这满足任务书列出的四项核心断言。它通过公开的 `DshAcpExecutor.startExecution()` 触发，没有调用私有 validator；如果 guard 不存在，流程会到达 fake Store 的 `commit()` 并抛出普通 `must not commit` 错误，`assert.rejects(..., {code:'INVALID_TASK_PROJECTION'})` 会失败。因此不存在“包装 Store 抛错反而让测试误通过”的问题。

### 2.2 测试没有直接断言的项

- 新增测试没有直接给 `newExecution` / `project` 加计数；我用独立 monkeypatch 探针确认两者均为 0。
- 新增测试没有覆盖幂等重放和 `dispatchQueued`，这是上述 P3/P2 的覆盖缺口。
- 测试使用包装 Store 而非真实 Store；这是为了在 guard 失败时观察到 commit，而不是把它当作真实持久化路径。

### 2.3 修复前后证据

提交中：

- `logs/phase1.1.4-before-probe.txt`：基线探针 1 failed，实际错误为 `must not commit`，说明缺失 result 没有触发 guard，而是到达 commit；
- `logs/phase1.1.4-after-probe.txt`：修复后同一个聚焦探针 1 passed；
- `logs/phase1.1.4-repeat.txt`：3 个 run，每 run 12 tests，共 36 checks，0 fail；
- `logs/phase1.1.4-unit.txt`：77 passed / 0 failed / 0 skipped；
- `logs/phase1.1.4-simulated.txt`：37 passed / 0 failed / 0 skipped；
- `logs/phase1.1.4-all.txt`：114 passed / 0 failed / 0 skipped。

我独立复跑得到相同计数：

| 命令 | 结果 |
| --- | --- |
| `npm run test:unit` | 77 passed / 0 failed / 0 skipped，exit 0 |
| `npm run test:simulated` | 37 passed / 0 failed / 0 skipped，exit 0 |
| `npm test` | 114 passed / 0 failed / 0 skipped，exit 0 |
| `node --test test/n05-store.test.mjs`（3 次） | 每次 12 passed / 0 failed；3 次全通过 |
| 聚焦 N05-E1 测试 | 1 passed / 0 failed |

测试时间（Asia/Hong_Kong）：

- unit：15:16:24–15:16:25；
- simulated：15:16:25–15:16:30；
- full `npm test`：15:16:30–15:16:35；
- N05 反例 3 次：15:16:41–15:16:44；
- 聚焦测试：本轮独立复跑通过。

环境：

- Node.js `v24.18.0`；
- npm `11.16.0`；
- ACP SDK `1.4.0`；
- 项目版本 `0.1.3`；
- 未运行真实 DSH 集成；本轮按任务书不要求，也不把任何 Fake/Simulated 结果称为真实 DSH 证据。

## 3. 提交与范围审查

### 3.1 完整 diff

`918da3a..5842fe0` 实际变更 8 个文件：

- `packages/dsh-acp-v2/index.mjs`：生产代码只增加 `result` 一个字段；
- `test/n05-store.test.mjs`：只新增 22 行回归测试；
- 6 个 `logs/phase1.1.4-*.txt` 证据日志。

`5842fe0..c967577` 实际变更 3 个文件：

- `README.md`：Phase 1.1.4 标题/链接；
- `DEVELOPMENT.md`：开发日志；
- `docs/phase-1.1.4-fix-report.md`：修复报告。

没有修改：

- `packages/task-store-v2/index.mjs` 的 Store schema/校验；
- Task/Execution 状态机；
- ACP transport；
- `package.json` / `package-lock.json` / scripts；
- 其他业务模块。

生产代码的唯一差异就是 guard 字段列表增加 `result`，符合“最小范围”声明。

### 3.2 分支、远端与工作区

- 审查开始时 `git status --short` 为空；
- 审查开始时本地 `master` 的 `HEAD` 为 `c967577`；
- 审查开始时 `origin/master` 同样为 `c967577`；
- `git ls-remote origin refs/heads/master` 返回：`c9675771dce25dceae5443366e31b82404923b41`。

因此当前 GitHub `master` 已包含实现和报告提交。修复报告中未发现“尚未推送”的声明，实际远端也没有与本地不一致。

### 3.3 文档/日志一致性

- 修复报告的 77/37/114 与仓库日志一致，也与独立复跑一致；
- 3×12 tests、36 checks 与 repeat 日志一致；
- before-probe 是**预期失败**，不是回归失败；
- after-probe 通过；
- 1.1.4 的 `.txt` 日志是 UTF-8、无 NUL/BOM，优于此前 1.1.3 的 UTF-16 日志；
- `git diff --check` 只报告 `logs/phase1.1.4-before-probe.txt` 中捕获的 TAP 行有尾随空格；这是日志格式，不是业务代码问题。

### 3.4 发布卫生

- `docs/phase-1.1.4-fix-report.md` 第 134 行仍含本机仓库绝对路径/账户名；
- `README.md`、`DEVELOPMENT.md`、`docs/deployment-windows.md`、`scripts/probe-acp.mjs` 和旧日志仍有本机路径；
- 这是既有发布卫生问题，不是本轮代码回归；新增 1.1.4 日志本身为 UTF-8 且未发现本机路径。
- 公开前建议用 `<user>`、`<repo>` 或配置项替换；不要重复把真实账户名写入新文档。

## 4. 未验证风险

- 本轮没有真实 DSH 集成；真实 ACP 的终态崩溃、OS 级不可杀进程、真实工具副作用/孙进程回收仍未验证。
- `dispatchQueued` 的缺 `result` 绕过只在包装 Store 上验证；正常 Store 会拒绝该快照，所以不是已落盘 Store 的常规 fail-open。
- `resumeTask`/`closeSession` 等 context transport 路径没有同等的投影 guard；它们不创建新 Execution，但若验收标准是“任何 transport 创建”，仍需另行覆盖。
- Store 与 Executor 各自维护投影字段列表，未来新增字段仍可能漂移；本轮不要求重构为共享常量。
- N01/N03 及其他 P3 未处理，符合本轮范围。

## 5. 最终判定与 Phase 2 建议

| 项目 | 结论 |
| --- | --- |
| `startExecution` 缺 result guard | 通过 |
| guard 在 newExecution/project/commit/launch 前 | 通过；独立顺序探针 `newExecutions=0`、`projects=0`、`commits=0`、`transports=0` |
| 新增测试 | 通过；commit/transport/原 Task/Execution 断言成立 |
| 测试复跑 | 77/37/114 全部通过；N05 3×12 通过 |
| 提交范围 | 生产代码仅一行；无 Store/transport/状态机改动 |
| 分支/远端 | 本地与 `origin/master` 均为 `c967577` |
| 其他路径 | `dispatchQueued` 可绕过并 commit/transport，P2；幂等 replay 不拒绝，P3 |
| 真实 DSH | 本轮未执行；不把 Fake 结果当真实 DSH 证据 |

**最终：CONDITIONAL PASS。**

`startExecution` 的目标修复可以接受，新增测试和独立探针均通过。不能判定为无条件 PASS，因为 `dispatchQueued` 仍可从缺 `result` 的包装 Store 启动 queued Execution、创建 transport 并 commit；如果验收标准只覆盖 `startExecution` 的新执行路径，可视为通过；如果要求 Executor 所有 launch/commit/transport 路径统一 fail-closed，则需补上 `dispatchQueued` 的同一投影检查（以及明确 replay 语义）。

建议：

1. 保留本轮 `startExecution` 的最小修复；
2. 在 Phase 2 实现前，把 `dispatchQueued` 的投影检查或共享 guard 作为 P2 处理；
3. 明确幂等 requestKey 重放是否要求硬拒绝缺失投影；
4. 公开前清理本机路径；
5. 在真实 DSH 集成中继续保持“dispatch intent 后 kill 不等于远端执行证据”的边界。

本报告作为独立审查提交，只包含本报告文件，不改动业务源码、Contracts、测试实现或配置；未进入 Phase 2。
