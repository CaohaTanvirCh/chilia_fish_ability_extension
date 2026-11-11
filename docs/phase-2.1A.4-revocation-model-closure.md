# Phase 2.1A.4 Revocation Model Closure & Baseline Reconciliation

状态：**AUTHORITY FENCE DECISION FROZEN (OD-11 OPTION A) / OD-09 ARCHIVE OPEN / IMPLEMENTATION NOT READY**

日期：2026-11-11（Asia/Shanghai）

范围：docs-only。本文件不实现 Store、Fence/Reconcile、授权检查、Migration、Native Helper 或 ACP Adapter；不修改业务代码、配置、数据库或测试。

依据：

- `docs/phase-2.1A.2-contracts-v3-design.md`
- `docs/phase-2.1A.2-store-api-v3-design.md`
- `docs/phase-2.1A.2-design-review.md`
- `docs/phase-2.1A.3-implementation-readiness.md`
- `docs/phase-2.1A.5-authority-fence-decision-closure.md`（决策冻结/Reconcile 完整性）
- `docs/phase-2.1A-identity-workspace-design.md`
- `docs/phase-2.1A-design-review.md`
- Phase 2.0.1、2.0.2、2.0.3 冻结决策与 `docs/phase-2.0-baseline-review.md`
- 当前 Phase 1.1 Contracts/Store/Executor 代码与测试

---

## 0. 结论

### 0.1 本轮关闭了什么

1. **直接 User 控制 Task 的撤权缺口**：Membership 被撤销后，只有 Delegation/Principal 检查时 `effectiveControlState` 仍显示 `active`。现在 controller 在赋值时绑定 Principal/Membership/Delegation 的 authority version；任一 version 变化，旧 controller 立即失效。
2. **三种撤权来源统一**：Principal 禁用/删除、Membership 撤销、Delegation 撤销/到期，统一为 authority version + `AuthorityRevocationFence` + effective 派生 + 异步物化。
3. **撤权与执行取消分离**：撤权不写 cancel request、不伪造 Execution 终态、不释放 Lease、不改变 Task `goalStatus`/`lifecycle`。
4. **多来源并发取并集**：一个 fence 完成不能清除另一个来源的拒绝；没有任何自动 unfreeze。
5. **Replay 与结果可查询性分离**：Replay 必须重新授权；撤权后不返回旧 `resultSnapshot`，但当前仍有读取权限的主体可通过读 API 查询已提交事实。
6. **OD-09 来源核对**：仓库与 Git 历史中没有可验证的原始基线文件；用户补充的 Draft 文本/元数据可作为历史输入，但不能伪造归档原文。OD-09 部分收敛：规范性来源已确定，仓库归档动作仍需用户决定。
7. **OD-11 已由用户冻结为方案 A**：接受 Authority Version + `AuthorityRevocationFence` + Effective 派生；撤权 commit 原子提交权威记录，派生 `Task.controlState`/`ArtifactGrant.revokedAt` 允许异步物化。AD-06-R1/AD-12-R1 已正式记录；详见 `docs/phase-2.1A.5-authority-fence-decision-closure.md`。

### 0.2 仍然不 READY

- OD-09 的仓库归档方式未定（不阻塞 OD-11/撤权设计）。
- OD-11 已冻结；Store 撤权实现、Fence/Reconcile 实现尚未开始，不能再以“等待 OD-11”作为阻塞理由。
- P0-01（v2 不能承载 v3）、P0-02（Workspace 不是 OS 隔离）未关闭。
- P1 的 Replay/Fence 实现、容量、native path guard、迁移 manual recovery、ACP 不可恢复边界、Artifact 物理存储、到期物化均未实现/验收。
- Phase 2.1B 未获批准。

**结论：撤权模型及 AD-06/AD-12 决策已冻结；实现准入仍为 CONDITIONAL / NOT APPROVED，OD-09 归档独立待处理。**

---

## 1. 三种撤权来源的统一模型

### 1.1 五个概念不能互相替代

| 概念 | 定义 | 不等于 |
|---|---|---|
| 权限失效 | 某 Principal/Delegation 当前不再允许某操作 | Task 被取消 |
| Controller 控制权冻结 | 旧 controller 不能继续控制 Task | Execution 已终止 |
| Execution 取消请求 | 某 actor 记录“请求停止” | 取消已确认 |
| Execution 取消确认 | 有 ACP cancelled/local_not_submitted 证据 | Task goalStatus 改变 |
| Task 生命周期变化 | archived/deleted 等显式生命周期命令 | 撤权自动产生 |

撤权只产生第 1、2 项；第 3、4、5 项必须由独立命令和证据产生。

### 1.2 权威记录与作用域

| 来源 | 权威记录 | 作用域 | 失效判据 |
|---|---|---|---|
| Principal | `Principal.status`、`deletedAt`、`version` | 全局（所有 Workspace） | status != active、deletedAt != null、匹配 principal fence |
| Membership | `WorkspaceMember.status`、`version` | 单个 Workspace | stored revoked、version 变化（role/re-add）、匹配 membership fence、Principal 失效 |
| Delegation | `DelegationGrant.status`、`expiresAt`、`version`、grantor/delegate authority versions | 单个 Workspace | revoked/expired、version 不匹配、grantor/delegate 失效、匹配 delegation fence |

统一记录：

```text
AuthorityRevocationFence:
  fenceId
  sourceKind                 principal | membership | delegation
  sourceKey                  principal:<id> / membership:<ws>:<pid> / delegation:<id>
  sourceVersion              number        // 被失效的 authority version（撤销/禁用前的版本）
  scope:
    kind                     global | workspace
    workspaceId              WorkspaceId | null
  principalId                PrincipalId | null
  delegationId               DelegationId | null
  cause                      disabled | deleted | revoked | expired
  effectiveAt                Timestamp
  authorizationRevision      number
  status                     pending | reconciling | completed | failed
  processedTaskIds           string[]
  processedGrantIds          string[]
  lastError
  createdAt / completedAt
```

- `sourceVersion` 是失效前版本（不是 revoke/disable 后的新 version），但 version 只是局部版本；匹配必须同时校验 sourceKey 解析出的 Principal/Membership/Delegation ID、Workspace（适用时）和对应 authority version。commit 后源记录 version 递增。
- 源记录当前 status/version 仍是当前授权判据；Membership re-add、Principal enable 产生新 version，旧 fence 不命中新对象，也不会让旧 Controller/Delegation 复活。旧 Task 因绑定旧 version 保持 frozen，直到显式 `transferController`。
- `scope.kind=global` 明确表示所有 Workspace，不是“未指定”。
- fence 是失效事实和 reconcile 游标；源记录当前 status/version 判断当前请求是否失权，fence 的旧 `sourceVersion` 判断 Task/Grant 的绑定是否已被失效。任一失效即拒绝。
- 同一 `(sourceKind, sourceKey, sourceVersion)` 重复撤销返回已有 fence；若源已处于同一终态（revoked/disabled/deleted），返回该 sourceKey 的现有 fence，不按 commit 后的新 version 再建。只有 re-add/enable 后再次失效才创建新 version 的 fence。

### 1.3 原子提交边界

| 操作 | 同一 commit 至少写入 | 不在同一 commit 做 |
|---|---|---|
| `removeMember` / `leaveWorkspace` | Membership revoked + version + MembershipRevision + membership fence + authRev + event | 枚举所有 Task/Grant、取消 Execution、释放 Lease、删除 Artifact |
| `updateMemberRole`（角色降低） | role + version + MembershipRevision + authRev + event | 不创建 removal fence；旧 controller 因 version 不匹配立即 frozen |
| `revokeDelegation` | Delegation revoked + version + delegation fence + authRev + event | 枚举所有 Task/Grant、取消 Execution、释放 Lease |
| `disablePrincipal` | Principal disabled + version + principal fence(global) + authRev + event | 枚举所有 Membership/Delegation/Task、取消 Execution、删除 Artifact |
| `deletePrincipal` | Principal disabled/deletedAt + version + principal fence(global) + authRev + event | 同上；Membership/Delegation stored 物化可异步 |

约束：

- 最后一个 Workspace Owner 的 remove/disable/delete 必须 `LAST_OWNER` 拒绝，或走 system ownerless recovery；不能静默产生无主 Workspace。
- `enablePrincipal` 必须等待该 Principal 的所有 principal fence `completed`；否则返回 `AUTHORIZATION_RECONCILING`。否则可能在 Delegation 尚未物化时重新启用，导致旧委托复活。
- `deletePrincipal` 不可逆；`enablePrincipal` 只恢复 stored active Membership，不恢复 revoked Membership/Delegation/旧 controller。
- Phase 2.1A/2.1A.1 中“撤权事务在同一 commit 枚举所有受影响 Task 并置 frozen”的措辞是 A3 之前的容量方案；A4/A5 以 authority version + fence + 异步物化取代。其授权交集、可见性和生命周期结论仍有效；AD-06-R1/AD-12-R1 已正式冻结，详见 A5。

### 1.4 对 Task / Execution / Artifact / Controller 的影响

| 对象 | 影响 |
|---|---|
| Task `goalStatus` | 不变；撤权不是取消/完成/失败 |
| Task `lifecycle` | 不变；不自动 archive/delete |
| Task `controlState` | effective frozen；stored cache 可滞后 |
| Task owner/requestedBy | 历史审计引用；失去当前权限，不等于 Task 消失 |
| running Execution | 继续；由绑定 executor/lease 提交真实结果；不伪造 cancelled |
| queued Execution | 保持 queued；不自动 dispatch；Owner/Admin 可取消或等待新 controller |
| cancel request | 只有显式 `cancelExecution`/`cancelTask` 才写；撤权不写 |
| WorkspaceWriteLease | 不释放；旧 executor 未停止时仍按 AD-13 处理 |
| Artifact | 不删除；owner 失效需显式转移；grantee Grant effective 无效 |
| ArtifactGrant | snapshot controller Grant 的 `revokedAt` 可滞后；effective 按 authority version/fence 拒绝。explicit/requester Grant 只做 effective ACL，不自动物理撤销。 |
| Controller | 旧 controller 永久失去控制；只能显式 `transferController` 替换，不能自动 unfreeze |

- Owner/requestedBy 失效不会自动冻结一个仍由其他合法 controller 控制的 Task；但 owner/requestedBy 的权限立即失效，Owner 必须由 Owner/Admin 显式转移，不能继续行使 owner 权限。
- Controller 失效才会冻结控制；Task 是否取消、Execution 是否终止、Artifact 是否删除都是独立决定。

---

## 2. `effectivePermission` 与 `effectiveControlState`

### 2.1 定义

- `effectivePermission(actor, op, resource)`：某个 Principal 当前是否有权执行某个操作。它按操作、资源、Workspace、Delegation、ACL 计算。
- `effectiveControlState(task)`：某个 Task 当前是否允许其 controller 继续控制。它只回答控制权，不回答 Owner/Admin 的治理权限。

二者可以不同：

- Owner/Admin 在 Task frozen 时仍有 `transferController`/`cancelTask`/审计读取权限；
- 旧 controller 在 frozen 时必须对所有“继续控制”操作返回拒绝；
- 不能因为 Owner/Admin 有治理权限，就让旧 controller 继续控制。

### 2.2 统一判定

```text
principalAuthorityValid(p) =
  p.status=active && p.deletedAt=null
  && no fence(sourceKey=principal:<p.id>, sourceVersion=p.version)

membershipAuthorityValid(p, ws) =
  membership(p, ws).status=active
  AND no matching membership fence
  AND principalAuthorityValid(p)
  AND effectiveMembership(p, ws)=active

delegationAuthorityValid(d) =
  d.status=active
  AND now < d.expiresAt
  AND no matching delegation fence
  AND d.grantorPrincipalVersion == principal(d.grantorPrincipalId).version
  AND d.grantorMembershipVersion == membership(d.grantorPrincipalId, d.workspaceId).version
  AND d.delegatePrincipalVersion == principal(d.delegatePrincipalId).version
  AND d.delegateMembershipVersion == membership(d.delegatePrincipalId, d.workspaceId).version
  AND membershipAuthorityValid(d.grantorPrincipalId, d.workspaceId)
  AND membershipAuthorityValid(d.delegatePrincipalId, d.workspaceId)

controllerAuthorityValid(task) =
  membershipAuthorityValid(task.controllerPrincipalId, task.workspaceId)
  AND principal(task.controllerPrincipalId).version == task.controllerPrincipalVersion
  AND membership(task.controllerPrincipalId, task.workspaceId).version == task.controllerMembershipVersion
  AND if task.controllerDelegationId != null:
        delegationAuthorityValid(delegation(task.controllerDelegationId))
        AND delegation.version == task.controllerDelegationVersion
        AND delegation.delegatePrincipalId == task.controllerPrincipalId

effectiveControlState(task) =
  frozen if task.controlState == frozen
  frozen if controllerAuthorityValid(task) == false
  else active
```

`effectivePermission` 的控制操作还要求：

```text
actor == task.controllerPrincipalId
AND actor 的 delegation 与 task.controllerDelegationId 一致（直接 controller 为 null）
AND effectiveControlState(task) == active
```

治理操作（`transferController`、Owner/Admin 的 `cancelTask`/`archiveTask`/`deleteTask`/审计读取）不要求旧 controller 有效，但要求 actor 当前拥有对应 Owner/Admin 权限。

- `controllerPrincipalId`/membership/delegation 记录缺失、版本字段缺失或无法解析时，`controllerAuthorityValid=false`，不得按 active 处理。

### 2.3 九个必测场景

| # | 场景 | effectivePermission | effectiveControlState | 其他影响 |
|---:|---|---|---|---|
| 1 | User 直接控制 Task，Membership 被撤销 | false | frozen | Task 不取消；running Execution 继续；ArtifactGrant 对 User 无效；Owner/Admin 可 transfer |
| 2 | Agent 受 User 委托控制，Delegation 被撤销 | false | frozen | Agent Membership 仍有效也不够；旧 snapshot grant 无效；新 Delegation 不自动恢复旧 Task |
| 3 | Agent 自主控制，Agent Principal 被禁用 | false | frozen | Membership effective suspended；running Execution 继续；enable 后旧 Task 仍 frozen |
| 4 | Membership 失效但 Delegation 记录仍 active | false | frozen | 不依赖 Delegation.status 的物化；direct/委托两条路径都拒绝 |
| 5 | Delegation 失效但 Membership 仍有效 | false（该委托操作） | frozen（该委托 Task） | 同一 User 的其他 direct Task 不受影响；可新建 Task，但旧 Task 需 transfer |
| 6 | Principal 禁用，Membership/Delegation 尚未物化 | false | frozen | principal status/version + fence 立即拒绝；enable 需等 fence 完成 |
| 7 | Membership 撤销 + Delegation 撤销同时发生 | false | frozen | 取并集；一个 fence 完成不清除另一个 |
| 8 | Controller 转移与撤权并发 | 新 controller 按当前权限 | 新 controller 有效则 active；旧 controller 永远 frozen | Store 串行化；旧 fence 条件更新跳过已转移 Task |
| 9 | 已提交请求在撤权后 Replay | 当前授权失败 -> `AUTHORIZATION_REVOKED` | 不适用 | 不返回旧 resultSnapshot；当前读权限可走读 API |

### 2.4 安全不变量

1. 权威撤权记录提交后，后续授权检查不得接受已失效权限。
2. 派生投影未更新，不得成为继续授权的理由。
3. Reconcile 只能补派生状态，不能撤销/覆盖更新的权威事实。
4. 旧 Controller 不得因延迟事件、旧快照、re-add、enable 或恢复操作重新获得控制权。
5. running Execution 不得被错误标记为已取消。
6. 撤权前已提交的 dispatch/commit 遵守 AD-12/AD-13 语义，不声称外部执行器已停止。
7. 多个失效来源并发时取并集；一个来源 reconcile 完成不能恢复另一个来源已撤销的权限。

---

## 3. Reconcile 的幂等性与崩溃恢复

### 3.1 处理范围

| fence 来源 | 扫描对象 |
|---|---|
| Principal global | controller=principal 的 Task；controller delegation 的 grantor/delegate=principal 的 Task；grantee=principal 或 source delegation 的 grantor/delegate=principal 的 snapshot controller Grant；delete 时 Membership stored revoked；Delegation 物化 revoked |
| Membership workspace | controller=principal 的 Task；controller delegation 的 grantor=principal 或 delegate=principal 的 Task；grantee=principal 或 source delegation 的 grantor=principal 或 delegate=principal 的 snapshot controller Grant |
| Delegation workspace | `controllerDelegationId=delegationId` 的 Task；`sourceDelegationId=delegationId` 的 snapshot controller Grant |

- `origin=explicit`/`task-snapshot-requester` 的 Grant 不因 Membership/Principal/Delegation 撤权自动写 `revokedAt`；它们按当前 grantee/source 的 live ACL 立即 effective 无效/恢复，不做 controller authority version 绑定。显式 revoke 仍由 `updateArtifactGrant` 执行，不能借 Reconcile 扩大撤销范围；new explicit Grant 是不同 grantId，不能替代旧 snapshot Grant 的撤销义务。
- 目标识别必须基于具体 Task/Grant ID + Workspace + authority binding；匹配同时校验 Principal/Membership/Delegation ID、Workspace（适用时）和 version。委托目标必须解析 Delegation 的 grantor/delegate Principal/Membership binding，不能只看 controllerMembershipVersion 或 sourceDelegationVersion；source identity 规则见 `docs/phase-2.1A.8-authority-fence-source-identity-audit.md`。
- Artifact owner 关系只用于完整性审计；Reconcile 不得修改 `ownerPrincipalId`、不得删除 Artifact，也不得把 owner 自动转移列为 Fence 目标。

### 3.2 规则

- 启动扫描 `status != completed` 的 fence（含 `failed`），按 `authorizationRevision`、`fenceId` 排序。
- 每批只写可枚举对象；批次 commit 原子；`processedTaskIds`/`processedGrantIds` 是幂等进度，不是授权判据。
- 匹配前先解析 `sourceKey`：`principal:<principalId>`（global）、`membership:<workspaceId>:<principalId>`（workspace）、`delegation:<delegationId>`（workspace）。version 是局部版本，不能替代 ID/Workspace 匹配。
- 条件更新：只冻结当前 controller 绑定仍匹配 fence `sourceKey/sourceVersion` 的 Task；只有显式 `transferController` 改变 binding 后才跳过，单纯 re-add/enable 不改变旧 Task binding，不得跳过。Principal fence 要求 Principal ID == fencePrincipalId 且对应 version == sourceVersion；Membership fence 要求 workspaceId == fenceWorkspaceId、Principal ID == fencePrincipalId 且对应 Membership version == sourceVersion；Delegation fence 要求 delegationId == fenceDelegationId 且 version == sourceVersion，并校验 Workspace。委托目标分别检查 grantor/delegate 两端的 ID/Workspace/version；ArtifactGrant 的 sourceDelegationId 非 null 时必须解析完整 Delegation binding。
- 已 frozen/已 revoked 的对象跳过，不追加重复派生 Event；源级事件在撤权 commit，`controller.frozen`/`artifact.grant_revoked`/`authorization.reconciled` 是 Reconcile 派生事件。
- 崩溃恢复：从进度继续；未记录批次可重做；每个 batch commit 原子；batch commit 与 completion commit 分离，不要求所有批次同一事务。
- 完成：从权威状态重新扫描具体 Task/Grant target identity，全部目标 frozen/revoked，或存在针对具体对象的显式 transfer/revoke；不能仅凭 processed ids 乐观完成。`completed` 只表示当前 fence/sourceVersion/scope 的物化完成。completion commit 单独提交 `status=completed`、`completedAt`、`authorization.reconciled`；失败保持 pending/retry，不回滚已完成批次、不重复派生事件。
- 重复撤权：同 source/version 返回已有 fence；新 version 才新建。
- 绝不写 `controlState=active`，绝不恢复旧 controller，绝不自动创建/取消 Execution，绝不释放 Lease。
- `failed` 不是终态；retry 包括 `pending/reconciling/failed`。
- 多 fence 并发：一个 fence 完成不能清除另一个；effective 始终取并集。
- Membership role 降低/变更使 version 变化时，旧 controller 立即 frozen；该路径不强制创建 fence，`Task.controlState` cache 可保持旧值，但 API/写入使用 effective。角色变更仍需审计事件 `membership.role_changed`。
- 完成条件、重叠 Fence、失败恢复和 delegate 覆盖的完整规则见 `docs/phase-2.1A.5-authority-fence-decision-closure.md` 第 3 节；target identity 与操作影响矩阵见 `docs/phase-2.1A.6-reconcile-target-identity-audit.md`；Delegation 双端 Membership 与 batch/completion 边界见 `docs/phase-2.1A.7-delegation-membership-binding-audit.md`；sourceKey/ID/Workspace/version 匹配见 `docs/phase-2.1A.8-authority-fence-source-identity-audit.md`；不能仅凭 `processedTaskIds`/`processedGrantIds` 标记完成。
- 扫描中发现的新对象若仍绑定旧 `sourceVersion`，必须纳入旧 Fence 或 fail closed；不能当作新对象跳过。

### 3.3 Controller 转移与撤权

- 若 transfer 先提交：旧 fence 的条件更新识别到具体 Task binding 已改变，跳过；旧 snapshot Grant 已由 transfer 同事务撤销；新 controller 保持。
- 若撤权先提交：Owner/Admin 仍可 transfer；新 controller 必须重新通过当前授权；旧 controller 不能恢复。
- transfer 必须重新写 `controllerPrincipalVersion`/`controllerMembershipVersion`/`controllerDelegationVersion`；不能只改 ID。

### 3.4 运行中 Execution

- 撤权不取消 Execution、不释放 Lease、不写 cancel request。
- 已提交 `dispatch_intent` 的 Execution 可由绑定 executor/lease 提交 result/terminal 证据；该路径不能创建新 Execution 或发送新 prompt。
- 若 executor 本身不可用，按 Phase 1.1 的 interrupted/unknown 规则处理；不能伪造 completed/cancelled。

---

## 4. Replay 与撤权的交叉审计

### 4.1 固定顺序

```text
lock
 -> load current Principal/Workspace/Membership/Delegation/ACL
 -> recompute effective authorization
 -> resolve requestKey scope
 -> lookup RequestRecord
 -> if exists:
      current auth invalid -> AUTHORIZATION_REVOKED
      inputHash differs    -> IDEMPOTENCY_CONFLICT
      else                 -> original resultSnapshot; replayed=true
 -> if not exists:
      expectedRevision + expectedAuthorizationRevision/entity versions
      state preconditions/execution leases
      changes + RequestRecord + events -> atomic persist
unlock
```

- 授权在最前；`inputHash` 在返回结果前验证。
- Replay 不检查 `expectedRevision`/`expectedAuthorizationRevision`；新请求才检查。
- Replay 不重新执行，不再次调用 ACP prompt/cancel，不写 Event。
- 并发同 scope 由单 Store 串行化；一个首次执行，另一个 replay；不会重复 mutation/外部副作用。

### 4.2 撤权后的行为

| 场景 | 结果 |
|---|---|
| Membership 撤销后 Replay | `AUTHORIZATION_REVOKED`；不返回 resultSnapshot |
| Delegation 撤销/过期后 Replay | 同上 |
| Principal 禁用/删除后 Replay | 同上 |
| Artifact ACL 修改后 Replay | 当前 ACL 不允许则拒绝 |
| 同 key 不同 inputHash | `IDEMPOTENCY_CONFLICT` |
| 同 key 不同 operation | scope 不同；不跨 operation replay |
| dispatch_intent 已提交后 Hub 崩溃 | Replay 只返回原接受结果；不再 prompt；远端仍 unknown |
| Replay 与当前读权限 | 读 API 另走当前资源可见性 |

### 4.3 结果可查询性

**Replay 不是读取授权。** 撤权后：

- 原调用者若仍是 Task/Execution/Artifact 的当前读取主体，可通过 `getTask`/`getExecution`/`getExecutionResult`/`getArtifact` 读取已提交事实；
- 若已失去读取权限，不能通过 requestKey、`resultSnapshot` 或旧 cursor 读取；
- v3 不承诺“原请求者永久可读结果”；若产品要求，必须设计独立 RequestResult ACL，不能扩大 Replay 权限；
- Replay 拒绝不会删除已提交 Task/Execution/Artifact/Event。

---

## 5. Phase 2.0 基线来源核对（OD-09）

### 5.1 仓库与 Git 搜索结果

核对时间：2026-11-11；仓库 HEAD `8f769e7e072f22705f29168e3395afe6b758272a`。

| 检查 | 结果 |
|---|---|
| `docs/phase-2.0-architecture-baseline.md` | 不存在 |
| 全仓库文件名含 `baseline` | 只有 `docs/phase-2.0-baseline-review.md` |
| Git 历史所有路径 (`git log --all --name-status`) | 从未出现 baseline 原文件 |
| `git log --all -S'Companion Hub Phase 2.0' -- docs` | 无提交 |
| `git fsck --unreachable` | 824 个未可达 blob；候选大文本未发现标题匹配；无 dangling 原文件 |
| reflog | 26 个可达提交；无 baseline 路径/提交 |
| Desktop/Downloads/Documents 同名文件 | 未发现 |

`docs/phase-2.0-baseline-review.md` 记录：审查对象是“用户提供的 Phase 2.0 Architecture Baseline / Draft v2.0（781 行）”，被审查代码基线 `a83e52f3ec9d03718411680ee1d6f1516729a4d5`。该 Review 是**证据**，不是原文，不能据此拼凑原文。

### 5.2 用户补充的基线

任务书声明用户已补充完整的 Companion Hub Phase 2.0 架构设计基线文本；本仓库当前未收到可校验的正文文件或 Git 对象。可确认的元数据为：

- 标题：Companion Hub Phase 2.0 架构设计基线
- 版本：2.0
- 状态：Architecture Baseline / Draft
- 用途：Phase 2 后续 API、数据模型、分阶段实现的依据
- 覆盖：项目定位、Principal、Workspace、RBAC、Delegation、Task/Execution、Message/Event/Command、Agent Connector、Execution Feedback、Automation、DSH Adapter、多 Agent 协作、审计、实施阶段、待确认事项。

本仓库当前没有该文本的可验证文件或 Git 对象。因此：

- 不能声称“已从 Git 历史恢复原文”；
- 不能把 Review/后续设计拼成“原始基线”；
- 不能把 Draft 的建议当作已冻结决策；
- 用户补充的元数据/范围可作为来源说明，但仓库归档仍需单独确认。

### 5.3 规范性层级

```text
Phase 2.0.3（AD-12/13/14）
  > Phase 2.0.2（AD-06..11）
  > Phase 2.0.1（AD-01..05）
  > 用户提供的 Phase 2.0 Draft v2.0（历史输入）
```

- 2.0.1/2.0.2/2.0.3 的冻结决策继续有效；Draft 不得覆盖。
- `phase-2.0-baseline-review.md` 是审查证据，不是规范性 AD。
- 若 Draft 与冻结 AD 冲突，以冻结 AD 为准；冲突应记录，不得静默选择。

### 5.4 OD-09 最终状态

**NEEDS_USER_DECISION（范围已收窄）。**

已确定：

- 原始基线内容由用户补充/声明；仓库无可验证原文；
- 规范性依据为 2.0.1/2.0.2/2.0.3 + 本阶段审查文档；
- 不伪造归档文件。

仍需用户选择：

- 方案 A：提供可校验的原文，归档为 `docs/phase-2.0-architecture-baseline.md`，记录来源/校验和；推荐用于审计可追溯性。
- 方案 B：确认不归档原文，以冻结的 2.0.1/2.0.2/2.0.3 + baseline review 为唯一规范性依据，并在文档中保留来源缺口说明。

在用户选择前，OD-09 不能标记为 `DECIDED`。

---

## 6. Phase 2.1A.3 实施准入复核

### 6.1 逐项状态

| 领域 | 状态 | 说明 / 解除条件 |
|---|---|---|
| Contracts v3 实体/状态 | **CONDITIONAL** | 实体/状态语义完整；authority version/AD-06-R1/AD-12-R1 已冻结；实现仍待批准 |
| Store v3 授权/mutation 原子性 | **CONDITIONAL** | `commitAuthorized` 设计明确；OD-11 已冻结；实现/故障测试未开始 |
| Replay 顺序/结果可查询性 | **READY** | 设计已明确；实现需并发/崩溃/撤权测试 |
| Membership/Delegation/Principal 撤权 | **READY** | 统一模型/AD-06-R1/AD-12-R1 已冻结；实现测试未开始 |
| WorkspaceLease / 文件边界 | **CONDITIONAL** | mutex/lease 设计明确；OS 隔离为 **BLOCKED**（无 native helper/OS sandbox） |
| Artifact ACL 独立检查 | **CONDITIONAL** | ACL 独立；AD-06-R1 已冻结；实现/存储未完成 |
| Event 查询重新授权 | **READY** | 每次读取重新授权；cursor 不是凭证 |
| v2→v3 Migration | **CONDITIONAL** | 拒绝猜测/隔离策略明确；manual recovery 未实现/演练 |
| ACP Adapter 能力限制 | **CONDITIONAL** | 不承诺 exactly-once；unknown/cancel/late notification 仍是实现/测试项 |
| 并行 Execution 写隔离 | **CONDITIONAL** | mutex 可验证；worktree/copy 能力未证明，不能宣称已隔离 |

### 6.2 BLOCKED / NEEDS_USER_DECISION

**BLOCKED：**

1. **Workspace OS 隔离**：当前只有字符串 normalize（`packages/windows-paths/index.mjs:2-4`），DSH 子进程同 OS 用户；真实隔离需 native helper/OS sandbox。若产品接受 cooperative，则不要求该项作为实现前置，但不得宣称 OS 隔离。

**NEEDS_USER_DECISION：**

- OD-09：是否归档用户补充的原始基线。该事项不影响 OD-11/撤权设计冻结。

### 6.3 OD-11 决策记录（已由用户冻结）

| 选项 | 内容 | 结果 |
|---|---|---|
| **A（已选择）** | authority version + effective 派生 + `AuthorityRevocationFence`；撤权 commit 原子写源状态/version/fence，授权立即拒绝；`Task.controlState`/`ArtifactGrant.revokedAt` 是 cache，reconcile 只物化 | **冻结为正式语义**；AD-06-R1/AD-12-R1 已记录 |
| B | 严格按 AD-12/AD-06：撤权 commit 枚举所有受影响 Task/Grant 并写 frozen/revoked | 未选择；O(N) 写放大/容量上限 |
| C | 混合同步前 N 个 + fence 异步 | 未选择；仍有物理滞后且不能字面闭合 |

冻结后的约束：

- Store 撤权实现不再受 OD-11 阻塞；不得再以“等待 OD-11”为由推迟设计/实现规划。
- 不得把派生 `Task.controlState`/`ArtifactGrant.revokedAt` 当作授权事实来源。
- 不得把 scheme A 扩大解释为“所有 Artifact ACL 变化都可延迟”；AD-06 的显式 grant/transfer/owner/visibility 规则不变。

### 6.4 P0 / P1 / P2

**P0：**

- P0-01：v2 不能承载 v3（`packages/contracts/v2.d.ts:4` 的 `TaskStatus=ExecutionStatus`；`packages/task-store-v2/index.mjs:248` 的 `commit(expectedRevision, changes)` 无授权；`packages/dsh-acp-v2/index.mjs:198-202` 的读接口无过滤）。
- P0-02：Workspace 不是 OS 隔离；`packages/windows-paths/index.mjs:2-4` 只有字符串 normalize；cooperative 边界必须明确。

**P1：**

- A4-P1-01：三种撤权来源的统一实现/测试（authority version、fence、reconcile）。
- A3-P1-01：Replay 顺序/resultSnapshot 实现。
- A3-P1-02：Fence/reconcile 实现（AD-06-R1/AD-12-R1 已冻结）。
- P1-03：Store v3 容量/JSON 写放大。
- P1-04：Windows native path guard。
- P1-05：v2→v3 migration manual recovery。
- P1-06：ACP unknown/无 replay/取消不确认。
- P1-07：Artifact 物理存储/保留。
- P1-08：Delegation/Principal 到期/撤权物化调度。

**P2：**

- API 错误码/分页/命名；Event schema；`Task.title/description`；`dispatching/cancelling` 字段名；容量参数；Message/ACK；跨 Workspace Artifact。

### 6.5 实现阶段影响

- Phase 0（Contracts/纯状态机）可继续：需要加入 `AuthorityRevocationFence`、controller authority version、snapshot-controller grantee/source version。
- Phase 1（Store 核心）可先做无撤权的 commit/replay；撤权 commit 可按 AD-12-R1 实现，但整体实现仍需 Phase 2.1B 批准。
- Phase 2（Identity/Workspace/Membership/Delegation）按 AD-12-R1 实现撤权事务。
- Phase 3（Task/Execution）必须使用 effective control/authority version，不能读 stored `controlState` 当授权。
- Phase 4（Artifact）必须使用 snapshot-controller grantee/source delegation version；explicit/requester 用 live ACL；AD-06-R1 已冻结，显式转移仍同事务。
- Phase 5-9 的顺序不变；Migration 必须为控制器写 authority version，缺版本进入 manual recovery。

---

## 7. 剩余问题与依赖

| ID | 问题 | 状态 | 解除条件 |
|---|---|---|---|
| OD-09 | 原始基线归档 | NEEDS_USER_DECISION | 用户提供原文归档，或确认不归档 |
| OD-11 | AD-06/AD-12 逻辑撤权解释 | **DECIDED（方案 A）** | 已冻结；AD-06-R1/AD-12-R1 |
| P0-01 | v2 不能承载 v3 | BLOCKED | 新建 v3；不在 v2 打补丁 |
| P0-02 | Workspace OS 隔离 | BLOCKED | native helper/OS sandbox，或明确接受 cooperative |
| A4-P1-01 | 统一撤权实现 | CONDITIONAL | 实现/故障测试 |
| A3-P1-01 | Replay 实现 | CONDITIONAL | 并发/崩溃/撤权测试 |
| A3-P1-02 | Fence/reconcile 实现 | CONDITIONAL | 幂等/crash/transfer 测试 |
| P1-03..08 | 容量/路径/迁移/ACP/Artifact/到期 | CONDITIONAL | 各自实现/验收 |

依赖顺序：

```text
Contracts v3 + 纯状态机
  -> Store v3 核心（无撤权）
  -> 撤权 commit + fence/reconcile（AD-06-R1/AD-12-R1）
  -> Identity/Workspace/Membership/Delegation
  -> Task/Execution
  -> Artifact/ACL
  -> Event/API
  -> Migration
  -> Windows path guard
  -> ACP Adapter
  -> 集成/恢复
```

---

## 8. 验证记录

本阶段为 docs-only，未实现新设计，也未编写针对撤权/Fence/Replay 的测试；已执行：

- 文档与代码交叉核对：Phase 1.1 Contracts/Store/Executor、Phase 2.0.1/2.0.2/2.0.3、Phase 2.1A/2.1A.1/2.1A.2/2.1A.3。
- Git 来源核对：路径、pickaxe、reflog、unreachable blobs、同名文件。
- 现有 Phase 1.1 回归：`npm test` 118/118 通过（首轮 `hub-stop` 出现一次环境性 ready timeout，隔离重跑通过；第二轮全量 118/118）。
- 文档检查：`git diff --check`、`git show --check`、敏感信息扫描。
- 不修改源码/配置/数据库/测试。

未验证：

- 真实多 Principal/Workspace/Delegation 运行；
- Fence/reconcile crash/并发；
- Windows native path guard；
- ACP 真实撤权/取消竞态；
- v2→v3 迁移演练。

这些是 P0/P1 实现验收，不是本文件已完成的证明。

---

## 9. 最终判断

**撤权模型：设计层 FROZEN（OD-11 方案 A）。**

- 直接 User、委托 Agent、自主 Agent 三条控制路径统一到 authority version + effective control；
- Membership/Delegation/Principal 三种失效来源统一到 `AuthorityRevocationFence` + reconcile；
- 撤权与执行取消/Lease/Artifact 删除分离；
- Replay 重新授权，结果读取另走当前 ACL；
- 多来源并发取并集，无自动 unfreeze；
- AD-06-R1/AD-12-R1 已正式冻结。

**实现准入：NOT APPROVED。**

- OD-11 已解决；OD-09 归档独立待处理，不阻塞撤权设计；
- P0-01/P0-02、P1 未关闭；
- 没有任何撤权/Fence/Replay 实现或真实测试。

本文件不开始 Phase 2.1B，不实现代码，不推送远程。
