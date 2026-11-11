# Phase 2.1A.2 Design Review：Contracts v3 / Store v3 / API v3

状态：**Conditional Design Pass / Open Decisions / Implementation Not Started**

日期：2026-11-11（Asia/Shanghai）

审查对象：

- `docs/phase-2.1A.2-contracts-v3-design.md`
- `docs/phase-2.1A.2-store-api-v3-design.md`

审查基线：

- Phase 2.0 冻结决策 AD-01 至 AD-14（`be36ba7`）
- Phase 2.1A / 2.1A.1 Identity & Workspace IW-01 至 IW-11（`10369df`）
- Phase 1.1 当前代码：`packages/contracts/v2.d.ts`、`packages/task-store-v2/index.mjs`、`packages/dsh-acp-v2/index.mjs`、`packages/acp-transport/index.mjs`、`packages/windows-paths/index.mjs`、`apps/companion-hub/main.mjs`

审查性质：只读设计审查 + 当前代码差距核对。没有实现、没有运行权限/路径测试、没有修改业务代码或配置。

---

## 0. 结论

**CONDITIONAL DESIGN PASS。**

Contracts v3、Store v3、API v3 的设计足以作为后续实现拆分输入，但**不能据此开始实现**，因为：

1. 当前 v2 Store/API 没有授权提交、Workspace/Principal/Artifact 和多 Execution 语义；
2. 设计中的多个关键能力（Windows handle-relative guard、ACP exactly-once、物理 Artifact 安全）尚未实现；
3. 仍有需要用户确认的 Open Decisions（见第 7 节）。

本轮未发现 AD-01 至 AD-14 或 IW-01 至 IW-11 的未解释语义冲突；发现的是实现门槛、容量/路径/迁移边界和状态投影选择。

### 0.1 问题分级

| 级别 | 数量 | 说明 |
|---|---:|---|
| P0 | 2 个实现门槛 | v2 无法承载 v3；Workspace 文件边界不是 OS 强制隔离 |
| P1 | 7 | 批量撤权容量、Store 容量、路径 native helper、迁移 manual recovery、ACP 不可恢复边界、Artifact 物理存储/保留、Delegation 到期物化 |
| P2 | 7 | API 错误/分页/命名、Event schema、Task title/description、cancel 投影、Store 容量参数、Message 延后、Artifact 跨 Workspace 接口 |

> P0 是“不能把它当成已实现能力”，不是本设计文档自身矛盾。

---

## 1. 现有代码与目标设计的差距

### 1.1 当前实际能力

| 领域 | 当前代码 | 目标 v3 | 结论 |
|---|---|---|---|
| Task 状态 | `TaskStatus = ExecutionStatus`；`Task.status` 是执行投影 | goalStatus + lifecycle + controlState | 需重构 |
| 多 Execution | Store 强制每 Task 最多一个 active；单 `activeExecutionId` | 多 Execution 数据模型；租约/隔离控制并发 | 需重构 |
| selected | 无 `selectedExecutionId`；`Task.result` 强制最新 Execution | selected/latest 分离 | 需新增 |
| 身份 | 无 Principal；stdio 无 actor | Principal/AuthorizationContext | 需新增 |
| Workspace | 无 Workspace；Task 有绝对 `cwd` | Workspace + rootIdentity | 需新增 |
| Membership/Delegation | 无 | stored/effective/revision/grant | 需新增 |
| 授权 | `commit(expectedRevision, changes)` 无 actor/auth | `commitAuthorized` | 需新增 |
| 读过滤 | `getTask/listTasks/...` 无过滤；`acknowledgedBy` 来自 payload | 统一 readAuthorized | 需新增 |
| requestKey | 全局 key；重放不重新授权 | AD-10 五元组；replay 重新授权 | 需迁移/重构 |
| Event | 全局 sequence；Task 事件；无 workspace scope | workspace/system scope + audience | 需新增 |
| Artifact | 无 Artifact 实体；`Task.result` 文本 | Artifact/Grant/Reference | 需新增 |
| 路径 | `normalizeWorkspace` 只做 `path.win32.normalize` | root identity + handle-relative + quarantine | 需新增 |
| Store | v2 `state-v2.json`，32 MiB 等限制 | `state-v3.json`，单所有者原子快照 | 需新增 |
| ACP | `dispatch_intent` 后 prompt；断连 unknown；无 replay/turnId | 保持，Adapter 映射执行 | 需 Adapter 重构 |

### 1.2 关键代码证据

- `packages/contracts/v2.d.ts`：
  - `TaskStatus = ExecutionStatus`；
  - Task `activeExecutionId` 单值；
  - 没有 Principal/Workspace/Artifact；
  - RequestRecord 的 key 是全局字段。
- `packages/task-store-v2/index.mjs`：
  - `COLLECTIONS` 只有 tasks/executions/bindings/requests；
  - 校验每 Task 一个 active Execution；
  - `Task.result` 必须等于 latest Execution result；
  - `commit(expectedRevision, changes)` 不接收授权上下文。
- `packages/dsh-acp-v2/index.mjs`：
  - `gate(taskId)` 串行化 Task；
  - `dispatch_intent` 在 `session/prompt` 前提交；
  - `cancel` 先写 request，再发送；
  - `getTask/listTasks/...` 无 access filter；
  - `acknowledgeIntegrityAlerts` 接受调用方 `acknowledgedBy`。
- `packages/windows-paths/index.mjs`：
  - 仅字符串 normalize；无 file ID、reparse 或 handle-relative。
- `apps/companion-hub/main.mjs`：
  - `ready.protocolVersion` 为 2；无连接身份。
- `docs/phase-2.0-architecture-baseline.md` **不存在**；本设计使用冻结的 2.0.1/2.0.2/2.0.3 和 baseline review，不使用不存在的原文。

### 1.3 结论

不能把 v2 的 `Task.status`、`activeExecutionId`、`Task.result` 当作 v3 的兼容实现；也不能在 v2 上增加可选 `principalId` 参数来“先跑起来”。v3 必须是新 Store 文件、新类型、新写入入口。

---

## 2. AD-01 至 AD-14 一致性核对

| AD | 设计要求 | 本设计落点 | 结论 |
|---|---|---|---|
| AD-01 | goalStatus/lifecycle/executionSummary 分离；多 Execution；selected | Contracts 6；Task 状态表；Execution 多记录 | 通过；`executionSummary` 不持久化为权威 |
| AD-02 | Principal/Workspace/Membership/Delegation；五个角色字段分离 | Contracts 3-5；API 6.2；AuthorizationContext | 通过 |
| AD-03 | private Task 可见性；Agent 同时受自身/用户/委托约束 | Contracts 6.5、10；API 读过滤 | 通过 |
| AD-04 | Artifact 独立授权；Task 可见性只给创建默认值 | Contracts 8；Store 3.4 | 通过 |
| AD-05 | Store v3/API v3；v2 只读迁移 | Store 1、11；迁移 8 | 通过 |
| AD-06 | Artifact ACL 创建时物化；controller 转移/冻结同步 | Contracts 8.2；Store createArtifact/transfer | 通过 |
| AD-07 | Task/Execution/Lifecycle 矩阵；awaiting_input 延后 | Contracts 6.3、7.3；`dispatching`/`cancelling` 仅投影 | 通过；Open Decision 3 |
| AD-08 | revoke/expiry/membership loss 冻结 controller；运行中继续 | Contracts 5.2；Store 2.5/3.3 | 通过；容量边界 P1 |
| AD-09 | Event workspace/system scope；cursor 重新授权 | Store 5 | 通过 |
| AD-10 | requestKey 五元组；replay 重新授权 | Store 4 | 通过 |
| AD-11 | 多 Execution 与 Workspace mutex 分层 | Contracts 9；Store 3.3 | 通过 |
| AD-12 | 授权检查与状态写入同一 commit | Store 2 | 通过 |
| AD-13 | Lease 释放需要进程终止/fencing；否则 quarantine | Contracts 9.2；Store 3.3/9 | 通过 |
| AD-14 | interrupted 与 unknown 都进入 awaiting_decision/风险确认 | Contracts 6.3、6.4；Store acknowledge | 通过 |

---

## 3. IW-01 至 IW-11 一致性核对

| IW | 核对点 | 本设计落点 | 结论 |
|---|---|---|---|
| IW-01 | Principal 主体分离 | Contracts 3 | 通过 |
| IW-02 | Workspace Owner 是 User；Agent 不能 Owner/Admin | Contracts 4/5；API 6.2 | 通过 |
| IW-03 | Membership 只给 Workspace 级能力 | Contracts 5/10 | 通过 |
| IW-04 | Delegation User→Agent；禁止二次委托 | Contracts 5.2 | 通过 |
| IW-05 | AuthorizationContext/atomic commit | Store 2 | 通过 |
| IW-06 | Artifact 创建时物化 ACL | Contracts 8.2 | 通过 |
| IW-07 | 本地 bootstrap 显式身份/无匿名 | Store/API；Contracts BootstrapState | 通过（设计层） |
| IW-08 | Task/Artifact 细节归后续 | 本设计只定义 v3 契约，不实现 | 通过 |
| IW-09 | root 字符串≠identity；reparse/TOCTOU/cooperative | Store 9；Contracts 4；`rootStatus=unbound` 迁移例外 | 通过（设计层）；native helper 未实现 |
| IW-10 | Local Bootstrap 无 `workspace:create` | Store 6.2；API 表 | 通过 |
| IW-11 | Membership stored/effective；显式 revoked 不复活 | Contracts 5.1；Store 2/3 | 通过 |

---

## 4. 状态机审查

### 4.1 Task

- `open` 只在无 Execution 时成立；首个 Execution 进入 queued 后 active。
- 最后一个 queued/running 离开后，无论 terminal/interrupted/unknown，都进入 `awaiting_decision`（AD-14）。
- `completed`/`failed`/`cancelled` 只能显式目标决定；`completed` 要求 selected completed、无 active、风险已记录。
- `cancelTask` 是目标级取消，同时写所有 active Execution 的 cancel request；Execution 终态仍按证据。
- `archiveTask`/`deleteTask` 只改 lifecycle，要求无 active；不删除 Artifact。
- `restoreTask` 不把终态 goalStatus 重新打开。

**审查结论：** 与 AD-01/AD-07/AD-14 一致。`cancelTask` 后 Task 可短暂保留清理中的 Execution，这是显式目标决定与执行清理并存；若产品要求“取消完成后才显示 cancelled”，属于 Open Decision 2。

### 4.2 Execution

- 持久化状态沿用 AD-07 七种；`dispatching`/`cancelling`/`succeeded` 只作为 API 投影。
- `running -> interrupted` 与 `interrupted -> unknown` 分离；没有 `interrupted -> completed`。
- `cancel.requestedAt`/`sentAt`/`confirmedAt` 分离；terminal cancelled 必须有证据。
- `dispatch_intent` 在 prompt 前提交；重启后 `running + dispatch_intent` 无终态 -> unknown。
- `commitExecutionResult` 不能写 terminal status；终态只走 `commitExecutionTerminal`。

**审查结论：** 保留 Phase 1.1 可靠性语义。`dispatching`/`cancelling` 的投影选择需要用户确认（Open Decision 1），但当前设计没有擅自新增持久化状态。

### 4.3 Artifact

- 创建时物化 owner/visibility/snapshot grants；后续 Task 角色不动态改 ACL。
- Controller 转移/冻结只同步 snapshot controller grant。
- 软删除不删文件；物理 purge 有 retention/no-reference 条件，v3 不开放普通 API。
- 多 Task 引用不因删除一个 Task 删除 Artifact。

**审查结论：** 与 AD-04/AD-06 一致。物理存储/保留策略仍是 P1/P2。

### 4.4 Task 取消与 Execution 取消

- `cancelExecution` 只请求一个 Execution，不改变 Task goalStatus。
- `cancelTask` 明确目标取消，写所有 active cancel requests；不伪造 Execution 终态。
- `cancelTask` 不阻止已运行 Execution 记录真实完成；Task 仍为 cancelled。
- `archiveTask`/`deleteTask` 要求无 active；清理中的 Execution 会阻止归档。

**审查结论：** 语义自洽；但“cancelled Task + active cleanup Execution”是否允许作为 API 可见状态，需 Open Decision 2 确认。

---

## 5. 授权、原子性与并发审查

### 5.1 commitAuthorized

- 授权上下文由连接身份/Store 版本生成，不接受客户端 actor/delegation proof。
- `commitAuthorized` 在同一临界区重新计算 effective Membership/Delegation/ACL，再构建 changes/events。
- 失败不产生部分写入；事件与状态同事务。
- `expectedAuthorizationRevision` 失败返回 `AUTHORIZATION_STALE`，不是已授权。

**结论：** 满足 AD-12，前提是实现不把 `context` 当作“已授权”凭证。

### 5.2 批量撤权

设计默认在同一 commit 冻结所有受影响 Task；如果集合超过容量，提出 `revocationFence + reconcile` 方案：

- `revoked` + authRevision 先原子生效；
- 所有授权检查先拒绝；
- 后续物化 Task frozen/ArtifactGrant；
- materialization 完成前返回 `AUTHORIZATION_RECONCILING`。

这与 AD-12 的“授权检查在 commit 内”一致，但和 AD-08 的“同一事务冻结 Task”存在实现/容量张力。**P1，需要用户确认是否接受 fence/reconcile，还是强制单事务容量上限。**

### 5.3 过期

- Store commit 按服务端时间判断 `expiresAt`；即使未物化也拒绝新命令。
- 读投影使用 effective frozen；reconciler 物化。
- 不在本轮实现定时器/扫描；实现阶段必须补。

### 5.4 并发写

- Store 单所有者 + `expectedRevision`；不自动 merge。
- 多 Execution 数据模型允许，但 mutex 下 lease 串行；worktree/copy 才能并行写。
- `commitDispatchIntent` 原子获取 lease；没有 lease 不发送 prompt。
- 旧 Executor 未停止：lease frozen/quarantine；不交新写执行。
- 并行结果不自动合并；selected 显式。

---

## 6. Event、迁移、ACP 与 Windows 路径审查

### 6.1 Event

- 全局 sequence；不引入每 Workspace sequence。
- workspace/system scope；audience；每次读取重新授权。
- cursor 不是凭证；成员失效返回 `AUTHORIZATION_REVOKED`，不返回空。
- Event 与状态同 commit；`appendEvent` 不是公共 API。
- `data` 有 4 KiB 上限；不含 result 正文/rootPath/token。

**结论：** 通过。`event type` 命名/版本仍是 P2 API 细节。

### 6.2 v2 → v3 迁移

- 显式 workspace/owner/root；不从 cwd/账户/显示名推断。
- Task status 映射：queued/running -> active；terminal/interrupted/unknown -> awaiting_decision。
- 不生成 Artifact/Delegation；不伪造 selected/owner/requestedBy。
- Binding 无 executionId -> legacy_unbound；不猜。
- Request key -> legacy scope；只允许迁移 principal 在显式窗口重放。
- Event 保留 ID/sequence；不重写。
- 失败/不可映射 -> manual recovery/quarantine；不静默丢弃。

**结论：** 符合 AD-05。需要实现阶段验证 v2 实际数据中的“terminal + unsettled binding”“unknown + active binding”等组合；P1。

### 6.3 ACP Adapter

能力矩阵明确：

- `session/new`、`resume`（条件）、`prompt`、`cancel`、`close`、notification 的 ACP 现状；
- 不假设 notification replay、历史加载、turnId、exactly-once、桌面 UI、完整交互输入；
- Adapter 只映射 Execution 生命周期，不决定 Task 完成。

**结论：** 没有过度假设；仍有 ACP 无法消除的 unknown/重复副作用边界，P1（接受为限制，不是可实现关闭项）。

### 6.4 Windows 路径

- `rootIdentity` 持久化 volume/fileId/finalPath；重启重新验证。
- RootHandle 运行期有效，不可序列化；每操作 handle-relative/no-follow。
- File ID 可复用；不能只凭持久化 ID 宣称连续。
- reparse 一律拒绝；TOCTOU 不能靠 `realpath`+prefix 解决。
- 当前 `workspaceBoundaryEnforcement=cooperative`；DSH 子进程无沙箱。
- 失败 -> quarantine；不退回绝对路径。

**结论：** 与 IW-09 一致；native helper/OS sandbox 未实现，P0/P1 边界。API 不返回 rootPath/rootIdentity。

---

## 7. Open Decisions

以下问题不能由本轮设计单方面决定；实现前必须确认：

| ID | 问题 | 当前建议 | 影响 |
|---|---|---|---|
| OD-01 | `dispatching`/`cancelling` 是否持久化 | 不持久化；保留 AD-07 七状态 + API 投影 | 若要求持久化，需新增 AD，Store/迁移/测试变更 |
| OD-02 | `cancelTask` 是否允许 `goalStatus=cancelled` 与清理中 Execution 并存 | 允许；不伪造 Execution 终态 | 若要求等全部终态才 cancelled，API 语义需改 |
| OD-03 | `awaiting_input` 是否进入 v3 | 不进入；Phase 2.3 InputRequest | 影响 Execution 状态机/ACP 能力 |
| OD-04 | `Task.result` 兼容投影是否保留 | 保留只读投影；权威仍是 selected Execution | 影响 v2 客户端兼容 |
| OD-05 | 批量撤权是否接受 fence/reconcile | 建议先确认容量上限；若接受 fence，需 AD 修订 | AD-08/AD-12 的“同一事务冻结”与容量冲突 |
| OD-06 | Store v3 是否继续 JSON 快照及容量参数 | 继续 `state-v3.json`；参数待容量测试 | 高容量/写放大风险 |
| OD-07 | Workspace 是否需要 `status=quarantined` 单枚举 | 保持 `status` + `quarantineState` 正交 | API/Contracts 类型选择 |
| OD-08 | Artifact 物理 purge 的保留期/审批 | v3 不开放普通 API；离线流程 | 合规/容量 |
| OD-09 | 缺失 `phase-2.0-architecture-baseline.md` | 使用冻结的 2.0.1/2.0.2/2.0.3；补源文档 | 审计可追溯性 |
| OD-10 | 本设计包含 Task/Artifact v3 详细模型，是否视为 Phase 2.1B 设计启动 | 仅设计输入；Phase 2.1B 实现仍需单独启动 | 阶段边界 |

---

## 8. P0 / P1 / P2

### 8.1 P0

#### P0-01 当前 v2 不能承载 v3

- 证据：无 Principal/Workspace/Artifact；单 active Execution；无 `commitAuthorized`；无读过滤；`TaskStatus=ExecutionStatus`。
- 结论：实现必须新建 Contracts v3/Store v3/API v3；不能在 v2 上打补丁。

#### P0-02 Workspace 文件边界不是 OS 隔离

- 证据：`windows-paths` 只有字符串 normalize；DSH 子进程同 OS 用户；无 native handle-relative/沙箱。
- 结论：`workspaceBoundaryEnforcement=cooperative`；如果产品要求真实文件隔离，必须先实现 native helper/OS sandbox，且不得在此之前宣称安全隔离。

### 8.2 P1

| ID | 问题 | 影响 | 下一步 |
|---|---|---|---|
| P1-01 | 批量撤权容量/fence | 可能违反 AD-08 同事务冻结或触发容量失败 | 确认 OD-05；容量测试/事务拆分策略 |
| P1-02 | Store v3 容量/JSON 写放大 | 32 MiB 不足；v3 集合/事件/历史增长 | 容量测试；冻结 limits/reserve |
| P1-03 | Windows native path guard | 无 handle-relative/no-follow；TOCTOU 未消除 | 设计/实现 native helper 或 OS sandbox |
| P1-04 | 迁移 manual recovery | v2 数据可能不可映射；不能猜 owner/workspace | 迁移报告/隔离流程/回滚演练 |
| P1-05 | ACP 不可恢复边界 | 无 replay/turnId/exactly-once；unknown 可能长期 | 明确降级/人工恢复；不承诺关闭 |
| P1-06 | Artifact 存储/物理保留 | storageRef/ACL 已设计，但无后端/安全删除 | Phase 2.1B 存储设计；purge 条件 |
| P1-07 | Delegation 到期物化 | 逻辑拒绝/持久化 frozen 之间需要 reconciler/启动扫描 | 实现 scheduler；测试“到期但未物化”写路径 |

### 8.3 P2

| ID | 问题 | 建议 |
|---|---|---|
| P2-01 | API 错误码/分页/命名未冻结 | Contracts v3 统一；不要每个 API 自造错误 |
| P2-02 | Event type/schemaVersion 细节 | 统一 event schema registry |
| P2-03 | `Task.title/description` 可选语义 | 确认产品需求；objective 为权威 |
| P2-04 | `dispatching/cancelling` 投影字段名 | 与 OD-01 一起冻结 |
| P2-05 | Store 容量参数 | 与 P1-02 一起冻结 |
| P2-06 | Message/ACK 延后 Phase 2.2 | 不把 Event 当 Message |
| P2-07 | 跨 Workspace Artifact 分享 | 未来独立 AD/接口，不在 v3 开放 |

---

## 9. 实现阶段依赖与建议顺序

本设计通过后，建议按以下顺序拆分实现；不开始 Phase 2.1B 实现，除非单独批准。

1. **Contracts v3 types/validation**：Principal、Workspace、Membership、Delegation、Task、Execution、Artifact、Event、RequestRecord。
2. **Store v3 skeleton**：state-v3 文件、锁、版本/sequence、原子 snapshot、迁移锁。
3. **Authorization/commit**：AuthorizationContext、`commitAuthorized`、readAuthorized、effective Membership/Delegation。
4. **Identity/Workspace bootstrap**：离线 provisioning、Local Bootstrap、成员/Delegation。
5. **Task/Execution**：goalStatus/lifecycle/controlState、多 Execution、dispatch/terminal/cancel、lease。
6. **Artifact**：ACL 快照、Grant/Reference、soft delete、storage guard。
7. **Event/API**：scope/audience/cursor、typed API/错误码。
8. **v2→v3 migration**：显式 workspace/owner/root、manual recovery、回滚。
9. **ACP Adapter**：capability probe、dispatch/cancel/close/reconcile；不假设 replay/turnId。

依赖：

- 2/3 先于 4/5/6；
- 5 的 lease 依赖 4 的 Workspace；
- 6 的 storage guard 依赖 IW-09；
- 7 依赖 2/3；
- 8 依赖 1/2/3；
- 9 依赖 5/7。

---

## 10. 最终判断

Contracts v3/Store v3/API v3 设计在以下意义上通过：

- 核心实体、字段、关系完整；
- Task goalStatus/lifecycle/controlState 与 Execution 状态分离；
- Artifact ACL 独立于 Task ACL；
- `commitAuthorized` 的授权/状态/事件原子边界明确；
- requestKey/Event cursor 语义明确；
- ACP 能力没有过度假设；
- v2→v3 没有伪造 owner/workspace/Artifact/Delegation；
- Windows 路径与 IW-09 一致，且明确 cooperative 边界。

但不能判定为“可实现完成”：

- 当前 v2 不能承载；
- P0/P1 尚未关闭；
- Open Decisions 未确认；
- 没有代码/测试/真实多用户/路径攻击证据；
- Phase 2.1B 实现仍未启动。

**建议：接受为 Contracts v3/Store v3/API v3 设计基线，进入实现拆分与 Open Decisions 确认；不开始实现，不进入 Phase 2.1B。**
