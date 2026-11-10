# Phase 1.1.3 修复报告：N02 恢复标志闭环与 N05 Store Fail-Closed

日期：2026-11-10（Asia/Hong_Kong）。版本：0.1.3。范围：Windows 原生 DSH ACP Companion Hub；未接入 Cyrene、AstrBot、QQ/NapCat、Bilibili，未进入 Phase 2。

结论：N02 与 N05 的已确认缺口均已修复并有针对性测试；Store 对含 Execution 的 Task 采用显式投影必填和 fail-closed 校验，Executor 不再把缺失投影当作空数组。上一轮独立最终审查的 CONDITIONAL PASS 不变，仍未宣布 PASS。

---

## 1. N02：recoveryRequired 未闭环

### 根因

- `reconcileTask` 成功时提交 `{...b, availability:'closed'}`，展开旧 Binding 时保留了 `recoveryRequired:true`。
- `closeSession` 只在 `availability !== 'closed'` 时执行远端恢复/关闭；Binding 已是 `closed` 时直接跳过，无法清理 stale 标志。
- 结果是 `closed + recoveryRequired:true` 的自相矛盾状态，后续健康检查/Phase 2 门禁可能误判。

### 修复

`packages/dsh-acp-v2/index.mjs`：

1. `reconcileTask` 对 `availability==='closed'` 的 Binding：
   - `recoveryRequired===true` 时执行本地安全归一化，提交 `recoveryRequired:false` 并记录 `session.recovery_normalized`；
   - 不发起远端 resume/close；
   - `recoveryRequired` 已为 false 时直接返回。
2. 远端 resume/close 成功后，提交显式：
   ```js
   availability: 'closed',
   recoveryRequired: false
   ```
   不再依赖旧 Binding 展开值。
3. `closeSession` 同样处理 `closed + recoveryRequired=true`：本地归一化，不再创建远端 transport；`unknown` Binding 仍必须经过可信 resume/close。
4. 远端关闭成功但本地 commit 失败时，commit 异常直接传播：
   - 不返回“恢复成功”；
   - Binding 保持 unknown/recoveryRequired=true；
   - Executor 进入 storageFault，health 不健康；
   - 新 Executor 可重试 reconcile。

历史 `TERMINAL_SESSION_UNSETTLED` 诊断不被删除；恢复完成只改变 Binding 状态字段。

### 测试

`test/crash-v2.test.mjs` 新增/扩展：

- afterTerminalCommit 恢复后断言 `availability=closed`、`recoveryRequired=false`、历史诊断仍存在；
- 再次 `reconcileTask()` 与 `closeSession()` 不产生矛盾；
- 恢复后 `startExecution` 正常；
- `closed + recoveryRequired=true` 直接回归：`closeSession` 本地归一化，远端 transport 数量不增加；`reconcileTask` 同样不增加；
- 远端 close 成功、本地 Binding commit 抛 EIO：`reconcileTask` 拒绝，Binding 仍 unknown/recoveryRequired=true，health 不健康；新实例重试后 closed/false。

---

## 2. N05：unknown Execution 投影可被省略而 fail-open

### 根因

- Store 只在 `task.unresolvedExecutionIds != null` 时比较投影；含 unknown Execution 但省略该字段的快照可通过。
- Executor `startExecution` 使用 `t.unresolvedExecutionIds ?? []`，把缺失字段当空数组，从而不要求显式承认 unknown。
- `resultIntegrity` 枚举、`integrityAlerts.executionId` 引用、必填指针等校验不完整。

### 修复

`packages/task-store-v2/index.mjs`：

- 对存在 Execution 的 Task 强制要求以下投影字段存在：
  `status`、`latestExecutionId`、`activeExecutionId`、`unresolvedExecutionIds`、`sessionId`、`result`、`duplicateExecutionRisk`、`integrityAlerts`。
- `unresolvedExecutionIds` 必须是数组，且与真实 unknown/interrupted Execution 集合完全一致；缺失、空数组、幽灵 ID、跨 Task ID、重复 ID 均拒绝。
- `latestExecutionId` 必须是最后创建的 Execution；`Task.result` 必须等于最新 Execution.result；`Task.sessionId` 必须等于最新 Binding.sessionId。
- `activeExecutionId` 必须真实对应唯一活动 Execution；缺失、错误或跨 Task 引用拒绝。
- `Task.status` 必须等于真实投影；`duplicateExecutionRisk` 必须为布尔，存在 unresolved 或任何 integrityAlerts 时必须为 true。
- `Execution.resultIntegrity` 仅允许 `partial` / `observed_complete` / `uncertain`。
- `integrityAlerts` 每条必须引用当前 Task 的真实 Execution；确认时间必须可解析、确认人必须存在、note 必须为字符串。
- 发现不一致时返回 `VALIDATION`，不静默修复、不删除 unknown Execution、不补造证据。

`packages/dsh-acp-v2/index.mjs`：

- `startExecution` 检查必需的投影字段存在且数组/布尔类型正确；缺失时抛 `INVALID_TASK_PROJECTION`，不再使用 `?? []`。
- 只有 `unresolvedExecutionIds` 被显式承认后才能创建新 Execution；旧 unknown Execution 保留，`duplicateExecutionRisk` 保留。

### 测试

新增 `test/n05-store.test.mjs`（Store 层 + Executor 调用路径）：

1. unknown + 缺少 `unresolvedExecutionIds` → 加载拒绝；
2. unknown + 空 unresolved → 加载拒绝；
3. unknown + 正确 unresolved → 可加载，但 `startExecution` 仍要求显式承认；
4. 显式 acknowledge 后原 unknown Execution 保留、duplicate risk 为 true；
5. 非法 `resultIntegrity` → 拒绝；
6. alert 指向不存在 Execution → 拒绝；
7. alert 指向其他 Task 的 Execution → 拒绝；
8. active/latest 缺失、错误、跨 Task → 拒绝；unresolved 幽灵/跨 Task/重复 → 拒绝；
9. 正常 completed/failed/cancelled 快照仍可加载；
10. v1→v2 迁移后的合法快照仍可加载；
11. Store `commit` 省略 unresolved 也拒绝；
12. 模拟 Executor 拿到缺失投影的 Store 快照，断言 `INVALID_TASK_PROJECTION`、不 commit、不启动 transport。

---

## 3. 迁移兼容性

- v1→v2 迁移由 `scripts/migrate-v1.mjs` 生成完整投影，严格校验下仍可加载（测试覆盖）。
- 旧 v2 快照若缺少上述必填投影，不再被普通运行路径用默认值兼容；这是有意的 fail-closed 行为。
- 目前没有为旧 v2 缺失投影提供自动迁移；若发现此类快照，应停止加载并人工迁移，不能静默补空数组。
- 迁移仍保留原始 v1 事件备份；不伪造执行收据。

---

## 4. 失败路径与恢复路径

- `closed + recoveryRequired=true`：本地归一化（不访问远端），提交失败则保留状态并允许重试。
- `unknown + recoveryRequired=true`：必须通过 resume/close 的成功远端证据；成功提交才 closed/false。
- 远端成功、本地 commit 失败：不报告成功；状态保持 unknown/recoveryRequired=true；health 显示 storage fault；新实例重试。
- Store 校验失败：拒绝加载或提交，返回明确 `VALIDATION`；不修改磁盘/内存快照。

---

## 5. 测试结果（本次重新运行）

| 类别 | 结果 | 日志 |
| --- | --- | --- |
| Unit/Store/迁移 | 76 passed / 0 failed / 0 skipped | `logs/phase1.1.3-unit.txt` |
| Simulated ACP/Transport/Hub/fault | 37 passed / 0 failed / 0 skipped | `logs/phase1.1.3-simulated.txt` |
| 合并全量本地测试 | 113 passed / 0 failed / 0 skipped | `logs/phase1.1.3-all.txt` |
| N02/N05 关键反例重复运行 | 3 次 × 20 项全部通过 | `logs/phase1.1.3-repeat.txt` |
| 真实 Windows DSH ACP | PASS；8 组检查 | `logs/phase1.1.3-real-console.txt`、`logs/real-v2-2026-11-10T06-34-55-196Z.jsonl` |

测试分类：

- `test/n05-store.test.mjs`、Store/迁移用例：Store 单元 + 直接 JSON 快照，不启动 DSH。
- Executor 缺失投影测试：Executor + 注入 Store/Fake transport，不启动 DSH。
- N02 崩溃恢复：真实 Node 进程退出，但 ACP 为模拟 transport。
- 真实 DSH：已安装 DSH 0.2.2-rc.1，prompt 不调用工具；N09 证据边界仍为 dispatch intent 后 kill，不证明远端执行。
- 真实 DSH 没有复现“终态已提交、Binding 未关闭”的崩溃窗口；N02 的真实崩溃窗口仍未验证。

---

## 6. 剩余风险

1. N02 的真实 DSH 终态崩溃窗口仍是模拟 ACP 证据。
2. N01/N06 的 OS 级不可杀进程、真实 Store 锁与真实 Hub 组合仍未验证。
3. 真实长时间、工具副作用、孙进程回收、Desktop UI 同步、多客户端身份/授权未验证。
4. 严格 Store 校验会让旧 v2 缺失投影快照直接拒绝加载；没有自动旧 v2 迁移。
5. `recoveryRequired` 仅做本地归一化，不证明远端 Session 仍然存在；closed 由之前的可信关闭证据决定。

---

## 7. 文件与提交

主要修改：

- `packages/dsh-acp-v2/index.mjs`（N02/N05 Executor 防御）
- `packages/task-store-v2/index.mjs`（N05 必填投影/枚举/引用校验）
- `test/crash-v2.test.mjs`（N02 回归）
- `test/n05-store.test.mjs`（N05 回归）
- `package.json`（把 N05 测试加入 test:unit）
- 文档与测试日志

实现提交：`31139e874afa73fc3de3d82427e403b84cb0d031`（`fix: phase 1.1.3 n02 recovery flag and n05 fail-closed store`）。报告 SHA 回填提交见 `git log`。
