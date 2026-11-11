# Phase 2.1A.6 Reconcile Target Identity & Design Consistency Audit

状态：**A6-P1-01..P1-05 CLOSED (DESIGN) / DOCS-ONLY / IMPLEMENTATION NOT APPROVED / OD-09 OPEN**

日期：2026-11-11（Asia/Shanghai）

范围：docs-only 设计修正。不实现 Fence/Reconcile/授权逻辑，不修改源码、测试、Schema、配置或运行时行为。

依据：

- Phase 2.1A.5 commit：`550d0b4c00722277014a62c472baa0f894397145`
- `docs/phase-2.1A.5-authority-fence-decision-closure.md`
- `docs/phase-2.1A.4-revocation-model-closure.md`
- `docs/phase-2.1A.2-contracts-v3-design.md`
- `docs/phase-2.1A.2-store-api-v3-design.md`
- `docs/phase-2.1A.2-design-review.md`
- `docs/phase-2.1A.3-implementation-readiness.md`
- `docs/phase-2.0.2-architecture-decisions.md`（AD-06-R1）
- `docs/phase-2.0.3-implementation-constraints.md`（AD-12-R1）
- Phase 1.1 Store/Executor 代码与测试

---

## 0. 本轮发现与修订记录

### 0.1 P1-01：Reconcile 完成条件的目标识别歧义

**发现：** A5 3.4 原先把 transfer、re-add、new delegation、new explicit grant 都列为旧目标可以跳过的依据。这会错误地让：

- Principal enable / Membership re-add 使旧 Task 被当作“已重新授权”；
- 新建 Delegation 被当作旧 Task 已重新绑定；
- 新建 explicit ArtifactGrant 被当作旧 snapshot-controller Grant 已撤销。

**修订：** A5 3.4/3.5/3.7 已改为基于具体对象 ID + authority binding 的 target identity；只有针对具体 Task 的 `transferController`、或针对具体 snapshot Grant 的显式 transfer/revoke，才能让该目标退出旧 Fence。re-add/enable/new delegation/new explicit Grant 均不能跳过旧目标。

### 0.2 P1-02：源级事件与派生事件混淆

**发现：** A5 1.1 的“审计事件”与 1.2 的派生投影没有明确分层，容易被理解成撤权 commit 必须为每个 Task/Grant 写 `controller.frozen`/`artifact.grant_revoked`。

**修订：** A5 1.1/1.2/3.3/3.4/3.7、AD-12-R1、Store 5.4 已明确：

- 源级事件在撤权 commit；
- `controller.frozen`、`artifact.grant_revoked`、`authorization.reconciled` 是 Reconcile 派生事件；
- 派生事件幂等、不得重复、不作为授权前置条件；
- Event 查询仍按当前授权重新过滤。

### 0.3 P1-03：Artifact owner 与 snapshot Grant 边界

**发现：** A5 3.4 的 scope 查询提到“Artifact owner 关系”，容易被误解为 owner 是 Fence 的物化目标。

**修订：** A5 2.3/2.4/3.2/3.4/4.12、Contracts 8.3、Store 2.5、A4 3.1 已明确：

- owner effective access 是 live ACL；
- `ownerPrincipalId` 是独立所有权字段，Reconcile 不得写；
- Controller Fence 不自动转移 owner；
- 只有 snapshot-controller Grant 进入 `revokedAt` 物化范围；
- owner 关系只用于完整性审计/扫描，不是物理目标。

### 0.4 P1-04：完成条件与并发复核

**发现：** 需明确“新对象绑定旧 authority version”、transfer 与批次竞态、重叠 Fence、processed ids 非完整性证明、completed/failed 语义。

**修订：** A5 3.4/3.5/3.6/3.7 已补齐；本文件第 6/7 节给出对应矩阵。

### 0.5 P1-05：跨文档一致性复核

**发现：** 历史文档仍有“同一事务枚举所有 Task”“同一 controller unfreeze”“explicit Grant 可替代 snapshot Grant”等旧措辞风险。

**修订：** 第 7 节逐文档核对；2.0.2/2.0.3 的 AD-06-R1/AD-12-R1、历史 Review 的 superseding note、A2/A3/A4/A5 的目标 identity/owner/event 规则已对齐。未发现需要重新引入同步物化的理由。

**结论：A6-P1-01..P1-05 在设计层关闭；实现测试未开始。**

---

## 1. 旧 authority version 与新 authority version

### 1.1 版本不会自动传递到旧对象

| 操作 | 源记录变化 | 旧 Task binding | 旧 snapshot Grant binding |
|---|---|---|---|
| Principal disable | Principal V -> V+1；Fence(sourceVersion=V) | 不变（仍 V） | 不变（仍 grantee/source V） |
| Principal enable | Principal V+1 -> V+2 | 不变（仍 V） | 不变 |
| Membership revoke | Membership V -> V+1；Fence(V) | 不变（仍 V） | 不变 |
| Membership re-add | Membership V+1 -> V+2 | 不变（仍 V） | 不变 |
| Delegation revoke | Delegation V -> V+1；Fence(V) | `controllerDelegationVersion` 仍 V | `sourceDelegationVersion` 仍 V |
| New Delegation | 新 `delegationId`/version | 旧 Task 仍指旧 delegationId/version | 旧 Grant 仍指旧 sourceDelegationId/version |
| Explicit transfer | 具体 Task 的新 controller/version 同事务写入 | 仅该 Task 改变 | 旧 snapshot Grant 同事务撤销 |
| New explicit Grant | 新 grantId | 旧 Task 不变 | 旧 snapshot Grant 不变 |

结论：

1. Principal enable 不自动解除旧 Task 冻结。
2. Membership re-add 不自动解除旧 Task 冻结。
3. 新建 Delegation 不自动替换旧 Task 的 `controllerDelegationId`。
4. 新建 explicit Grant 不自动替代或恢复旧 snapshot-controller Grant。
5. 旧 Task 只能通过显式、经过授权的 `transferController` 等治理操作重新绑定合法 controller。

### 1.2 Target identity

```text
TaskTargetIdentity:
  taskId
  + controllerPrincipalVersion
  + controllerMembershipVersion
  + controllerDelegationId
  + controllerDelegationVersion

SnapshotGrantTargetIdentity:
  grantId + origin=task-snapshot-controller
  + granteePrincipalId + granteePrincipalVersion + granteeMembershipVersion
  + sourceDelegationId + sourceDelegationVersion
```

- 目标识别不能只看 Principal ID、当前 Membership、当前 Delegation 或“存在新授权”。
- 旧 Task/Grant 的 identity 不变，就仍是旧 Fence 的目标。
- 只有具体对象的权威 binding 已被显式操作改变，才能退出旧目标集。

---

## 2. 操作对旧目标的影响矩阵

| 操作 | 是否改变旧 Task binding | 是否撤销旧 snapshot Grant | 旧 Fence 能否跳过旧目标 | 说明 |
|---|---|---|---|---|
| `transferController(taskId)` | 仅该 Task 改变 | 是，同事务撤销旧 snapshot Grant | **是，仅该 Task** | 条件更新必须基于 taskId + 新 binding；旧 Fence 不覆盖新 controller |
| Principal enable | 否 | 否 | **否** | 旧 Task 仍绑定旧 principal version；仍须物化 frozen |
| Membership re-add | 否 | 否 | **否** | 旧 Task 仍绑定旧 membership version |
| 新建 Delegation | 否（新 delegationId） | 否（旧 Grant 仍指旧 ID） | **否** | 旧 Task 仍是旧 Fence 目标；需 transfer |
| 新建 explicit Grant | 否 | 否（不同 grantId） | **否** | 新 Grant 独立生效；旧 snapshot Grant 仍须撤销 |
| 显式 revoke 旧 snapshot Grant | 否 | 是（该 grantId） | **是，仅该 Grant** | 必须针对旧 grantId；new explicit Grant 不算 |
| 显式 revoke 旧 Delegation | 否（Fence 本身） | 旧 snapshot Grant effective 无效 | **否，直到物化** | 撤权源事件不替代物化 |

### 2.1 “允许访问”与“Reconcile 完成”不是同一件事

- 新 explicit Grant 有效时，按独立 ACL 允许访问；这不代表旧 snapshot Grant 已撤销。
- 旧 snapshot Grant 仍必须由 Fence/显式 revoke 物化 `revokedAt`；否则旧 Fence 不得标记 `completed`。
- 旧 Fence 的 `completed` 只表示该 Fence 的 `sourceVersion/scope` 目标物化完成，不表示新授权合法，也不表示所有旧权限已恢复/撤销。

---

## 3. Artifact owner 与 snapshot Grant 的边界矩阵

| 对象/关系 | 权威状态 | 即时授权 | Reconcile 物化 | 允许的修改者 |
|---|---|---|---|---|
| `Artifact.ownerPrincipalId` | 独立所有权字段 | owner effective access 按 live Principal/Membership/Artifact ACL | **不物化、不修改** | 显式 owner transfer（Artifact owner/Workspace Owner/Admin） |
| `origin=task-snapshot-controller` Grant | source delegation/controller authority | Fence/authority version 立即 effective 无效 | `revokedAt` 可异步物化 | Fence/Reconcile；显式 transfer 同事务撤销 |
| `origin=explicit` Grant | 显式 ACL | live grantee/source ACL；成员失效暂停 | 不自动写 `revokedAt` | `updateArtifactGrant` 显式 revoke |
| `origin=task-snapshot-requester` Grant | 创建时快照 | live requester membership/ACL | 不自动写 `revokedAt` | 显式 revoke/独立 ACL |
| Workspace Owner/Admin 审计读取 | Workspace 权限 | 按当前 Owner/Admin 权限 | 不因 Controller Fence 改变 | 既有治理权限 |

规则：

1. Principal/Membership 失效后，Artifact owner 的访问立即按 live ACL 拒绝。
2. Controller Fence 不自动转移 Artifact owner。
3. Reconcile 不得静默修改 `ownerPrincipalId`。
4. Owner/Admin 显式转移仍遵守原有原子操作规则。
5. Artifact owner 关系可以是完整性审计/扫描的一部分，但不能因此把 owner 自动转移或删除列为 Fence 的物化目标。
6. 只有符合 Fence 依赖关系的 snapshot-controller Grant 才进入对应 `revokedAt` 物化范围。

---

## 4. 源级事件与派生物化事件

### 4.1 分类

| 事件 | 类型 | 产生位置 | 幂等键 | 是否授权前置 |
|---|---|---|---|---|
| `principal.disabled/enabled/deleted` | 源级 | 撤权/启用 commit | principalId + version + command | 是（源状态本身） |
| `membership.removed/re_added/role_changed` | 源级 | 成员 commit | workspaceId + principalId + version | 是（源状态本身） |
| `delegation.revoked/expired` | 源级 | Delegation commit/expiry commit | delegationId + version | 是（源状态本身） |
| `controller.transferred` | 显式命令源事件 | transfer commit | taskId + new controller + revision | 是（transfer 本身） |
| `artifact.grant_changed` | 显式命令源事件 | grant update commit | grantId + revision | 是（显式 ACL 操作） |
| `controller.frozen` | 派生 | Reconcile 批次 | fenceId + sourceVersion + taskId | 否 |
| `artifact.grant_revoked` | 派生 | Reconcile 批次 | fenceId + sourceVersion + grantId | 否 |
| `authorization.reconciled` | 派生 | Fence 完成 commit | fenceId + sourceVersion | 否 |

### 4.2 要求

- 不得丢失源级撤权事件；源状态、Fence、authRev、源级事件同一 commit。
- 派生事件必须幂等；同一 `fenceId + sourceVersion + targetId` 不重复追加。
- 派生事件不能成为授权失效的前置条件；授权失效在源 commit 已生效。
- Event 查询仍必须重新执行当前授权检查；派生事件不是读取凭证。
- 如果某类事件必须在撤权源事务产生，必须说明它是源级事件，不得隐含要求同步更新全部 Task/ArtifactGrant。

---

## 5. Reconcile 完成条件

Fence 只有同时满足以下条件才能标记 `completed`：

1. 从权威状态重新执行 scope 查询，覆盖全部 `TaskTargetIdentity`、`SnapshotGrantTargetIdentity`；Artifact owner 只做审计，不是物理目标。
2. 每个目标 Task 已 `controlState=frozen`，或存在针对该具体 `taskId` 的权威 `transferController`，且同一事务写入新 binding、撤销该 Task 的旧 snapshot Grant（若有）。
3. 每个目标 snapshot-controller Grant 已 `revokedAt`，或由针对该具体 `grantId`/`sourceDelegationId` 的显式 transfer/revoke 同事务撤销。
4. Reconcile 未修改 `ownerPrincipalId`、未删除 Artifact。
5. 扫描中发现的新对象若仍绑定旧 `sourceVersion`，必须纳入目标或 fail closed；不能跳过。
6. 没有扫描错误、Store 错误、无法解析的引用。
7. 所有批次、派生事件、完成记录同 commit；源级事件已在源 commit。
8. 多 Fence 重叠无未解决冲突；每个 Fence 只对自身 `sourceVersion/scope` 完成。
9. 不能仅凭 `processedTaskIds`/`processedGrantIds` 判断完成。

无法确认完整性时保持 `pending/reconciling/failed`，不得乐观标记 `completed`。`completed` 只表示当前 fence/sourceVersion/scope 的物化完成；`failed` 始终可重试。

---

## 6. 崩溃、重试、重叠 Fence、transfer 并发

| 场景 | 权威 Fence | 目标处理 | 允许完成？ | 恢复/条件 |
|---|---|---|---|---|
| 撤权 commit 前崩溃 | 不存在 | 无 | — | 重新提交 |
| 撤权 commit 后崩溃 | 有效 | 可能未物化 | 否 | 启动扫描/重试 |
| 批次 commit 后崩溃 | 有效 | 部分完成 | 否 | 从权威/进度重算 |
| 批次 commit 前崩溃 | 有效 | 未完成 | 否 | 重做批次 |
| Store 写失败 | 有效 | 未完成 | 否 | `failed`，retry |
| 扫描不完整 | 有效 | 不确定 | 否 | 保持 pending/failed |
| 完成记录写失败 | 有效 | 已完成未标记 | 否 | retry 完成记录 |
| 重复批次 | 有效 | 已 frozen/revoked | 是（幂等） | 跳过重复派生事件 |
| transfer 并发（具体 taskId） | 有效 | 新 controller 已绑定；旧 Grant 已撤销 | 是（仅该 Task） | 基于 taskId + binding 条件更新 |
| 新撤权并发 | 两个 Fence 有效 | 并集 | 各自独立完成 | 新 Fence 处理新版本 |
| 新对象仍绑定旧 sourceVersion | 有效 | 旧 binding | **否** | 纳入目标或 fail closed；这是授权/Store bug |
| re-add/enable/new delegation | 有效 | 旧目标仍旧 binding | **否，直到旧目标 frozen** | 新对象不受旧 Fence |
| new explicit Grant | 有效 | 旧 snapshot Grant 仍可能未撤销 | **否，直到旧 Grant revoked** | 新 Grant 按独立 ACL |
| 投影损坏/不一致 | 有效 | 不可信 | 否 | 从权威重算，失败则 failed |

补充：

- transfer 与批次之间，条件更新必须比较具体 `taskId` + 新 binding；不能只看 Principal ID。
- 旧 Fence 不能覆盖新 controller，不能写回 active，不能恢复旧 controller。
- 重叠 Fence 取拒绝并集；旧 Fence 完成不清除新 Fence 的拒绝。
- `completed` 只表示当前 fence/sourceVersion/scope 的物化完成；`failed` 始终可重试。
- 崩溃/Store 写失败不会使 Fence 失效；只影响派生投影。

---

## 7. 跨文档一致性复核

| 文档 | 检查点 | 结论 |
|---|---|---|
| `phase-2.0.2-architecture-decisions.md` | AD-06-R1；Controller 冻结 snapshot Grant 即时 effective 无效、`revokedAt` 异步；显式 transfer 同事务；其他 ACL 规则不延迟 | 一致 |
| `phase-2.0.2-design-consistency-review.md` | 历史审查已注明 A5 superseding note；旧“同事务冻结”不再作为规范 | 一致 |
| `phase-2.0.3-implementation-constraints.md` | AD-12-R1；权威状态/Fence 同 commit；派生投影/事件异步；源级事件与派生事件分离 | 一致 |
| `phase-2.1A-design-review.md` | 历史“同一事务枚举所有 Task”已注明被 A5 取代；容量分析保留为历史 | 一致 |
| `phase-2.1A-identity-workspace-design.md` | 撤权事务细节已改为 authority version/Fence；explicit/requester live ACL；snapshot Grant 异步物化 | 一致 |
| `phase-2.1A.2-contracts-v3-design.md` | `controlState` stored cache；target identity；snapshot-controller 版本绑定；owner 不修改；源/派生事件 | 一致 |
| `phase-2.1A.2-store-api-v3-design.md` | Reconcile 条件更新仅显式 transfer；完成重扫；owner 只审计；事件分层；explicit/requester 不物理撤销 | 一致 |
| `phase-2.1A.2-design-review.md` | AD-06-R1/AD-12-R1；target identity；owner 边界；源/派生事件 | 一致 |
| `phase-2.1A.3-implementation-readiness.md` | 目标 identity、owner、事件、完成条件已同步；OD-11 DECIDED；OD-09 独立 | 一致 |
| `phase-2.1A.4-revocation-model-closure.md` | Reconcile 条件更新仅 transfer；完成重扫；owner 审计；explicit/requester live ACL | 一致 |
| `phase-2.1A.5-authority-fence-decision-closure.md` | 已按 P1-01..P1-05 修订；target identity；owner；源/派生事件；完成条件 | 一致 |

未发现需要重新引入 AD-06/AD-12 同步物化的理由；未把 `stored controlState` 当作授权事实；未把 Artifact owner 与 Task controller 合并。

---

## 8. P0 / P1 / P2 剩余问题

### 8.1 本轮关闭

A6-P1-01..05 是本任务编号，与仓库既有 P1-03..08（容量/路径/迁移/ACP/Artifact/到期）区分。

| ID | 问题 | 状态 |
|---|---|---|
| A6-P1-01 | Reconcile 完成条件目标识别歧义 | **CLOSED（设计）**；实现测试未做 |
| A6-P1-02 | 源级事件/派生事件混淆 | **CLOSED（设计）**；实现测试未做 |
| A6-P1-03 | Artifact owner 与 snapshot Grant 边界 | **CLOSED（设计）**；实现测试未做 |
| A6-P1-04 | 完成条件/并发/崩溃复核 | **CLOSED（设计）**；实现测试未做 |
| A6-P1-05 | 跨文档一致性复核 | **CLOSED（设计）**；见第 7 节 |

### 8.2 仍开放

**P0：**

- P0-01：v2 不能承载 v3；必须新建 v3。
- P0-02：Workspace 不是 OS 隔离；若要求真实隔离，需要 native helper/OS sandbox；否则明确接受 cooperative。

**P1：**

- P1-03：Store v3 容量/JSON 写放大。
- P1-04：Windows native path guard。
- P1-05：v2→v3 migration manual recovery。
- P1-06：ACP unknown/无 replay/取消不确认。
- P1-07：Artifact 物理存储/保留。
- P1-08：Delegation/Principal 到期/撤权物化调度。
- Reconcile 实现测试：即时拒绝、幂等、崩溃恢复、部分完成、重叠 Fence、transfer/re-add/enable 竞态。
- Replay/resultSnapshot 并发与撤权交叉测试。

**P2：**

- API 错误码/分页/命名、Event schema、Task title/description、`dispatching/cancelling` 字段名、容量参数、Message/ACK、跨 Workspace Artifact。

**OD-09：**

- 保持 `NEEDS_USER_DECISION`；没有原始 baseline 文件；不伪造、不拼凑、不擅自选择归档方案；不阻塞本任务。

---

## 9. 实现准入结论

- **OD-11：DECIDED（方案 A）。**
- **AD-06-R1 / AD-12-R1：FROZEN。**
- **OD-09：NEEDS_USER_DECISION（独立）。**
- **代码实现：NOT APPROVED。**
- **Phase 2.1B：未获批准。**

设计层：Authority Fence、Reconcile target identity、owner 边界、事件分层、完成条件已闭合，可作为实现输入。

实现层仍受以下条件约束：

1. Phase 2.1B 单独批准。
2. v3 新入口实现，不在 v2 打补丁。
3. OS 隔离真实实现或明确接受 cooperative。
4. Store 容量/写放大基准。
5. Fence/Reconcile/Replay 故障注入和并发测试。
6. Windows path guard、migration manual recovery、ACP 限制、Artifact 存储、到期物化等 P1 验收。

本文件不开始 Phase 2.1B，不实现代码，不推送远程。
