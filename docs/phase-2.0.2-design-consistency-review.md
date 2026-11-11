# Phase 2.0.2 Design Consistency Review

日期：2026-11-10（Asia/Hong_Kong）
审查对象：

- `docs/phase-2.0.1-architecture-decisions.md`（基线提交 `ad736e5`）
- `docs/phase-2.0.2-architecture-decisions.md`（本轮 AD-06 至 AD-11 修订）

> Phase 2.0.3 又补充了 AD-12 至 AD-14，见 `docs/phase-2.0.3-implementation-constraints.md`；本报告保留为 2.0.2 的历史审查记录。
>
> **Phase 2.1A.5 更新：** 用户已冻结 Authority Version + Fence + Effective 派生方案。AD-06-R1 将 Controller **冻结**的 snapshot Grant 改为“Fence 立即 effective 无效、`revokedAt` 异步物化”；显式 Controller 转移仍同事务。AD-08 的 v3 实现不暴露同一 controller 的 `unfreezeController`，只允许 `transferController`。本报告第 2.1/2.3 节的旧措辞按此更新；详见 `docs/phase-2.1A.5-authority-fence-decision-closure.md`。

审查性质：只读文档审查与设计修订；未修改业务代码、Contracts、Store、Executor、ACP Transport、测试或配置。

## 1. 结论

Phase 2.0.1 的六个一致性问题已在 Phase 2.0.2 通过 AD-06 至 AD-11 明确：

| 问题 | 修订 | 结论 |
|---|---|---|
| Artifact ACL 与 Task 角色变化 | AD-06 | 已解决设计矛盾 |
| Task / Execution / Lifecycle 完整迁移矩阵 | AD-07 | 已补齐 |
| Delegation 撤销与 Controller 冻结 | AD-08 | 已定义失效/冻结/接管 |
| Event Workspace/System 归属与游标 | AD-09 | 已定义 scope、授权和游标 |
| requestKey 委托身份作用域 | AD-10 | 已定义五元作用域与撤销重放 |
| 并行 Execution 与 Workspace mutex | AD-11 | 已区分数据模型与写并发策略 |

当前判定：**CONDITIONAL DESIGN CONSISTENCY PASS**。文档内部已无已知的 P0 语义冲突；实现前仍需独立评审和后续 AD（尤其是 InputRequest、Artifact 存储后端、租约恢复实现）。

## 2. 审查发现与修订

### 2.1 Artifact ACL 与 Task 角色变化

**发现：**

Phase 2.0.1 同时声称 Artifact 是“创建时快照”，又允许 private Artifact 按“当前来源 Task 的 owner/requestedBy/controller”读取。Task owner 或 controller 转移会导致 Artifact 访问权随之变化，实际形成动态继承；这与“多 Task 引用同一文件时独立授权”冲突。

**修订（AD-06）：**

- Artifact 创建事务中物化 `ownerPrincipalId`、`visibility`、requester/controller 的 ArtifactGrant；
- 读取时只看 Artifact ACL，不再查当前 Task 角色；
- Task owner 转移不自动转移 Artifact；发送 `artifact.access_review_required`；
- Task controller 转移时，旧 `origin=task-snapshot-controller` grant 同事务撤销、新 controller 创建新 grant；Task controller **冻结/撤权**时，snapshot grant 由 Fence 立即 effective 无效，`revokedAt` 异步物化（AD-06-R1）；
- Task visibility 改变不自动改 Artifact；
- Artifact owner/grantee 失去 Workspace 成员资格时访问暂停，由 Owner/Admin 显式处理。

**遗留：** Artifact owner 转移 API、Artifact 存储后端和跨 Workspace grant 尚未实现；这是后续阶段。另有一个需要实现时显式处理的安全点：Task 从 workspace 缩窄为 private 时，已有 workspace Artifact 不会自动变为 private；必须显示 `artifact.access_review_required`，由 Owner/Admin 明确 restrict，不能静默保留公开访问。

### 2.2 Task / Execution / Lifecycle 矩阵

**发现：**

Phase 2.0.1 只有 Task 状态摘要，没有完整的 Execution 和 lifecycle 迁移表；`open/active/awaiting_decision`、`archived/deleted`、`interrupted/unknown` 的边界容易混用。尤其：

- `open` 是否包含 queued；
- `active` 是否允许 queued；
- `active` 时能否 complete/fail；
- `interrupted` 是否能转 completed；
- `archived/deleted` 如何 restore；
- `awaiting_input` 是否属于 Execution 状态。

**修订（AD-07）：**

- Task `goalStatus`、Execution 状态、lifecycle 三套矩阵分别给出；
- `open` 只表示尚无 Execution；首个 queued/running 即 active；
- `active` 包含 queued/running，但 complete/fail 仅允许在 `awaiting_decision`；
- `unknown`/`interrupted` 不是 Task goalStatus，进入 executionSummary；
- Execution 终态不可逆；`interrupted` 只能转 unknown 或保持已提交终态；
- `awaiting_input` 不进入 v3 Execution 状态，Phase 2.3 使用独立 InputRequest；
- lifecycle 有独立 archive/delete/restore 矩阵，`deletedFrom` 记录恢复目标。

**遗留：** `InputRequest` 的字段、与 ACP 的能力协商、真实反馈通路仍属于 Phase 2.3 设计。

### 2.3 Delegation 撤销与 Controller 冻结

**发现：**

Phase 2.0.1 只说“撤销后立即失效”，没有定义：

- 运行中的 Execution 是否取消；
- Controller 保留还是清空；
- 旧 ArtifactGrant 如何处理；
- 撤权与进行中命令的竞态；
- 谁可以恢复执行。

**修订（AD-08）：**

- revoke/expire/membership loss/principal disable 等触发授权失效；
- 关联 Task 的 effective `controlState=frozen`；stored `controlState` 是可滞后 cache；保留 controller ID 用于审计，但撤销控制权；
- 运行中 Execution 不自动取消，由 Hub/Executor 继续到真实终态；Agent 立即失去读取/订阅；
- queued Execution 不自动 dispatch；
- controller 的 `origin=task-snapshot-controller` ArtifactGrant 立即 effective 无效；`revokedAt` 异步物化；
- Owner/Admin 通过显式 `transferController` 接管；v3 不暴露同一 controller 的 `unfreezeController`；
- 用 `authorizationEpoch` 检查入口和提交前授权，避免撤权竞态写入；
- 记录 delegation/controller/Artifact grant 事件。

**遗留：** Controller 租约/超时未决定；当前采用显式冻结/接管，不引入租约。

### 2.4 Event 归属与游标

**发现：**

Phase 1.1/2.0.1 的 Event 只有全局 sequence 和 `afterSequence`，没有：

- workspace/system scope；
- system event 的可见性；
- 权限撤销后的游标处理；
- 事件 payload 的隐私边界；
- v2 全局游标的迁移。

**修订（AD-09）：**

- Event 增加 `scope=workspace|system`、`workspaceId`、`audience`、`actorPrincipalId`、`source`；
- workspace 事件必须有 workspaceId；system 事件 workspaceId=null 且只进入系统流；
- 游标为 `{scope,workspaceId,sequence}`；全局 sequence 允许跨 Workspace 空洞；
- 每次读取重新授权；撤权/成员失效返回 `AUTHORIZATION_REVOKED`；
- 游标不授予权限，不能跨 Workspace 复用；
- 事件 data 只放 ID/状态/摘要，不放结果正文；
- v2 事件迁移为 legacy workspace，不生成 system 事件。

**遗留：** 事件保留期限、跨归档游标、Message/Command 的独立模型仍属于 Phase 2.2。

### 2.5 requestKey 委托身份作用域

**发现：**

Phase 2.0.1 只写了 `(workspaceId, principalId, key)`，没有定义“principal”是 actor 还是 requestedBy，也没有 delegationId；多 Agent、多委托、撤权重放都会冲突或泄漏。

**修订（AD-10）：**

- 作用域为 `(workspaceId, actorPrincipalId, delegationId|null, operation, clientRequestKey)`；
- `requestedBy` 不作为唯一作用域，delegationId 区分同一 Agent 的不同委托；
- 同一作用域相同 inputHash 才重放；
- 撤权、成员失效、Task 不可读时返回 `AUTHORIZATION_REVOKED`，不返回旧 Execution；
- v2 旧 key 使用 `scope=legacy`，不能跨 Principal/Workspace 重新解释。

**遗留：** 旧 v2 key 的显式迁移窗口仍需在迁移 CLI 设计中定义。

### 2.6 并行 Execution 与 Workspace mutex

**发现：**

Phase 2.0.1 同时说“一个 Task 可以有多个 Execution”和“默认 mutex，一个 Workspace 一个可写 Execution”，但没有解释：

- 多个 queued Execution 是否存在；
- 谁持有 mutex；
- 租约何时获取/释放；
- unknown/崩溃时是否自动释放；
- worktree/copy 是否仍需要 mutex；
- `maxConcurrent=8` 与 Workspace 上限的关系。

**修订（AD-11）：**

- 数据模型允许多个 Execution；实际写并发由 isolationPolicy 决定；
- mutex 是每 Workspace 的写租约；默认 `maxRunningPerWorkspace=1`；
- 租约在 dispatch_intent 前获取，终态和清理后释放；
- unknown/interrupted/清理未完成时租约冻结，不自动释放；
- worktree/copy 使用独立 workspaceSnapshot，不需要 Workspace mutex；
- `shared-readonly` 必须由执行器证明只读；
- 全局 `maxConcurrent=8` 只是资源上限，不等于每 Workspace 并行写。

**遗留：** 租约调度器、崩溃恢复和 Owner/Admin 显式释放 API 尚未实现。

## 3. 一致性核对

### 3.1 状态与权限交叉检查

| 场景 | 期望 | 文档依据 |
|---|---|---|
| Task active 且有 queued Execution | `Task.status=active`，但 `executionSummary.running` 可为 0 | AD-07 |
| Task 最后一个 Execution 完成 | `awaiting_decision`，不是 `completed` | AD-07 |
| unknown Execution + 无活动 Execution | `awaiting_decision` + risk，不是 Task `unknown` | AD-07 |
| `completeTask` 有活动 Execution | 拒绝/BUSY | AD-07 |
| 删除 Task | Artifact 不删除，ACL 不变 | AD-06 |
| Task owner 转移 | Artifact owner 不变，发 review 事件 | AD-06 |
| Controller 转移 | 旧 controller 的 snapshot grant 撤销，新 controller grant 创建 | AD-06 |
| Delegation 撤销 | Controller frozen；运行中 Execution 不伪造终态 | AD-08 |
| 旧事件游标撤权 | 返回 AUTHORIZATION_REVOKED，不返回旧数据 | AD-09 |
| 同一 Agent 两个委托同 key | 不同 scope，不互相重放 | AD-10 |
| Workspace mutex + 多 queued | 只有 1 个 running，其余 queued | AD-11 |
| mutex lease 持有者 unknown | 租约 frozen，不能自动释放 | AD-11 |

### 3.2 与 Phase 1.1 可靠性约束的兼容

- Execution 终态不可覆盖：AD-07 保留；
- unknown/interrupted 不自动重发：AD-07/AD-11 保留；
- 单 Store 所有者、原子提交：AD-05/AD-11 保留；
- 不承诺 exactly-once：未改变；
- 结果完整性/完成证据：AD-07 保留；
- `closeTask` 兼容：映射为取消 + archive，不伪造目标终态。

## 4. 仍然开放的设计项

以下不阻塞本轮的“一致性”结论，但阻塞对应实现：

1. `InputRequest` 的正式字段、ACP 能力探测和 Phase 2.3 状态/超时；
2. Artifact 的物理存储后端、跨 Workspace 传输和保留策略；
3. WorkspaceLease 的调度公平性、租约超时和崩溃恢复细节；
4. Controller 租约/超时是否需要，以及多 Controller 的明确禁止；
5. Message/Command 的传输、ACK、重投和订阅协议；
6. v2 legacy key 的迁移窗口和迁移 CLI 参数；
7. `Task.status` 兼容投影的弃用时间表。

## 5. 验证记录

- 只修改设计文档，未修改业务代码、Contracts、Store、Executor、ACP Transport 或测试；
- 未运行真实 DSH 或多用户测试；本报告是静态一致性审查；
- 已检查 AD-06 至 AD-11 与 Phase 1.1 的终态/unknown/Store 不变量无直接冲突；
- 已检查 Task 状态矩阵、Execution 矩阵、Lifecycle 矩阵中的终态/reopen/restore 规则一致；
- 已检查 Artifact ACL、Delegation 撤销、Controller 冻结、Event 游标和 requestKey 作用域之间没有未说明的自动继承；
- 已检查并行 Execution 与 mutex 的关系：数据模型可多 Execution，写并发由租约/隔离策略约束。

## 6. 最终判断

Phase 2.0.2 的六项修订已经消除了 Phase 2.0.1 中已知的设计级矛盾。可以继续做 Phase 2.1A 的身份/Workspace 设计评审；但 Phase 2.1B 的私有 Task、Artifact、并行 Execution 实现仍必须等待这些 AD 被独立审查接受。

本报告不代表代码实现通过，也不代替真实 DSH、多用户或权限测试。
