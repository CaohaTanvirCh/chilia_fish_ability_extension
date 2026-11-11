# Phase 2.1A.5 Authority Fence Decision Closure & Reconciliation Completeness

状态：**AUTHORITY FENCE DECISION FROZEN (OD-11 OPTION A) / RECONCILE DESIGN READY / IMPLEMENTATION NOT APPROVED / OD-09 ARCHIVE OPEN**

日期：2026-11-11（Asia/Shanghai）

范围：docs-only。本文件不实现 Fence、Reconcile、授权逻辑、Store、API、Migration、Native Helper 或 ACP Adapter；不修改源码、测试、Schema、配置或运行时行为。

依据：

- 用户对 OD-11 的明确决策：接受 Authority Version + Revocation Fence + Effective 派生状态。
- `docs/phase-2.1A.2-contracts-v3-design.md`
- `docs/phase-2.1A.2-store-api-v3-design.md`
- `docs/phase-2.1A.2-design-review.md`
- `docs/phase-2.1A.3-implementation-readiness.md`
- `docs/phase-2.1A.4-revocation-model-closure.md`
- `docs/phase-2.0.2-architecture-decisions.md`（AD-06-R1）
- `docs/phase-2.0.3-implementation-constraints.md`（AD-12-R1）
- Phase 1.1 Store/Executor 代码与测试

---

## 0. 决策记录

### 0.1 OD-11 正式冻结

**OD-11 = DECIDED（方案 A）。**

用户已明确选择：

```text
Authority Version
+ AuthorityRevocationFence
+ Effective 派生
+ 派生投影异步物化
```

正式语义：

1. 撤权事务必须原子提交权威撤权记录（`AuthorityRevocationFence`）、相关授权版本变化、`authorizationRevision` 和审计事件。
2. 撤权事务成功提交后，旧授权立即失效。
3. 后续所有授权判断——读、写、Replay、Artifact 读取、Event 读取、Execution 控制——都必须检查权威撤权状态。
4. `effectivePermission`、`effectiveControlState`、ArtifactGrant 的物化状态是派生结果，不能反过来成为授权事实来源。
5. 派生状态允许异步 Reconcile；Reconcile 完成前不得放行已撤销权限。
6. Reconcile 失败、进程崩溃或部分完成时，权威 Fence 仍然有效；恢复后允许幂等重试。
7. 已经提交的 `dispatch_intent` 不因后续撤权被伪造为取消；运行中的 Execution 不自动取消；后续通知投递和结果读取仍须重新授权。

OD-11 不再标记为 `NEEDS_USER_DECISION`。本决策不代表批准进入代码实现阶段。

### 0.2 本次同时冻结的两项 AD 修订

- **AD-06-R1**：Controller 冻结的权威效果与 Fence 同事务；snapshot controller Grant 由 Fence 立即 effective 无效，物理 `revokedAt` 可异步物化。显式 Controller 转移仍同事务撤销旧 Grant/创建新 Grant。
- **AD-12-R1**：AD-12 的“同一 commit”指最终授权检查 + 本次权威状态变更（源 status/version、Fence、`authorizationRevision`、审计事件）；不要求同步写所有派生 `Task.controlState`/`ArtifactGrant.revokedAt`。

### 0.3 本文件不改变的范围

- 不批准 Phase 2.1B。
- 不实现 Fence/Reconcile/授权。
- 不改变 Artifact 的显式 grant/revoke、owner 转移、visibility 变化规则。
- 不改变 Phase 1.1 的 terminal/unknown/interrupted 事实。
- 不改变 OD-09 的归档状态；OD-09 独立待处理。

---

## 1. AD-12-R1：权威撤权与最终授权检查的原子性

### 1.1 同一 Store commit 的最小集合

撤权 commit 必须在同一个 Store 单所有者临界区、同一个原子快照中写入：

```text
Principal/Membership/Delegation 的权威 status + authority version
AuthorityRevocationFence:
  sourceKind, sourceKey, sourceVersion=失效前版本,
  scope, cause, effectiveAt, authorizationRevision
authorizationRevision + 1
对应审计事件（principal/membership/delegation/controller/artifact 相关）
```

这些权威记录必须全部成功或全部不生效。不能：

- 先写 Fence、后写源状态；
- 先撤源状态、后写 Fence；
- 把一个撤权拆成多个独立 Store commit；
- 先返回“已撤权”再补 Fence。

### 1.2 不要求同 commit 写入的派生投影

以下属于派生投影，允许异步 Reconcile：

```text
Task.controlState = frozen
Task.controllerFrozenReason / controllerFrozenAt
ArtifactGrant.revokedAt / revokedReason
fence.processedTaskIds / processedGrantIds
```

它们不是授权事实来源。即使投影仍是 `active`/`revokedAt=null`，撤权 commit 成功后也必须拒绝旧权限。

### 1.3 授权判断必须覆盖的入口

每次判断都必须重新读取当前权威状态，不得复用长期缓存或客户端声明：

- 写命令的 `commitAuthorized`；
- 读 `getTask/getExecution/getExecutionResult/getArtifact/list*`；
- `getEvents/subscribeEvents` 与 cursor；
- Replay 的 RequestRecord 命中路径；
- Artifact 文件读取/下载；
- Execution control（create/dispatch/cancel/complete）；
- 通知投递与结果推送。

### 1.4 失败与恢复

- Store 持久化失败：整个 commit 不生效，源状态/Fence/authRev/Event 都不产生。
- commit 成功但响应丢失：权威状态已生效；客户端重试时按当前授权判断，不能因为响应丢失而恢复旧权限。
- Reconcile 失败/崩溃/部分完成：Fence 仍有效；重启后重试；不得以“投影未完成”为由放行。
- `AUTHORIZATION_RECONCILING` 只表示物化未完成，不表示旧权限仍有效。

### 1.5 dispatch_intent 与运行中 Execution

- 已经提交 `dispatch_intent` 的 Execution 不因后续撤权被改写为 `cancelled`。
- 撤权不写 `cancel.requestedAt/confirmedAt`，不释放 Lease，不自动创建新 Execution。
- 绑定 executor/lease 仍可提交 result/terminal 证据；撤权只阻止旧 controller 发新命令。
- 结果/通知的读取必须按当前授权；失去读取权限的主体不能通过旧订阅/旧 cursor 继续接收。

---

## 2. AD-06-R1：Artifact ACL 与 Controller 冻结

### 2.1 修订点

AD-06 原规则“Controller 冻结与 snapshot ArtifactGrant 撤销必须在同一事务”修订为：

1. Controller 冻结的权威效果与撤权 Fence 在同一事务提交；
2. `origin=task-snapshot-controller` 的 ArtifactGrant 因 Fence/authority version **立即 effective 无效**；
3. `ArtifactGrant.revokedAt` 的物理物化允许异步 Reconcile；
4. Reconcile 未完成不能成为继续访问 Artifact 的理由；
5. 显式 transfer 仍按原规则在同一事务撤销旧 snapshot Grant、创建新 Grant。

### 2.2 分界表

| 变化 | 权威效果 | 派生/物化 | 是否允许延迟 |
|---|---|---|---|
| Controller 冻结（delegation revoke/expiry、membership revoke、principal disable） | Fence + authority version 同 commit；旧 snapshot controller Grant 立即 effective 无效 | `Task.controlState`、snapshot controller `ArtifactGrant.revokedAt` | 是（仅投影） |
| 显式 `transferController` | controller + 旧 snapshot Grant 撤销 + 新 Grant 创建同事务 | 无需等待 reconcile | 否 |
| 显式 `updateArtifactGrant`（grant/revoke） | 直接授权操作，同事务生效 | 不因撤权 reconcile 延迟 | 否 |
| requester snapshot Grant | 创建时物化；成员失效时 live ACL 暂停 | 不因 Controller 冻结自动物理撤销；re-add 后按 live ACL 恢复 | 不适用 |
| Artifact owner 转移 | 显式管理操作，同事务生效 | 不自动随 Controller 冻结转移 | 否 |
| `Task.visibility` 变化 | 只追加 `artifact.access_review_required`，不自动改 Artifact | 既有 Artifact visibility 保持不变 | 不适用 |
| Task archive/delete | 不改变 Artifact ACL；Artifact 独立生命周期 | 不自动删除/转移 | 不适用 |
| Task restore | 不自动恢复已撤销的 Grant | 不自动 unfreeze | 不适用 |

### 2.3 不被扩大解释的部分

AD-06-R1 只把**撤权驱动的 Controller 冻结/snapshot Grant 撤销**改为“即时 effective 无效 + 异步物化”。不得扩大为：

- 显式 ArtifactGrant 的 grant/revoke 可以延迟；
- Artifact owner 转移可以延迟；
- Artifact visibility 变化可以延迟；
- Workspace Owner/Admin 的审计读取权可以延迟；
- 所有 Artifact ACL 变化都可以等待 reconcile。

### 2.4 独立规则保持不变

- Artifact 创建时快照 owner/visibility/requester/controller Grant 仍在同一事务物化。
- 显式 Grant 仍由 Artifact owner 或 Workspace Owner/Admin 管理并审计。
- Artifact owner 与 Task controller 是不同所有权；Controller 冻结不自动转移 Artifact owner。
- Artifact owner/grantee 失去 Workspace 成员资格时，访问立即失败；Owner/Admin 可显式转移/处置。
- Workspace Owner/Admin 的审计读取仍按既有权限，不受旧 Controller 影响。
- Artifact 的物理存储/保留仍是 Phase 2.1B 范围；本次不改变。

---

## 3. Reconcile 完整性

### 3.1 三层状态不能混淆

| 层 | 内容 | 生效时点 |
|---|---|---|
| L1 权威失效 | 源 status/version + Fence + authRev | 撤权 commit 成功时 |
| L2 有效授权 | `effectivePermission`/`effectiveControlState`/effective Grant | 每次请求即时计算 |
| L3 派生投影 | `Task.controlState`、snapshot-controller `ArtifactGrant.revokedAt`、进度/事件 | 异步 Reconcile |

- L1 失效后，L2 必须立即拒绝。
- L3 未更新不改变 L2。
- L3 完成不恢复 L1。
- 不能用 L3 的 `active`/`revokedAt=null` 反推 L2 允许。

### 3.2 覆盖矩阵

Reconcile 必须从权威关系出发，而不是只扫描“直接 grantee”。

| Fence 来源 | Task 目标 | ArtifactGrant effective 检查 | 物理物化 `revokedAt` | Artifact owner |
|---|---|---|---|---|
| Principal global | controller=principal；controller delegation 的 grantor/delegate=principal | grantee=principal；source delegation 的 grantor=principal；source delegation 的 delegate=principal | 仅 `origin=task-snapshot-controller` 且 source delegation/controller authority 匹配 | owner=principal 时按独立 owner 规则处理，不自动转移 |
| Membership workspace | controller=principal；controller delegation 的 grantor=principal；delegate=principal | grantee=principal；source delegation 的 grantor=principal；delegate=principal | 仅 `origin=task-snapshot-controller` 且 source delegation/controller authority 匹配 | owner=principal 时按独立 owner 规则处理 |
| Delegation workspace | controllerDelegationId=delegationId | sourceDelegationId=delegationId | `sourceDelegationId=delegationId` 的 snapshot controller Grant | owner 不因 Delegation 撤销自动改变 |

**A4 的 delegate 遗漏已修正**：Membership fence 对 ArtifactGrant 的扫描不能只看 grantee 或 grantor，还必须覆盖 `sourceDelegationId` 对应 Delegation 的 delegate。Agent 作为 delegate 被移出 Workspace、Principal disabled、Delegation revoked 都必须命中。

- `origin=explicit`/`task-snapshot-requester` 的 Grant 不因 Membership/Principal/Delegation 撤权自动写 `revokedAt`；它们使用当前 grantee/source 的 live ACL 立即 effective 无效/恢复，不做 controller authority version 绑定。显式 revoke 仍由 `updateArtifactGrant` 执行。
- `grantedByPrincipalId` 是授权时的审计主体，不是 explicit Grant 的长期 live 依赖；grantor 失去 Membership 不会自动撤销其签发的 explicit Grant。explicit Grant 只由显式 revoke、grantee 失效或独立的 Artifact ACL 变化改变。
- `origin=task-snapshot-controller` 的 Grant 依赖 `sourceDelegationId`/controller authority version；该依赖失效时立即 effective 无效，并物化 `revokedAt`；re-add/enable 不会让它自动恢复。
- `Artifact.ownerPrincipalId` 是独立所有权，不因 Controller 冻结自动转移；owner 失效时访问按当前成员/Principal 规则拒绝，需 Owner/Admin 显式转移。

### 3.3 Reconcile 状态机

```text
pending
  -> reconciling
  -> completed

pending/reconciling
  -> failed
  -> pending/reconciling（retry）

completed
  -> terminal for this fence
  -> 新撤权/新版本必须创建新 fence，不能复活旧 fence
```

- `failed` 是可重试状态，不是终态。
- 启动扫描 `pending/reconciling/failed`。
- `reconciling` 的进度可恢复；崩溃不会把 Fence 变成无效。
- `completed` 只对该 fence 的 `sourceVersion/scope` 终态；不授权新对象，不解除旧 Task 的冻结。

### 3.4 完成条件

Fence 只有同时满足以下条件才能标记 `completed`：

1. 从权威状态重新执行 scope 查询，覆盖全部 Task/Grant/Artifact owner 关系；
2. 每个目标对象已处于预期派生状态（Task frozen；snapshot controller Grant revoked），或已由**新的权威记录**证明不再是该 fence 的目标（transfer、re-add、new delegation、new explicit grant）；explicit/requester Grant 不作为物理物化目标，但仍必须由 effective ACL 检查；
3. 没有扫描错误、Store 错误、无法解析的引用；
4. 所有批次、进度、事件和完成记录在同一 commit 成功；
5. 多 fence 重叠时，没有未解决的冲突版本；
6. 不能仅凭 `processedTaskIds`/`processedGrantIds` 判断完成；进度不是完整性证明。

无法确认完整性时：保持 `pending/reconciling/failed`，不得乐观标记 `completed`。

### 3.5 重叠 Fence 与新授权

- 每个 Fence 绑定 `sourceKind/sourceKey/sourceVersion`；旧 Fence 只处理旧版本目标。
- 旧 Reconcile 只能写 `frozen`/`revoked`，不能写 `active`、不能删除新 Grant、不能覆盖新 controller。
- 新撤权创建新 Fence；旧 Fence 完成不代表新 Fence 完成。
- Principal enable、Membership re-add、Delegation re-create 产生新 authority version/新 ID；旧 Fence 不命中新对象，也不会使旧 Task 解除冻结。
- 新显式 Grant/transfer 必须绑定当前 authority version；旧 Fence 不得把它们误判为旧目标。
- 旧 Fence 的 `completed` 不会恢复旧权限；旧 controller 只能被显式 transfer 替换。

### 3.6 失败场景表

| 场景 | 权威 Fence | 派生投影 | 允许完成？ | 恢复 |
|---|---|---|---|---|
| 撤权 commit 前崩溃 | 不存在 | 无 | — | 重新提交撤权 |
| 撤权 commit 成功后崩溃 | 有效 | 可能未物化 | 否 | 启动扫描/重试 |
| 批次 commit 后崩溃 | 有效 | 部分完成 | 否 | 从进度/权威重算 |
| 批次 commit 前崩溃 | 有效 | 未完成 | 否 | 重做批次 |
| Store 写失败 | 有效 | 未完成 | 否 | `failed`，retry |
| 扫描不完整/引用无法解析 | 有效 | 不确定 | 否 | 保持 pending/failed |
| 完成记录写失败 | 有效 | 已完成但未标记 | 否 | retry 完成记录 |
| 重复批次 | 有效 | 已 frozen/revoked | 是（幂等） | 跳过重复 Event |
| transfer 并发 | 有效 | 旧 controller 不再是目标 | 是（跳过） | 条件更新 |
| 新撤权并发 | 两个 Fence 均有效 | 并集 | 各自独立完成 | 新 Fence 处理新版本 |
| re-add/enable/new delegation | 旧 Fence 仍有效于旧版本 | 新对象不匹配 | 旧 Fence 可完成 | 旧 Task 仍 frozen |
| 投影损坏/不一致 | 有效 | 不可信 | 否 | 从权威重算，失败则 failed |

### 3.7 Reconcile 不变量

1. 撤权 commit 后，任何读/写/Replay/Artifact/Event/Execution control 都必须先检查权威失效。
2. 派生投影未更新不能成为继续授权的理由。
3. Reconcile 只能写 frozen/revoked，不能写 active，不能恢复旧 controller。
4. Reconcile 完成一个来源不能清除另一个来源的拒绝。
5. 旧 Fence 不能被新授权“意外失效”；新授权只对新版本/新对象生效。
6. 旧 controller 不能因 re-add/enable/new delegation/恢复操作重新获得控制；只能显式 transfer。
7. 运行中 Execution 不因撤权被标记 cancelled；dispatch_intent 不被追溯取消。
8. 无法确认完整性时保留 pending/failed，不得乐观完成。

---

## 4. 十二个场景

### 4.1 User 被移出 Workspace，直接控制 Task

| 维度 | 结果 |
|---|---|
| 权威状态 | Membership revoke，version V->V+1，Fence(sourceVersion=V) |
| 即时授权 | `effectivePermission=false`；`effectiveControlState=frozen` |
| 派生状态 | `Task.controlState` 可能仍 active；`controllerFrozenAt` 未物化 |
| Reconcile | 按 controllerMembershipVersion=V 命中，写 frozen；running Execution 继续；不取消 |

### 4.2 Agent 被移出 Workspace，且作为 Delegation delegate 控制 Task

| 维度 | 结果 |
|---|---|
| 权威状态 | Agent Membership revoke，version V->V+1，Fence(V)；Delegation delegateMembershipVersion=V |
| 即时授权 | Agent 的 controller membership version 不匹配；Delegation 也因 delegate version 不匹配失效；frozen |
| 派生状态 | snapshot controller Grant 仍可能 revokedAt=null，但 effective 无效 |
| Reconcile | Membership fence 覆盖 controller=Agent 与 source delegation delegate=Agent 的 Grant；写 frozen/revoked；Agent 不能继续控制 |

### 4.3 Delegation grantor 被禁用

| 维度 | 结果 |
|---|---|
| 权威状态 | Principal disable，version V->V+1，principal Fence(V)；Delegation grantorPrincipalVersion=V |
| 即时授权 | Delegation invalid；controller Agent frozen；Agent 自身 Membership 仍有效也不够 |
| 派生状态 | Delegation.status 可能仍 active；snapshot Grant 可能未 revoked |
| Reconcile | 覆盖 delegation grantor=Principal 的 Task/Grant；物化 frozen/revoked；running Execution 继续；不自动取消 |

### 4.4 Delegation 被撤销，但 Agent 仍是 Workspace 成员

| 维度 | 结果 |
|---|---|
| 权威状态 | Delegation revoke，version V->V+1，Fence(V) |
| 即时授权 | controllerDelegationVersion=V 不匹配；frozen |
| 派生状态 | `Task.controlState`/snapshot controller Grant 可能未物化；explicit/requester Grant 按 live ACL 暂停 |
| Reconcile | 按 controllerDelegationId/sourceDelegationId 命中；物化 frozen/revoked；Agent 成员资格本身不恢复控制 |

### 4.5 Principal disabled 后重新 active

| 维度 | 结果 |
|---|---|
| 权威状态 | disable V->V+1，Fence(V)；enable V+1->V+2 |
| 即时授权 | enable 后 Principal active；但旧 Task controllerPrincipalVersion=V，当前 V+2，仍 frozen |
| 派生状态 | 旧 Task 可能仍 frozen 或 active cache；API 用 effective |
| Reconcile | 旧 Fence 完成；旧 Task 不自动 unfreeze；新 Task 用 V+2；旧 Delegation 仍需新 grant |

### 4.6 Membership revoke 后重新加入

| 维度 | 结果 |
|---|---|
| 权威状态 | revoke V->V+1，Fence(V)；re-add V+1->V+2 |
| 即时授权 | 旧 Task controllerMembershipVersion=V，当前 V+2，仍 frozen；新请求按新 membership |
| 派生状态 | 旧 Task 可能未物化；snapshot-controller Grant 的 grantee version 失效；explicit/requester Grant 按 live ACL 暂停 |
| Reconcile | 旧 Fence 只处理 V；新对象 V+2 不命中；旧 controller 仍需 transfer |

### 4.7 Controller transfer 与旧 Controller Fence 并发

| 维度 | 结果 |
|---|---|
| 权威状态 | transfer 写新 controller + 新 authority version；旧 Fence(V) 仍存在 |
| 即时授权 | transfer 后新 controller active；旧 controller frozen |
| 派生状态 | 旧 snapshot Grant 撤销/新 Grant 创建同事务；旧 Fence 可能未完成 |
| Reconcile | 条件更新发现 controller/version 已变，跳过；不覆盖新 controller；旧 Fence 不复活旧权限 |

### 4.8 ArtifactGrant Reconcile 期间发生新的撤权

| 维度 | 结果 |
|---|---|
| 权威状态 | 旧 Fence(V1) + 新 Fence(V2) 同时有效 |
| 即时授权 | 并集拒绝；旧/新来源都不能读取 |
| 派生状态 | 旧批次可能只物化 V1 对象；V2 对象可能未物化 |
| Reconcile | 两个 Fence 独立；旧完成不清除新；新 Fence 处理 V2；不能乐观完成 |

### 4.9 Reconcile 已完成后发生新的授权或撤权

| 维度 | 结果 |
|---|---|
| 权威状态 | 新显式 Grant/transfer 绑定当前 version；或新撤权创建新 Fence |
| 即时授权 | 新授权按新记录生效；新撤权按新 version 拒绝 |
| 派生状态 | 旧 `completed` 不代表新对象状态 |
| Reconcile | 旧 Fence 不重开；新授权/撤权由新记录/新 Fence 处理；旧 Task 仍按旧绑定 frozen |

### 4.10 Replay 命中旧 RequestRecord，但当前授权已经失效

| 维度 | 结果 |
|---|---|
| 权威状态 | 当前 Membership/Delegation/Principal 已失效 |
| 即时授权 | 当前授权检查失败 -> `AUTHORIZATION_REVOKED` |
| 派生状态 | RequestRecord/resultSnapshot 仍存在 |
| Reconcile/读取 | 不返回旧 resultSnapshot、不重新执行；当前仍有读取权限可走读 API，否则拒绝 |

### 4.11 已提交 dispatch_intent 后发生撤权

| 维度 | 结果 |
|---|---|
| 权威状态 | 撤权 Fence 提交；Execution 已有 dispatch_intent |
| 即时授权 | 旧 controller 不能发新命令；不伪造取消 |
| 派生状态 | Execution 仍 running/interrupted/unknown；Task 不自动 cancelled |
| Reconcile | 不释放 Lease、不取消 Execution；executor 仍可提交证据；结果读取重新授权 |

### 4.12 Artifact owner 与被撤权 Controller 是同一 Principal

| 维度 | 结果 |
|---|---|
| 权威状态 | Membership/Delegation/Principal 失效 + Fence |
| 即时授权 | controller 权限拒绝；Artifact owner 读取也因当前成员/Principal 失效而拒绝 |
| 派生状态 | Artifact owner 不自动转移；snapshot Grant effective 无效，`revokedAt` 可滞后 |
| Reconcile | 物化 snapshot Grant 撤销；Artifact 不删除；Workspace Owner/Admin 审计读取；需显式 owner transfer/处置 |

---

## 5. AD 逐项复核

| AD | 结论 | 状态 |
|---|---|---|
| AD-06 | 创建时 ACL 不变；Controller 冻结的 snapshot Grant 由 Fence 立即 effective 无效，`revokedAt` 异步；显式 transfer 仍同事务；其他 ACL 规则不延迟 | **READY**（AD-06-R1；实现 CONDITIONAL） |
| AD-08 | 撤权立即冻结 controller；running Execution 继续；不伪造 cancel；v3 不暴露同一 controller 的 unfreeze，只允许 transfer | **READY**（实现 CONDITIONAL） |
| AD-09 | 撤权后 Event/cursor 每次重新授权；旧 cursor 不是凭证；订阅失效 | **READY**（实现 CONDITIONAL） |
| AD-10 | Replay 重新授权；inputHash/RequestRecord 语义不变；撤权后拒绝旧结果 | **READY**（实现 CONDITIONAL） |
| AD-12 | 最终授权检查 + 权威撤权状态/Fence/authRev 同 commit；派生投影异步；不把派生物当授权判据 | **READY**（AD-12-R1；实现 CONDITIONAL） |
| AD-14 | 撤权不改变 interrupted/unknown 风险；不自动重试、不自动完成、不自动取消 | **READY**（实现 CONDITIONAL） |

### 5.1 AD-08 与 Execution 生命周期

- 撤权只撤 controller 权限，不改变 Execution 真实状态。
- `dispatch_intent` 已提交的 Execution 不被伪造为 cancelled。
- `cancel` 仍需显式请求和证据；撤权不写 cancel request。
- `interrupted`/`unknown` 风险保留；撤权不清除风险、不自动创建新 Execution。
- Owner/Admin 可显式 transfer/cancel；旧 controller 不能继续控制。

### 5.2 AD-14 风险语义

- 撤权不把 `interrupted`/`unknown` 改成 terminal。
- 撤权不清除 `unresolvedExecutionIds`、`duplicateExecutionRisk` 或 integrity alerts。
- 撤权不自动完成/失败 Task；新 Execution 仍需显式风险确认。

---

## 6. OD-09 原始 Phase 2.0 Baseline

### 6.1 再次核对结果

核对时仓库 HEAD：`86d439bd1056a4c518cf6403bb7f45436fa8945c`。

| 检查 | 结果 |
|---|---|
| `docs/phase-2.0-architecture-baseline.md` | 不存在 |
| 文件名含 `baseline` | 只有 `docs/phase-2.0-baseline-review.md` |
| Git 历史路径 | 从未出现原始 baseline 文件 |
| `git log -S'Companion Hub Phase 2.0'` | 无提交 |
| unreachable blobs | 未发现可构成 781 行基线的原文 |
| reflog | 无 baseline 提交 |
| 同名本地文件 | 未发现 |

`phase-2.0-baseline-review.md` 记录审查对象为“用户提供的 Phase 2.0 Architecture Baseline / Draft v2.0（781 行）”，被审查代码基线 `a83e52f`。该 Review 是证据，不是原文。

### 6.2 当前处理

- 不声称从 Git 恢复原文。
- 不把 Review/后续设计拼成“原始基线”。
- 用户补充的 Draft 文本/元数据可作为设计参考，但仓库原始归档仍待处理。
- 规范性层级：2.0.3 > 2.0.2 > 2.0.1 > 用户提供的 Draft v2.0。
- OD-09 继续保留为 `NEEDS_USER_DECISION`，但不阻塞 OD-11 冻结或本任务。

### 6.3 OD-09 选项

- 方案 A：提供可校验原文，归档为 `docs/phase-2.0-architecture-baseline.md`，记录来源/校验和；推荐。
- 方案 B：确认不归档原文，以 2.0.1/2.0.2/2.0.3 + baseline review 为唯一规范性依据，并保留来源缺口说明。

---

## 7. 实现准入判断

### 7.1 结论

**本次设计闭合足以作为实现输入；不批准进入代码实现阶段。**

- OD-11 已冻结，不再是实现前置。
- 权威撤权、AD-06-R1、AD-12-R1、Reconcile 完整性语义已达到可实现规划级别。
- 但整体实现仍受 P0/P1 和 Phase 2.1B 批准约束。

### 7.2 状态矩阵

| 领域 | 状态 | 说明 |
|---|---|---|
| Authority Fence 决策 | **READY** | OD-11 方案 A 冻结 |
| AD-06-R1 / AD-12-R1 | **READY** | 已正式修订 |
| Reconcile 覆盖/完成语义 | **READY** | delegate/grantor/grantee 覆盖已补；实现测试未做 |
| Replay / Event 重新授权 | **READY** | 设计已明确；实现测试未做 |
| v2 承载 v3（P0-01） | **BLOCKED** | 必须新建 v3；禁止 v2 补丁 |
| Contracts v3 | **CONDITIONAL** | 类型/字段/实现评审未完成 |
| Store v3 实现 | **CONDITIONAL** | 设计已冻结；实现/故障测试未开始 |
| Artifact ACL | **CONDITIONAL** | AD-06-R1 已冻结；存储/实现未完成 |
| OS 隔离 | **BLOCKED** | 无 native helper/OS sandbox；若接受 cooperative 可降级为接受限制 |
| Migration | **CONDITIONAL** | manual recovery 未演练 |
| ACP Adapter | **CONDITIONAL** | exactly-once/unknown 限制需测试 |
| Artifact 存储 | **DEFERRED** | Phase 2.1B |
| Phase 2.1B | **DEFERRED** | 未批准 |
| OD-09 | **NEEDS_USER_DECISION** | 独立归档事项，不阻塞本决策 |

### 7.3 进入实现的具体前置条件

1. Phase 2.1B 获得单独批准（OD-10）。
2. v3 Contracts/Store/API 在新入口实现，不在 v2 打补丁（P0-01）。
3. 若产品要求真实文件隔离，先完成 native helper/OS sandbox；否则明确接受 cooperative（P0-02）。
4. Store v3 容量/写放大基准（P1-03）。
5. Fence/Reconcile 实现测试：即时拒绝、幂等、崩溃恢复、部分完成、重叠 Fence、transfer/re-add/enable 竞态（A3-P1-02/A4-P1-01）。
6. Replay/resultSnapshot 并发与撤权交叉测试（A3-P1-01）。
7. Windows path guard 能力探测（P1-04）。
8. v2→v3 migration manual recovery/回滚演练（P1-05）。
9. ACP unknown/cancel/late notification 限制测试（P1-06）。
10. Artifact 物理存储/保留设计（P1-07）。
11. 到期/撤权物化调度器（P1-08）。
12. OD-09 归档可并行处理，不阻塞上述实现，但审计上仍需关闭。

### 7.4 允许的下一步

- 可以进入实现规划、任务拆分、测试设计和纯状态机原型。
- 可以在 Phase 2.1B 批准后实现 `AuthorityRevocationFence`、authority version、effective 授权和 Reconcile。
- 不得把本文件当作代码实现批准，不得跳过 Phase 2.1B。

---

## 8. 最终判断

**OD-11 已按用户选择方案 A 正式冻结；AD-06-R1/AD-12-R1 已写入规范性文档。**

**Reconcile 已补齐 Delegation delegate 覆盖，并明确 L1/L2/L3 分层、完成条件、重叠 Fence、失败恢复。**

**OD-09 仍为独立归档事项，不影响 Authority Fence 决策。**

**实现准入：设计输入 READY；代码实现 NOT APPROVED。剩余 BLOCKED 为 OS 隔离（若要求真实隔离）；Store/Migration/ACP/Artifact/Path 等仍有 P1 实现前置条件。**

本文件不开始 Phase 2.1B，不实现代码，不推送远程。
