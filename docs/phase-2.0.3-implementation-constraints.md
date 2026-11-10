# Phase 2.0.3 Implementation Constraints：Phase 2.0 冻结补充

状态：**Phase 2.0 Frozen Design Baseline / Implementation Not Started**
日期：2026-11-10（Asia/Hong_Kong）
基线：`docs/phase-2.0.2-architecture-decisions.md`（提交 `4581990`）
范围：只处理三个实现前边界，不重新审查 AD-01 至 AD-11，不实现代码，不修改 Contracts、Store、Executor、ACP Transport 或测试。

本文件新增 **AD-12 至 AD-14**：

1. 授权检查与 Store 写入的原子性（关闭 AD-08 的 TOCTOU 窗口）；
2. WorkspaceLease 强制释放的 fencing / 进程停止证据（关闭 AD-11 的旧进程并发写风险）；
3. `interrupted` 的 Task 状态聚合与新一轮风险确认（修正 AD-07 的过渡）。

这三项通过后，Phase 2.0 设计可以正式冻结；本文件不开启 Phase 2.1A 或 2.1B 的实现。

## 0. 补充摘要

| ID | 主题 | 决定 |
|---|---|---|
| AD-12 | 授权/写入原子性 | 最终授权检查与对应状态写入在同一个 Store commit 边界内；入口检查只是提前拒绝，不是授权证明 |
| AD-13 | WorkspaceLease 安全释放 | 旧执行器停止证明、隔离快照或执行器强制 fencing 三者至少满足一项；否则只能隔离 Workspace，不能把租约交给新执行 |
| AD-14 | interrupted 聚合 | 没有 queued/running 即进入 awaiting_decision；interrupted 与 unknown 都是未解决风险，新一轮必须显式确认 |

## 1. AD-12：授权检查与状态写入的原子边界

### 1.1 问题

AD-08 要求命令在入口和提交前检查 `authorizationEpoch`。如果两次检查后、实际 Store 写入前发生撤权，仍可能出现：

```text
入口授权通过
  -> 管理员撤销 Delegation
  -> 提交前授权通过（旧快照）
  -> 写入 Execution/状态
```

只要“最终授权检查”和“状态变更”不是一个原子操作，两个独立检查只能缩小窗口，不能消除 TOCTOU。

### 1.2 决定

**授权状态必须与 Task/Execution/Artifact 变更在同一个单所有者 Store 的同一个原子 commit 中校验。**

- v3 Store 增加全局单调的 `authorizationRevision`（或等价的 authz epoch）。
- Principal 状态、Workspace membership、DelegationGrant、权限策略的每次变更都递增 `authorizationRevision`。
- `AuthorizationContext` 至少冻结：

```text
actorPrincipalId
requestedByPrincipalId | null
delegationId | null
authorizationRevision
principalVersion
membershipVersion
delegationVersion
workspacePolicyVersion
```

- 写命令的 Store commit 同时携带：
  - `expectedRevision`（数据快照 revision）；
  - `expectedAuthorizationRevision`；
  - 当前 actor/delegation 的版本。
- Store 在**同一个 commit 校验**：
  1. 数据 revision 未变；
  2. `authorizationRevision` 未变；
  3. Principal/membership/delegation 仍有效；
  4. 请求 scope 仍被允许；
  5. 数据变更合法。

  任一失败返回 `AUTHORIZATION_STALE` 或 `AUTHORIZATION_REVOKED`，不产生任何 Task/Execution/Request/Event 写入。

- 最终授权检查与对应状态写入必须在同一个 **Store 单所有者临界区** 内完成；不得先调用一个独立 `authorize()` 再调用 `commit()`。
- 入口检查可以保留，用于快速拒绝和减少无意义工作，但不构成授权证明。

### 1.3 线性化点

授权边界以 Store commit 成功为线性化点：

- 如果撤权 commit 先成功，后续写入因 authz revision 或 grant 状态失败；
- 如果写入 commit 先成功，该操作在撤权前已被授权；随后撤权按 AD-08 冻结 Controller，但不追溯撤销已提交的 Execution 记录；
- 已经提交的 Execution 仍按真实 ACP 证据结算；撤权后不再允许新的控制命令。

禁止的实现方式：

- 先读 Identity Store 校验，再写 Task Store；
- 先发送 ACP/transport，再补授权/状态；
- 用调用方传入的 `principalId`、`delegationId` 或 `authorized=true` 作为授权证明；
- 只在 Hub 入口做一次检查。

### 1.4 撤权事务

撤销 Delegation 本身也必须是一个原子事务，至少同时写入：

```text
DelegationGrant.revokedAt
authorizationRevision + 1
Task.controlState = frozen（受影响的 Task）
Task.controllerFrozenReason / controllerFrozenAt
受影响的 ArtifactGrant 撤销（AD-06）
delegation.revoked / controller.frozen 事件
```

这些变更必须全部成功或全部不生效。不能先撤 grant、后冻结 Task，也不能先冻结 Controller、后撤 grant，否则中间窗口仍可能被命令利用。

### 1.5 AD-12 验收条件

设计评审通过前，不接受以下实现：

- 授权检查与 commit 分离；
- 授权状态不在同一个 Store 事务中；
- 入口通过即发送 transport；
- 撤权/冻结/grant 撤销分成多个独立事务；
- 通过客户端 payload 传递 actor 身份。

## 2. AD-13：WorkspaceLease 强制释放的安全前提

### 2.1 问题

AD-11 的租约只能保证 Hub 不再把同一 Workspace 租给第二个 Execution，不能保证旧 DSH 进程已经停止写文件。

`unknown/interrupted` 时冻结租约、管理员显式 release，并不能证明旧执行器已退出。Hub 断连后旧进程可能仍在运行；若此时把租约交给新 Execution，两个执行器会同时写同一 Workspace。

“确认旧 Execution 不会自动重发”不等于“旧进程已经停止”或“旧进程的后续写入会被拒绝”。

### 2.2 决定

强制释放租约**不再以人工确认作为充分条件**。安全条件分为两类：

**A. 允许新的可写执行：**

1. **进程终止证明**：旧执行器及其工具/子进程已全部终止，且可提供 OS 级证据（进程树退出、PID 不再存在、退出码/信号、观察时间）；
2. **工作区隔离**：新执行使用 `git-worktree`/`directory-copy` 等独立副本，旧进程即使继续写原始目录也不会写新副本；
3. **fencing 生效**：执行器或存储层能拒绝携带旧 `fencingToken`/旧 `workspaceEpoch` 的写入，并且该拒绝能力已经验证。

**B. 允许释放/复用同一 Workspace 写租约：**

只有第 1 项（进程终止证明）或第 3 项（实际 fencing）可以释放旧租约。第 2 项工作区隔离只允许在新副本执行，**旧租约保持 frozen**，不能交给新执行器复用原 Workspace。

如果三类都不满足，只能将 Workspace 标为 `quarantined`，禁止新的可写 Execution；不得把租约交给新执行器，也不得把“管理员确认”当作安全释放。

### 2.3 Workspace epoch / fencing token

```text
Workspace:
  writeEpoch              单调递增，租约获取/强制释放/隔离恢复时更新

WorkspaceWriteLease:
  leaseId
  workspaceId
  executionId
  fencingToken            {workspaceId, epoch, leaseId, executionId}
  state                   held | releasing | released | frozen | quarantined
  acquiredAt
  expiresAt
  releaseEvidence         process_tree_terminated | fencing_enforced（workspace_isolated 不允许释放旧租约）

Execution.workspaceSnapshot:
  kind                    mutex | git-worktree | directory-copy | shared-readonly
  workspaceId
  baseRevision
  leaseId?                mutex 时必填
  fencingToken?           mutex 时必填
```

规则：

- 每次获得写租约时递增 `writeEpoch`，签发新的 `fencingToken`。
- 旧 token 只有在执行器/存储层**实际执行** token 校验时才具有安全意义；仅在 Hub 记录 token 属于“元数据”，不算 fencing。
- `kind=mutex` 必须同时有 `leaseId` 和 `fencingToken`；如果执行器不支持强制 fencing，`fencingToken` 只能用于诊断，不能用于证明安全。
- `kind=git-worktree`/`directory-copy` 使用独立副本，不持有 Workspace 写租约；旧进程写原始目录不会影响新副本，但旧进程的终止/清理仍是独立风险。
- `shared-readonly` 只有在执行器明确证明不会写时才允许；不能靠 prompt 文案推断。

### 2.4 租约状态机

| 当前 | 事件 | 守卫 | 下一状态 | 说明 |
|---|---|---|---|---|
| held | Execution 终态，开始 Session/进程清理 | 无 unknown/cleanup 未决 | releasing | 不再允许新写入 |
| releasing | Session/进程清理完成 | 无 unknown/cleanup 未决 | released | 正常释放 |
| releasing | 清理失败/出现 unknown | 不清除证据 | frozen | 不自动释放 |
| held | 断连/unknown/清理失败 | 不清除证据 | frozen | 不自动释放 |
| frozen | 提供进程终止证明，或 fencing 实际验证通过 | 证据可验证 | released | 记录 releaseEvidence |
| frozen | 新执行使用独立 worktree/copy | 新 workspaceSnapshot 独立 | frozen（旧租约保持） | 新执行不使用旧 Workspace 写租约；旧租约仍需证据释放 |
| frozen | 无证据，管理员强制 release | — | quarantined | 禁止新可写执行 |
| quarantined | 离线确认进程已停止/存储修复 | 审计证据 | held/released | 需要显式恢复 Workspace |
| released | 新 Execution 获取租约 | 新 epoch/fencingToken | held | 旧 token 失效（若 fencing 生效） |

- `frozen` 不是自动可恢复状态；不能因时间过去或 Hub 重启而自动释放。
- `quarantined` 是 Workspace 级状态，不是 Task/Execution 状态；Task 可以仍为 awaiting_decision，但该 Workspace 不允许新的写执行。
- `releaseWorkspaceLease` 的强制路径必须提交 typed `releaseEvidence`；只有“管理员说可以”没有证据时返回 `UNSAFE_RELEASE`。
- 无法验证进程树是否停止时，不能使用 `process_tree_terminated` 证据；应退化为隔离副本或 quarantine。

### 2.5 与 DSH ACP 当前能力的关系

Phase 1.1 已确认：

- ACP 断连不等于子进程停止；
- 真实 kill 只证明 dispatch intent 后中断，不证明远端执行或工具副作用；
- 没有可靠的远端执行终止查询或写入 fencing 协议。

因此 Phase 2.0.3 的默认结论是：

- DSH ACP 当前不能单独提供“旧进程已停止”的强证明；
- 没有 worktree/copy 隔离时，`mutex` 下发生 unknown 只能 `frozen` 或 `quarantined`，不能安全 reuse；
- 只有 OS 级进程树终止证据，或执行器/存储层实际验证的 fencing，才允许 release；
- 人工确认只能用于启动离线恢复流程，不能直接成为 `released` 证据。

### 2.6 AD-13 验收条件

设计评审通过前，不接受以下实现：

- `frozen` 租约按超时自动释放；
- `releaseWorkspaceLease(force:true)` 仅凭 actor/note 就释放；
- 把 Hub 断连当作旧进程已停止；
- 在 `mutex` 下引入第二个写执行器但没有 fencing/隔离；
- 用 `fencingToken` 字段冒充实际 fencing，而没有执行器/存储层的拒绝验证。

## 3. AD-14：`interrupted` 的 Task 聚合和风险确认

### 3.1 问题

AD-07 的 Task 矩阵写的是：

> 最后一个 queued/running Execution 进入终态或 unknown 后，Task 进入 awaiting_decision。

但 Execution 可以先从 `running` 变成 `interrupted`，再变成 `unknown`。在 `interrupted` 期间：

- 已经没有 queued/running Execution；
- `interrupted` 不是终态，Task 可能仍停在 `active`；
- 如果只等 terminal/unknown，Task 会错误地保持 active。

### 3.2 决定

**Task 聚合只看是否存在 `queued`/`running` Execution，不等待 interrupted 变成 unknown。**

规则：

1. `activeExecutionIds` 只包含 `queued`/`running`。
2. `unresolvedExecutionIds` 包含 `interrupted` 和 `unknown`。
3. 当最后一个 `queued`/`running` Execution 离开（无论变成 terminal、interrupted 还是 unknown），且没有显式目标决定：
   - Task `goalStatus` 立即进入 `awaiting_decision`；
   - `interrupted`/`unknown` 继续通过 `executionSummary` 和 `hasIntegrityRisk` 暴露；
   - 不等待 interrupted -> unknown 的后续迁移。
4. 之后 `interrupted -> unknown` 只更新 risk/summary，不再次改变 Task goalStatus；Task 已经是 awaiting_decision。
5. `Task.status` 读取投影仍按 goalStatus/lifecycle 计算，不新增 `interrupted` 或 `unknown` 的 Task goalStatus。

### 3.3 新一轮的风险确认

从 `awaiting_decision` 恢复到 `active` 时，必须把 `interrupted` 和 `unknown` 都视为未解决风险：

- 新 `startExecution` 必须显式确认**全部** `unresolvedExecutionIds`（包括 interrupted 和 unknown）；
- `dispatchQueued` 如果会开启新的活动执行，也必须完成同样的风险确认；不能绕过；
- `duplicateExecutionRisk` 保持 true，不能因 interrupted 后续变成 unknown 而清除；
- 风险确认必须是显式命令字段/事件，记录确认人、时间、ID 集合、风险说明；不能默认空数组；
- 未确认时返回 `UNKNOWN_EXECUTION`/`UNRESOLVED_EXECUTION`（具体错误码在 Contracts 冻结时确定），不创建新 Execution、不发送 transport。

`completeTask`/`failTask` 仍要求记录未解决风险；`completeTask` 不能把 interrupted/unknown 静默忽略。是否允许“带风险完成”由 Owner/Controller 显式决定，并在事件中记录，不得自动。

### 3.4 更新后的 Task 聚合表

| 当前 Execution 集合 | Task goalStatus | executionSummary |
|---|---|---|
| 无 Execution | open | 空 |
| 任一 queued/running | active | active IDs + risks |
| 无 queued/running，且无终态/unknown/interrupted | open | 空 |
| 无 queued/running，有 terminal/interrupted/unknown，无显式目标决定 | awaiting_decision | terminal/unresolved/risk |
| 有显式 completed 决定，selected completed | completed | 保留历史/risk |
| 有显式 failed/cancelled 决定 | failed/cancelled | 保留历史/risk |

- `interrupted` 与 `unknown` 都使 `hasIntegrityRisk=true`；两者都不能自动转为 completed。
- `interrupted` 不是 Task 状态；它只影响 Execution 和 summary。
- 如果 `interrupted -> unknown` 发生在 Task 已 awaiting_decision 后，Task 不再次迁移，只更新 summary/risk。

### 3.5 AD-14 验收条件

设计评审通过前，不接受以下实现：

- Task 在最后一个 running 变 interrupted 后仍停留 active；
- 等待 interrupted 变 unknown 才更新 Task；
- `awaiting_decision -> active` 只确认 unknown、不确认 interrupted；
- 把 interrupted 当作 terminal 或自动成功；
- 自动清空 `duplicateExecutionRisk`。

## 4. Phase 2.0 冻结声明

AD-12、AD-13、AD-14 与 AD-01 至 AD-11 合并后，Phase 2.0 设计基线按以下条件冻结：

| 条件 | 状态 |
|---|---|
| 授权检查与写入在同一 Store commit 边界 | AD-12 冻结 |
| 无安全证据不得强制复用 Workspace 写租约 | AD-13 冻结 |
| interrupted 在无 queued/running 时进入 awaiting_decision，并与 unknown 一样要求风险确认 | AD-14 冻结 |
| 不引入无身份 fallback、无自动重试、无伪终态 | 保留 Phase 1.1 不变量 |
| 文档不修改业务代码/Contracts/Store/Executor/Transport | 本次仅设计补充 |

### 4.1 Phase 2.1A 的开始条件

Phase 2.1A（Identity & Workspace）可以开始**设计评审**，但实现前必须先确认：

- Principal/Membership/Delegation 与 `authorizationRevision` 的字段和原子提交契约；
- 授权上下文不依赖客户端自报身份；
- `config/windows.json` / 本地 stdio 兼容模式有明确的 bootstrap Principal，不引入匿名 fallback。

### 4.2 Phase 2.1B 的开始条件

Phase 2.1B（Task / Artifact / 私有可见性）仍暂不开始，除 AD-01 至 AD-14 外还需要：

- v3 Store/API 迁移契约通过评审；
- Artifact 创建/授权快照事务与 AD-06 一致；
- `selectedExecutionId`、Task goalStatus、lifecycle 矩阵与实际 Store 约束一致；
- WorkspaceLease 的强制释放路径有可验证证据，或明确只能 quarantine。

## 5. 不修改范围

- 不修改 `packages/`、`apps/`、`scripts/`、`test/`、`config/`、`logs/`；
- 不改 Contracts、Store、Executor、ACP Transport 或状态机代码；
- 不实现 AD-12 至 AD-14；
- 不接入 Cyrene、AstrBot、QQ/NapCat 或 Bilibili；
- 不进入 Phase 2.1A/2.1B 实现。

## 6. 结论

三个补充点把 Phase 2.0.2 剩余的实现前风险收敛为可检查约束：

1. **授权**：最终检查与写入必须同一原子 commit；入口检查不够。
2. **租约**：没有旧进程停止证明、隔离副本或实际 fencing，不得强制释放写租约；只能 quarantine。
3. **interrupted**：Task 聚合只看 queued/running；interrupted 与 unknown 都是未解决风险，新一轮必须显式确认。

本文件完成后，Phase 2.0 设计基线正式冻结；不开始 Phase 2.1A/2.1B 实现。Phase 2.1A 可以开始设计评审，Phase 2.1B 仍暂不开始。
