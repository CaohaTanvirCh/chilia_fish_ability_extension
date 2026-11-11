# Phase 2.1A.3 Implementation Readiness：设计收敛与实现准入

状态：**CONDITIONAL DESIGN FREEZE / IMPLEMENTATION NOT READY / TWO USER DECISIONS OPEN**

日期：2026-11-11（Asia/Shanghai）

> Phase 2.1A.4 更新：新增统一撤权模型、controller authority version、Replay/结果可查询性分离、OD-09 来源核对、OD-11。本文保留 A3 结构，逐项状态以 A4 复核为准。

依据：

- `docs/phase-2.1A.2-contracts-v3-design.md`
- `docs/phase-2.1A.2-store-api-v3-design.md`
- `docs/phase-2.1A.2-design-review.md`
- `docs/phase-2.1A.3-implementation-readiness.md`
- `docs/phase-2.1A.4-revocation-model-closure.md`
- AD-01 至 AD-14、IW-01 至 IW-11
- 当前 Phase 1.1 代码与 Store v2 实际实现

范围：docs-only；不实现 Contracts、Store、API、Migration、Native Helper、Reconcile Worker 或 ACP Adapter。

---

## 0. 结论

### 0.1 v3 设计是否已经冻结？

**设计语义已冻结到“可实现规划”级别，但不是“实现已通过”级别。**

可以冻结：

- Principal/Workspace/Membership/Delegation 的实体和授权交集；
- Principal/Membership/Delegation 三种撤权的 authority version + unified fence 语义；
- Task goalStatus/lifecycle/controlState 与 Execution 状态的分离；
- Artifact 创建时 ACL 快照与独立 Grant/Reference；
- Store 单所有者、`commitAuthorized`、Replay 顺序、Event 全局 sequence；
- 撤权后用 effective control 立即拒绝，reconcile 只物化派生投影；
- v2→v3 不猜测 owner/workspace/Artifact/Delegation 的迁移边界；
- Windows root 的 cooperative 边界和 quarantine 行为。

不能冻结为“已经可以开始实现”：

- 当前 v2 没有承载结构；
- native path guard/OS sandbox 不存在；
- Store 容量/写放大未测；
- fence/reconcile 的 worker 未实现；
- OD-09 的 baseline 归档方式未确定；
- OD-11（AD-06/AD-12 逻辑撤权解释）未确定；
- Phase 2.1B 实现尚未获准。

### 0.2 是否实现就绪？

**NO。**

准入条件：

1. P0-01：v3 Store/API/Contracts 实现必须在新文件/新入口上开始，不能改 v2 语义。
2. P0-02：Workspace 文件边界仍是 cooperative；若产品要求真实隔离，native helper/OS sandbox 是实现前置。
3. P1：Replay/Store 容量/迁移/路径/ACP/Artifact/到期物化必须按 5.x 的测试验收。
4. OD-09：用户提供或确认 baseline 归档方式。
5. OD-11：用户确认 AD-06/AD-12 的逻辑撤权解释，或改为同事务物化。
6. OD-10：Phase 2.1B 实现必须单独启动。

---

## 1. 本轮收敛的 P1 与撤权缺口

> 任务书中的 P1-01/P1-02 在本仓库历史 Review 中已分别占用“批量撤权/Store 容量”编号。为避免重号，本文使用：
>
> - **A3-P1-01 Idempotency Replay**
> - **A3-P1-02 Revocation Fence / Reconcile**
> - **A4-P1-01 直接 User Controller 撤权缺口**

### 1.1 A3-P1-01：Replay 顺序（DECIDED）

Store 的顺序固定为：

```text
lock
 -> load current Principal/Workspace/Membership/Delegation/ACL
 -> recompute effective authorization
 -> resolve requestKey scope
 -> lookup RequestRecord
 -> if exists:
      inputHash same? -> current auth -> return resultSnapshot (replayed=true)
      inputHash diff? -> IDEMPOTENCY_CONFLICT
      auth invalid?   -> AUTHORIZATION_REVOKED
 -> if not exists:
      check expectedRevision
      check expectedAuthorizationRevision
      check state preconditions/leases
      build changes + RequestRecord(resultSnapshot) + events
      persist atomically
unlock
```

不变量：

- Replay 必须重新授权；不能返回已撤销主体的旧结果。
- Replay 不被无关 revision 变化阻塞。
- Replay 不重新执行；不再次调用 ACP prompt/cancel。
- 相同 scope + 相同 inputHash 不重复创建对象。
- 相同 scope + 不同 inputHash 返回冲突。
- scope 包含 actor/delegation/operation/workspace/clientKey。
- 没有 RequestRecord 时才检查 expected revision。
- `resultSnapshot` 是有界原始结果（建议 ≤64 KiB）；缺失/损坏 -> `IDEMPOTENCY_CORRUPT`，禁止重执行。

### 1.2 A3-P1-02 / A4-P1-01：Revocation Fence / Reconcile（DECIDED，设计层）

撤权 commit（三种来源统一）：

```text
Principal/Membership/Delegation 状态 + version
+ AuthorityRevocationFence(sourceKind, sourceKey, sourceVersion, scope)
+ authorizationRevision++
+ audit events
```

- Fence 是持久失效事实和 reconcile 游标；授权判断同时看源 status/version 与匹配 fence。
- `Task.controlState` / `ArtifactGrant.revokedAt` 是 materialized cache。
- controller 在赋值时绑定 Principal/Membership/Delegation authority version；任一 version 变化，旧 controller 立即 frozen，不依赖 Task 枚举。
- effective control/grant：
  - controller 的 Principal/Membership version 不匹配 -> frozen；
  - `Task.controllerDelegationId` 指向 revoked/expired/fenced delegation -> frozen；
  - `ArtifactGrant` grantee/version 或 `sourceDelegationId`/version 失效 -> 无效；
  - stored `active`/`revokedAt=null` 不能覆盖 version/fence。
- Reconcile 只物化已生效的拒绝，不是撤权生效点；绝不写 `controlState=active`。
- `AUTHORIZATION_RECONCILING` 只表示物化未完成，不允许旧权限继续。
- running Execution 继续；不伪造 cancelled；不释放 Lease；不自动创建新 Execution。
- 启动扫描 pending/reconciling/failed fence；分批、幂等、可重试。
- Controller transfer 与 fence 竞态：条件更新，新 controller 不被旧 fence 覆盖。
- 多来源撤权：取并集，一个 fence 完成不清除另一个；不自动 unfreeze。
- `enablePrincipal` 必须等待 principal fence 完成，避免 Delegation 复活。

详细见 `docs/phase-2.1A.4-revocation-model-closure.md`。

### 1.3 A4-P1-01：直接 User Controller 缺口（DECIDED，设计层）

Phase 2.1A.3 只检查 controller delegation/principal，导致：

```text
User U 直接控制 Task T
-> U 被移出 Workspace
-> effectivePermission(U, task:control) = false
-> effectiveControlState(T) 仍 = active  // 缺陷
```

修正：

- Task 增加 `controllerPrincipalVersion` / `controllerMembershipVersion` / `controllerDelegationVersion`。
- `effectiveControlState` 必须检查 controller 的 Principal/Membership 当前有效且 version 完全匹配；Membership 撤销后旧 controller 立即 frozen。
- 委托 controller 还要求 Delegation 的 grantor/delegate authority version 匹配。
- Membership 失效但 Delegation 记录仍 active、Delegation 失效但 Membership 仍 active、Principal 禁用但未物化，均由 version/status/fence 取并集拒绝。
- 旧 controller 不能因 re-add/enable/旧快照恢复；只能显式 `transferController`。
- 该结论已写入 Contracts 6.1、Store 2.5、Review 9.5。

---

## 2. Replay 场景验收

| # | 场景 | 期望 |
|---:|---|---|
| 1 | 原操作提交，响应丢失，客户端旧 revision 重试 | 返回 resultSnapshot；`replayed=true`；不因 revision 失败 |
| 2 | 原操作后无关 Task 修改 | 同上；不受 Store revision 变化影响 |
| 3 | 原操作后 Membership revoked/disabled | `AUTHORIZATION_REVOKED`；不返回旧结果 |
| 4 | 原操作后 Delegation revoked/expired | `AUTHORIZATION_REVOKED` |
| 5 | 原操作后 Artifact ACL 修改 | 当前 ACL 不允许则拒绝；不能靠 requestKey 绕过 |
| 6 | 同 clientKey 不同 operation | scope 不同；不跨 operation replay |
| 7 | 两个并发同 scope | 单 Store 串行；一个执行，一个 replay |
| 8 | dispatch_intent 已提交后 Hub 崩溃 | replay 只返回原接受结果；不再 prompt；远端执行仍 unknown |
| 9 | Principal disabled/deleted 后 Replay | `AUTHORIZATION_REVOKED`；不返回旧结果 |
| 10 | 撤权后仍有当前 Task 读取权限 | 通过 `getTask`/`getExecutionResult` 读取已提交事实；不通过 Replay |
| 11 | 撤权后已失去读取权限 | `*_NOT_VISIBLE`/`*_NOT_FOUND`；不能靠 requestKey 读取 resultSnapshot |
| 12 | Membership re-add 后 Replay 旧请求 | 当前授权按新 membership；旧 controller Task 仍 frozen；旧 resultSnapshot 不返回 |

附加：

- Replay 的当前授权使用原 operation 权限 + `resultRef` 资源可见性；不能只检查 Workspace 成员资格。
- `resultSnapshot` 超限时原始请求失败，不能写无法 replay 的记录。
- Replay 不产生 Event；原 Event 已随首次 commit 持久化。
- Replay 不改变 `createdAt`，不更新 resultSnapshot。
- Replay 是写幂等路径，不是读取授权；结果可查询性见 `docs/phase-2.1A.4-revocation-model-closure.md` 4.3。

---

## 3. Revocation Reconcile 验收

| # | 场景 | 期望 |
|---:|---|---|
| 1 | Fence 已提交、reconcile 未开始 | 新命令/读取立即拒绝；TaskView effective frozen；ArtifactGrant effective invalid |
| 2 | Reconcile 部分完成 | 未物化对象仍由 fence 拒绝；不能放行旧权限 |
| 3 | Reconcile 中 Hub 重启 | 启动扫描；从 processed ids 继续；重复批次幂等 |
| 4 | 完成记录持久化失败 | fence 保持 pending；重试；即时拒绝不变 |
| 5 | 同一 Delegation 重复撤销 | 返回已有 fence；不产生第二套状态 |
| 6 | Reconcile 中 Controller 转移 | 条件更新；已转移 Task 保留新 controller |
| 7 | Reconcile 中 Principal disable | 新 fence 叠加；不自动 unfreeze |
| 8 | ArtifactGrant 显式 grant | 不被 controller snapshot 撤权误删；只撤 sourceDelegationId 匹配项 |
| 9 | User 直接 controller 被移出 Workspace | Membership fence 提交即 effective frozen；即使 Task 未物化 |
| 10 | Membership 已撤销、Delegation 记录仍 active | 委托 controller 也 frozen；grantor/delegate version 不匹配 |
| 11 | Principal 禁用、Membership/Delegation 未物化 | principal status/version + fence 立即拒绝；enable 等待 fence |
| 12 | Membership + Delegation 同时撤销 | 取并集；一个 fence 完成不清除另一个 |
| 13 | Reconcile 完成后旧 controller 尝试恢复 | 无自动 unfreeze；旧 controller 仍 frozen；只能 transfer |
| 14 | Principal enable 时 fence 未完成 | `AUTHORIZATION_RECONCILING`；不恢复 Delegation/旧 controller |

完成判定：

- fence scope 内没有剩余匹配的 controller Task/Grant；
- `status=completed`、`completedAt`、`authorization.reconciled` Event 同 commit；
- 完成不改变 effective 判定，也不写 active。

---

## 4. OD-01 至 OD-11 状态

| ID | 状态 | 结论 |
|---|---|---|
| OD-01 `dispatching/cancelling` | **DECIDED** | 只做 API 投影；Store 持久化仍为 AD-07 七状态 + submission + cancel 字段；`succeeded=completed` 别名。 |
| OD-02 cancelled + running cleanup | **DECIDED** | `cancelTask` 立即写目标取消和全部 cancel requests；Execution 保留真实状态；禁止新 Execution；不伪造 terminal。 |
| OD-03 `awaiting_input` | **DEFERRED** | 留到 Phase 2.3；v3 Execution 保持 `running`；不假设 ACP 交互输入。 |
| OD-04 Artifact 物理删除 | **DECIDED** | v3 只 soft-delete；物理 purge 仅离线/内部，retention/no-ref/no-grant；不开放普通 API。 |
| OD-05 批量撤权 | **DECIDED** | 统一 `AuthorityRevocationFence` + authority version；三种来源即时失效；物化可滞后。 |
| OD-06 Store 容量/JSON | **DECIDED** | 继续 `state-v3.json`；初始目标 256 MiB/200k events/10k tasks/50k executions/20k artifacts（provisional）；实现前必须容量/写放大基准，超限拒绝。 |
| OD-07 Workspace status/quarantine | **DECIDED** | `status=active/archived/deleted` + `quarantineState=normal/quarantined`；API 派生 WorkspaceAccessState；不混成单一业务状态。 |
| OD-08 Artifact purge 保留期/审批 | **DEFERRED** | 具体 retention/approval 归 Phase 2.1B 存储设计；v3 只冻结不可通过普通 API 物理删除。 |
| OD-09 缺失 baseline 文档 | **NEEDS_USER_DECISION** | 仓库/Git 无可验证原文；用户补充的 Draft 文本/元数据可作历史输入；只能选择归档原文或确认不归档。详见 A4 第 5 节。 |
| OD-10 2.1B 设计边界 | **DECIDED** | 本文件中的 Task/Artifact v3 只是设计输入；Phase 2.1B 实现必须单独批准。 |
| OD-11 AD-06/AD-12 逻辑撤权解释 | **NEEDS_USER_DECISION** | 本设计用 authority version + effective 派生实现撤权即时拒绝，`controlState`/`revokedAt` 可滞后；AD-12 字面要求同 commit 写所有受影响字段。需选择 A/B/C。 |

### 4.1 需要用户决定

**OD-09：**

- 方案 A：提供/恢复 `phase-2.0-architecture-baseline.md` 原文，并以其为审计基线；
- 方案 B：明确以已冻结的 2.0.1/2.0.2/2.0.3 与 baseline review 作为唯一基线，不追溯缺失原文；
- 推荐：方案 A（可追溯性最好）；若无法提供，选 B 并记录来源缺口。

**OD-11：**

- 方案 A（推荐）：批准 authority version + effective 派生 + `AuthorityRevocationFence`；撤权 commit 原子写源状态/version/fence，授权立即拒绝；`Task.controlState`/`ArtifactGrant.revokedAt` 是 cache。
- 方案 B：严格按 AD-12/AD-06 字面，同一 commit 枚举所有受影响 Task/Grant 并写 frozen/revoked；接受 O(N) 写放大/容量上限。
- 方案 C：混合同步前 N 个 + fence 异步；仍有物理滞后，不推荐作为冻结方案。
- 在 OD-11 确认前，Store 撤权实现和 Artifact controller grant 同事务同步保持 `BLOCKED`。

---

## 5. v3 实现准入标准

### 5.1 Contracts

- Principal/Workspace/Membership/Delegation 类型、字段、唯一性完整。
- Task/Execution/Artifact 状态机完整，状态与 Event 对应。
- `controlState` 区分 stored/effective；controller Principal/Membership/Delegation authority version 字段完整；`ArtifactGrant` grantee/source delegation version 完整。
- 三种撤权来源统一到 `AuthorityRevocationFence`，`scope.kind=global/workspace` 明确。
- 所有引用关系/Workspace 归属/角色约束明确。
- 授权交集和 read filter 有可执行规则。
- 错误码/枚举/version 字段冻结；OD-11 的字面语义需确认。

### 5.2 Store

- `commitAuthorized` 是唯一写入口；授权/状态/Event/Request 原子提交。
- Replay 顺序为“授权 -> request scope -> RequestRecord -> inputHash -> result”；重放不再执行。
- `resultSnapshot` 有界、不可变；损坏/缺失返回 `IDEMPOTENCY_CORRUPT`。
- 撤权 commit 原子写源状态/version + fence + authRev；不枚举 Task；effective 即时拒绝。
- `Task.controlState`/`ArtifactGrant.revokedAt` 只做物化；reconcile 绝不写 active。
- Reconcile 幂等、可重试、可 crash recovery；多 fence 取并集。
- `expectedRevision` 只用于新操作，不阻塞 replay。
- 并发请求由单 Store 串行化；不自动 merge。
- 持久化失败不产生部分提交。
- unknown Execution 不自动重试；Lease 不自动释放。
- OD-11 未定前，撤权 commit 的物理字段边界不能宣称完成。

### 5.3 API

- 每个 API 的调用者身份/权限/幂等/错误/Event/外部副作用明确。
- 客户端不能伪造 actor/requestedBy/delegation proof。
- Replay/Conflict/Unauthorized/Quarantined/Reconciling 错误语义明确。
- Replay 是写幂等路径，不是读取授权；撤权后结果查询按当前 Task/Execution/Artifact ACL。
- 读 Event 每次重新授权；cursor 不是凭证；Principal/Membership/Delegation 撤权后 cursor 失效。
- `dispatchExecution` 的外部 prompt 只在 commit 后发生；Replay 不再次发送。
- Local Bootstrap 无 `workspace:create`；Create Workspace 只走离线/未来管理上下文。

### 5.4 Migration

- v2 备份/锁/只读输入明确。
- 显式 workspace/owner/root；不猜 Owner/Workspace/历史 Execution。
- controller 必须写 owner 的当前 Principal/Membership authority version；缺版本 -> manual recovery，不能按 active 控制。
- 不伪造 Event/Artifact/Delegation。
- 无法映射 -> `MigrationRecord`/quarantine/manual recovery。
- 失败保持 v2 原文件，临时 v3 不发布；回滚可恢复。
- `rootStatus=unbound` 的 legacy Workspace 只读，禁止新 Execution。

### 5.5 Windows Workspace

- Root Handle 生命周期明确；运行期不可序列化。
- 重启后无法证明 Root Identity 连续 -> quarantine；不能仅凭持久化 fileId 宣称连续。
- 不依赖字符串前缀；reparse/no-follow 明确。
- TOCTOU/Handle-relative 约束明确。
- `workspaceBoundaryEnforcement=cooperative` 不得被宣传为 OS sandbox。

### 5.6 外部 ACP

- 不宣称 exactly-once。
- 无法确认发送结果 -> unknown。
- unknown 不自动重试。
- Cancel request 与 terminal confirmation 分离。
- late notification 不可关联时隔离。
- Adapter 不决定 Task goalStatus。

### 5.7 P0 / P1 / P2

| 级别 | 项 | 准入处理 |
|---|---|---|
| P0 | v2 不能承载 v3 | 必须新建 v3；禁止 v2 补丁 |
| P0 | Workspace 不是 OS 隔离 | 接受 cooperative 或先实现 native/OS sandbox |
| P1 | Replay 顺序/resultSnapshot | 已决定；实现测试 |
| P1 | Revocation fence/reconcile（三来源） | 模型已决定；OD-11 后实现测试/crash |
| P1 | Store 容量/JSON 写放大 | 容量基准后冻结 limits |
| P1 | 路径 native helper | 阻塞真实隔离 |
| P1 | 迁移 manual recovery | 迁移演练 |
| P1 | ACP unknown/无 replay | 接受限制并测试 |
| P1 | Artifact 物理存储/保留 | Phase 2.1B 存储设计 |
| P1 | Delegation/Principal 到期/撤权物化 | reconciler/启动扫描 |
| P2 | API 错误/分页/Event schema、title/description、容量参数、Message、跨 Workspace Artifact | 模块实现前解决，不阻塞设计冻结 |

### 5.8 A4 准入矩阵

| 领域 | 状态 | 阻塞/条件 |
|---|---|---|
| Contracts | CONDITIONAL | OD-11 字面语义 |
| Store 授权/原子性 | BLOCKED | OD-11；撤权 commit 物理字段 |
| Replay/查询 | READY | 实现测试 |
| 三来源撤权 | CONDITIONAL | OD-11；实现测试 |
| WorkspaceLease/FS | CONDITIONAL（OS 隔离 BLOCKED） | native helper/sandbox |
| Artifact ACL | CONDITIONAL | AD-06/OD-11 |
| Event 重新授权 | READY | 实现测试 |
| Migration | CONDITIONAL | manual recovery |
| ACP | CONDITIONAL | 接受限制并测试 |
| 并行 Execution | CONDITIONAL | mutex 可验证；worktree/copy 未证明 |


---

## 6. 实现阶段拆分

### Phase 0：Contracts 与纯状态机

- **前置依赖**：本文件 + Contracts v3 设计。
- **允许修改的模块**：`packages/contracts`（未来 v3 类型）、纯状态机/验证函数；不修改 v2 行为。
- **不变量**：ID/字段/枚举/状态转换；不引入第二套 Task/Execution 状态；controller authority version/grantee version 纯函数。
- **单元测试**：类型解析、非法转换、引用/唯一性、effective Membership/control、authority version mismatch。
- **故障注入**：无 Store；纯函数边界。
- **验收**：Contracts v3 类型/错误码/状态表通过独立评审；OD-11 已确认或明确 blocked。

### Phase 1：Store v3 核心

- **前置依赖**：Phase 0。
- **允许修改的模块**：新 `packages/task-store-v3`；不修改 v2。
- **不变量**：单所有者、原子快照、revision/sequence、事件同 commit、replay 顺序、capacity 拒绝；撤权 commit 的物理边界按 OD-11。
- **单元测试**：快照/commit、revision、replay、RequestRecord、事件 sequence、容量。
- **故障注入**：写临时文件失败、rename 失败、崩溃中断、锁竞争、损坏状态。
- **验收**：`commitAuthorized` 事务/恢复/Replay 测试全通过；OD-11 未定前撤权 commit 不实现。

### Phase 2：Identity / Workspace / Membership / Delegation

- **前置依赖**：Phase 1 + OD-11。
- **允许修改的模块**：v3 Store + 授权服务 + bootstrap/provisioning CLI（未来）；不修改 v2。
- **不变量**：Owner 唯一 User、effective Membership、无匿名、无 `workspace:create` Local、Delegation 交集；三来源撤权统一。
- **单元测试**：成员/角色/owner 转移、disable/enable、revoked 不复活、Delegation scope/过期、Membership/Delegation/Principal 并发撤权、bootstrap 失败关闭。
- **故障注入**：撤权 fence、重复撤销、Principal disable 竞态、enable 未完成、re-add、多 fence 取并集。
- **验收**：所有授权路径从 context 到 Store commit；无 payload 身份；旧 controller 不复活。

### Phase 3：Task / Execution

- **前置依赖**：Phase 2。
- **允许修改的模块**：v3 Store 操作、Executor/Adapter 上层、API 服务；不修改 v2。
- **不变量**：goalStatus/lifecycle/controlState；controller authority version；多 Execution；selected/latest；dispatch/terminal/cancel/unknown。
- **单元测试**：Task 状态表、Execution 状态机、cancel request/confirmation、AD-14 聚合、acknowledgment、撤权后 running Execution 证据落盘。
- **故障注入**：dispatch 后崩溃、prompt 后断连、cancel 未确认、late notification、lease freeze。
- **验收**：无自动完成/重试/伪造 cancel；selected 必须显式。

### Phase 4：Artifact / ACL

- **前置依赖**：Phase 3（Task/Execution）+ IW-09 接口。
- **允许修改的模块**：Artifact Store、storage guard、API；不修改 v2。
- **不变量**：创建时快照、独立 Grant/Reference、grantee/source delegation authority version、Task 删除不删 Artifact、controller 同步。
- **单元测试**：private/workspace、grant/revoke、reference、soft delete、purge 条件、grantee 撤权/重加。
- **故障注入**：ACL 写入失败、Grant 与 Task 变更竞态、staging 失败。
- **验收**：Artifact ACL 独立；无路径泄漏；无悬空引用删除；AD-06 同事务边界按 OD-11。

### Phase 5：Event / API

- **前置依赖**：Phase 1/2/3/4。
- **允许修改的模块**：API 服务/传输；不修改 v2 客户端契约。
- **不变量**：scope/audience/sequence/cursor 重新授权；typed commands；外部副作用边界。
- **单元测试**：读过滤、cursor 失效、错误码、subscription、Local Bootstrap allowlist。
- **故障注入**：撤权后 cursor、事件读取失败、API 超时/重复请求。
- **验收**：每个 API 输入/输出/授权/幂等/错误/Event 明确。

### Phase 6：v2 → v3 Migration

- **前置依赖**：Phase 1/2/3/4。
- **允许修改的模块**：迁移脚本/临时 Store；不修改 v2 文件。
- **不变量**：显式 workspace/owner/root；不猜 owner/workspace/Delegation/Artifact；unknown 保留；备份/回滚。
- **单元测试**：每种 v2 状态、Binding 无 executionId、terminal+active binding、Request legacy scope。
- **故障注入**：迁移中断、容量不足、发布失败、回滚。
- **验收**：v2 原文不动；v3 不发布半迁移；manual recovery 报告完整。

### Phase 7：Windows Workspace Path Guard

- **前置依赖**：Phase 2（Workspace）+ Phase 4（Artifact）。
- **允许修改的模块**：`packages/windows-paths` 或新的 native helper；不修改 v2 执行路径。
- **不变量**：rootIdentity/handle/no-follow/quarantine；cooperative 声明；不退回绝对路径。
- **单元测试**：路径语法、UNC/device、reparse、case、fileId、重叠。
- **故障注入**：junction 替换、fileId 复用、root 重启/变更、打开失败。
- **验收**：native helper 能力探测；无 OS sandbox 时明确 cooperative，不宣称隔离。

### Phase 8：ACP Adapter

- **前置依赖**：Phase 3/5。
- **允许修改的模块**：`packages/dsh-acp-v3`/Adapter；不修改 v2 Transport。
- **不变量**：session/new/resume/prompt/cancel/close 映射；无 replay/turnId/exactly-once；cancel 不等于确认；late notification 隔离。
- **单元测试**：能力探测、dispatch 顺序、cancel、close、notification 归属。
- **故障注入**：进程崩溃、连接断、prompt 后无响应、cancel 未确认、late notification。
- **验收**：Execution 终态有证据；unknown 不重发；Task 完成不由 Adapter 决定。

### Phase 9：集成与恢复

- **前置依赖**：Phase 1-8。
- **允许修改的模块**：集成测试/只读工具；不改生产契约。
- **不变量**：所有 AD/IW/Phase 1.1 约束；无部分提交/自动重试。
- **单元测试**：全套。
- **故障注入**：Store 崩溃、Hub 重启、dispatch/cancel 竞态、撤权/reconcile 中断、migration 回滚。
- **验收**：端到端/恢复/迁移测试通过；不是“模拟通过”冒充真实 DSH。

### 6.1 串行/并行

必须串行：

- Phase 0 → 1 → 2；
- Phase 3 依赖 2；
- Store 单一写入边界不能被并行实现破坏。

可并行：

- Phase 4 与 Phase 5 的部分 API 设计可在 3 稳定后并行；
- Phase 7（path guard）可与 Phase 3/4 的存储无冲突部分并行；
- Phase 8 Adapter 可在 3/5 接口冻结后与 Phase 6 并行；
- Phase 9 必须最后。

### 6.2 不允许的并行

- 不允许两个实现同时写 Store v3 权威文件；
- 不允许在 v2 上并行实现“v3 兼容字段”；
- 不允许在 Replay/fence 语义未冻结时并行实现 API；
- 不允许在 Contracts 未冻结时实现 Migration。

---

## 7. 已知限制（可接受但不隐藏）

1. ACP 不提供 exactly-once；dispatch 后断连仍可能 unknown。
2. 无 notification replay/turnId；late notification 只能隔离。
3. Windows root 当前 cooperative；无 native helper/OS sandbox 时不提供文件隔离。
4. v3 Store 仍是单机 JSON 快照；容量/写放大需实测。
5. Artifact 物理 purge 不在 v3 普通 API。
6. Message/ACK 不在 v3；Event 不是 Message。
7. Local Bootstrap 只能一个受限 Workspace，不能创建/切换。
8. Phase 2.1B 实现未启动。
9. 撤权后原请求者不保证永久可读 resultSnapshot；结果查询按当前读取 ACL，v3 不提供 RequestResult ACL。
10. AD-06/AD-12 的物理同事务字段要求与 authority version 派生存在解释差异；OD-11 未定前不能宣称字面闭合。

---

## 8. 最终建议

1. 将本文件作为后续实现阶段的入口文档；撤权细节以 `docs/phase-2.1A.4-revocation-model-closure.md` 为准。
2. 先完成 Contracts v3 + Store v3 的纯状态机/事务原型，不接真实 DSH。
3. 单独批准 Phase 2.1B，不在本阶段开始。
4. 在实现前确认 OD-09、OD-11；其余 OD 已按 4 节处理。
5. 不把 cooperative path guard、模拟 ACP、v2 兼容投影当作已完成的安全/一致性能力。
6. 不因 authority version 设计而宣称 AD-06/AD-12 已字面满足；OD-11 是明确门槛。

**结论：设计可冻结为实现输入；实现准入为 CONDITIONAL，尚未 ready；Store 撤权实现和 OS 隔离为 BLOCKED。**
