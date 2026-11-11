# Phase 2.0.2 Architecture Decisions：一致性修订

状态：**Proposed Design Baseline / 独立审查候选**
日期：2026-11-10（Asia/Hong_Kong）
基线：`docs/phase-2.0.1-architecture-decisions.md`（提交 `ad736e5`）
审查报告：`docs/phase-2.0.2-design-consistency-review.md`
范围：只修订设计文档，不实现代码，不修改 Contracts、Store、Executor、ACP Transport 或测试。

> **Phase 2.0.3 补充：** AD-12 至 AD-14 见 `docs/phase-2.0.3-implementation-constraints.md`。AD-12 收紧 AD-08 的授权检查，AD-13 收紧 AD-11 的强制释放，AD-14 修正 AD-07 的 interrupted 聚合；与本文件冲突时以 2.0.3 为准。
>
> **Phase 2.1A.5 修订（AD-06-R1）：** 用户已选择 Authority Version + Revocation Fence + Effective 派生方案。Controller 冻结的权威效果与撤权 Fence 同事务提交；snapshot controller ArtifactGrant 由 Fence 立即失效，物理 `revokedAt` 可异步物化。显式 Controller 转移、显式 ArtifactGrant、owner/visibility 变化仍按本文件原有独立规则处理，不因本次修订扩大为“所有 Artifact ACL 都可延迟”。详见 `docs/phase-2.1A.5-authority-fence-decision-closure.md` 第 2 节。

本文件新增 **AD-06 至 AD-11**，并修正 Phase 2.0.1 中容易产生隐性矛盾的六处边界：

1. Artifact ACL 与 Task 角色变化的关系；
2. Task / Execution / Lifecycle 的完整状态迁移矩阵；
3. Delegation 撤销后的权限失效和 Controller 冻结；
4. Event 的 Workspace/System 归属与游标规则；
5. requestKey 的委托身份作用域；
6. 并行 Execution 与 Workspace mutex 的关系。

如本文件与 Phase 2.0.1 冲突，以本文件为准。Phase 2.0.1 的 AD-01 至 AD-05 在未被本文件修改的部分继续有效。

## 0. 修订摘要

| AD | 主题 | 关键决定 |
|---|---|---|
| AD-06 | Artifact ACL 与 Task 角色变化 | Artifact 使用创建时 ACL 快照；Task 角色变化不自动改变 owner/visibility；仅 Controller 变更和 Controller 冻结有定义中的自动 grant 同步 |
| AD-07 | Task / Execution / Lifecycle 矩阵 | 三个状态机分离；补齐允许/拒绝迁移；Execution 终态不可逆；unknown 不是 Task goalStatus |
| AD-08 | Delegation 撤销与 Controller 冻结 | revoke/expire/membership loss 立即失效授权；Controller 进入 frozen；运行中 Execution 不自动取消；Owner/Admin 显式接管 |
| AD-09 | Event 归属与游标 | workspace event 与 system event 分流；全局 sequence + workspace/system 作用域游标；每次读取重新授权 |
| AD-10 | requestKey 委托作用域 | 作用域为 workspace + actor + delegation + operation + client key；撤销后重放拒绝，不返回旧结果 |
| AD-11 | 并行 Execution 与 Workspace mutex | 数据模型允许多个 Execution；mutex 是每 Workspace 的写租约，默认只允许一个 running；worktree/copy 才放开并行写 |

## 1. AD-06：Artifact ACL 与 Task 角色变化

### 1.1 要解决的问题

Phase 2.0.1 的 AD-04 同时写了：

- Artifact 权限是创建时快照，不动态继承；
- private Artifact 可由“来源 Task 的 owner/requestedBy/controller”读取。

后一项是读取时按当前 Task 角色判断，若 Task owner/controller 转移，Artifact 的访问权会随之变化，实际上又变成动态继承。必须明确哪些角色变化会改变 Artifact，哪些不会。

### 1.2 决定

Artifact 的权限在创建事务中物化：

```text
Artifact.ownerPrincipalId = 来源 Task 的 ownerPrincipalId
Artifact.visibility       = 来源 Task 创建时的 visibility
ArtifactGrant[]:
  - requestedBy（若非 owner）  scope=read, origin=task-snapshot-requester
  - controller（若非 owner/requester） scope=read, origin=task-snapshot-controller
  - 其他显式授权              origin=explicit
```

- **读取时不再查询当前 Task 角色**；只使用 Artifact 自身的 owner、visibility、ArtifactGrant 和 Workspace Owner/Admin 审计权限。
- Phase 2.1B 只实现 principal grant；`granteeTaskId` 作为未来 task-scoped 授权预留，必须另行定义成员快照，不能直接按当前 Task 成员动态展开。
- Task 的 owner/requestedBy/controller 是创建时的“种子”，不是长期动态授权。
- Task 角色变化的影响：

| Task 变化 | Artifact owner | requester grant | controller grant | visibility | 说明 |
|---|---|---|---|---|---|
| owner 转移 | 不变 | 不变 | 不变 | 不变 | 新 owner 不自动获得 Artifact；发送 `artifact.access_review_required`，由 Artifact owner/Workspace Admin 显式 grant 或 transfer |
| controller 转移 | 不变 | 不变 | 旧 controller 的 `task-snapshot-controller` grant 在同一事务撤销；新 controller 创建新 read grant | 不变 | 这是唯一的自动 controller 同步，避免旧 controller 保留 Artifact 访问 |
| controller 冻结 | 不变 | 不变 | `task-snapshot-controller` grant 撤销 | 不变 | AD-08 的冻结必须同时撤销其 Artifact 读取 |
| requestedBy 变化 | 不允许 | 不变 | 不变 | 不变 | requestedBy 是不可变审计字段 |
| Task visibility 变化 | 不变 | 不变 | 不变 | 不变 | 只发审核事件；要扩大/缩小 Artifact 必须显式操作 |
| Task archive/delete | 不变 | 不变 | 不变 | 不变 | Artifact 有独立生命周期，不随 Task 删除 |
| Task 恢复 | 不变 | 不变 | 不变 | 不变 | 不自动恢复已撤销的 grant |

- Controller 冻结行的“撤销”首先指 effective 授权立即无效；`ArtifactGrant.revokedAt` 的物理物化按 1.3/AD-06-R1 异步完成，不等待 reconcile 才拒绝读取。
- Task owner 转移后，旧 owner 仍是 Artifact owner；这是有意的“Artifact 独立所有权”。需要转移时使用显式 `transferArtifact`。
- Controller 转移的自动同步只针对 `origin=task-snapshot-controller` 的 grant；显式授予旧 controller 的 grant 不会自动撤销，必须显式 revoke。
- Artifact owner 和 grantee 必须是 active Workspace 成员；成员被撤销后访问自动暂停，不能靠旧的 owner 字段继续读取。Workspace Owner/Admin 可显式转移 Artifact owner。
- Workspace Owner/Admin 始终有审计读取权，但不能绕过 Artifact 的写入/分享限制；管理操作必须审计。
- Artifact 所有权独立于 Task controller。Controller 冻结不会静默转移 Artifact owner；如果被冻结的 controller 同时是 Artifact owner，Workspace Owner/Admin 必须显式审核/转移，不能把“冻结控制权”误认为“自动收回 Artifact 所有权”。

### 1.3 并发和事务（AD-06-R1）

- 创建 Artifact、写入 owner/visibility、创建 requester/controller grants 必须在**同一事务**完成；不能出现 Artifact 已存在但 ACL 未建立的窗口。
- **显式 Controller 转移**：controller 字段、旧 controller snapshot Grant 撤销、新 controller snapshot Grant 创建仍必须在同一事务；失败则都不生效。
- **Controller 冻结/撤权**：权威撤权记录、authority version、`authorizationRevision` 和审计事件必须在同一 commit；`origin=task-snapshot-controller` 的 ArtifactGrant 因 Fence/authority version 立即 effective 无效，即使 `revokedAt` 尚未物化。Fence/reconcile 只负责把 `revokedAt` 写到投影，reconcile 未完成不能成为继续读取的理由。
- **显式 ArtifactGrant 操作**（grant/revoke）、Artifact owner 转移、`Task.visibility` 变化、Task archive/delete 仍按本文件其他规则独立处理；不得以“等待 reconcile”为由延迟这些显式操作的授权效果。
- `Task.visibility` 改变只追加 `artifact.access_review_required` 事件，不修改 Artifact。
- 读取时若 Artifact ACL 与当前 Task 角色不一致，不自动修正；返回 Artifact 自己的 ACL 结果。

### 1.4 结论

“创建时快照”现在有一致的可执行含义：**创建时物化 owner/visibility/grant，之后只有显式的 Artifact 操作或明确列出的 Controller 同步会改变它。** Task 角色变化不再隐式改变 Artifact 权限。

## 2. AD-07：Task / Execution / Lifecycle 状态迁移矩阵

### 2.1 Task goalStatus 矩阵

状态集合：

```text
open | active | awaiting_decision | completed | failed | cancelled
```

| 当前 | 命令/事件 | 守卫 | 下一 goalStatus | 事件 |
|---|---|---|---|---|
| — | 创建 Task，无 Execution | 合法 Workspace/owner/controller | open | `task.created` |
| open | 首个 Execution 进入 queued/running | Task live、controller 有效 | active | `execution.created` 或 `execution.dispatched` |
| active | 最后一个 queued/running Execution 离开，变为 terminal/interrupted/unknown | 无显式目标决定 | awaiting_decision | `task.awaiting_decision` |
| awaiting_decision | 新 Execution 进入 queued/running | 无未承认 unknown 风险或显式承认 | active | `execution.created` |
| open/active/awaiting_decision | cancelTask | controller/owner/admin；取消所有 queued/running Execution | cancelled | `task.cancelled` |
| awaiting_decision | completeTask | selected 指向 completed；无 queued/running；风险已记录 | completed | `task.completed` |
| awaiting_decision | failTask | 无 queued/running；理由/风险已记录 | failed | `task.failed` |
| completed/failed/cancelled | 普通 Execution 事件 | — | 不迁移 | 拒绝 `INVALID_TASK_TRANSITION` |
| completed/failed/cancelled | 新 Execution | — | 不迁移 | 创建新 Task，不能复用旧 goalStatus |

补充规则：

- `active` 允许同时有多个 queued/running Execution；`completeTask`/`failTask` 不得在 active 时执行，必须先取消/结算。
- `unknown`/`interrupted` 不属于 goalStatus；它们进入 `executionSummary.unresolvedExecutionIds` 和 `hasIntegrityRisk`。没有活动 Execution 时，Task 进入 `awaiting_decision`，而不是 `unknown`。
- `completeTask` 必须指定 `selectedExecutionId`，且该 Execution 为 `completed`；unknown 风险必须在决定事件中记录，不能被静默忽略。
- `cancelTask` 是显式目标取消；`cancelExecution` 只影响一个 Execution，不自动改变 goalStatus。

### 2.2 Execution 状态矩阵

状态集合（v3 当前范围）：

```text
queued | running | completed | failed | cancelled | interrupted | unknown
```

| 当前 | 事件/命令 | 守卫 | 下一状态 | 证据/字段 |
|---|---|---|---|---|
| — | 创建 Execution | Task live，controller 有效 | queued | prompt/requestKey/输入快照 |
| queued | dispatch intent 已持久化并开始发送 | 工作区租约/隔离已获得 | running | `submission=dispatch_intent` |
| queued | 本地取消，证明未发送 | 无 dispatch_intent | cancelled | `local_not_submitted` |
| queued | 恢复 | 未发送 | queued | 不自动启动 |
| running | ACP `end_turn` 且结果完整性合格 | 输出 flush、终态事务成功 | completed | completionEvidence + observed_complete |
| running | 确认的执行错误 | 终态事务成功 | failed | failure evidence |
| running | ACP `cancelled` | 取消证据 | cancelled | cancel.confirmedAt |
| running | 连接/进程丢失 | 无终态收据 | interrupted | disconnect diagnostics |
| running | 超时/断连后不能确认终态 | 不得伪造终态 | unknown | RESULT_UNAVAILABLE |
| interrupted | 恢复后仍无终态证据 | 不自动重发 | unknown | diagnostic |
| completed/failed/cancelled/unknown | 任何自动重试 | — | 拒绝 | 新 Execution + 新 requestKey |

补充规则：

- `completed`/`failed`/`cancelled`/`unknown` 是 v3 Execution 的终态；终态不可改写。
- `interrupted` 不是最终结果；恢复只能转 `unknown` 或保持已提交终态，不能凭 Session 可恢复性转 completed。
- 取消请求（requestedAt）与确认（confirmedAt）分离；只有 cancelled 响应或证明未发送的本地取消可进入 cancelled。
- **`awaiting_input` 不进入 v3 Execution 状态。** Phase 2.3 的输入等待使用独立的 `InputRequest` 实体；Execution 仍是 `running`，直到输入返回或终态。这样不需要在 Phase 2.1/2.2 提前实现无法支持的 ACP 运行中输入。

### 2.3 Lifecycle 矩阵

状态集合：

```text
live | archived | deleted
```

| 当前 | 命令 | 守卫 | 下一 lifecycle | 说明 |
|---|---|---|---|---|
| live | archiveTask | 无 queued/running Execution；controller/owner/admin | archived | goalStatus 不变 |
| live | deleteTask | 无 queued/running Execution；owner/admin | deleted | 软删除 |
| archived | restoreTask | owner/admin | live | goalStatus 不变；不自动执行 |
| archived | deleteTask | owner/admin | deleted | 软删除 |
| deleted | restoreTask | owner/admin | 恢复前的 lifecycle（live/archived） | 需要记录恢复目标 |
| archived/deleted | 新 Execution | — | 拒绝 | 先 restore |
| archived/deleted | archive/delete 重复 | — | 幂等或拒绝 | 不应产生重复生命周期事件 |

- `deleted` Task 需要持久化 `deletedFrom=live|archived`；restore 回到该 lifecycle，不能猜测。
- `archived`/`deleted` 不改变 goalStatus；restore 也不会把 completed/failed/cancelled 重新打开。
- 归档/删除不会删除 Execution、Artifact 或事件；Artifact 有独立生命周期。
- `closeTask` 是 v2 兼容入口：取消活动 Execution，再 archiveTask；新 API 使用 archiveTask/deleteTask。

### 2.4 Task 读写投影

```text
Task.status 读取投影 =
  archived  if lifecycle=archived
  deleted   if lifecycle=deleted
  goalStatus otherwise

executionSummary =
  activeExecutionIds = queued + running
  unresolvedExecutionIds = unknown + interrupted
  latestExecutionId = 最近创建
  selectedExecutionId = 显式选择
  hasIntegrityRisk = 未确认 alert 或 duplicate risk
```

`Task.status` 是兼容展示值，不是新的权威状态；写操作必须基于 `goalStatus` + `lifecycle` + `controlState` 联合判断。

## 3. AD-08：Delegation 撤销与 Controller 冻结

### 3.1 触发条件

以下任一情况立即使相关 `DelegationGrant` 失效：

- `DelegationGrant.revokedAt` 被设置；
- `expiresAt` 到期；
- delegator 或 delegate 的 Workspace 成员被撤销；
- delegator 或 delegate 的 Principal 被 disabled；
- grant scope 被移除；
- 其他显式撤销策略。

### 3.2 失效范围

1. 所有使用该 grant 的认证上下文、短期 token、订阅和未开始命令立即失效；新命令必须重新认证。
2. 该 grant 关联的 Task：
   - `effectiveControlState` 立即变为 `frozen`；stored `Task.controlState` 是可滞后物化 cache；
   - `controllerFrozenReason=delegation_revoked|delegation_expired|membership_revoked|principal_disabled|scope_revoked`；
   - `controllerFrozenAt` 记录时间；
   - `controllerPrincipalId` 保留用于审计，但不再有执行/取消/选择/完成/转移权限；
   - `controllerDelegationId` 指向失效 grant；
   - controller 的 Principal/Membership/Delegation authority version 绑定失效。
3. **不自动取消正在运行的 Execution。** Hub/Executor 继续把已开始的执行带到终态或 unknown，结果仍持久化；Agent 立即失去读取、订阅和 Artifact grant，不能再发命令。

Task 需要增加以下控制字段：

```text
delegationId             创建 Task 时的委托来源（可空）
controllerDelegationId   当前 Controller 的委托来源（可空）
controlState             active | frozen（stored cache；effective 由 authority version 派生）
controllerFrozenReason
controllerFrozenAt
```
4. queued Execution 保持 queued，不自动 dispatch；Owner/Admin 可以取消、重新分配或等待新的合法 controller。
5. 该 controller 的 `origin=task-snapshot-controller` ArtifactGrant 立即 effective 无效；`revokedAt` 的物理物化可异步完成。其他显式 grants 保留，除非单独撤销。
6. 该 grant 相关的事件订阅和游标失效；后续读取返回 `AUTHORIZATION_REVOKED`，不能返回旧数据。

### 3.3 Controller 冻结的语义

```text
Task.controlState = active | frozen
controllerFrozenReason
controllerFrozenAt
```

- `frozen` 只冻结控制/写入，不改变 goalStatus 或 lifecycle；
- `frozen` Task 仍可被 Owner/Admin 读取和审计；
- controller Agent 失去由该 controller 身份派生的 private Task 读取权；如果它同时是 Task owner/requestedBy 或持有独立有效 grant，按 AD-03 保留相应权限，但不能再使用 controller 权限；
- 运行中 Execution 的结果继续由 Hub 保存，但不推送给已撤销的 Agent；
- Owner/Admin 可以显式 `transferController`；v3 不暴露同一 controller 的 `unfreezeController`。恢复控制必须重新绑定新的有效 controller/authority version，并产生审计事件；
- 撤销 grant 不等于自动恢复旧的 controller；必须显式转移。

### 3.4 竞态：命令在执行中撤权

- 每个认证上下文携带 `authorizationEpoch`；`DelegationGrant`、成员关系或 Principal 状态变化时递增。
- 入口检查可以快速拒绝，但不是授权证明；最终授权检查必须与状态写入在同一个 Store commit 中完成（AD-12）。epoch/grant 已变化时返回 `AUTHORIZATION_REVOKED`/`AUTHORIZATION_STALE`，不得产生任何状态写入。
- 已经进入 Executor 的 prompt 不因撤权而被伪造取消；其终态仍按真实证据记录。
- 如果撤销发生在输出写入过程中，Hub 可以继续完成该 Execution 的内部持久化，但不能再把通知投递给被撤销主体。

### 3.5 审计

必须记录：

```text
delegation.revoked / delegation.expired
controller.frozen
controller.unfrozen
controller.transferred
artifact.grant_changed
```

事件包含 actor、delegationId、taskId、旧/新 controller、reason、时间；不得包含私有结果正文。

## 4. AD-09：Event 的 Workspace/System 归属与游标

### 4.1 Event 结构

```text
eventId
sequence             全局单调递增；系统内审计顺序
scope                workspace | system
workspaceId          workspace 必填；system 必须为 null
type
schemaVersion
actorPrincipalId     可空；system 事件使用 system principal
source               user | agent | hub | executor | system
taskId               可空
executionId          可空
artifactId           可空
correlationId        可空
causationId          可空
audience             tenant | system | admin
time
data                 只放 ID/状态/摘要，不放累积结果正文
```

### 4.2 归属规则

- `scope=workspace`：必须有 `workspaceId`，只能属于一个 Workspace；Task/Execution/Artifact 事件必须带上对应 ID。
- `scope=system`：`workspaceId=null`，用于 Principal、Workspace 创建/删除、权限系统、迁移、Hub 生命周期等全局事实；不得包含租户私有内容。
- `audience=tenant` 的事件可进入 Workspace 流；`audience=system/admin` 的事件只进入系统/管理流。
- 混合事件（例如 Workspace 创建）只能选择一个 scope；如果既需要系统审计又需要 Workspace 可见，发布两条有 `correlationId` 关联的事件，而不是让一条事件跨 scope。
- 事件不可变；`eventId` 稳定且不复用；`schemaVersion` 随 payload 演进。

### 4.3 游标规则

API 形态（v3）：

```text
getEvents({scope, workspaceId?, afterSequence, limit})
subscribeEvents({scope, workspaceId?, afterSequence}, listener)
```

- 游标是 `{scope, workspaceId, sequence}`；`scope=workspace` 时 `workspaceId` 必填，`scope=system` 时 workspaceId 必须为 null。
- `sequence` 是全局单调值；不同 Workspace 的事件序列会留下全局空洞，客户端不能把“连续”当作无丢失保证。
- 每次读取/推送都重新执行授权，游标本身不授予任何权限。
- 成员被撤销、Workspace 被禁用或 Task 变为不可读时，对应订阅立即失效；后续调用返回 `AUTHORIZATION_REVOKED`，不能静默返回空列表。
- 游标不能跨 Workspace 复用；改变 workspaceId 必须重新建立游标。
- `limit` 有上限；`afterSequence` 只能前进；过期归档的游标返回 `CURSOR_EXPIRED`。
- system 流只允许 system principal 或明确的管理员 principal；普通 Workspace 成员不能读取。
- 事件读取仍需 Task/Artifact 可见性检查；即使事件 data 只有 ID/状态，也不能通过事件探测 private Task 的存在。

### 4.4 迁移和兼容

- v2 的 `DomainEvent` 迁移为 `scope=workspace`，`workspaceId=legacy workspace`，`audience=tenant`，`correlationId/causationId=null`；不生成 system 事件。
- v2 的全局 `getEvents(afterSequence)` 不能直接复用为 v3 的无作用域读取；v2 兼容层只能返回迁移后的 legacy workspace 事件，并且仍要经过授权。
- 事件数量、eventId、sequence 保持；不重写历史事件内容。

## 5. AD-10：requestKey 的委托身份作用域

### 5.1 作用域

requestKey 的唯一作用域为：

```text
(workspaceId, actorPrincipalId, delegationId|null, operation, clientRequestKey)
```

- `actorPrincipalId`：实际认证调用者（User 或 Agent）；
- `delegationId`：委托访问时必填；Agent 自主操作为 null；用户直接操作为 null；
- `operation`：至少区分 `task.create` 与 `execution.create`/`execution.dispatch`；
- `clientRequestKey`：调用方提供的原字符串；
- 不使用 `requestedBy` 单独作为作用域；同一用户的不同委托由 delegationId 区分。

### 5.2 RequestRecord

```text
RequestRecord:
  scopeHash
  workspaceId
  actorPrincipalId
  delegationId
  operation
  clientRequestKey
  inputHash
  taskId
  executionId
  createdAt
  authorizationEpoch
```

### 5.3 重放规则

- 同一 scope + 相同 inputHash：返回原记录/Execution；但必须先重新检查当前授权。
- 同一 scope + 不同 inputHash：`IDEMPOTENCY_CONFLICT`。
- 不同 actor、不同 delegation、不同 operation 或不同 workspace：即使 clientRequestKey 相同，也是不同请求。
- grant 已撤销/过期、成员被撤销、Task 已不可读：重放返回 `AUTHORIZATION_REVOKED`，不得泄露旧 Execution 或结果。
- 知道 requestKey 不是授权凭证；不能凭 key 跨主体重放。
- 旧 v2 key 迁移后 `scope=legacy`，只能由迁移指定的 legacy principal 在显式迁移窗口重放；不能跨 Workspace 或新 Principal 重新解释。

### 5.4 为什么不用 requestedBy 作作用域

- Alice 可能通过多个 Agent 或多个 delegation 操作；仅用 Alice 作为 key 会让不同 Agent 互相覆盖/冲突。
- 同一 Agent 可能代表不同用户；仅用 Agent 会让不同委托共享幂等记录。
- 作用域必须稳定、不可伪造，并且能在撤权后重新检查；`(workspace, actor, delegation, operation, key)` 满足这些条件。

## 6. AD-11：并行 Execution 与 Workspace mutex

### 6.1 两个概念分离

- **并行 Execution（数据模型）**：一个 Task 可以有多个 Execution 记录，允许 queued 和（在支持隔离时）同时 running。
- **并发可写（运行策略）**：同一 Workspace 是否允许多个 Execution 同时写文件，由 `isolationPolicy` 和 `workspaceSnapshot` 决定。
- 数据模型允许多个 Execution，不等于默认允许并发写。

### 6.2 mutex 的定义

`isolationPolicy=mutex` 时：

```text
WorkspaceWriteLease:
  leaseId
  workspaceId
  executionId
  state              held | released | frozen
  acquiredAt
  expiresAt
  releasedAt
  reason
```

Store v3 增加 `workspaceLeases` 集合；租约记录必须和 Execution 的 dispatch/终态/清理事件可验证地关联，不能只存在于进程内存。

- 一个 Workspace 同时最多一个 `held` 租约；
- Execution 在持久化 dispatch_intent 之前必须获得租约；
- 终态提交且 Session/进程清理完成后才释放；
- unknown/interrupted 或清理未完成的 Execution **不得自动释放租约**；租约进入 `frozen`，阻止新的写执行，直到 AD-13 的进程终止证明/实际 fencing 完成，或 Workspace 进入 quarantine；
- 排队 Execution 保持 queued，按 FIFO/公平策略等待，不自动重试；
- `maxRunningPerWorkspace=1`（mutex 默认）；`maxConcurrent=8` 只是全局上限；
- 一个 Task 可以有多个 queued Execution，但 mutex 下不会同时 running。

### 6.3 隔离策略矩阵

| isolationPolicy | 同时 running | workspaceSnapshot | 工作区租约 | 备注 |
|---|---:|---|---|---|
| `mutex` | 1 / Workspace | `{kind:'mutex', leaseId, baseRevision}` | 必须 | 默认；最安全 |
| `git-worktree` | 可配置 >1 | `{kind:'git-worktree', worktreeRef, baseRevision}` | 不需要 | 每个 Execution 独立可写副本 |
| `directory-copy` | 可配置 >1 | `{kind:'directory-copy', copyRef, baseRevision}` | 不需要 | 每个 Execution 独立副本 |
| `shared-readonly` | 可配置 >1 | `{kind:'shared-readonly', baseRevision}` | 不需要 | 只有执行器明确证明只读；否则拒绝 |

- `git-worktree`/`directory-copy` 的基线快照和合并由上层 Agent/用户决定；Hub 不自动合并。
- `shared-readonly` 不能因为“任务看起来只读”而默认开启；必须是执行器能力声明和显式配置。
- 不支持隔离能力的执行器只能使用 mutex；Hub 不得为了“并行”让多个执行器写同一目录。

### 6.4 租约与崩溃恢复

- 租约获取/释放必须持久化，并与 Execution 状态/事件在同一 Store 事务或可验证的顺序中记录。
- 进程崩溃后，若 Execution 为 unknown/interrupted 或 Session 清理未确认，租约保持 `frozen`；不能自动释放给下一个执行者。
- Owner/Admin 显式释放时不能只确认“不会自动重发”；必须按 AD-13 提供旧执行器停止证明、隔离副本或实际 fencing，否则只能 quarantine。
- mutex 不改变 Phase 1.1 的 unknown 语义：等待租约不等于失败，也不自动创建新 Execution。

## 7. 一致性与验收检查

### 7.1 六项问题与决策对应

| 问题 | 决策 | 检查 |
|---|---|---|
| Artifact ACL 与 Task 角色变化 | AD-06 | Task owner/controller/visibility 变化不会无审计地改变 Artifact；controller 转移/冻结有明确同步 |
| 完整状态矩阵 | AD-07 | Task goalStatus、Execution 状态、lifecycle 的每条迁移都有守卫/拒绝规则 |
| Delegation 撤销/Controller 冻结 | AD-08 | 撤权立即失效授权；运行中 Execution 不伪造取消；Owner/Admin 显式恢复 |
| Event 归属/游标 | AD-09 | workspace/system 分流；每次读取重新授权；游标不授予权限 |
| requestKey 委托作用域 | AD-10 | actor + delegation + workspace + operation 决定幂等；撤销后拒绝重放 |
| 并行与 mutex | AD-11 | 数据模型多 Execution，mutex 下每 Workspace 只有一个 held lease/running |

### 7.2 必须保持的跨决策不变量

1. Task goalStatus、Execution 状态、lifecycle、controlState 是四个不同维度，不能用单一 `status` 代替写判断。
2. Artifact ACL 不按读取时的 Task 角色动态计算；Task 角色变化只能通过明确列出的同步/显式操作影响 Artifact。
3. 撤销委托不会自动伪造 Execution 终态；运行中的执行由 Hub 继续结算，Agent 失去后续权限。
4. 事件游标不是权限凭证；撤权后不能靠旧游标继续读取。
5. requestKey 只在明确的委托/主体/操作作用域内幂等；撤销后不返回旧结果。
6. 并行写必须由隔离能力或 Workspace mutex 支撑；没有隔离就排队。
7. 所有 unknown/interrupted 风险继续显式暴露，不自动重试、不自动完成。

## 8. 本轮明确不做

- 不实现 AD-06 至 AD-11 的任何代码；
- 不修改 Phase 1.1/2.0.1 Contracts、Store、Executor、ACP Transport、测试；
- 不实现 Artifact 存储后端、worktree 管理器、租约调度器或 Event 服务；
- 不决定 Message/Command 的传输协议、Automation、跨 Workspace 共享或 MFA；
- 不接入 Cyrene、AstrBot、QQ/NapCat 或 Bilibili。

## 9. 结论

Phase 2.0.2 的六项修订把 Phase 2.0.1 中容易隐含矛盾的地方转成了可检查的规则：

- Artifact 权限不再依赖读取时的 Task 角色；
- 状态迁移有了完整守卫和拒绝矩阵；
- 委托撤销有明确的 Controller 冻结和运行中执行处理；
- Event 有 Workspace/System 分流和可撤销游标；
- requestKey 有委托身份作用域；
- 并行 Execution 与 Workspace mutex 的关系明确为“数据模型并行、写并发受租约/隔离能力约束”。

这些仍是设计决策，需独立审查后再进入具体实现。
