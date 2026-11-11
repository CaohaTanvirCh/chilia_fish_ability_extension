# Phase 2.1A.7 Delegation Membership Binding & Reconcile Commit Boundary Audit

状态：**A7-P1-01..P1-02 CLOSED (DESIGN) / DOCS-ONLY / IMPLEMENTATION NOT APPROVED / OD-09 OPEN**

日期：2026-11-11（Asia/Shanghai）

范围：docs-only。不修改源码、测试、Schema、配置或运行时行为；不实现 Fence/Reconcile/授权；不批准 Phase 2.1B。

依据：

- 基线 commit：`652f02d84a4fa801bef76e0f701cb4370fa7fd6c`
- `docs/phase-2.1A.2-contracts-v3-design.md`
- `docs/phase-2.1A.2-store-api-v3-design.md`
- `docs/phase-2.1A.4-revocation-model-closure.md`
- `docs/phase-2.1A.5-authority-fence-decision-closure.md`
- `docs/phase-2.1A.6-reconcile-target-identity-audit.md`
- `docs/phase-2.0.3-implementation-constraints.md`（AD-12-R1）

---

## 0. 本轮发现与修订记录

### 0.1 P1-01：Delegation 两端 Membership 版本遗漏

**发现：** A5/A6 的 Membership fence 条件更新只写了：

- 直接 controller：`controllerMembershipVersion`；
- 委托 controller：`grantorMembershipVersion`。

这遗漏了 `delegateMembershipVersion`。Task 的 `controllerMembershipVersion` 只代表 controller（通常是 Agent delegate）的 Membership，不能替代 Delegation grantor 的 Membership；同样，grantor 版本也不能替代 delegate 版本。

**修订：**

- Membership fence 对委托目标必须同时检查 `grantorMembershipVersion` 与 `delegateMembershipVersion`。
- Principal fence 对委托目标必须同时检查 `grantorPrincipalVersion` 与 `delegatePrincipalVersion`。
- ArtifactGrant 的 `sourceDelegationId` 非 null 时，必须解析完整 Delegation binding；只检查 `sourceDelegationVersion` 不足。
- A5/A6/A4/Store/Contracts/A3/Review 已同步；本文件给出矩阵。

### 0.2 P1-02：批次与完成 commit 边界混淆

**发现：** A6 第 5 节原第 7 条“所有批次、派生事件、完成记录同 commit”会被理解为所有批次和 completion 必须在同一个 Store commit，与 A6 第 6 节的部分批次/崩溃恢复描述冲突。

**修订：**

- 撤权源 commit、每个 Reconcile batch commit、Fence completion commit 是三个不同边界。
- 每个 batch 内部原子；不要求所有 batch 同一事务。
- completion 单独提交；失败保持 pending/retry，不回滚已完成 batch，不重复派生事件。

**结论：A7-P1-01..P1-02 在设计层关闭；实现测试未开始。**

---

## 1. Delegation grantor/delegate authority binding

### 1.1 字段

Contracts v3 的 `DelegationGrant` 已有：

```text
delegationId
workspaceId
grantorPrincipalId
grantorPrincipalVersion
grantorMembershipVersion
delegatePrincipalId
delegatePrincipalVersion
delegateMembershipVersion
version
status
expiresAt
```

- `grantorPrincipalVersion` / `grantorMembershipVersion` 是 grant 创建时的 grantor binding。
- `delegatePrincipalVersion` / `delegateMembershipVersion` 是 grant 创建时的 delegate binding。
- 四个字段都必须匹配当前权威记录，Delegation 才有效。
- **不得把 grantor 与 delegate 合并成一个“membership version”**；两端是独立主体、独立 Membership。

### 1.2 DelegationAuthorityBinding

```text
DelegationAuthorityBinding:
  delegationId
  delegationVersion
  grantorPrincipalId
  grantorPrincipalVersion
  grantorMembershipVersion
  delegatePrincipalId
  delegatePrincipalVersion
  delegateMembershipVersion
```

- 通过 `delegationId` 从权威 Delegation 记录解析。
- `delegationId`/`delegationVersion` 缺失、记录不存在、version 不匹配 -> fail closed，不能猜当前记录。
- Task 的 `controllerDelegationId`/`controllerDelegationVersion` 指向该 binding。
- ArtifactGrant 的 `sourceDelegationId`/`sourceDelegationVersion` 指向该 binding。

### 1.3 不重复存储 vs 必须可 join

如果现有字段能通过权威 Delegation 记录无歧义地推导，不必在 Task/ArtifactGrant 重复存四个字段；但必须明确：

- join key：`controllerDelegationId` 或 `sourceDelegationId`；
- version guard：`controllerDelegationVersion` / `sourceDelegationVersion`；
- 解析失败 -> fail closed；
- 解析出的 grantor/delegate 两端都参与授权和 Reconcile 匹配。

---

## 2. Principal Fence 与 Membership Fence 匹配矩阵

### 2.1 直接 controller

| Fence | 匹配规则 | 说明 |
|---|---|---|
| Principal fence | `Task.controllerPrincipalId == fencePrincipalId` **AND** `Task.controllerPrincipalVersion == sourceVersion` | global；不能只看 version |
| Membership fence | `Task.workspaceId == fenceWorkspaceId` **AND** `Task.controllerPrincipalId == fencePrincipalId` **AND** `Task.controllerMembershipVersion == sourceVersion` | workspace + principal + version |

### 2.2 委托 controller（Task）

| Fence | 匹配规则 | 说明 |
|---|---|---|
| Principal fence | `(grantorPrincipalId == fencePrincipalId AND grantorPrincipalVersion == sourceVersion)` **OR** `(delegatePrincipalId == fencePrincipalId AND delegatePrincipalVersion == sourceVersion)` | 两端都检查；ID 与 version 同时匹配 |
| Membership fence | `Delegation.workspaceId == fenceWorkspaceId` **AND** `((grantorPrincipalId == fencePrincipalId AND grantorMembershipVersion == sourceVersion)` **OR** `(delegatePrincipalId == fencePrincipalId AND delegateMembershipVersion == sourceVersion))` | 两端都检查；workspace + principal + membership version |

- “OR”表示任一端的 **ID + version** 同时命中该 fence，该 Task 就是目标。
- 不能只比较 version；不同 Grantor/Delegate 的相同数字版本不能命中。
- identity 必须保留两端字段；不能因为一端命中就推断另一端有效。
- 若 Delegation 记录缺失、Workspace 不一致、grantor/delegate Principal ID 与引用不一致：Task 进入 fail closed/frozen，不能按 active 处理。

### 2.3 ArtifactGrant

| Grant 关系 | Fence | 匹配 |
|---|---|---|
| snapshot-controller Grant（sourceDelegationId 非 null） | Principal fence | source Delegation workspace 一致；`(grantorPrincipalId==fencePrincipalId AND grantorPrincipalVersion==sourceVersion)` OR `(delegatePrincipalId==fencePrincipalId AND delegatePrincipalVersion==sourceVersion)` |
| snapshot-controller Grant | Membership fence | Artifact workspace 与 source Delegation workspace 一致且等于 fenceWorkspaceId；`(grantorPrincipalId==fencePrincipalId AND grantorMembershipVersion==sourceVersion)` OR `(delegatePrincipalId==fencePrincipalId AND delegateMembershipVersion==sourceVersion)` |
| snapshot-controller Grant | Delegation fence | `sourceDelegationId == fenceDelegationId` AND `sourceDelegationVersion == sourceVersion` AND workspace 一致 |
| snapshot-controller Grant | grantee 失效 | Principal：`granteePrincipalId==fencePrincipalId AND granteePrincipalVersion==sourceVersion`；Membership：`Artifact.workspaceId==fenceWorkspaceId AND granteePrincipalId==fencePrincipalId AND granteeMembershipVersion==sourceVersion` |
| explicit/requester Grant | Principal/Membership | live ACL；不进入 Fence 的物理 `revokedAt` 目标 |

- `sourceDelegationVersion` 只证明 Delegation 记录版本，不证明 grantor/delegate 的 Principal/Membership 仍有效。
- ArtifactGrant 的完整 target identity 必须包含 artifact workspace + grantee binding + source Delegation 两端 binding。
- 只检查 `sourceDelegationVersion` 不足以覆盖 Principal/Membership fence。

### 2.4 双 Fence 命中

- 同一 Delegation 可能同时被 Principal fence 和 Membership fence 命中。
- 两个 Fence 都有效；Task/Grant 目标取并集。
- 一个 Fence 完成不能清除另一个；effective 拒绝取并集。
- Reconcile 每个 Fence 各自扫描/完成；同一对象可以出现在两个 Fence 的 target 集。

---

## 3. Task 与 ArtifactGrant target identity

### 3.1 TaskTargetIdentity

```text
TaskTargetIdentity:
  taskId
  workspaceId
  controllerPrincipalId
  controllerPrincipalVersion
  controllerMembershipVersion
  controllerDelegationId
  controllerDelegationVersion
  resolvedDelegation?:
    workspaceId
    grantorPrincipalId/Version
    grantorMembershipVersion
    delegatePrincipalId/Version
    delegateMembershipVersion
```

匹配规则：

- 直接 controller：`controllerPrincipalId` + `controllerPrincipalVersion`（Principal fence）；`workspaceId` + `controllerPrincipalId` + `controllerMembershipVersion`（Membership fence）。
- 委托 controller：解析 Delegation 后，grantor/delegate 两端分别比较 Principal ID + Principal version、Workspace + Principal ID + Membership version。
- 不能只看 Principal ID、Delegation ID、version 数值或 `controllerMembershipVersion`。

### 3.2 SnapshotGrantTargetIdentity

```text
SnapshotGrantTargetIdentity:
  grantId
  artifactId
  workspaceId
  origin=task-snapshot-controller
  granteePrincipalId/Version
  granteeMembershipVersion
  sourceDelegationId
  sourceDelegationVersion
  resolvedSourceDelegation?:
    workspaceId
    grantorPrincipalId/Version
    grantorMembershipVersion
    delegatePrincipalId/Version
    delegateMembershipVersion
```

匹配规则：

- 先按 grantId 锁定具体 Grant；不能用新 Grant 替代旧 Grant。
- 解析 source delegation；Workspace、grantor/delegate Principal ID、Principal/Membership version 都参与匹配。
- `sourceDelegationVersion` 只用于版本 guard，不是完整授权证明。
- 缺失/Workspace 不一致/ID 不一致/version 不一致 -> fail closed。

### 3.3 目标与 sourceVersion

- 目标属于旧 Fence 的判据是 **source identity + scope + authority version 同时匹配**，不是 version 相等。
- Principal fence：对象中的 Principal ID 必须等于 sourceKey 的 principalId，对应 Principal version 必须等于 sourceVersion；scope=global。
- Membership fence：对象 Workspace 必须等于 sourceKey 的 workspaceId，Principal ID 必须等于 sourceKey 的 principalId，对应 Membership version 必须等于 sourceVersion。
- Delegation fence：delegationId 必须等于 sourceKey 的 delegationId，version 必须等于 sourceVersion，Workspace 一致。
- 目标是否可跳过：只能是该具体对象的权威变更（transfer/revoke）改变了 binding。
- 不能因为“当前 Membership=active”“当前 Principal=active”“新建 Delegation”就跳过旧目标。
- 不能因为 new explicit Grant 存在就认为旧 snapshot Grant 已撤销。

---

## 4. 十个以上场景

### 4.0 匹配摘要

| # | 场景 | Fence source identity | 对象 identity | version 关系 | 属于目标？ | effective / control | Reconcile 完成 |
|---:|---|---|---|---|---|---|---|
| 1 | User grantor Membership 撤销，delegate 仍有效 | `membership:ws:U` V | D.grantorPrincipalId=U、grantorMembershipVersion=V | 同 Workspace + 同 Principal + 同 version | 是（grantor 端） | Delegation 失效 / frozen | Task frozen + source Grant revoked；delegate 有效不改变 |
| 2 | Agent delegate Membership 撤销，grantor 仍有效 | `membership:ws:A` V | D.delegatePrincipalId=A、delegateMembershipVersion=V | 同 Workspace + 同 Principal + 同 version | 是（delegate 端） | Delegation 失效 / frozen | Task frozen + Grant revoked；不能只看 grantor |
| 3 | grantor Principal disable | `principal:U` V | D.grantorPrincipalId=U、grantorPrincipalVersion=V | 同 Principal + 同 version（global） | 是（grantor 端） | Delegation 失效 / frozen | Task frozen + Grant revoked |
| 4 | delegate Principal disable | `principal:A` V | D.delegatePrincipalId=A、delegatePrincipalVersion=V | 同 Principal + 同 version（global） | 是（delegate 端） | Delegation 失效 / frozen | Task frozen + Grant revoked |
| 5 | grantor re-add | `membership:ws:U` V | old D.grantorPrincipalId=U、grantorMembershipVersion=V；新 Membership V+2 | 旧对象 version 仍 V | 旧对象是；新对象不是 | 旧 Delegation 仍失效 / 旧 Task frozen | 旧 Task frozen + 旧 Grant revoked；新对象不属旧 Fence |
| 6 | delegate re-add | `membership:ws:A` V | old D.delegatePrincipalId=A、delegateMembershipVersion=V；新 Membership V+2 | 旧对象 version 仍 V | 旧对象是；新对象不是 | 旧 Delegation 仍失效 / 旧 Task frozen | 旧 Task frozen + 旧 Grant revoked |
| 7 | 新 Delegation 创建 | `delegation:D1` V | old Task.controllerDelegationId=D1、version=V；新 D2 | 旧 Task 仍 D1/V | 旧 Task 是；新 D2 不是 | 旧 Task frozen | 旧 Task frozen；只有 transfer 才绑定 D2 |
| 8 | 撤权与 transfer 并发 | `delegation:D1` V | 旧 Task D1/V；transfer 后 taskId 新 binding | 旧 binding 同；新 binding 不同 | 旧 binding 是；新 binding 不是 | 新 controller active；旧 controller frozen | 旧 Fence 仅对旧 binding 条件跳过；旧 Grant 已撤销 |
| 9 | Principal + Membership 双 Fence | `principal:U` V1 + `membership:ws:A` V2 | 对象同时含 U 的 Principal binding 与 A 的 Membership binding | 分别匹配各自 source identity/version | 属于两个 Fence | 并集拒绝 / frozen | 两个 Fence 都需完成；一个完成不清除另一个 |
| 10 | source snapshot Grant 与 Task controller 同时受影响 | `delegation:D1` V | Task.controllerDelegationId=D1/V；Grant.sourceDelegationId=D1/V | 同 delegationId + 同 version + 同 Workspace | 两者都是 | Task frozen；Grant effective 无效 | Task frozen + Grant revoked；不能只处理一端 |
| 11 | grantee Membership 撤销，Delegation 仍有效 | `membership:ws:A` V | Grant.granteePrincipalId=A、granteeMembershipVersion=V | 同 Workspace + 同 Principal + 同 version | snapshot Grant 是；explicit/requester 只 live ACL | Grant 失效 / 不适用 | snapshot Grant revoked；不能因 Delegation 有效而放行 |
| 12 | 新 explicit Grant 与旧 snapshot Grant 并存 | `delegation:D1` V | old Grant.sourceDelegationId=D1/V；new explicit grantId 不同 | 旧 Grant 同 ID/version；新 Grant 不同 ID | 旧 Grant 是；新 Grant 不是 | 新 Grant 按独立 ACL；旧 Grant 无效 | 旧 Grant revoked；新 Grant 不需旧 Fence 处理 |

详细小节补充 effective/control/Reconcile；identity/version 关系以本摘要表为准。

### 4.1 User grantor Membership 被撤销，Agent delegate Membership 仍有效

> 以下详表只补充 effective/Reconcile；target 是否命中以 4.0 摘要的 source identity + scope + version 同时匹配为准。仅 version 相同不算命中。

| 维度 | 结果 |
|---|---|
| 权威状态 | grantor Membership V->V+1；Fence(V)；delegate Membership 不变 |
| effective 授权 | Delegation 因 grantorMembershipVersion 不匹配失效；Agent 自身 Membership 仍有效也不够 |
| effectiveControlState | frozen |
| Reconcile 目标 | Task 通过 grantorMembershipVersion=V 命中；source snapshot Grant 通过 source Delegation grantorMembershipVersion=V 命中 |
| 完成条件 | Task frozen + snapshot Grant revoked；delegate 有效不改变目标 |

### 4.2 Agent delegate Membership 被撤销，User grantor Membership 仍有效

| 维度 | 结果 |
|---|---|
| 权威状态 | delegate Membership V->V+1；Fence(V)；grantor Membership 不变 |
| effective 授权 | Delegation 因 delegateMembershipVersion 不匹配失效 |
| effectiveControlState | frozen |
| Reconcile 目标 | Task 通过 delegateMembershipVersion=V 命中；Grant 通过 source Delegation delegateMembershipVersion=V 命中 |
| 完成条件 | Task frozen + Grant revoked；不能只看 grantorMembershipVersion |

### 4.3 grantor Principal 被 disable

| 维度 | 结果 |
|---|---|
| 权威状态 | grantor Principal V->V+1；Principal Fence(V) |
| effective 授权 | Delegation 因 grantorPrincipalVersion 不匹配失效；Agent controller frozen |
| effectiveControlState | frozen |
| Reconcile 目标 | Task 通过 grantorPrincipalVersion=V 命中；Grant 通过 source Delegation grantorPrincipalVersion=V 命中 |
| 完成条件 | Task frozen + Grant revoked；delegate Principal 有效不改变目标 |

### 4.4 delegate Principal 被 disable

| 维度 | 结果 |
|---|---|
| 权威状态 | delegate Principal V->V+1；Principal Fence(V) |
| effective 授权 | Delegation 因 delegatePrincipalVersion 不匹配失效；Agent controller frozen |
| effectiveControlState | frozen |
| Reconcile 目标 | Task 通过 delegatePrincipalVersion=V 命中；Grant 通过 source Delegation delegatePrincipalVersion=V 命中 |
| 完成条件 | Task frozen + Grant revoked；不能只看 grantorPrincipalVersion |

### 4.5 grantor re-add 后旧 Delegation 不恢复

| 维度 | 结果 |
|---|---|
| 权威状态 | grantor Membership revoke V->V+1；re-add V+1->V+2 |
| effective 授权 | 旧 Delegation 的 grantorMembershipVersion 仍 V；不匹配 V+2，仍失效 |
| effectiveControlState | 旧 Task 仍 frozen |
| Reconcile 目标 | 旧 Fence 仍处理旧 Task/Grant；re-add 不改变旧 binding |
| 完成条件 | 旧 Task frozen + 旧 Grant revoked；新对象 V+2 不是旧 Fence 目标 |

### 4.6 delegate re-add 后旧 Delegation 不恢复

| 维度 | 结果 |
|---|---|
| 权威状态 | delegate Membership revoke V->V+1；re-add V+1->V+2 |
| effective 授权 | 旧 Delegation 的 delegateMembershipVersion 仍 V；不匹配 V+2，仍失效 |
| effectiveControlState | 旧 Task 仍 frozen |
| Reconcile 目标 | 旧 Fence 仍处理旧 Task/Grant；re-add 不改变旧 binding |
| 完成条件 | 旧 Task frozen + 旧 Grant revoked；新 Delegation/新 Task 才使用新 version |

### 4.7 新 Delegation 创建后旧 Task 不自动绑定

| 维度 | 结果 |
|---|---|
| 权威状态 | 新 delegationId/version |
| effective 授权 | 旧 Task 的 controllerDelegationId 仍旧 ID；不会自动使用新 Delegation |
| effectiveControlState | 旧 Task 仍 frozen |
| Reconcile 目标 | 旧 Task 仍是旧 Fence 目标；新 Delegation 不是替代记录 |
| 完成条件 | 旧 Task frozen；只有显式 transfer 才绑定新 Delegation |

### 4.8 撤权与 Controller transfer 并发

| 维度 | 结果 |
|---|---|
| 权威状态 | 旧 Fence(V)；transfer 为具体 taskId 写入新 controller/binding |
| effective 授权 | transfer 后新 controller active；旧 controller frozen |
| effectiveControlState | 新 controller active；旧 controller 不再控制 |
| Reconcile 目标 | 仅当该 taskId binding 已改变且旧 snapshot Grant 同事务撤销时跳过；否则仍目标 |
| 完成条件 | 旧 Fence 完成前需确认旧目标已 frozen/revoked 或有合法 transfer 记录 |

### 4.9 Delegation 同时被 Principal Fence 和 Membership Fence 命中

| 维度 | 结果 |
|---|---|
| 权威状态 | 两个 Fence 同时有效（例：grantor Principal disable + delegate Membership revoke） |
| effective 授权 | 并集拒绝；Delegation 失效 |
| effectiveControlState | frozen |
| Reconcile 目标 | 同一 Task/Grant 可同时属于两个 Fence；每个 Fence 各自完成 |
| 完成条件 | 两个 Fence 都需完成；一个完成不能清除另一个 |

### 4.10 source snapshot Grant 与 Task controller 同时受影响

| 维度 | 结果 |
|---|---|
| 权威状态 | Delegation revoke/expiry 或双端撤权，Fence 命中 controller 和 source Grant |
| effective 授权 | Task controller frozen；snapshot Grant effective 无效 |
| effectiveControlState | frozen |
| Reconcile 目标 | Task 和 snapshot Grant 都是目标；不能只处理一端 |
| 完成条件 | Task frozen + Grant revoked；source Delegation 两端 binding 均检查 |

### 4.11 ArtifactGrant grantee Membership 撤销，Delegation 仍有效

| 维度 | 结果 |
|---|---|
| 权威状态 | grantee Membership V->V+1；Membership Fence(V) |
| effective 授权 | Grant 因 granteeMembershipVersion 不匹配失效；Delegation 本身可能仍有效 |
| effectiveControlState | 不适用（Grant 场景） |
| Reconcile 目标 | 若为 snapshot-controller Grant，按 granteeMembershipVersion=V 物化 revokedAt；explicit/requester 只做 live ACL |
| 完成条件 | 具体 Grant 目标满足；不能把 Delegation 两端未失效当作 Grant 仍有效 |

### 4.12 新 explicit Grant 与旧 snapshot Grant 并存

| 维度 | 结果 |
|---|---|
| 权威状态 | 新 explicit grantId；旧 snapshot Grant 仍存在 |
| effective 授权 | 新 explicit Grant 按独立 ACL 生效；旧 snapshot Grant 由 Fence 立即无效 |
| effectiveControlState | 不适用 |
| Reconcile 目标 | 旧 snapshot Grant 仍是目标；新 explicit Grant 不是替代 |
| 完成条件 | 旧 snapshot Grant revoked；新 explicit Grant 不需被旧 Fence 处理 |

---

## 5. batch commit 与 completion commit 边界

### 5.1 三个原子边界

| 边界 | 写入 | 原子范围 |
|---|---|---|
| 撤权源 commit | 最终授权检查 + 源 status/version + `AuthorityRevocationFence` + `authorizationRevision` + 源级事件 | 一个 commit |
| Reconcile batch commit | 当前批次目标投影（Task frozen / snapshot Grant revoked）+ 派生事件 + 幂等进度 | 每个 batch 一个 commit |
| Fence completion commit | 重新扫描确认后：`status=completed` + `completedAt` + `authorization.reconciled` + 审计/进度 | 独立的最后 commit |

- **不得要求所有批次和 completion 处于同一个 Store commit。**
- 每个 batch 内部必须原子；失败不能留下“投影更新但进度未写”或相反。
- 进度记录与当前 batch 在同一 commit；不存在“batch 写入成功、进度未写”的可恢复状态。崩溃只可能是 commit 前（重做）或 commit 后（进度已存在，跳过）。
- completion commit 失败时，Fence 保持 pending/failed；已完成批次不回滚。
- completion 重试不得重复派生事件；应按 `fenceId+sourceVersion+targetId` 幂等。
- 单 Store 写入者；不引入第二写入者/分布式锁。

### 5.2 完成判定

- completion commit 前必须从权威状态重新扫描，确认当前 fence/sourceVersion/scope 的所有目标已冻结/撤销或已有具体 transfer/revoke。
- `processedTaskIds`/`processedGrantIds` 只是进度，不是完整性证明。
- 扫描不完整/引用无法解析 -> 不得 completed。
- completed 只覆盖当前 Fence；新撤权创建新 Fence。

---

## 6. 崩溃、幂等与重试矩阵

| 场景 | 源 Fence | batch 状态 | completion 状态 | 结果/恢复 |
|---|---|---|---|---|
| 撤权 commit 前崩溃 | 不存在 | 无 | 无 | 重新提交撤权 |
| 撤权 commit 后崩溃 | 有效 | 无/部分 | 未完成 | 启动扫描；从权威重算 |
| batch commit 前崩溃 | 有效 | 未提交 | 未完成 | 重做当前 batch |
| batch commit 后崩溃 | 有效 | 已提交且进度已记录 | 未完成 | 从下一 batch 继续；不重复 |
| 第一批成功、第二批失败 | 有效 | batch1 已提交；batch2 未完成 | 否 | 保留 batch1；重试 batch2 |
| batch 写入成功、记录进度前崩溃 | 有效 | 不存在该状态：进度与 batch 同一 commit | 未完成 | commit 前崩溃则重做；commit 后进度已存在，跳过 |
| 最后一批成功、completion commit 失败 | 有效 | 全部目标可能已物化 | 未完成 | 重试 completion；不回滚 batch |
| completion 成功、响应丢失 | 有效 | 已完成 | completed | 重试读取到 completed；不重复事件 |
| 两个 worker 重复同一 batch | 有效 | 已记录进度 | 可能未完成 | 单 Store 串行；第二个跳过/幂等 |
| 新 Fence 并发 | 两个有效 | 各自 batch | 各自 completion | 拒绝并集；旧完成不清除新 |
| transfer 并发（具体 taskId） | 有效 | 新 binding 已提交；旧 Grant 已撤销 | 视旧目标 | 条件更新跳过该 Task；不覆盖新 controller |
| Store 写失败 | 有效 | 未完成 | 未完成 | `failed`，retry |
| 扫描不完整 | 有效 | 不确定 | 未完成 | pending/failed，不 completed |

---

## 7. 跨文档一致性复核

| 文档 | 检查点 | 结论 |
|---|---|---|
| `phase-2.1A.2-contracts-v3-design.md` | 四个 Delegation authority 字段；Principal/Membership fence 双端匹配；ArtifactGrant source delegation 完整 binding | 一致 |
| `phase-2.1A.2-store-api-v3-design.md` | 条件更新含 delegateMembershipVersion；sourceDelegation 完整解析；batch/completion 分离 | 一致 |
| `phase-2.1A.4-revocation-model-closure.md` | 条件更新含 delegateMembershipVersion；batch/completion 分离；target identity | 一致 |
| `phase-2.1A.5-authority-fence-decision-closure.md` | 3.4 target identity 含 resolved Delegation 两端；batch/completion 条件分离 | 一致 |
| `phase-2.1A.6-reconcile-target-identity-audit.md` | target identity 含 resolved Delegation 两端；completion 条件不再要求所有批次同 commit | 一致 |
| `phase-2.1A.3-implementation-readiness.md` | 双端 Membership、source delegation、batch/completion 已同步 | 一致 |
| `phase-2.1A.2-design-review.md` | 双端 Membership、batch/completion 已同步 | 一致 |
| `phase-2.0.3-implementation-constraints.md` | AD-12-R1 只约束源级 commit；batch/completion 是独立边界 | 一致 |
| `phase-2.1A.8-authority-fence-source-identity-audit.md` | sourceKey/ID/Workspace/version 同时匹配；数值碰撞 fail closed | 一致 |

检查结果：

- 未发现只检查 Delegation grantor Membership 的规则。
- 未发现把 `controllerMembershipVersion` 当作 Delegation 两端 Membership 版本的替代。
- 未发现 Task/Grant target identity 无法定位实际失效来源。
- 未发现把所有 Reconcile 批次误写为单一原子事务。
- 未发现批次部分完成后无法安全重试。
- 未发现完成状态仅由进度 ID 推导。

---

## 8. P0 / P1 / P2 剩余问题

### 8.1 本轮关闭

| ID | 问题 | 状态 |
|---|---|---|
| A7-P1-01 | Delegation delegate Membership binding 遗漏 | **CLOSED（设计）**；实现测试未做 |
| A7-P1-02 | batch/completion commit 边界混淆 | **CLOSED（设计）**；实现测试未做 |

### 8.2 仍开放

**P0：**

- P0-01：v2 不能承载 v3；必须新建 v3。
- P0-02：Workspace 不是 OS 隔离；真实隔离需 native helper/OS sandbox，或明确接受 cooperative。

**P1：**

- P1-03：Store v3 容量/JSON 写放大。
- P1-04：Windows native path guard。
- P1-05：v2→v3 migration manual recovery。
- P1-06：ACP unknown/无 replay/取消不确认。
- P1-07：Artifact 物理存储/保留。
- P1-08：Delegation/Principal 到期/撤权物化调度。
- Reconcile/Replay 实现测试（包含 batch/completion 崩溃恢复、双端 binding、双 Fence）。
- P2：API 错误/分页、Event schema、title/description、容量参数、Message/ACK、跨 Workspace Artifact。
- OD-09：`NEEDS_USER_DECISION`（独立，不阻塞）。

---

## 9. 实现准入结论

- **OD-11：DECIDED（方案 A）。**
- **AD-06-R1 / AD-12-R1：FROZEN。**
- **A6 target identity/owner/事件分层：继续有效。**
- **A8 source identity/scope/version 匹配：继续有效。**
- Artifact owner、显式 Grant、Workspace Owner/Admin 审计权限、running Execution/unknown/interrupted/dispatch_intent 语义不变。
- **OD-09：NEEDS_USER_DECISION（独立）。**
- **代码实现：NOT APPROVED。**
- **Phase 2.1B：未获批准。**

设计层：Delegation 两端 binding、Principal/Membership fence 匹配、Task/Grant target identity、batch/completion 边界已闭合，可作为实现输入。

实现前置条件：

1. Phase 2.1B 单独批准。
2. v3 新入口实现，不在 v2 打补丁。
3. OS 隔离实现或明确接受 cooperative。
4. Store 容量/写放大基准。
5. Reconcile batch/completion 崩溃恢复与幂等测试。
6. Delegation grantor/delegate 双端 Principal/Membership fence 测试。
7. Replay/resultSnapshot 并发/撤权交叉测试。
8. Path guard、migration manual recovery、ACP 限制、Artifact 存储、到期物化等 P1 验收。

本文件不开始 Phase 2.1B，不实现代码，不推送远程。
