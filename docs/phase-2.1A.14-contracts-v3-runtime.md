# Phase 2.1A.14 Contracts v3 Runtime Implementation

状态：**IMPLEMENTATION / CONTRACTS FOUNDATION / V2 PRESERVED / HUB NOT WIRED**

- 基线 commit：`e6065fa75e6c452798a2eba5580787422fb1028c`
- 实现范围：Contracts v3 类型/运行时校验，以及 Store v3 的实体校验接入
- 未实现 `commitAuthorized`、认证、Bootstrap provisioning 或业务 CRUD
- 未接入 Hub、Executor、ACP Adapter

---

## 1. 新增与修改文件

新增：

```text
packages/contracts/v3.d.ts
packages/contracts/v3.mjs
test/contracts-v3.test.mjs
docs/phase-2.1A.14-contracts-v3-runtime.md
```

修改：

```text
packages/task-store-v3/index.mjs   // 接入 Contracts v3 validator
test/store-v3.test.mjs             // 使用合法 Workspace fixture；适配契约错误分类
package.json                       // test:unit 纳入 contracts-v3.test.mjs
```

未修改：

```text
packages/contracts/v2.d.ts
packages/task-store-v2/
apps/companion-hub/
packages/dsh-acp-v2/
v2 数据文件或 v2 锁
```

---

## 2. Contracts v3 导出 API

`packages/contracts/v3.mjs` 导出：

```text
V3_SCHEMA_VERSION
CONTRACT_ERROR_CODES
ContractsV3Error
```

实体校验：

```text
assertPrincipal
assertWorkspace
assertWorkspaceMember
assertMembershipRevision
assertMembershipInvite
assertDelegationGrant
assertAuthorityRevocationFence
assertFenceUsable
assertBootstrapState
assertAuthorizationContext
assertDomainEvent
assertRequestRecord
```

一致性/辅助：

```text
canonicalSourceKey
parseCanonicalSourceKey
computeRequestScopeHash
effectiveMembershipStatus
validateStoreV3IdentityState
```

`packages/contracts/v3.d.ts` 提供对应 TypeScript 类型，不使用宽泛的 `Record<string, unknown>` 作为实体类型。

错误分类使用稳定 `CONTRACT_*` 代码，例如：

```text
CONTRACT_REQUIRED_FIELD
CONTRACT_INVALID_FIELD
CONTRACT_INVALID_ENUM
CONTRACT_INVALID_ID
CONTRACT_INVALID_TIME
CONTRACT_INVALID_VERSION
CONTRACT_UNKNOWN_FIELD
CONTRACT_INVALID_COMBINATION
CONTRACT_DUPLICATE_KEY
CONTRACT_INVALID_REFERENCE
CONTRACT_INVALID_SOURCE_KEY
CONTRACT_FENCE_IDENTITY_MISMATCH
CONTRACT_FENCE_SOURCE_VERSION
CONTRACT_DELEGATION_SECONDARY
CONTRACT_SCOPE_INVALID
CONTRACT_STATE_INCONSISTENT
```

`ContractsV3Error` 同时携带 `code`、`path` 和 `details`。

---

## 3. 实体校验范围

### Principal

- `user | agent | system`；
- `active | disabled`；
- `deletedAt` 与 `status=disabled` 的组合；
- `disabledAt` 与 disabled 的组合；
- `version >= 1`；
- `createdAt <= updatedAt`；
- System Principal 必须使用 `system:` 前缀；
- 非 system Principal 禁止 `system:` 前缀；
- Agent 的 `agentProfile` 可空；存在时校验合法 `connectorKind`、registeredBy 与非重复 capabilities；
- User/System 禁止 `agentProfile`；
- `displayName` 只做展示，不参与授权。

### Workspace

- `active | archived | deleted`；
- `rootStatus=bound` 必须有 `rootRef` 与 `rootIdentity`；
- `rootStatus=unbound` 的 `rootRef/rootPath/rootIdentity` 必须为 null；
- `rootIdentity` 校验 volumeSerial/fileId/finalPath/observedAt；
- `quarantineState=normal` 不得携带 reason/time；
- `quarantineState=quarantined` 必须有 reason/time；
- `archivedAt/deletedAt/deletedFrom` 与 status 一致；
- `workspaceBoundaryEnforcement`、`isolationPolicy`、`governanceState` 枚举；
- `writeEpoch`/`policyVersion` 非负；
- Owner 必须是 User；
- Store 交叉校验要求恰好一个 owner Membership，且与 `Workspace.ownerPrincipalId` 一致；
- 正常 Workspace 的 owner Membership 必须 active，owner Principal 必须 active 且未删除；
- `governanceState=ownerless_locked` 允许 system recovery 的例外。

### WorkspaceMember / MembershipRevision / Invite

WorkspaceMember：

- `owner | admin | operator | viewer`；
- stored `active | revoked`；
- `effectiveStatus` **不是存储字段**，出现即 `CONTRACT_UNKNOWN_FIELD`；
- `version`、`lastMembershipRevisionId`、`grantedByPrincipalId`、时间与撤销字段组合；
- Store 交叉校验 owner/admin 必须是 User，Agent 只能 operator/viewer；
- `(workspaceId, principalId)` 复合唯一；
- MembershipRevision 最新版本必须匹配 Membership 当前 role/status/version；
- `previousRevisionId` 必须属于同一 Membership 且版本更低。

MembershipInvite：

- role 只能是 admin/operator/viewer；
- status pending/accepted/revoked/expired；
- `expiresAt >= createdAt`；
- accepted/revoked 状态的时间组合；
- Store 交叉校验 workspace、target、creator；creator 必须是 User；admin invite 的 target 必须是 User；
- System Principal 不能被邀请。

`effectiveMembershipStatus` 按冻结公式实现：

```text
stored revoked -> revoked
matching membership fence -> revoked
principal deleted -> revoked
matching principal fence -> revoked
principal disabled -> suspended
workspace deleted -> suspended
workspace archived -> active
workspace quarantined -> active
workspace ownerless -> active
else active
```

Principal 恢复 active 不会复活 stored revoked 的 Membership；显式 revoked 始终优先。

### DelegationGrant

- grantor 必须是 User，delegate 必须是 Agent（Store 交叉）；
- 两端 Membership 必须存在；
- `grantorPrincipalVersion`/`grantorMembershipVersion`/`delegatePrincipalVersion`/`delegateMembershipVersion` 都必须存在；
- 两端版本不得来自未来（不得大于当前记录版本）；
- `parentDelegationId` 必须为 null，拒绝二次委托；
- scopes 只能来自冻结集合；
- `resourceScope=workspace` 不允许显式 ID；
- `resourceScope=tasks` 必须只有非空 taskIds；
- `resourceScope=artifacts` 必须只有非空 artifactIds；
- `expiresAt >= createdAt`；
- active/revoked/expired 的撤销字段组合；
- 允许 active 但已过期的记录存在，实际过期由服务端时间和授权判定处理。

### AuthorityRevocationFence

- sourceKind：principal/membership/delegation；
- sourceKey 必须 canonical；
- sourceVersion 为正整数；
- scope global/workspace 与 workspaceId 组合；
- principalId/delegationId 与 sourceKind 对应；
- cause 必须与 sourceKind 匹配；
- status pending/reconciling/completed/failed/quarantined；
- completed 必须有 completedAt；其他状态 completedAt 必须 null；
- quarantined 必须有 quarantineReason；
- processedTaskIds/processedGrantIds 唯一；
- diagnostics 有界（最多 32 条，每条 ≤ 1 KiB）；
- `assertFenceUsable` 额外要求 source 存在，且 `sourceVersion < 当前 source.version`；
- Store 对非 quarantined Fence 强制 source identity/scope/version 匹配。

`quarantined` 的显式修复路径：

- 默认 `assertAuthorityRevocationFence` 仍拒绝身份不一致；
- 只有显式 `{allowQuarantinedMismatch:true}` 才允许保存已隔离的 Fence 记录；
- 该记录永远不是 usable Fence；
- 不能把它当 completed，也不能跳过目标。

### BootstrapState / AuthorizationContext

BootstrapState：

- 单一 bootstrap User；
- 单一 Workspace；
- owner 是 User，且与 Workspace owner 一致；
- Store 交叉要求 bootstrap Principal 为 active User、Workspace 为 active；
- 不包含匿名 fallback 或 `workspace:create`；
- 本轮只校验结构，不做 provisioning。

AuthorizationContext：

- 覆盖 connectionId、actor、workspace、requestedBy、delegation、authorizationRevision、principal/membership/delegation/workspacePolicy versions、可选 managementScope；
- 校验 User 自报 requestedBy、Agent delegation、System 非委托、global context 的 membership 组合；
- **结构合法不等于可信**。可信生成、当前授权和最终提交检查仍属于后续 Store `commitAuthorized`。

### DomainEvent / RequestRecord

DomainEvent：

- workspace/system scope 与 workspaceId 组合；
- sequence/revision 为正；
- actor/source/audience；
- task/execution/artifact 可空 ID；
- data 为 JSON，单事件 ≤ 4 KiB；
- Store 交叉校验 workspace/actor/task/execution/artifact 引用存在。

RequestRecord：

- scopeHash、inputHash 为小写 SHA-256；
- scopeHash 必须由 workspaceId + actorPrincipalId + delegationId + operation + clientRequestKey 计算一致；
- resultRef 只允许 taskId/executionId/artifactId；
- resultSnapshot ≤ 64 KiB，resultBytes 必须与序列化字节数一致；
- authorizationRevision 非负；
- status=committed；
- Store 交叉校验 workspace/actor/delegation/resultRef/authorizationRevision。

---

## 4. Store v3 校验接入位置

`packages/task-store-v3/index.mjs`：

- 导入 `validateStoreV3IdentityState`；
- `#validate` 保留原有：
  - 顶层 version/revision/sequence/authorizationRevision；
  - 集合数组检查；
  - ID/基础结构；
  - 原子事件序列；
- 新增 Contracts v3 校验，覆盖：
  - Principal
  - Workspace
  - WorkspaceMember
  - MembershipRevision
  - MembershipInvite
  - DelegationGrant
  - AuthorityRevocationFence
  - BootstrapState
  - DomainEvent
  - RequestRecord
  - 相应跨实体引用。

错误处理：

- 新事务提交结构非法实体 -> 保留具体 `CONTRACT_*` 错误；
- 加载磁盘快照结构非法 -> 包装为 `STORE_CORRUPT`，并保留 `contractCode`/`contractPath`；
- 既有 `STORE_CORRUPT`、`STORE_VERSION_UNSUPPORTED`、`REVISION_CONFLICT`、`CAPACITY` 行为不变；
- 数据格式版本仍为 `3`，没有静默升级；
- Store v3 仍独立于 v2，不读取/改写 v2 文件。

Task/Execution/Artifact 详细字段仍未定义；Store 对这些集合保留原基础 ID/boundary 校验，不伪造完整 Schema。DomainEvent/RequestRecord 对它们的引用做存在性校验，但不对 Task/Execution/Artifact 做业务字段推断。

---

## 5. 内部事务入口边界

保留 `STORE_V3_INTERNAL_COMMIT` Symbol：

- 不加入 Hub command table；
- 不加入 Executor API；
- 不提供通用 `commit(changes)`；
- 不是 `commitAuthorized`；
- 测试通过 Symbol 使用同一 Store；
- 未来 `commitAuthorized` 可在 Store 内部复用该事务原语；
- 仍受完整 Store validator、revision、sequence 与持久化边界约束。

当前没有引入脆弱的运行时访问控制；边界由模块职责和未接入运行路径保证，并在文档中明确。

---

## 6. 测试结果

新增 `test/contracts-v3.test.mjs`：**24 个测试全部通过**。

覆盖：

- Principal 三种类型、status/type/version/agentProfile/system prefix；
- Workspace root/lifecycle/quarantine；
- Owner 必须 User、Owner Membership 唯一；
- Membership stored/effective 分离；
- Principal disabled/deleted 与 revoked 不复活；
- Membership 复合唯一键、Role 约束；
- MembershipRevision 版本绑定；
- MembershipInvite；
- Delegation User→Agent、两端 membership version、scope/resourceScope、过期/revoked、二次委托；
- Fence 三种 source、canonical sourceKey、identity/scope/sourceVersion；
- Fence quarantine 只能通过显式修复路径保存；
- AuthorizationContext；
- DomainEvent 4 KiB；
- RequestRecord scopeHash/resultBytes；
- BootstrapState；
- Store 合法实体提交/重启；
- Store 非法实体提交拒绝；
- 非法磁盘快照 `STORE_CORRUPT` + `contractCode`；
- 有效快照打开不被改写；
- 事件原子性/sequence 不退化。

原有 Store v3 测试：**26 个通过**。

回归：

```text
npm run test:unit      131 passed / 0 failed
npm run test:simulated  37 passed / 0 failed
npm test               168 passed / 0 failed
```

v2 原有 118 个测试全部通过，断言未修改。

---

## 7. 尚未实现 / 后续依赖

- `commitAuthorized` 与最终授权检查；
- 真实认证与可信连接；
- Bootstrap provisioning；
- Principal/Workspace/Membership/Delegation CRUD API；
- AuthorityRevocationFence Reconcile Worker；
- Task/Execution/Artifact 完整业务 Schema；
- Artifact ACL；
- WorkspaceWriteLease / fencing；
- v2→v3 Migration；
- Hub / Executor / ACP Adapter 接入；
- OS sandbox / native path guard。

**AuthorizationContext 结构校验不代表认证或授权已完成。**

**本轮不改变 OD-11、AD-06-R1、AD-12-R1、A7/A8/A9 已冻结语义。**
