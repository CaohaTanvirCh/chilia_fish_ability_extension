# Phase 2.1A.2 Contracts v3 Design：数据模型与状态机

状态：**Proposed Contracts v3 Design / Implementation Not Started**

日期：2026-11-11（Asia/Shanghai）

基线：

- Phase 2.0 冻结决策：AD-01 至 AD-14（`be36ba7`）
- Phase 2.1A Identity & Workspace：IW-01 至 IW-11（`10369df`）
- Phase 1.1 当前实现：`packages/contracts/v2.d.ts`、`packages/task-store-v2/index.mjs`、`packages/dsh-acp-v2/index.mjs`、`packages/acp-transport/index.mjs`

范围：只设计实体、字段、状态机和权限语义；不实现 Contracts、Store、Executor、ACP Transport、API 或迁移。

> **源文档缺口：** 任务要求阅读的 `docs/phase-2.0-architecture-baseline.md` 在当前仓库不存在。本文不虚构其内容，使用已冻结的 Phase 2.0.1/2.0.2/2.0.3、baseline review 和 Phase 1.1 实际代码作为依据。该缺口记入设计审查的 Open Decision / source gap。

---

## 0. 结论摘要

Contracts v3 的核心是五个分离：

1. **Principal 与业务角色分离**：`actor`、`createdBy`、`requestedBy`、`owner`、`controller` 不合并。
2. **Task 目标状态、Task 生命周期、Execution 状态分离**：Task 完成必须显式确认，不能由单次 Execution 成功自动推导。
3. **Execution 的持久化状态与派生展示状态分离**：保留 AD-07 的七种持久化状态；`dispatching`、`cancelling`、`succeeded` 只作为 API 投影，不新增持久化状态。
4. **Artifact ACL 与 Task ACL 分离**：Artifact 创建时物化 ACL；Task 权限变化不动态改写 Artifact。
5. **数据并行与写并发分离**：Task 可拥有多个 Execution；是否同时写由 Workspace 隔离策略和 `WorkspaceWriteLease` 决定。

v3 的关键决定：

| ID | 决策 |
|---|---|
| C3-01 | Principal/Workspace/Membership/Delegation 是 Store v3 一级实体 |
| C3-02 | Task 使用 goalStatus + lifecycle + controlState；Execution 独立状态机 |
| C3-03 | 持久化 Execution 状态沿用 AD-07；`dispatching`/`cancelling`/`succeeded` 是投影 |
| C3-04 | `awaiting_input` 不进入 v3；Phase 2.3 用 InputRequest，Execution 保持 running |
| C3-05 | Task 取消是显式目标决定；running Execution 的取消仍需真实证据 |
| C3-06 | Artifact 创建时物化 ACL；Grant/Reference 独立 |
| C3-07 | Workspace 业务生命周期与 WorkspaceWriteLease 状态分离 |
| C3-08 | 授权使用 effective Membership/Delegation；不信任 stored status 或客户端身份 |
| C3-09 | 所有终态 Execution 不可覆盖；unknown/interrupted 不自动重试 |
| C3-10 | v3 不提供自动结果合并；selectedExecutionId 由上层显式选择 |

---

## 1. 设计原则与不可破坏的不变量

### 1.1 不变量

1. `Execution` 终态和完成证据不可覆盖；重试创建新 `executionId` 和新 `requestKey`。
2. `unknown` / `interrupted` 不自动重发；新 Execution 必须显式 acknowledgment。
3. `cancel request` 不等于 `cancel confirmation`；只有 ACP 取消响应或证明未发送的本地取消可进入 `cancelled`。
4. Store 是本地已提交事实的权威，不是 DSH 远端执行状态的全知来源。
5. 单 Store 所有者、原子 commit、全局事件 sequence。
6. 不承诺 ACP exactly-once；不把 Session 可恢复性当作结果证据。
7. 任何授权都不能只凭知道 ID、requestKey、cursor 或 payload 中的身份字段。
8. Task goalStatus 不能由单次 Execution 完成自动推进为 `completed`。
9. Artifact ACL 不按当前 Task 角色动态计算。
10. Workspace 写入并发必须有租约或独立工作副本；没有隔离就排队。

### 1.2 v3 与 Phase 1.1 的边界

当前 Phase 1.1：

- `TaskStatus = ExecutionStatus`；
- 每个 Task 最多一个活动 Execution；
- Task 有单值 `activeExecutionId`、`latestExecutionId`；
- `Task.result` 强制等于最新 Execution 的 result；
- 没有 Principal/Workspace/Artifact/selectedExecutionId；
- Store commit 不接收 AuthorizationContext。

v3 **不是**在 v2 字段上追加几个可选字段；它需要新的 Store 文件、新的任务投影和新的写入接口。迁移必须离线、显式、可回滚。

---

## 2. 通用类型与 ID

```text
Timestamp          ISO-8601 字符串，UTC 或带时区；服务端生成
Revision           number，单实体乐观版本
JsonValue          null | boolean | number | string | JsonValue[] | { [key:string]: JsonValue }
PrincipalId        prn_<opaque>
WorkspaceId        ws_<opaque>
TaskId             tsk_<opaque>
ExecutionId        exe_<opaque>
ArtifactId         art_<opaque>
DelegationId       dlg_<opaque>
LeaseId            lease_<opaque>
EventId            evt_<opaque>
BindingId          bind_<opaque>
RequestRecordId    req_<opaque>

FencingToken:
  workspaceId
  epoch
  leaseId
  executionId
```

- ID 只用于标识，不编码角色、显示名、本机账户或路径。
- 所有实体有 `createdAt`、`updatedAt`；可审计实体有 `revision`/`version`。
- 时间由 Hub 服务端生成；客户端时间只作展示，不参与授权/过期判断。
- 金额/大小使用整数；`size` 为字节数。

---

## 3. Principal

### 3.1 实体

```text
Principal:
  principalId              PrincipalId
  principalType            user | agent | system
  displayName              string | null
  status                   active | disabled
  deletedAt                Timestamp | null
  disabledAt               Timestamp | null
  disabledReason           string | null
  createdByPrincipalId     PrincipalId | null
  createdAt                Timestamp
  updatedAt                Timestamp
  version                  number

  agentProfile?:
    registeredByPrincipalId PrincipalId
    connectorKind           local | remote | system
    capabilities            string[]       // 提示，不是授权
```

对外视图 `PrincipalView`：

```text
PrincipalView.status = deleted  if deletedAt != null
                     = disabled if status == disabled
                     = active
```

### 3.2 类型与约束

| 类型 | API 登录/调用 | Workspace Owner/Admin | Task owner/controller | 说明 |
|---|---:|---:|---:|---|
| user | 是（可信连接） | 是 | 是 | Workspace Owner 必须是 User |
| agent | 是（未来 Connector） | 否（v3） | 是 | 独立主体，不继承 User 权限 |
| system | 否 | 否 | 否 | 仅内部迁移/恢复/审计 |

- `system:*` 前缀保留；客户端不能创建或冒充 system principal。
- Agent 的 `agentProfile.registeredByPrincipalId` 只是注册审计，不是权限继承。
- `displayName` 可空；不参与授权。
- `version` 是 authority version：disable/enable/delete 必须递增；仅显示性元数据变化不应递增。Task/Delegation 的 controller/grantor/delegate 绑定使用该 version。
- 一个 Agent 可以同时持有多个 User 的 Delegation；每个请求绑定一个 `(actor, workspaceId, delegationId)`。

### 3.3 生命周期

```mermaid
stateDiagram-v2
    [*] --> active: create
    active --> disabled: disable
    disabled --> active: enable
    active --> disabled_deleted: delete
    disabled --> disabled_deleted: delete
    disabled_deleted --> [*]
```

- `disable`：status=disabled，递增 version/authorizationRevision；不删除 Membership；effective 变为 suspended；Delegation 立即 effective revoked；controller 立即 effective frozen；运行中 Execution 继续。写 `AuthorityRevocationFence(sourceKind=principal, scope=global)`；不要求在同一 commit 枚举所有 Membership/Delegation/Task，物化由 reconcile 完成。
- `enable`：status=active，递增 version；只有 stored active 的 Membership 恢复 effective；显式 revoked Membership 不恢复；Delegation 不恢复（disable 已使其 effective revoked，物化后 stored 也是 revoked）；旧 Controller 不因 enable 重新获得控制权。
- `enable` 的前置条件：该 Principal 的所有 principal fence 已完成；未完成返回 `AUTHORIZATION_RECONCILING`。否则可能在 Delegation 尚未物化时重新启用，导致旧委托复活。
- `delete`：status=disabled + deletedAt，递增 version；写 principal fence；Membership/Delegation 立即 effective revoked；不可恢复。
- 删除或禁用最后一个 Workspace Owner 默认 `LAST_OWNER`；只有 system 的显式 ownerless recovery 可进入 `ownerless_locked`，不能由普通 disable/delete 静默产生无主 Workspace。

### 3.4 主体对现有对象的影响

| 对象 | disabled | deleted |
|---|---|---|
| Membership | stored 不变，effective suspended；membership 绑定失效 | stored revoked；membership 绑定失效 |
| Delegation | effective revoked；materialized `status=revoked` 可滞后 | 同 disabled，且不可恢复 |
| Task owner/requestedBy | 历史审计引用，无有效权限；不等于自动冻结 Task | 历史引用 |
| Task controller | effective frozen；stored `controlState` 可滞后 | effective frozen |
| running Execution | 继续；按真实 ACP 证据结算 | 继续；按真实 ACP 证据结算 |
| Artifact owner | 保留；读取/写入按 Artifact ACL 拒绝，需审计处置 | 保留；需转移 |
| ArtifactGrant | snapshot-controller effective 无效、`revokedAt` 可滞后；explicit/requester 按 live ACL 暂停 | 同 disabled；snapshot-controller 物化 revoked，explicit/requester 不自动写 revokedAt |

- “有效权限失效”不等于“Task 取消”“Execution 取消”或“Artifact 删除”。Principal 失效只撤权，不伪造执行终态。
- Owner/requestedBy 失效不会自动冻结一个仍由其他合法 Controller 控制的 Task；但 Owner 必须由 Owner/Admin 显式转移，不能继续行使 owner 权限。

---

## 4. Workspace

### 4.1 实体

```text
Workspace:
  workspaceId               WorkspaceId
  name                      string
  status                    active | archived | deleted       // 业务生命周期
  ownerPrincipalId          PrincipalId (User)
  rootStatus                bound | unbound                    // unbound 仅用于迁移/只读
  rootRef                   string | null                     // 对外逻辑引用
  rootPath                  string | null                     // 服务端专用，不进入 API/Event/日志
  rootIdentity:
    volumeSerial            string
    fileId                  string
    finalPath               string
    observedAt              Timestamp
  | null                                                      // rootStatus=unbound 时为 null
  workspaceBoundaryEnforcement  cooperative | os-enforced
  quarantineState           normal | quarantined
  quarantineReason          string | null
  quarantinedAt             Timestamp | null
  isolationPolicy           mutex | git-worktree | directory-copy
  governanceState           normal | ownerless_locked
  writeEpoch                integer
  policyVersion             integer
  createdByPrincipalId      PrincipalId
  createdAt / updatedAt
  archivedAt / deletedAt
  deletedFrom               live | archived | null
```

派生访问状态：

```text
WorkspaceAccessState =
  deleted      if status=deleted
  archived     if status=archived
  quarantined  if status=active && quarantineState=quarantined
  active       otherwise
```

- `status` 不包含 `quarantined`；quarantine 是运行时写安全状态，不是业务生命周期。
- `rootPath`/`rootIdentity` 只存在于服务端 Store；API 只返回 `rootRef`、`boundaryEnforcement`、`quarantineState`。
- `rootStatus=unbound` 只允许迁移的 legacy Workspace：可读、可审计、可归档，但禁止新 Execution，直到 Owner/Admin 离线 rebind root；`rootPath/rootIdentity/rootRef` 为 null。
- 新建 Workspace 必须 `rootStatus=bound`；`rootIdentity` 非空。
- `isolationPolicy=mutex` 是默认；`git-worktree`/`directory-copy` 必须有执行器能力证明。

### 4.2 生命周期

```mermaid
stateDiagram-v2
    [*] --> active: provision
    active --> archived: archive (no active exec/lease/quarantine)
    archived --> active: restore
    active --> deleted: delete (after archive)
    archived --> deleted: delete
    deleted --> [*]: no physical delete in v3
```

- archive：要求无 queued/running Execution、无 held/releasing/frozen 租约、`quarantineState=normal`、无 ownerless_locked；Task goalStatus/lifecycle 不变。
- archived：读写策略只读；默认列表不返回；Task/Execution/Artifact/Event 保留。
- restore：不自动恢复 Execution、Lease、Delegation、Controller。
- delete：软删除；root/Task/Execution/Artifact/Event 保留；只有 system recovery 可读。
- 不提供物理删除；物理清理是独立的离线保留策略。

### 4.3 BootstrapState

```text
BootstrapState:
  bootstrapPrincipalId      User
  workspaceId               WorkspaceId
  ownerPrincipalId          User
  rootFingerprint           string          // 不暴露绝对路径
  completedAt               Timestamp
```

- 正常启动只绑定已有 bootstrap 记录，不自动创建 Principal/Workspace。
- 配置 ID 与记录不一致时启动失败（`BOOTSTRAP_MISMATCH`）。

### 4.4 Workspace 与 Lease 的关系

- Workspace `status`/`quarantineState`/`rootStatus` 决定是否允许新写、新 Execution、新 Task；`rootStatus=unbound` 时只读。
- `WorkspaceWriteLease` 决定当前是否有某个 Execution 持有写租约。
- 一个 `active` Workspace 可以没有租约；有租约时最多一个 `held`（mutex）。
- `quarantined` Workspace 不得获取新写租约；已有租约保持 `frozen/quarantined`，不得依靠租约释放恢复。
- `archived/deleted` Workspace 不获取租约；归档前必须无租约。

---

## 5. Membership 与 DelegationGrant

### 5.1 Membership

```text
MembershipEffectiveStatus = active | suspended | revoked

WorkspaceMember:
  workspaceId + principalId     复合唯一
  role                          owner | admin | operator | viewer
  status                        active | revoked        // stored
  effectiveStatus               active | suspended | revoked  // 投影，不持久化
  version                       number                 // authority version：role/status/re-add 时递增
  lastMembershipRevisionId      string
  grantedByPrincipalId          PrincipalId
  grantedAt / updatedAt
  revokedAt / revokedReason

MembershipRevision:
  membershipRevisionId
  workspaceId + principalId
  version
  storedStatus                  active | revoked
  role
  actorPrincipalId
  time
  reason
  previousRevisionId

MembershipInvite:
  inviteId
  workspaceId
  targetPrincipalId            active Principal
  role                         admin | operator | viewer
  tokenHash
  status                       pending | accepted | revoked | expired
  createdByPrincipalId
  createdAt / expiresAt
  acceptedAt / revokedAt
```

`effectiveMembership`：

```text
if stored.status == revoked:                 revoked
if matching membership fence exists:         revoked
if principal.deletedAt != null:              revoked
if matching principal fence exists:          revoked
if principal.status != active:               suspended
if workspace.status == deleted:              suspended
if workspace.status == archived:             active（只读）
if workspace.quarantineState == quarantined: active（写受限）
if workspace.governanceState == ownerless_locked: active（治理/新工作受限）
else:                                       active
```

- “matching fence”指 `fence.sourceKind/sourceKey/sourceVersion` 与该 Membership/Principal 当前记录完全匹配；re-add/新 version 不会命中旧 fence。
- 授权只看 effective；`WorkspaceMember.status` 只是 stored。
- `version` 是 authority version：role、stored status、re-add 必须递增；仅显示性元数据变化不应递增。Task/Delegation 的 controller/grantor/delegate 绑定使用该 version；ArtifactGrant 仅 `origin=task-snapshot-controller` 使用 grantee version 绑定（见 5.2、6.1、8.1）。
- Role 变化可能使 controller 不再有控制权限：version 变化使旧绑定立即失效，即使没有单独的 revocation fence；该变化记录为 `membership.role_changed`，不是 `membership.removed`。

角色约束：

- Owner 唯一；`Workspace.ownerPrincipalId` 与唯一 `role=owner` Membership 一致。
- Owner/Admin 必须是 User；Agent 只能 Operator/Viewer。
- 新成员默认 Viewer。
- Owner 不能直接 revoked；必须先转移。
- 角色变化追加 MembershipRevision；显式 revoked 不会因 Principal enable 复活。

### 5.2 DelegationGrant

```text
DelegationGrant:
  delegationId
  workspaceId
  grantorPrincipalId           User
  delegatePrincipalId          Agent
  scopes[]                     task:read|create|control,
                               execution:read|create|control,
                               artifact:read|write
  resourceScope:
    kind                       workspace | tasks | artifacts
    taskIds? / artifactIds?
  status                       active | revoked | expired
  version                      number
  grantorPrincipalVersion      number          // grant 创建时的 authority version
  grantorMembershipVersion     number
  delegatePrincipalVersion     number
  delegateMembershipVersion    number
  parentDelegationId           null            // v3 禁止二次委托
  createdAt
  expiresAt                    Timestamp
  revokedAt / revokedBy / revokeReason
```

规则：

- grantor User、delegate Agent，且都是 effective active Workspace 成员。
- 不允许二次委托；Agent 不能创建 Delegation。
- `resourceScope=workspace` 允许 `task:create`；`tasks`/`artifacts` 必须显式 ID，不能是未来匹配。
- `expiresAt` 必填；服务端时钟判断过期。
- `version` 是 Delegation 的 authority version：创建为 1，revoke/expire 物化时递增；scope/resourceScope/expiresAt 不可原地修改，变更必须新建 delegationId。
- v3 不支持原地修改 scope/resourceScope/expiresAt；变更必须撤销旧 grant 并创建新 delegationId，以保留历史。
- Delegation 不替换 ArtifactGrant；`artifact:read` 只是上限之一（AD-06）。
- `grantor*Version`/`delegate*Version` 是创建时的 authority 快照。有效 Delegation 必须与当前 Principal/Membership 的 version 完全相等；任何一方 role/status/re-add 变化都会使旧 grant 失效，必须新建 delegationId。
- 撤销/过期：Delegation 立即 effective revoked；所有受影响 Task 立即 effective frozen；running Execution 继续；queued 不自动 dispatch；snapshot controller ArtifactGrant 立即 effective 无效；不追溯已接受 dispatch_intent（AD-12/AD-13 语义）。
- 撤销/过期 commit 不要求枚举全部 Task/Grant；写 `AuthorityRevocationFence(sourceKind=delegation, scope=workspace)`，reconcile 只物化 `Task.controlState`/`ArtifactGrant.revokedAt`。
- 旧 Task 只绑定旧 `delegationId`/`delegationVersion`；创建新 Delegation 不会让旧 Task 自动恢复控制，必须显式 `transferController`。

### 5.3 AuthorityRevocationFence（统一撤权记录）

Phase 2.1A.4 用一个统一记录覆盖 Principal、Membership、Delegation 三种失效来源；A3 的 `DelegationRevocationFence` 是本记录的 delegation 特例，不再保留两套 fence 类型。

```text
AuthorityRevocationFence:
  fenceId
  sourceKind                 principal | membership | delegation
  sourceKey                  string        // principal:<id> / membership:<ws>:<pid> / delegation:<id>
  sourceVersion              number        // 被失效的 authority version（撤销/禁用前的版本）
  scope:
    kind                     global | workspace
    workspaceId              WorkspaceId | null   // global 时为 null，表示所有 Workspace
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

| 来源 | sourceKey / sourceVersion | scope | 立即失效的授权 | reconcile 物化 |
|---|---|---|---|---|
| Principal | `principal:<principalId>` / 失效前 Principal.version | global（所有 Workspace） | Principal 的 Membership、Delegation、Controller、ArtifactGrant；作为 grantor/delegate/grantee 的关系均覆盖 | Membership stored（仅 delete）、Delegation.status、Task.controlState、**snapshot controller** ArtifactGrant.revokedAt；explicit/requester Grant 只做 effective ACL，不自动物理撤销 |
| Membership | `membership:<ws>:<pid>` / 失效前 Membership.version | workspace | 该成员在本 Workspace 的权限、其作为 Controller/Delegation grantor/Delegation delegate 的 Task、其作为 grantee 或 source delegation grantor/delegate 的 ArtifactGrant | Task.controlState、**snapshot controller** ArtifactGrant.revokedAt；explicit/requester Grant 只做 effective ACL |
| Delegation | `delegation:<delegationId>` / 失效前 Delegation.version | workspace | 该 Delegation 的权限、依赖它的 Task Controller/grant | Task.controlState、`sourceDelegationId` 匹配的 snapshot controller ArtifactGrant.revokedAt |

规则：

- **Fence 是持久的失效事实和 reconcile 游标，不是唯一的授权判据。** 源记录当前 status/version 判断当前请求是否失权；fence 的旧 `sourceVersion` 用于判断某个 Task/Grant 的绑定是否已被失效。两者任一判为失效即拒绝。
- `sourceVersion` 是**被失效的旧版本**，不是 revoke/disable commit 后的新 version。version 是各记录的局部版本，不能单独用于跨主体匹配；必须同时匹配 sourceKey 的身份/作用域。
- 匹配解析 `sourceKey`：`principal:<principalId>`（global）、`membership:<workspaceId>:<principalId>`（workspace）、`delegation:<delegationId>`（workspace）。比较时同时校验 Principal/Membership/Delegation 的 ID、Workspace（适用时）与对应 authority version；任一不一致即不匹配。
- 直接 controller：`controllerPrincipalId == fencePrincipalId && controllerPrincipalVersion == sourceVersion`（Principal）；`workspaceId == fenceWorkspaceId && controllerPrincipalId == fencePrincipalId && controllerMembershipVersion == sourceVersion`（Membership）。
- 委托 controller：grantor/delegate 两端分别用 `grantorPrincipalId`/`delegatePrincipalId` + 对应 Principal version（Principal fence），以及 `grantorPrincipalId`/`delegatePrincipalId` + 对应 Membership version + 同一 Workspace（Membership fence）匹配。
- Snapshot-controller Grant：grantee 以及 source Delegation 的 grantor/delegate 都必须按 ID + Workspace（Membership）/scope + version 匹配；只比较 `sourceDelegationVersion` 不足。
- 源记录当前 status/version 仍是当前授权判据；Membership re-add、Principal enable 产生新 version，旧 fence 不再命中新对象，也不会让旧 Controller/Delegation 复活。旧 Task 的绑定版本仍是旧值，因此保持 frozen，直到显式 `transferController`。
- `scope.kind=global` 明确表示所有 Workspace，不是“未指定”；不能用一个含义不清的布尔字段代替。
- Fence 提交后立即拒绝依赖该来源的新命令、读 API、Event cursor 和 Replay；不等待 `status=completed`。
- Reconcile 只物化已生效的拒绝：写 `Task.controlState=frozen`、**snapshot controller** `ArtifactGrant.revokedAt`、`lastError`/进度；**绝不写 `controlState=active`，绝不恢复旧 Controller**。explicit/requester Grant 只做 effective ACL，不自动物理撤销。
- 同一 sourceVersion 重复撤销返回已有 fence；若源已处于同一终态，返回该 sourceKey 的现有 fence，不按 commit 后新 version 再建。只有 re-add/enable 后再次失效才创建新 version 的 fence。
- `status=failed` 不是终态；retry 扫描包含 `pending/reconciling/failed`。完成记录失败不改变即时拒绝。
- `effectiveAt` 对 expiry 可等于 `expiresAt`，允许过去时间；对 revoke 是 commit 时间。服务端时钟为准。
- 源级撤权事件必须在撤权 commit；`controller.frozen`/`artifact.grant_revoked`/`authorization.reconciled` 是 Reconcile 派生事件，按 `fenceId+sourceVersion+targetId` 幂等，不能作为授权失效前置条件。
- Reconcile target identity 使用具体对象 ID + authority binding；Principal enable、Membership re-add、new Delegation、new explicit Grant 不能单独让旧 Task/Grant 退出旧 Fence。
- 委托目标必须解析 Delegation 的 grantor/delegate 两端：Principal fence 检查 `grantorPrincipalId`/`delegatePrincipalId` 与各自 `grantorPrincipalVersion`/`delegatePrincipalVersion`；Membership fence 检查 Workspace、`grantorPrincipalId`/`delegatePrincipalId` 与各自 `grantorMembershipVersion`/`delegateMembershipVersion`；ArtifactGrant 的 `sourceDelegationId` 非 null 时同样按完整 ID/Workspace/version binding 检查，不能只看 sourceDelegationVersion。

### 5.4 有效权限与失效来源

```text
effectivePermission(actor, op, resource) =
  principalAuthorityValid(actor)
  AND effectiveMembership(actor, resource.workspaceId) = active
  AND workspaceAllows(resource.workspaceId, op)
  AND membershipRoleAllows(role, op)
  AND delegation/ACL checks if actor is delegated agent
  AND resource-specific ACL (Task visibility / Artifact ACL)
```

Delegated Agent 还必须满足：

```text
delegation.status=active && now<expiresAt
AND no matching delegation fence
AND actor=delegatePrincipalId
AND op ∈ scopes
AND resource ∈ resourceScope
AND delegation.grantorPrincipalVersion == principal(delegation.grantorPrincipalId).version
AND delegation.grantorMembershipVersion == membership(delegation.grantorPrincipalId, delegation.workspaceId).version
AND delegation.delegatePrincipalVersion == principal(delegation.delegatePrincipalId).version
AND delegation.delegateMembershipVersion == membership(delegation.delegatePrincipalId, delegation.workspaceId).version
AND grantor 仍在目标 Workspace effective active
AND grantor 当前仍拥有该 op/资源的权限
AND actor 自身 Membership 仍允许该 op
AND Artifact ACL 仍允许（Artifact 场景）
```

- `principalAuthorityValid(p)`：`status=active`、`deletedAt=null`，且不存在 `sourceKey=principal:<id>` 且 `sourceVersion=p.version` 的 fence。
- 对对象授权，仍必须比较 controller 绑定（Principal/Delegation ID + Workspace + version；snapshot-controller Grant 还包括 grantee/source delegation ID/Workspace + version）与 fence 的旧 `sourceVersion`；不能只看 version 数值或当前记录。
- 任一版本不相等即拒绝；不能只看 stored `active` 或旧 `AuthorizationContext`。
- `effectivePermission` 回答“某个 Principal 现在能否做某个操作”，不回答“旧 Controller 是否仍能继续控制”；后者见 6.1 的 `effectiveControlState`。

---

## 6. Task v3

### 6.1 实体

```text
Task:
  taskId                       TaskId
  workspaceId                  WorkspaceId
  title                        string | null
  objective                    string                 // 原始目标，不可变
  description                  string | null
  ownerPrincipalId             PrincipalId
  requestedByPrincipalId       PrincipalId | null
  createdByPrincipalId         PrincipalId
  controllerPrincipalId        PrincipalId
  controllerPrincipalVersion   number                 // controller 赋值时的 authority version
  controllerMembershipVersion  number
  controllerDelegationId       DelegationId | null
  controllerDelegationVersion  number | null          // 无 delegation 时为 null
  controlState                 active | frozen         // stored/materialized cache
  controllerFrozenReason       string | null          // 诊断用；不是授权判据
  controllerFrozenAt           Timestamp | null
  visibility                   private | workspace
  goalStatus                   open | active | awaiting_decision |
                               completed | failed | cancelled
  lifecycle                    live | archived | deleted
  selectedExecutionId          ExecutionId | null
  latestExecutionId            ExecutionId | null
  duplicateExecutionRisk       boolean
  integrityAlerts              IntegrityAlert[]       // 只追加；确认不删除
  workingDirectory             string | null           // 相对 Workspace root；空字符串表示 root；null=legacy/未归一化
  legacyCwd                    string | null           // 仅迁移/审计
  legacy                       JsonValue | null        // 迁移元数据
  riskAcknowledgements         RiskAcknowledgement[]   // 只追加；见 6.6
  createdAt / updatedAt
  archivedAt / deletedAt
  deletedFrom                  live | archived | null
  revision                     number

RiskAcknowledgement:
  acknowledgementId
  taskId
  executionIds[]              // 当前全部 interrupted/unknown
  actorPrincipalId
  note
  createdAt
  authorizationRevision

IntegrityAlert:
  alertId
  executionId
  code
  time
  acknowledgedAt | null
  acknowledgedByPrincipalId | null
  note | null
```

**`controlState` 是 stored/materialized cache，不是唯一权威。** Controller 在赋值时绑定当时的 Principal/Membership/Delegation authority version；任一 authority 变化都会使旧绑定失效，因此不需要在撤权 commit 中枚举 Task。API 的 `TaskView.controlState` 和所有 Store 写授权使用 effective：

```text
controllerAuthorityValid(task) =
  principalAuthorityValid(task.controllerPrincipalId)
  AND effectiveMembership(task.controllerPrincipalId, task.workspaceId) = active
  AND principal(task.controllerPrincipalId).version == task.controllerPrincipalVersion
  AND membership(task.controllerPrincipalId, task.workspaceId).version == task.controllerMembershipVersion
  AND if task.controllerDelegationId != null:
        delegation(task.controllerDelegationId).status=active
        AND now < delegation.expiresAt
        AND no matching delegation fence
        AND delegation.version == task.controllerDelegationVersion
        AND delegation.grantorPrincipalVersion == principal(delegation.grantorPrincipalId).version
        AND delegation.grantorMembershipVersion == membership(delegation.grantorPrincipalId, task.workspaceId).version
        AND delegation.delegatePrincipalVersion == principal(task.controllerPrincipalId).version
        AND delegation.delegateMembershipVersion == membership(task.controllerPrincipalId, task.workspaceId).version
        AND delegation.delegatePrincipalId == task.controllerPrincipalId

effectiveControlState(task) =
  frozen if task.controlState == frozen
  frozen if controllerAuthorityValid(task) == false
  else active
```

- `stored controlState=frozen` 是显式冻结/撤权留下的 latch；没有任何自动 unfreeze。只有 `transferController`（或 system recovery）可以设置新 controller 并重新绑定，且必须审计。
- `controllerPrincipalId`/membership/delegation 记录缺失、版本字段缺失或无法解析时，`controllerAuthorityValid=false`，不得按 active 处理。
- v3 不暴露“同一 controller 的 unfreeze”；`controller.unfrozen` 事件不产生。需要恢复控制时，Owner/Admin 必须 `transferController` 到新的有效 controller；旧 controller 不得因恢复操作重新获得控制。
- 不能把 materialized `active` 当作“仍可控制”；Membership 被移除、Delegation 被撤销/过期、Principal 被禁用后，即使 stored 仍是 active，effective 也是 frozen。
- `controllerFrozenReason`/`controllerFrozenAt` 只是物化诊断；多个失效来源并发时，reason 可能只记录其中一个，不能用于判断是否已解除。
- AD-12-R1：撤权 commit 的原子边界是“最终授权检查 + 源 status/version + Fence + authRev”；`controlState` 等派生投影可异步物化，但不得作为授权判据。
- **权限失效与执行取消分离**：`effectiveControlState=frozen` 不修改 `goalStatus`，不写 `cancel.requestedAt`，不把 running Execution 改成 cancelled。
- **控制操作与治理操作分离**：创建/调度/取消/完成/更新 Task 等“继续控制”操作要求 `controlState=active` 且 actor 是 controller；`transferController`、Owner/Admin 的 `cancelTask`/`archiveTask`/`deleteTask`/审计读取属于治理操作，可在 frozen 时执行，但不能让旧 controller 继续控制。

**不把 `executionSummary` 作为权威持久字段。** API 派生：

```text
executionSummary:
  activeExecutionIds[]       queued + running
  unresolvedExecutionIds[]   interrupted + unknown
  latestExecutionId
  selectedExecutionId
  counts                     queued/running/terminal/unknown
  hasIntegrityRisk
  duplicateExecutionRisk
```

`Task.status` 兼容投影：

```text
archived if lifecycle=archived
deleted  if lifecycle=deleted
goalStatus otherwise
```

**goalStatus 与 executionSummary 是正交维度**：`active` 只表示“没有显式目标决定，且至少一个 queued/running”；显式 `completed/failed/cancelled` 是目标决定，允许仍有正在清理的 Execution（尤其 cancel），但禁止新 Execution。不能因为 summary 里还有 running 就把已显式 cancel 的 Task 强行改回 active。

`Task.result` 兼容投影只来自 `selectedExecutionId`（若存在），否则 null/legacy；不得用 latest 冒充 selected。

### 6.2 Task 创建默认值

| 场景 | owner | requestedBy | createdBy | controller | visibility |
|---|---|---|---|---|---|
| User 直接创建 | User | User（自我） | User | User | private（默认） |
| Agent 受 User 委托 | grantor | grantor | Agent | Agent | private |
| Agent 自主 | Agent | null | Agent | Agent | private |

- `Task.owner`/`controller` 必须是该 Workspace 的 effective active 成员；Agent 可以是 owner/controller。
- 创建 Task 时必须在同一 commit 写入 `controllerPrincipalVersion`、`controllerMembershipVersion`、`controllerDelegationVersion`；`transferController` 必须重新绑定新 controller 的当前版本。缺任一版本字段的 Task 只能进入 manual recovery，不能按 active 控制。
- `controllerDelegationId=null` 时 `controllerDelegationVersion` 必须为 null；非 null 时必须记录匹配的 delegation version。
- `createdBy`/`requestedBy` 不可变；`owner`/`controller` 可变但必须审计。
- `Task.owner` 与 `controller` 可以不同。
- `Task.visibility=private` 是默认；`workspace` 必须显式选择。
- 新建 Task 的 `workingDirectory` 必须是 Workspace root 下的相对路径；绝对路径/`..`/UNC 拒绝；`null` 只允许迁移的 legacy Task，且该 Task 在归一化前禁止新 Execution。

### 6.3 Task 状态转换表

| 当前 goalStatus | 触发 | 授权 | 结果 | 持久化副作用 | Event |
|---|---|---|---|---|---|
| — | createTask | `task:create` | open | Task + owner/controller + audit | task.created |
| open | 首个 Execution 进入 queued | `execution:create` | active | Execution queued；Task latest | execution.created |
| active | commitDispatchIntent | `execution:control` | active（goalStatus 不变） | Execution/Lease/dispatchIntent | execution.dispatched |
| active | 最后一个 queued/running 离开 | 系统聚合 | awaiting_decision | Task goalStatus；summary 派生 | task.awaiting_decision |
| awaiting_decision | 新 Execution 进入 queued/running | `execution:create` + risk ack | active | 新 Execution；不清除旧风险 | execution.created |
| open/active/awaiting_decision | cancelTask | controller/owner/admin | cancelled | 取消所有 queued/running；记录 cancel requests；不伪造 Execution 终态 | task.cancelled + execution.cancel_requested |
| awaiting_decision | completeTask | controller/owner/admin；selected completed；无 active；风险已记录 | completed | Task goalStatus；事件；不改 Execution | task.completed |
| awaiting_decision | failTask | controller/owner/admin；无 active；风险已记录 | failed | Task goalStatus；事件 | task.failed |
| completed/failed/cancelled | 普通 Execution 事件 | — | 不迁移 | 拒绝 `INVALID_TASK_TRANSITION` | — |
| completed/failed/cancelled | 新 Execution | — | 拒绝 | 创建新 Task | — |
| archived/deleted | 新 Execution | — | 拒绝 | 先 restore；不自动执行 | — |
| live | archiveTask | controller/owner/admin；无 active | lifecycle archived | goalStatus 不变 | task.archived |
| archived | restoreTask | owner/admin | life live | goalStatus 不变 | task.restored |
| live/archived | deleteTask | owner/admin；无 active | lifecycle deleted | `deletedFrom` 记录 | task.deleted |
| deleted | restoreTask | owner/admin | 原 lifecycle | 不自动执行 | task.restored |

说明：

- 表中的 `controller` 均指 `effectiveControlState=active` 的当前 controller；已冻结的旧 controller 不再属于 controller，不能执行创建/调度/取消/完成/更新。Owner/Admin 的治理操作按权限矩阵单独允许。
- `active` 是“目标未决且至少一个 queued/running”；`cancelled` 是显式目标决定，可能仍有正在清理的 Execution（`executionSummary` 显示），但禁止新 Execution。
- `completeTask`/`failTask` 不得在 active 时执行；必须等所有 Execution 结算或显式 cancel。
- `cancelTask` 不等待 cancel confirmation；它记录目标取消和 cancel requests；Execution 仍按真实证据结算。
- `archiveTask`/`deleteTask` 要求无 queued/running；unknown/interrupted 不阻塞归档，但必须在 summary 暴露风险。
- `restoreTask` 不把 completed/failed/cancelled 变成 active，也不自动 unfreeze controller；恢复后仍需显式 `transferController`。

### 6.4 complete/fail/cancel 的语义

- `completeTask`：必须指定 `selectedExecutionId`，且该 Execution 为 `completed`；没有 queued/running；所有 `interrupted`/`unknown` 风险已显式记录；不能静默忽略。
- `failTask`：没有 queued/running；记录 failure reason/风险；不修改 Execution。
- `cancelTask`：显式目标取消；对每个 queued/running 写 `cancel.requestedAt`；不把 running 直接写 cancelled；返回 Task + 每个 Execution 的请求结果。
- `cancelExecution`：只请求/确认一个 Execution；不改变 Task goalStatus。
- `archiveTask`：只改 lifecycle；不删除历史/Artifact。
- `deleteTask`：软删除；不删除 Execution/Artifact；Artifact 由自己的 ACL/生命周期决定。

### 6.5 可见性

`private` 可读：

1. Task owner；
2. requestedBy（若有）；
3. active controller（未冻结时）；
4. Workspace Owner/Admin 审计；
5. 有效 Delegation 且 scope 含 `task:read`、resourceScope 覆盖该 Task 的 Agent；
6. 未来显式 TaskGrant（v3 不开放任意 ACL）。

`workspace` 可读：Workspace 的 effective active 成员；控制权仍只属于 controller/owner/admin。

- `createdBy` 不自动获得 private 读权。
- 知道 taskId 不是授权。
- `Task` 的 owner/controller 变更必须审计。

### 6.6 风险确认

- `RiskAcknowledgement.executionIds` 必须等于当前 `unresolvedExecutionIds` 集合（顺序无关）；不能只确认部分。
- 确认只记录“知道风险”，不清除 `unknown`/`interrupted`，不改 result，不清除 `duplicateExecutionRisk`。
- 新 Execution 的 `acknowledgeUnknownExecutionIds` 必须与当前 unresolved 集合一致；否则 `UNKNOWN_EXECUTION`。
- 确认记录不可变；重复确认只追加新的记录或幂等返回，不覆盖旧记录。
- `completeTask`/`failTask` 的 risk note 也必须引用/记录当前 unresolved 集合；不能空数组绕过。

---

## 7. Execution v3

### 7.1 实体

```text
Execution:
  executionId                ExecutionId
  taskId                     TaskId
  workspaceId                WorkspaceId
  status                     queued | running | completed | failed |
                             cancelled | interrupted | unknown
  submission                 not_started | dispatch_intent | response_observed
  prompt                     string                       // 不可变
  input:
    cwd                      string                       // Workspace-relative，不是宿主绝对路径
    workspaceSnapshot        WorkspaceSnapshot
  requestKey                 string | null                // 兼容/审计；幂等以 RequestRecord 为准
  requestRecordId            RequestRecordId | null
  sessionBindingId           BindingId | null
  executor:
    executorId               string
    principalId              PrincipalId                  // 实际执行主体
    runtimeId                string | null
  createdByPrincipalId       PrincipalId                  // 提交命令的 actor
  createdAt / updatedAt
  startedAt / deadlineAt / finishedAt
  lastNotificationAt         Timestamp | null
  result                     JsonValue
  resultIntegrity            partial | observed_complete | uncertain
  completionEvidence         CompletionEvidence | null
  cancel:
    requestedAt              Timestamp | null
    requestedByPrincipalId   PrincipalId | null
    sentAt                   Timestamp | null
    confirmedAt              Timestamp | null
    outcome                  confirmed | not_submitted | unconfirmed | null
  dispatchIntent:
    intentId                 string
    committedAt              Timestamp
    authorizationRevision    number
    leaseId                  LeaseId | null
    fencingToken             FencingToken | null
  diagnostics                Diagnostic[]                 // 上限 32
  unknownReason              string | null
  duplicateExecutionRisk     boolean
  revision                   number
```

`WorkspaceSnapshot`：

```text
kind                mutex | git-worktree | directory-copy | shared-readonly
workspaceId
baseRevision        string | null
leaseId             LeaseId | null
fencingToken        FencingToken | null
cwd                 string              // Workspace-relative；Adapter 通过 root handle 解析
```

### 7.2 持久化状态与派生展示状态

**v3 不新增 AD-07 之外的持久化状态。** API 可以返回 `displayState`：

| 持久化 status/submission/cancel | displayState |
|---|---|
| queued, not_started | queued |
| running, dispatch_intent, no输出且未终态 | dispatching（只证明 intent，不证明 ACP 已接收） |
| running, dispatch_intent, 已有输出但未终态 | running |
| queued/running + cancel.requestedAt | cancelling |
| completed | completed（别名 succeeded） |
| failed | failed |
| cancelled | cancelled |
| interrupted | interrupted |
| unknown | unknown |

- `dispatching` 不是 Store 状态；它是 `running + dispatch_intent + 尚未收到终态` 的投影。
- `cancelling` 不是 Store 状态；它是 cancel request 已存在、终止未确认的投影。
- `succeeded` 只是 `completed` 的展示别名；Contracts v3 不引入第二个终态。
- `awaiting_input` 不进入 v3；Phase 2.3 用 InputRequest，Execution 仍是 `running`，直到输入返回或终态。

### 7.3 Execution 状态机

```mermaid
stateDiagram-v2
    [*] --> queued: createExecution
    queued --> running: commitDispatchIntent
    queued --> cancelled: local_not_submitted
    queued --> queued: restart/recover
    running --> completed: end_turn + observed_complete
    running --> cancelled: ACP cancelled
    running --> failed: confirmed failure
    running --> interrupted: disconnect/process loss
    running --> unknown: timeout/restart/no terminal evidence
    interrupted --> unknown: recovery without evidence
    completed --> [*]
    failed --> [*]
    cancelled --> [*]
    unknown --> [*]
```

规则：

- `queued` 可以在重启后保持；不自动 dispatch。
- `commitDispatchIntent` 后 `status=running`、`submission=dispatch_intent`；这是“可能已发送”的持久事实。
- 只有 `completionEvidence`/取消证据支持的终态才能写 `completed`/`cancelled`；`failed` 需要确认错误。
- `interrupted` 是非终态风险；恢复只能转 `unknown` 或保留已提交终态，不能凭 Session 可恢复性转 completed。
- `unknown` 是终态；不自动重试。
- `terminal` 为 `completed|failed|cancelled|unknown`；`interrupted` 不是终态，但不自动重发。
- 终态不可覆盖；diagnostics/cancel timestamps 可追加。

### 7.4 关键竞态

1. **Session 已创建但未 dispatch**：`queued` + binding（可能）；恢复保留 queued，不自动 prompt；可能产生孤立 Session，需要 cleanup/reconcile。
2. **dispatch_intent 已持久化但发送未知**：`running + dispatch_intent`；恢复不能证明未发送，进入 `unknown`，禁止自动重发。
3. **prompt 已发送但 Hub 未持久化结果**：`running`/`unknown`；没有 ACP 结果回放，不能伪造 completed。
4. **Hub 重启无法判断 DSH 是否执行**：`unknown` + `RESULT_UNAVAILABLE` 诊断；要求人工/显式 acknowledgment。
5. **cancel 已发送但未确认**：`cancel.requestedAt/sentAt` 存在，status 仍 running/interrupted；`confirmedAt` 仅由 ACP cancelled 或证明未发送的本地取消填写。
6. **late notification**：不能可靠关联原 Execution 的文本/通知进入 quarantine 诊断，最多 32 项；不覆盖终态；Task 可产生 integrity alert；不能据此生成 result 或 completed。

### 7.5 取消与 Task 取消

- `cancelExecution`：写 `cancel.requestedAt`；已 queued 且确定未发送可本地取消；running 只发送 ACP cancel，等待证据；返回请求结果，不返回伪造终态。
- `cancelTask`：写 Task `goalStatus=cancelled` + 所有 active execution 的 cancel request；Execution 仍按真实证据结算；Task 可显示执行清理。
- `cancelTask` 后不能创建新 Execution；已运行 Execution 的终态仍保存。
- `unknown`/`interrupted` 的存在不会阻止 `cancelTask`，但必须保留 unresolved risk。

### 7.6 SessionBinding

```text
SessionBinding:
  bindingId                BindingId
  executionId              ExecutionId
  taskId                   TaskId
  workspaceId              WorkspaceId
  sessionId                string | null
  cwd                      string              // 服务端使用；API View 不返回宿主绝对路径
  runtimeId                string | null
  generation               string
  availability             active | closed | unknown
  recoveryRequired         boolean
  createdAt / updatedAt
```

- 一个 Execution 至多一个 active Binding；一个 Session 同时至多一个 active Execution。
- 同一 Session 可以按顺序被同一 Task 的后续 Execution 复用，但必须新建 Binding/Execution，不能改写旧记录。
- `session/new` 成功后、dispatch intent 前崩溃：Binding 可能存在但 Execution 仍 queued；恢复不自动 prompt。
- `availability=unknown` 或 `recoveryRequired=true` 时，不得直接创建新 Execution；先 cleanup/reconcile。
- Binding 的 `sessionId`/`cwd` 是身份字段，不得被后续 Binding 静默覆盖。

### 7.7 结果与证据

- `resultIntegrity=observed_complete` 仅用于 completed。
- `completed` 需要 `stopReason=end_turn` + 输出 flush + 结果在同一终态事务。
- `cancelled` 需要 `stopReason=cancelled` 或 `local_not_submitted` 证据。
- `failed` 需要确认错误；timeout 不是 completed/failed 的证明。
- `unknown`/`interrupted` 不能带 completionEvidence。
- `unknown` 不能被自动改成 failed；`failed` 也不能覆盖已提交的 unknown。

---

## 8. Artifact v3

### 8.1 实体

```text
Artifact:
  artifactId                 ArtifactId
  workspaceId                WorkspaceId
  ownerPrincipalId           PrincipalId
  sourceTaskId               TaskId | null
  sourceExecutionId          ExecutionId | null
  storageRef                 string                 // 不透明，不暴露本机路径
  storageKind                string                 // 后端标识
  sha256                     string
  size                       integer
  mime                       string
  visibility                 private | workspace
  permissionMode             snapshot | explicit    // v3 只使用 snapshot
  retentionPolicy            string | null
  createdByPrincipalId       PrincipalId
  createdAt / updatedAt
  deletedAt                  Timestamp | null
  purgedAt                   Timestamp | null
  version                    number

ArtifactReference:
  artifactId + taskId + executionId + relation(produced|referenced)
  createdAt / createdByPrincipalId
  unique by (artifactId, taskId, executionId, relation)

ArtifactGrant:
  grantId
  artifactId
  granteePrincipalId         PrincipalId
  granteePrincipalVersion    number | null    // 仅 task-snapshot-controller 必填
  granteeMembershipVersion   number | null    // 仅 task-snapshot-controller 必填
  scope                      read | write
  grantedByPrincipalId       PrincipalId
  origin                     explicit | task-snapshot-requester |
                             task-snapshot-controller
  sourceDelegationId         DelegationId | null   // snapshot-controller 时记录
  sourceDelegationVersion    number | null
  createdAt
  expiresAt                  Timestamp | null
  revokedAt / revokedReason
```

### 8.2 创建时 ACL

创建 Artifact 的同一事务中物化：

```text
Artifact.ownerPrincipalId = source Task.ownerPrincipalId
Artifact.visibility = source Task.visibility
snapshot requester grant: requestedBy（若非 owner，scope=read）
snapshot controller grant: controller（若非 owner/requester，scope=read）
```

- 创建 Grant 时必须同时写入 grantee 的 Principal/Membership authority version；仅 `origin=task-snapshot-controller` 强制，用于冻结后不可自动恢复。`origin=explicit`/`task-snapshot-requester` 不依赖 version 绑定，使用当前 grantee Membership/Principal 做 live 检查；成员失效时访问暂停，re-add 后按既有 Grant 恢复（除非显式 revoke）。
- 读取时只使用 Artifact 自身 owner/visibility/Grant，不查询当前 Task 角色。
- 有效 Grant 必须满足：
  - 所有 origin：grantee Principal 当前有效、grantee Membership 当前 effective active、`revokedAt=null`、未过期；
  - `origin=task-snapshot-controller`：grantee Principal/Membership version 与记录一致，且 `sourceDelegationId` 有效、`sourceDelegationVersion` 一致；解析 source Delegation 的 grantor/delegate 两端 Principal/Membership binding 并校验，不能只检查 sourceDelegationVersion；无匹配 fence；
  - `origin=explicit`/`task-snapshot-requester`：不比较 grantee version；成员失效时立即 effective 无效，re-add 后按既有 Grant 恢复（除非显式 revoke）。
- Membership/Principal 变化不会自动写 explicit/requester Grant 的 `revokedAt`；只有 `origin=task-snapshot-controller` 的 Grant 由 Fence 立即 effective 无效并异步物化 revokedAt。新建 explicit Grant 是不同 grantId，不替代旧 snapshot Grant 的撤销义务。
- Artifact owner 变化不自动改变 Grant；Artifact owner 转移需显式操作。
- Controller 转移/冻结同步只针对 `origin=task-snapshot-controller` 的 Grant；冻结时该 Grant 由 Fence/authority version 立即 effective 无效，`revokedAt` 可异步物化；显式 transfer 仍在同一事务撤销旧 Grant/创建新 Grant（AD-06-R1）。
- Task owner 转移不改变 Artifact owner；需要显式 transfer。Reconcile 不得修改 `Artifact.ownerPrincipalId`；owner 关系只用于完整性审计，不是 Fence 物化目标。
- Task visibility 变化不改变 Artifact；发布审核事件。

### 8.3 Artifact 读取/写入

- private 读取：owner、snapshot requester/controller grant、显式 ArtifactGrant、Workspace Owner/Admin 审计；owner 本身也必须是当前 effective active 成员，否则 owner 读取被拒绝，需 Owner/Admin 显式转移。
- workspace 读取：Workspace effective active 成员，前提是 `Artifact.visibility=workspace`。
- 写入：Artifact owner 或对来源 Task 有写权限且 Artifact ACL 允许的 controller；Workspace 角色本身不授予写入。
- `artifact:grant`/transfer：Artifact owner 或 Workspace Owner/Admin 的显式管理操作并审计。
- 跨 Workspace 共享不在 v3 开放；未来必须独立 `ArtifactShare`/AD。

### 8.4 生命周期与删除

- `softDeleteArtifact`：设置 `deletedAt`，隐藏；不删除引用/存储。
- 删除 Task 不删除 Artifact；解除引用不删除仍被其他引用的 Artifact。
- `purgeArtifact`（v3 不开放普通 API；离线/内部）条件：
  1. `deletedAt` 已超过 retention；
  2. 没有 active `ArtifactReference` 指向它；
  3. 没有未撤销的 Grant；
  4. 通过 IW-09 path guard 定位 storageRef；
  5. 写入 `purgedAt` 并审计；
  6. 物理删除后保留最小 tombstone（artifactId/workspaceId/hash/时间）。
- 物理删除不能只按路径；必须通过 Workspace root handle / staging 约束。
- v3 API 只提供 soft-delete；物理 purge 留到离线管理或后续阶段。

---

## 9. Workspace 并发、工作副本与租约

### 9.1 数据并行与写并发

- 数据模型：一个 Task 可有多个 Execution（queued/running/terminal）。
- 写并发：由 `isolationPolicy` 和 `WorkspaceWriteLease` 决定。
- `mutex`：每 Workspace 最多一个 `held` 写租约；其他 Execution 排队。
- `git-worktree`/`directory-copy`：每个 Execution 独立副本，不持有原 Workspace 写租约。
- `shared-readonly`：仅当执行器证明不写；v3 不作为默认创建选项。
- 不自动合并并行结果；`selectedExecutionId` 由上层显式选择。

### 9.2 WorkspaceWriteLease

```text
WorkspaceWriteLease:
  leaseId
  workspaceId
  executionId
  state                held | releasing | released | frozen | quarantined
  fencingToken:
    workspaceId
    epoch
    leaseId
    executionId
  acquiredAt
  renewedAt
  expiresAt
  releasedAt
  releaseEvidence      process_tree_terminated | fencing_enforced | null
  releaseReason
```

规则：

- `mutex` 下每个 Workspace 最多一个 `held`。
- 租约与 `commitDispatchIntent` 在同一事务获取；没有租约不发送 prompt。
- `held` 期间可 `renewWorkspaceLease`，只延长 `expiresAt`，不改变 epoch/fencingToken；Workspace quarantine 或 Execution 终态后拒绝续期。
- Lease 超时本身不自动释放；Hub 存活但无法确认清理时进入 frozen；Hub 崩溃后恢复按 AD-13 冻结/quarantine。
- `held` 期间 Execution 终态 + Session/进程清理完成后，进入 `releasing`；清理确认后 `released`。
- `unknown`/`interrupted`/清理失败：`frozen`，不自动释放。
- 强制释放只接受 AD-13 证据：进程树终止证明或实际生效的 fencing；仅 workspace 隔离不允许释放旧租约。
- 无证据只能 `Workspace.quarantineState=quarantined` + lease `quarantined/frozen`；不得交给新 Execution。
- `fencingToken` 只有执行器/存储层实际拒绝旧 token 时才算 fencing；仅保存字段不算。
- `Workspace.writeEpoch` 每次获取/强制释放/恢复递增。

### 9.3 Controller 转移

- `transferController` 是单事务：旧 controller 失效/冻结，新 controller 校验 effective operator+，更新 `controllerPrincipalId`/`controllerDelegationId`/`controlState`。
- 运行中的 Execution 不因 transfer 取消；继续持有 lease。
- 新 controller 不能在同一事务创建新 Execution（先完成 transfer；下次命令）。
- 显式 controller transfer：旧 controller 的 snapshot ArtifactGrant 同事务撤销，新 controller 同事务创建新 grant（AD-06-R1）；撤权冻结则走 Fence 立即 effective 无效 + 异步物化。
- 所有旧连接/订阅重新授权。

### 9.4 旧 Executor 仍在运行

- Hub 断连不等于 DSH 子进程停止（Phase 1.1 已确认）。
- 如果没有进程终止证明或实际 fencing，不能把同一 Workspace 写租约交给新 Execution。
- 可以：
  - 使用 worktree/copy 新副本（旧租约保持 frozen，旧 Workspace 不释放）；
  - 进入 quarantine；
  - 由有证据的离线恢复释放。
- 不能：仅管理员 `force=true`、仅时间过去、仅 Hub 重启。

---

## 10. 授权模型摘要

### 10.1 AuthorizationContext

```text
AuthorizationContext:
  connectionId
  actorPrincipalId
  actorType
  workspaceId
  requestedByPrincipalId | null
  delegationId | null
  authorizationRevision
  principalVersion
  membershipVersion
  delegationVersion
  workspacePolicyVersion
  managementScope?             // 仅未来管理接口
```

- 由服务端连接/Store 状态生成，客户端不能构造/覆盖。
- 每次写 commit 重新计算 effective Membership/Delegation/ACL；不信任缓存。
- Context 中的 version 是“上次看到的版本”，不是授权证明。Store 必须与当前 Principal/Membership/Delegation version 比较；不相等返回 `AUTHORIZATION_STALE`，除非该请求是已提交 RequestRecord 的 Replay（Replay 仍重新授权，但不比较 expectedRevision）。
- `actor` 来自连接；`requestedBy` 来自 grantor 或 User 自身；`owner/controller` 来自 Task 字段/命令。

### 10.2 权限交集

Agent 有效权限 = Agent Membership ∩ grantor 当前权限 ∩ Delegation scope/resource ∩ 目标资源 ACL ∩ authority version 绑定。

- 任何一项失效即拒绝。
- Controller 的 `controllerPrincipalVersion`/`controllerMembershipVersion`/`controllerDelegationVersion` 必须与当前 authority 完全一致；否则 effective control 为 frozen，不能执行控制操作。
- `workspace:create` 不是 Workspace RBAC，也不在 Local Bootstrap；只属于离线 provisioning/未来管理上下文（IW-10）。
- 撤销/过期不追溯已接受的 `dispatch_intent`，但阻断新命令。
- 正在执行的 Execution 仍可由其绑定 executor/lease 提交结果证据；撤权不取消执行，也不让旧 controller 发新命令。

### 10.3 读过滤

- `getTask/listTasks`：先 Workspace Membership，再 Task visibility。
- `getExecution/listExecutions`：先 Task 可见性，不能绕过 Task。
- `getExecutionResult`：与 Execution 的 Task 可见性相同；撤权后不返回旧结果，除非调用者仍拥有当前读取权限。
- `getArtifact/listArtifacts`：Artifact ACL；不是 Task ACL。
- `getEvents/subscribeEvents`：scope + workspace + 资源可见性；每次重新授权。
- 非成员返回 `*_NOT_FOUND`，成员但不可见返回 `*_NOT_VISIBLE`，避免跨租户存在性泄漏。
- Replay 的写入幂等与结果读取是两条路径：Replay 需要当前操作授权；读取已提交结果需要当前资源读取授权。失去写权限不等于自动获得结果读取权，失去读权限也不能靠 requestKey 读取 resultSnapshot。

---

## 11. ER 图

```mermaid
erDiagram
    PRINCIPAL ||--o{ WORKSPACE_MEMBER : joins
    WORKSPACE ||--o{ WORKSPACE_MEMBER : has
    WORKSPACE ||--o{ DELEGATION_GRANT : contains
    PRINCIPAL ||--o{ DELEGATION_GRANT : grantor
    PRINCIPAL ||--o{ DELEGATION_GRANT : delegate
    PRINCIPAL ||--o{ AUTHORITY_REVOCATION_FENCE : invalidates
    WORKSPACE ||--o{ AUTHORITY_REVOCATION_FENCE : scopes
    DELEGATION_GRANT ||--o{ AUTHORITY_REVOCATION_FENCE : revokes
    WORKSPACE ||--o{ TASK : owns
    PRINCIPAL ||--o{ TASK : owner
    PRINCIPAL ||--o{ TASK : requested_by
    PRINCIPAL ||--o{ TASK : controller
    TASK ||--o{ EXECUTION : records
    EXECUTION ||--o| SESSION_BINDING : uses
    TASK ||--o{ ARTIFACT_REFERENCE : references
    ARTIFACT ||--o{ ARTIFACT_REFERENCE : referenced
    ARTIFACT ||--o{ ARTIFACT_GRANT : grants
    WORKSPACE ||--o{ WORKSPACE_WRITE_LEASE : serializes
    WORKSPACE_MEMBER ||--o{ MEMBERSHIP_REVISION : history
```

---

## 12. 实体不变量与 Store 校验

Store v3 必须验证：

1. ID 全局唯一；所有引用属于同一 Workspace（未来跨 Workspace 分享除外）。
2. `(workspaceId, principalId)` Membership 唯一；Owner 唯一且是 User。
3. Membership stored/effective 分离；`MembershipRevision` append-only。
4. Delegation grantor User、delegate Agent、不跨 Workspace、无二次委托。
5. Task owner/controller 在赋值时是 effective active 成员；Agent 不能 Owner/Admin Workspace。
6. `selectedExecutionId`/`latestExecutionId` 指向同一 Task 的 Execution。
7. Execution 的 `taskId`/`workspaceId`/`bindingId` 归属一致；终态不可变。
8. 一个 SessionBinding 只属于一个 Execution；同一 Session 不能跨 Task 并行。
9. 同一 Task 的多个 active Execution 必须满足 Workspace 隔离/租约规则。
10. `effectiveControlState=frozen` 的 Task 不能创建/控制 Execution；stored `controlState` 不能覆盖 authority version/fence。
11. Artifact owner/grantee 是 effective active 成员；Artifact reference 归属正确；snapshot-controller 的 `sourceDelegationId`/grantee authority version 失效时 grant 立即无效；explicit/requester 使用 live ACL，不因版本变化自动写 revokedAt。
12. `WorkspaceWriteLease` 最多一个 held（mutex）；与 Execution dispatch/终态/清理关联。
13. Event 关联完整；事件 scope/audience 与 Workspace 一致。
14. `authorizationRevision` 单调递增；所有影响授权的变更递增。
15. `rootIdentity`/`quarantineState` 与 Workspace 路径能力一致；`rootStatus=bound` 时 `rootIdentity` 非空，`unbound` 时只能只读且禁止新 Execution；不可验证时 quarantine。
16. Task 的 controller authority version 必须与赋值时一致；Principal/Membership/Delegation 任一 version 变化都必须使旧 controller 失效，不能因 re-add/enable 恢复。`controllerDelegationId=null` 当且仅当 `controllerDelegationVersion=null`；版本字段不得缺失或由客户端提供。
17. 多个撤权来源并发时取并集；任一 fence/source 仍失效则 effective control/ACL 仍拒绝。Reconcile 完成一个来源不能清除另一个来源的拒绝。
18. Reconcile 只能写 frozen/revoked 物化值，不能写 active、不能恢复旧 controller、不能取消 Execution、不能释放 Lease。
19. `RequestRecord` 的 Replay 与结果读取分离；Replay 不因旧 revision 失败，但必须按当前授权拒绝；结果读取只按当前资源可见性。

---

## 13. 待确认的 Contracts 决策

以下不阻塞本设计，但必须在 Contracts v3 冻结前确认：

1. **`dispatching`/`cancelling` 是否持久化**：本文建议不持久化，作为 AD-07 状态 + submission/cancel 的 API 投影；若要求持久化，需新增 AD。
2. **`awaiting_input`**：本文明确不进入 v3；Phase 2.3 InputRequest。
3. **`Task.title`/`description`**：本文保留 `objective` 为权威，title/description 为可选展示；若产品要求结构化标题，需另行冻结。
4. **`Task.result` 兼容投影**：是否保留在 v3 API；本文保留兼容投影，但 Store 不以它作为权威。
5. **Artifact 物理 purge**：v3 不开放普通 API；保留离线流程，需确认保留期。
6. **Workspace status `quarantined`**：本文使用 `status=active|archived|deleted` + `quarantineState`；如果 Contracts 要求单枚举，需要新增投影而非改 Store。
7. **Task `cancelTask` 与 running Execution 并存**：本文允许 `goalStatus=cancelled` 与清理中的 Execution 并存；若要求取消必须等全部终态，需要改 API 语义。
8. **跨 Workspace Artifact 分享**：v3 不开放；未来单独 AD。
9. **AD-06-R1/AD-12-R1（已冻结）**：用户已选择 Authority Version + Revocation Fence + Effective 派生（OD-11 方案 A）。撤权 commit 原子提交权威状态/version/fence/authRev；`Task.controlState`/`ArtifactGrant.revokedAt` 是可异步物化的派生 cache，不能反过来成为授权事实。冻结的 snapshot controller Grant 由 Fence 立即 effective 无效；显式 transfer 仍同事务。详见 `docs/phase-2.1A.5-authority-fence-decision-closure.md`。

---

## 14. 结论

Contracts v3 的稳定核心是：

- Principal/Workspace/Membership/Delegation 的可审计身份与授权；
- 三种撤权来源（Principal/Membership/Delegation）统一的 authority version 绑定与 fence/reconcile 语义；
- Task 目标状态与 Execution 执行状态的严格分离；
- 多 Execution 数据模型与 Workspace 写租约的分离；
- Artifact 创建时 ACL 与独立 Grant/Reference；
- 所有终态和 unknown 证据保留 Phase 1.1 的可靠性边界。

本文件只冻结数据模型和状态语义，不实现 Store/API/迁移。Store v3、API v3、ACP Adapter 边界和 v2→v3 迁移见 `docs/phase-2.1A.2-store-api-v3-design.md`。撤权模型、OD-11 方案 A 与 AD-06-R1/AD-12-R1 见 `docs/phase-2.1A.4-revocation-model-closure.md` 和 `docs/phase-2.1A.5-authority-fence-decision-closure.md`；sourceKey/ID/Workspace/version 匹配见 `docs/phase-2.1A.8-authority-fence-source-identity-audit.md`。
