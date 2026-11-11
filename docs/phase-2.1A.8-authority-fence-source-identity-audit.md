# Phase 2.1A.8 Authority Fence Target Source Identity Matching Audit

状态：**A8-P1-01 CLOSED (DESIGN) / DOCS-ONLY / IMPLEMENTATION NOT APPROVED / OD-09 OPEN**

日期：2026-11-11（Asia/Shanghai）

范围：docs-only 设计修正。不修改源码、测试、Schema、配置或运行时行为；不实现 Fence/Reconcile/授权；不批准 Phase 2.1B。

依据：

- 基线 commit：`f5cb72f6e3f1872670ee426034c21c88f3a9974e`
- `docs/phase-2.1A.2-contracts-v3-design.md`
- `docs/phase-2.1A.2-store-api-v3-design.md`
- `docs/phase-2.1A.2-design-review.md`
- `docs/phase-2.1A.3-implementation-readiness.md`
- `docs/phase-2.1A.4-revocation-model-closure.md`
- `docs/phase-2.1A.5-authority-fence-decision-closure.md`
- `docs/phase-2.1A.6-reconcile-target-identity-audit.md`
- `docs/phase-2.1A.7-delegation-membership-binding-audit.md`
- `docs/phase-2.0.3-implementation-constraints.md`（AD-12-R1）

---

## 0. 本轮发现与修订记录

### 0.1 A8-P1-01：version-only 匹配缺少 source identity

**发现：** A7 匹配矩阵仍使用：

```text
controllerPrincipalVersion == fence.sourceVersion
controllerMembershipVersion == fence.sourceVersion
grantorMembershipVersion == sourceVersion
delegateMembershipVersion == sourceVersion
```

这些比较只比较数字。Authority version 是各记录的局部版本，不是全局唯一 ID：

- 不同 Principal 可以有相同的 Principal version；
- 不同 Workspace 的 Membership 可以有相同的 Membership version；
- 不同 Delegation 可以有相同的 Delegation version。

因此仅凭 version 相等，可能把无关 Principal/Membership/Delegation 误认为同一个失效来源。

**修订：**

- 匹配必须同时满足 **source identity + scope + authority version**。
- Principal fence 必须校验 Principal ID + version（global scope）。
- Membership fence 必须校验 Workspace + Principal ID + Membership version。
- Delegation fence 必须校验 delegationId + version + Workspace。
- Delegation grantor/delegate 两端必须分别校验对应 Principal ID、Workspace（Membership）和 version。
- 无法解析/ID 不一致/Workspace 不一致/version 不一致 -> fail closed。

### 0.2 保持不变

- A7-P1-01/P1-02 保持关闭；Delegation 双端 binding 与 batch/completion 边界不回退。
- OD-11 方案 A、AD-06-R1/AD-12-R1、A6 owner/事件分层继续冻结。
- running Execution、unknown、interrupted、dispatch_intent、Artifact owner、显式 Grant、Workspace Owner/Admin 审计权限不变。
- OD-09 仍为 `NEEDS_USER_DECISION`。
- 代码实现 NOT APPROVED；Phase 2.1B 未批准。

**结论：A8-P1-01 在设计层关闭；实现测试未开始。**

---

## 1. Fence source identity 与 sourceKey

### 1.1 SourceKey 解析

| sourceKind | sourceKey | scope | 解析字段 |
|---|---|---|---|
| principal | `principal:<principalId>` | global | `principalId` |
| membership | `membership:<workspaceId>:<principalId>` | workspace | `workspaceId` + `principalId` |
| delegation | `delegation:<delegationId>` | workspace | `delegationId`；workspace 从权威 Delegation 记录解析 |

- `sourceVersion` 是失效前版本，不是 commit 后新版本。
- `sourceVersion` 只在对应 source identity 下有意义；不能跨 Principal/Workspace/Delegation 比较。
- `scope.kind=global` 只适用于 principal fence；membership/delegation 必须绑定 Workspace。

### 1.2 匹配谓词

```text
principalMatches(fence, principalId, principalVersion):
  fence.sourceKind == principal
  AND principalId == parse(fence.sourceKey).principalId
  AND principalVersion == fence.sourceVersion
  // global：不限制 Workspace

membershipMatches(fence, workspaceId, principalId, membershipVersion):
  fence.sourceKind == membership
  AND workspaceId == parse(fence.sourceKey).workspaceId
  AND principalId == parse(fence.sourceKey).principalId
  AND membershipVersion == fence.sourceVersion

delegationMatches(fence, delegationId, delegationVersion, workspaceId):
  fence.sourceKind == delegation
  AND delegationId == parse(fence.sourceKey).delegationId
  AND delegationVersion == fence.sourceVersion
  AND workspaceId == resolvedDelegation.workspaceId
```

- 谓词返回 false 不等于对象 active；还要执行当前 status/authority 检查。
- 解析失败、字段缺失、Workspace 不一致 -> fail closed，不能按 active 或“非目标”处理。

---

## 2. Principal Fence 匹配矩阵

| 目标组件 | 匹配规则 | 说明 |
|---|---|---|
| 直接 controller | `Task.controllerPrincipalId == fencePrincipalId` **AND** `Task.controllerPrincipalVersion == sourceVersion` | global；ID + version |
| Delegation grantor | `Delegation.grantorPrincipalId == fencePrincipalId` **AND** `Delegation.grantorPrincipalVersion == sourceVersion` | global；不能只看 version |
| Delegation delegate | `Delegation.delegatePrincipalId == fencePrincipalId` **AND** `Delegation.delegatePrincipalVersion == sourceVersion` | global；不能只看 version |
| Grant grantee | `ArtifactGrant.granteePrincipalId == fencePrincipalId` **AND** `ArtifactGrant.granteePrincipalVersion == sourceVersion` | global；Artifact workspace 仍须一致 |
| Grant source delegation grantor/delegate | 分别匹配 `grantorPrincipalId`/`delegatePrincipalId` 与对应 Principal version | 两端都检查；只检查 sourceDelegationVersion 不足 |

- 任一端命中都可使对象进入目标集，但必须是**同一个 Principal ID 与其对应 version**同时匹配。
- 两个不同 Principal 的 version 相同，不代表未命中的那个属于该 Fence。

---

## 3. Membership Fence 匹配矩阵

| 目标组件 | 匹配规则 | 说明 |
|---|---|---|
| 直接 controller | `Task.workspaceId == fenceWorkspaceId` **AND** `Task.controllerPrincipalId == fencePrincipalId` **AND** `Task.controllerMembershipVersion == sourceVersion` | Workspace + Principal + version |
| Delegation grantor | `Delegation.workspaceId == fenceWorkspaceId` **AND** `grantorPrincipalId == fencePrincipalId` **AND** `grantorMembershipVersion == sourceVersion` | 两端独立 |
| Delegation delegate | `Delegation.workspaceId == fenceWorkspaceId` **AND** `delegatePrincipalId == fencePrincipalId` **AND** `delegateMembershipVersion == sourceVersion` | 两端独立 |
| Grant grantee | `Artifact.workspaceId == fenceWorkspaceId` **AND** `granteePrincipalId == fencePrincipalId` **AND** `granteeMembershipVersion == sourceVersion` | 不是 Task membership |
| Grant source delegation grantor/delegate | `Delegation.workspaceId == fenceWorkspaceId` **AND** 对应 `grantorPrincipalId`/`delegatePrincipalId` + 对应 Membership version | 两端都检查 |

- 不能把 `Task.controllerMembershipVersion` 当成 Delegation 两端 Membership 的通用版本。
- 不同 Workspace 的相同 Membership version 不匹配。
- 同一 Principal 在两个 Workspace 的 Membership version 相同，只有 fenceWorkspaceId 命中的那个是目标。

---

## 4. Delegation Fence 匹配矩阵

| 目标组件 | 匹配规则 | 说明 |
|---|---|---|
| Task controller | `Task.controllerDelegationId == fenceDelegationId` **AND** `Task.controllerDelegationVersion == sourceVersion` **AND** Workspace 一致 | ID + version + workspace |
| Grant source delegation | `ArtifactGrant.sourceDelegationId == fenceDelegationId` **AND** `sourceDelegationVersion == sourceVersion` **AND** Artifact/Delegation Workspace 一致 | 不能只看 version |

- 不同 Delegation 的 version 数值相同，不匹配。
- 同一 Delegation 但 version 不匹配，不属于该 Fence；仍可能因当前 status/version 检查而 effective 失效，但不能被该 Fence 乐观跳过或错误物化。

---

## 5. Target identity

### 5.1 TaskTargetIdentity

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

- `controllerMembershipVersion` 属于 `(task.workspaceId, controllerPrincipalId)`。
- resolved Delegation 必须通过 `controllerDelegationId` join，并校验 `controllerDelegationVersion`。
- 缺少/不一致 -> fail closed。

### 5.2 SnapshotGrantTargetIdentity

```text
SnapshotGrantTargetIdentity:
  grantId
  artifactId
  workspaceId
  origin=task-snapshot-controller
  granteePrincipalId
  granteePrincipalVersion
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

- `granteeMembershipVersion` 属于 `(artifact.workspaceId, granteePrincipalId)`。
- resolved source Delegation 必须通过 `sourceDelegationId` join，校验 `sourceDelegationVersion`，且 Workspace 与 Artifact 一致。
- 只检查 `sourceDelegationVersion` 不足。

### 5.3 一致性约束

- Task/Grant 的 Workspace 与引用 Delegation 的 Workspace 不一致 -> fail closed。
- Delegation grantor/delegate Principal ID 与引用关系不一致 -> fail closed。
- version 缺失/记录缺失/无法解析 -> fail closed。
- 目标匹配使用 sourceKey 解析值 + sourceVersion；不是“某个 version 等于某个数字”。
- 旧对象不会因 re-add/enable/new Delegation/new explicit Grant 自动改变 binding。

---

## 6. 十二个数值碰撞场景

| # | 场景 | Fence source identity | 对象 identity | version 相同？ | 属于目标？ | effective / control | Reconcile |
|---:|---|---|---|---|---|---|---|
| 1 | 两个不同 Principal 的 Principal version 都为 3，只 disable 其中一个 | `principal:U1` V3 | U2 Principal version=3 | 是，但 Principal ID 不同 | **否** | U2 仍 active | 不处理 U2；只处理 U1 的对象 |
| 2 | 同一 Principal 在两个 Workspace 的 Membership version 都为 5，只 revoke ws1 | `membership:ws1:U` V5 | ws2 的 U Membership=5 | 是，但 Workspace 不同 | **否** | ws2 仍 active | 不处理 ws2；只处理 ws1 |
| 3 | Delegation grantor/delegate Membership version 都为 5，Fence 只针对 grantor | `membership:ws:U` V5 | D.grantor=U/5；D.delegate=A/5 | 两端都是 5 | **是（grantor 端）** | Delegation 失效 / frozen | Task frozen + source Grant revoked；delegate 同 version 不扩大目标 |
| 4 | Delegation grantor/delegate Principal version 都为 3，Fence 只针对 delegate | `principal:A` V3 | D.grantor=U/3；D.delegate=A/3 | 两端都是 3 | **是（delegate 端）** | Delegation 失效 / frozen | Task frozen + Grant revoked；grantor 同 version 不扩大目标 |
| 5 | 直接 controller 与无关 Principal 的 Principal version 都为 3 | `principal:U1` V3 | Task.controllerPrincipalId=U1、version=3；U2 version=3 | 是，但 U2 无关 | **是（U1）** | U1 旧 Task frozen；U2 不受影响 | 只处理 U1 的 controller 目标 |
| 6 | Task 的 controllerMembershipVersion 与其他 Workspace Membership version 都为 5 | `membership:ws1:U` V5 | Task.workspaceId=ws2、controllerMembership=5 | 是，但 Workspace 不同 | **否** | ws2 Task 仍按 ws2 授权 | 不处理 ws2 的 Task |
| 7 | Grant grantee 与 source Delegation delegate 是不同 Principal，Membership version 都为 5 | `membership:ws:A` V5 | Grant.grantee=G/5；source D.delegate=A/5 | 都是 5 | **是（source delegate=A）** | Grant 由 source delegation 失效 | snapshot Grant revoked；grantee G 同 version 不扩大目标 |
| 8 | source Delegation grantor/delegate Workspace 正确，Fence principalId 只匹配其中一端 | `principal:U` V3 | D.grantor=U/3；D.delegate=A/3，ws 正确 | 两端都是 3 | **是（grantor=U）** | Task frozen / Grant 无效 | Task frozen + Grant revoked；delegate 同 version 不扩大目标 |
| 9 | Delegation ID 相同但 Delegation version 不匹配 | `delegation:D1` V5 | Task.controllerDelegationId=D1、version=4 | 否 | **否（对 V5 Fence）** | 当前 binding 仍可能因 version 不匹配 frozen | 该 Fence 不处理；由对应 V4 Fence/当前授权处理，不能乐观清除 |
| 10 | Delegation version 数值相同但 delegationId 不同 | `delegation:D1` V5 | Task.controllerDelegationId=D2、version=5 | 是，但 ID 不同 | **否** | D2 按自身状态判断 | 不处理 D2；不能仅凭 version 命中 |
| 11 | Delegation 记录缺失、Workspace 不一致或 grantor/delegate ID 与引用不一致 | 任意 | 引用无法解析/不一致 | 不确定 | **是（fail closed 目标）** | frozen/fail closed | 不得 active；保持 pending/failed，不能乐观完成 |
| 12 | 同一 Task/Grant 同时命中两个不同 Fence，source identity 不同 | 例：`principal:U` V3 + `membership:ws:A` V5 | Task 同时含 U 的 Principal binding 与 A 的 Membership binding | 各自匹配各自 version | **两个 Fence 都是目标** | 并集拒绝 / frozen | 两个 Fence 各自完成；一个完成不清除另一个 |

补充解释：

- 场景 3/4/7/8 说明“同一 version 数字”不等于“同一 identity”；必须同时匹配 ID。
- 场景 1/2/5/6/10 说明不同 Principal/Workspace/Delegation 的同 version 不能互相命中。
- 场景 9 说明同一 Delegation ID 但 version 不匹配不属于该 Fence；当前授权仍按 version/status 判断，不能被乐观跳过。
- 场景 11 是 fail closed，不是“非目标”。
- 场景 12 是双 Fence 并集，不能用一个 Fence 完成清除另一个。

---

## 7. A7 既有场景不回退

以下 A7 规则继续有效：

- Delegation grantor/delegate 两端 Membership/Principal binding 都检查。
- `sourceDelegationId` 非 null 时必须解析完整 Delegation binding。
- Principal enable / Membership re-add / new Delegation / new explicit Grant 不自动改变旧对象 binding，不能让旧目标跳过。
- 新 explicit Grant 不替代旧 snapshot-controller Grant 的物理撤销义务。
- transfer 只改变具体 taskId 的 binding，并同事务撤销旧 snapshot Grant。
- 双 Fence 取并集；旧 Fence 完成不清除新 Fence。
- batch commit 与 completion commit 分离；completion 失败可重试，不回滚 batch，不重复派生事件。

---

## 8. Reconcile 原子边界（不变）

1. **撤权源 commit**：最终授权检查、源 status/version、`AuthorityRevocationFence`、`authorizationRevision`、源级事件同一 commit。
2. **Reconcile batch commit**：当前批次投影、派生事件、幂等进度同一 commit；不同批次独立。
3. **Fence completion commit**：重新扫描确认后，单独提交 `completed`、`completedAt`、`authorization.reconciled` 及必要审计/进度。
4. completion 失败不回滚已完成批次；重试不重复派生事件。
5. processed IDs 不是完整性证明。
6. 多 Fence 取拒绝并集，一个 Fence 完成不清除另一个。

本轮不改变上述边界。

---

## 9. 跨文档一致性复核

| 文档 | 检查点 | 结论 |
|---|---|---|
| `phase-2.1A.2-contracts-v3-design.md` | sourceKey/ID/Workspace/version 匹配；双端 Delegation；source delegation 完整 binding | 一致 |
| `phase-2.1A.2-store-api-v3-design.md` | 条件更新含 ID/Workspace/version；双端 Membership；batch/completion 分离 | 一致 |
| `phase-2.1A.2-design-review.md` | target identity/scope/version；双端 Membership；batch/completion | 一致 |
| `phase-2.1A.3-implementation-readiness.md` | 同左；未新增实现批准 | 一致 |
| `phase-2.1A.4-revocation-model-closure.md` | 条件更新/sourceKey 解析/双端 binding | 一致 |
| `phase-2.1A.5-authority-fence-decision-closure.md` | target identity 含 workspace/ID/resolved Delegation；source identity/scope/version | 一致 |
| `phase-2.1A.6-reconcile-target-identity-audit.md` | target identity 含 workspace/ID/resolved Delegation；条件不含 version-only | 一致 |
| `phase-2.1A.7-delegation-membership-binding-audit.md` | 匹配矩阵改为 ID+Workspace+version；双端 binding | 一致 |
| `phase-2.0.3-implementation-constraints.md` | AD-12-R1 源级 commit；batch/completion 独立 | 一致 |

搜索检查：

- 未发现只比较 version 的 target matching 规则。
- 未发现把 `controllerMembershipVersion` 当作 Delegation 两端版本。
- 未发现不同 Principal/Workspace/Delegation 的同 version 被当作同一来源。
- 未发现 batch/completion 边界回退。

---

## 10. P0 / P1 / P2 剩余问题

### 10.1 本轮关闭

| ID | 问题 | 状态 |
|---|---|---|
| A8-P1-01 | Fence target matching 缺少 source identity/scope | **CLOSED（设计）**；实现测试未做 |

### 10.2 仍开放

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
- Reconcile/Replay 实现测试：source identity/scope/version 碰撞、双端 binding、batch/completion 崩溃恢复、双 Fence。
- P2：API 错误/分页、Event schema、title/description、容量参数、Message/ACK、跨 Workspace Artifact。
- OD-09：`NEEDS_USER_DECISION`（独立，不阻塞）。

---

## 11. 实现准入结论

- **OD-11：DECIDED（方案 A）。**
- **AD-06-R1 / AD-12-R1：FROZEN。**
- **A7-P1-01 / A7-P1-02：保持关闭。**
- **A6 target identity/owner/事件分层：继续有效。**
- **OD-09：NEEDS_USER_DECISION（独立）。**
- **代码实现：NOT APPROVED。**
- **Phase 2.1B：未获批准。**

设计层：sourceKey 解析、Principal/Membership/Delegation 三类 source identity、双端 Delegation binding、Task/Grant target identity、batch/completion 边界已闭合，可作为实现输入。

实现前置条件：

1. Phase 2.1B 单独批准。
2. v3 新入口实现，不在 v2 打补丁。
3. OS 隔离实现或明确接受 cooperative。
4. Store 容量/写放大基准。
5. source identity/scope/version 碰撞与双端 binding 测试。
6. Reconcile batch/completion 崩溃恢复/幂等/双 Fence 测试。
7. Replay/resultSnapshot 并发/撤权交叉测试。
8. Path guard、migration manual recovery、ACP 限制、Artifact 存储、到期物化等 P1 验收。

本文件不开始 Phase 2.1B，不实现代码，不推送远程。
