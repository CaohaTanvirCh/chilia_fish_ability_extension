# Phase 2.0.1 Architecture Decisions

状态：**Proposed Design Baseline / 设计冻结候选 + Phase 2.0.2/2.0.3 amendments**
日期：2026-11-10（Asia/Hong_Kong）
依据：`docs/phase-2.0-baseline-review.md`（审查提交 `f339873`）与 Phase 1.1 当前实现
范围：只做设计决策，不实现代码，不修改 Store、Executor、ACP Transport 或测试。

> **Phase 2.0.2 修订：** AD-06 至 AD-11 见 `docs/phase-2.0.2-architecture-decisions.md`。与本文件冲突时，以 2.0.2 为准；重点覆盖 Artifact ACL（AD-06）、完整状态矩阵（AD-07）、Delegation 撤销/Controller 冻结（AD-08）、Event 游标（AD-09）、requestKey 委托作用域（AD-10）、并行 Execution 与 Workspace mutex（AD-11）。
>
> **Phase 2.0.3 补充：** AD-12 至 AD-14 见 `docs/phase-2.0.3-implementation-constraints.md`，分别收紧授权原子性、WorkspaceLease 强制释放和 interrupted 聚合；与 2.0.2 冲突时以 2.0.3 为准。

本文件冻结五个跨阶段问题。这里的“冻结”指：后续实现不得在未新增 AD（Architecture Decision）的情况下改变这些语义；具体字段名仍可在 Contracts 评审时微调，但不得改变权限边界、状态含义或迁移方向。

## 0. 决策摘要

| ID | 决策 | 主要影响 |
|---|---|---|
| AD-01 | Task 目标状态、Execution 状态、Task 生命周期三者分离；并行 Execution 是能力，不是默认 | Store v3、Task 投影、SessionBinding、取消/关闭、Workspace 隔离 |
| AD-02 | Principal / Workspace / Membership / Delegation 为一级实体；owner、createdBy、requestedBy、controller 各自独立 | 身份、RBAC、Task 创建与审计 |
| AD-03 | private Task 使用显式可见性矩阵；Agent 访问必须同时满足自身权限、用户权限和委托范围 | 私有 Task、委托访问、所有读接口 |
| AD-04 | Artifact 独立授权；Task 可见性只在 Artifact 创建时提供默认快照，不动态继承 | Artifact、文件权限、跨 Task 引用 |
| AD-05 | 采用 Store v3 + API v3；v2 只作为离线迁移输入；不静默改 v2 | 持久化迁移、协议版本、legacy 任务 |
| AD-06 | Artifact 创建时物化 ACL；Task 角色变化不隐式改变 Artifact | Artifact、Task owner/controller 转移 |
| AD-07 | 补齐 Task/Execution/Lifecycle 完整迁移矩阵 | 状态机、错误码、审计事件 |
| AD-08 | Delegation 撤销/过期立即冻结 Controller，不自动取消运行中 Execution | 委托、控制权、ArtifactGrant |
| AD-09 | Event 分 workspace/system scope，游标每次重新授权 | 事件、订阅、隐私隔离 |
| AD-10 | requestKey 作用于 workspace + actor + delegation + operation + key | 幂等、多 Agent、重放授权 |
| AD-11 | 并行 Execution 与 Workspace mutex 分层；默认每 Workspace 一个写租约 | 调度、工作区隔离、租约恢复 |

## 1. 术语和不可破坏的不变量

### 1.1 术语

- **Principal**：User、Agent 或 System 的不可变身份。
- **Workspace**：权限和资源的边界，拥有根目录、成员和隔离策略。
- **Task**：一个逻辑目标及其目标级决策状态。
- **Execution**：一次不可复用的执行尝试。
- **Artifact**：由 Execution 产生或被 Task 引用的文件/产物记录。
- **DelegationGrant**：用户授予 Agent 的、带范围和有效期的委托。
- **Controller**：当前唯一有权控制某个 Task 的 Principal。

### 1.2 必须保留的 Phase 1.1 不变量

1. Execution 终态和完成证据不可覆盖；重试必须创建新 executionId 和新 requestKey。
2. unknown/interrupted 不自动重发；必须显式承认风险后才能创建新尝试。
3. Store 是本地已提交事实的权威；不是 DSH 远端执行状态的全知来源。
4. 单 Store 所有者、原子 commit、事件单调序列和容量上限继续保留。
5. 不承诺 exactly-once；不把通知顺序或 Session 可恢复性当作结果证据。
6. 任何权限检查都不能只依赖知道资源 ID；不能依赖调用方自报身份。

## 2. AD-01：并行 Execution 与 Task 状态聚合

### 2.1 决策

**Task 不再只有一个 `status` 字段承担所有含义。** 拆成三个维度：

```text
Task.goalStatus       目标级决策状态
Task.lifecycle        记录生命周期
Task.executionSummary 由 Execution 派生的只读摘要
```

#### goalStatus

```text
open | active | awaiting_decision | completed | failed | cancelled
```

- `open`：Task 已创建，但还没有任何 Execution（草稿/仅目标）。一旦首个 Execution 进入 queued/not_started，Task 进入 active。
- `active`：至少存在一个 `queued` 或 `running` 的 Execution。queued 数量在 `executionSummary` 中可见；active 不表示目标仍在正常推进。
- `awaiting_decision`：没有 `queued`/`running` Execution，且至少存在一个终态或 unknown/interrupted Execution，但尚未由 Owner/Controller 作出目标级决定。
- `completed`：Owner/Controller 明确判定目标完成，并且 `selectedExecutionId` 指向一个 completed Execution。
- `failed`：Owner/Controller 明确判定目标无法完成。
- `cancelled`：Owner/Controller 明确取消整个 Task。

这里的 `open` 比 Phase 2.0 的“尚未开始”更窄：只要首个 Execution 已入队，就进入 `active`；这样 `open` 与“无 Execution 的 Task 草稿”一一对应，避免 queued + terminal 混合时无法判定。

**关键规则：Execution 的完成/失败/取消不会自动改变 goalStatus。** 这是对 Phase 1.1 “Task.completed 等于最新 Execution 正常结束”的明确废止。一个 Execution 完成只让 Task 进入 `awaiting_decision`（若没有其他活动 Execution），不会自动变成 `completed`。

#### lifecycle

```text
live | archived | deleted
```

- `live`：正常显示，可创建新 Execution。
- `archived`：从活动列表隐藏；历史保留；默认禁止新 Execution；可由 Owner/Admin 恢复。
- `deleted`：软删除；普通查询不返回；历史与 Artifact 保留；可恢复。

restore 只恢复 lifecycle，不自动把 completed/failed/cancelled 重新打开；需要新目标时创建新 Task，而不是复用已结束的 goalStatus。

`archived`/`deleted` 不是 `goalStatus` 的值。读取投影可以返回 `archived`/`deleted`，但内部状态必须保留原 `goalStatus`。归档/删除不得把目标自动标记为 completed/failed/cancelled。

- `unknown` 不是 Task 的 goalStatus。unknown/interrupted Execution 进入 `executionSummary.unresolvedExecutionIds` 和风险标记；没有活动 Execution 时 Task 进入 `awaiting_decision`，而不是把整个 Task 标成 unknown。

这是相对 Phase 2.0 基线 Task 状态列表的**有意修正**：`archived` 归 lifecycle，`unknown` 归 executionSummary，避免一个字段同时承担目标、执行和归档语义。

#### executionSummary

由 Execution 集合派生，不持久化为 Task 的唯一真相：

```text
activeExecutionIds[]       queued + running
unresolvedExecutionIds[]   unknown + interrupted
latestExecutionId         最近创建的 Execution
selectedExecutionId       显式选定的 Execution，可为 null
counts                    queued/running/terminal/unknown
hasIntegrityRisk          未确认警报或重复执行风险
```

`activeExecutionId` 单值字段在 v3 中废止；需要单值兼容时，仅当恰好一个活动 Execution 才返回它。

### 2.2 Task 状态迁移矩阵

> **AD-07 已修订此矩阵。** 完整且权威的 Task/Execution/Lifecycle 矩阵见 `docs/phase-2.0.2-architecture-decisions.md` 第 2 节；下表保留为 2.0.1 的历史摘要。

| 当前 | 事件 | 下一状态 | 说明 |
|---|---|---|---|
| open | 首个 Execution 进入 queued/running | active | 自动 |
| active | 最后一个 queued/running Execution 结算，且无显式目标决定 | awaiting_decision | 自动；不自动 completed |
| awaiting_decision | 新 Execution 进入 queued/running | active | 新尝试 |
| active | 所有活动 Execution 被取消，且显式取消 Task | cancelled | 显式命令 |
| awaiting_decision | 显式 completeTask，selected 指向 completed | completed | 显式命令 |
| awaiting_decision | 显式 failTask | failed | 显式命令 |
| open/awaiting_decision | 显式 archiveTask，且无 queued/running Execution | archived（lifecycle） | goalStatus 保留 |
| archived | 显式 restoreTask | 原 goalStatus，lifecycle=live | 不自动恢复执行 |
| live/archived | 显式 deleteTask，且无 queued/running Execution | deleted（lifecycle） | 软删除 |
| deleted | 显式 restoreTask | 恢复前的 lifecycle | 需权限 |

`completeTask`、`failTask`、`cancelled` 的目标级决定要求没有 queued/running Execution；若仍有活动 Execution，必须先显式取消/等待结算，或返回 BUSY。`completeTask` 还要求 `selectedExecutionId` 指向 completed Execution，且任何 unknown/interrupted 风险必须在决定中显式记录，不能被静默忽略。

以下转换直接拒绝：

- `completed`/`failed`/`cancelled` → 通过普通 Execution 事件自动变化；
- `archived`/`deleted` → `active`，除非先 restore；
- 无 `selectedExecutionId` 的 `completeTask`；
- 选择非终态 Execution 作为 `selectedExecutionId`；
- 多个 Controller 同时控制同一 Task。

### 2.3 并行 Execution 与 Session 基数

决定：

1. **Execution 是并行单位，Task 是目标单位。**
2. 一个 Task 可有多个 `queued`/`running` Execution；`activeExecutionIds` 由状态查询得到。
3. **每个 Execution 至多一个 SessionBinding；每个 SessionBinding 只属于一个 Execution。**
4. 同一 Session 不得被两个活动 Execution 并发使用。顺序续接可以显式复用已关闭的 Session，但必须创建新的 Execution 和新的 Binding 记录，不能把旧 Execution 改写成新执行。
5. `Task.sessionId` 废止；需要兼容时返回 `selectedExecution` 或 `latestExecution` 的 Binding，不把它当作 Task 级身份。
6. Store v3 的绑定唯一性改为：`(taskId, executionId)` 唯一；`sessionId` 可在同一 Task 的顺序 Binding 中复用，但同一 Session 同时至多一个 active Binding，且不得跨 Task 共享。旧 v2 Binding 迁移时补 `executionId`，无法归属的标记 `legacy_unbound`，不得猜测。

### 2.4 并行工作的安全默认值

> **AD-11 已补充此节。** 并行数据模型、Workspace mutex、写租约和崩溃恢复的权威规则见 `docs/phase-2.0.2-architecture-decisions.md` 第 6 节。

Phase 2.0 要求“并行 Execution 不默认共享可写目录”。当前 DSH ACP 没有 worktree 管理能力，因此：

1. **Workspace 增加 `root` 和 `isolationPolicy`。**
2. `Execution.workspaceSnapshot` 至少包含：`kind`、`workspaceId`、`baseRevision/ref`、`capturedAt`。
3. `kind` 允许：`git-worktree`、`directory-copy`、`mutex`、`shared-readonly`。
4. **默认策略是 `mutex`，即同一 Workspace 同时只允许一个可写 Execution。**
5. 只有当执行器明确声明并验证 `git-worktree` 或 `directory-copy` 能力时，才允许同一 Workspace 多个可写 Execution。
6. 未提供隔离能力时，Hub 必须把并行降级为排队/互斥；不得让两个执行器同时写同一目录。
7. `maxConcurrent=8` 只保留为全局资源上限，不表示每 Task 可并行 8 个。

`Task.workingDirectory` 允许是 Workspace root 下的相对路径；`Execution.input.cwd` 记录实际使用的目录。`Task.cwd` 在 v3 废止，迁移时保留为 legacy 字段。

### 2.5 取消与关闭

- `cancelExecution(executionId)`：只请求/确认一个 Execution。
- `cancelTask(taskId)`：取消该 Task 所有活动 Execution；返回 Task 和每个 Execution 的取消结果；不自动把 goalStatus 设为 completed/failed。
- `archiveTask`：要求无活动 Execution；否则先返回 BUSY 或要求显式取消；不删除历史。
- `deleteTask`：软删除；要求无活动 Execution；不删除 Execution、Artifact 或其他 Task 引用的文件。
- `closeTask`：作为 v2 兼容入口，映射为“取消活动 Execution + archiveTask”；新 API 使用 `archiveTask`/`deleteTask`，避免把“关闭 Session”和“Task 生命周期”混为一谈。

### 2.6 AD-01 验收条件

设计评审通过前，不接受以下实现：

- 用 `activeExecutionId` 单值表示并行 Task；
- 用 `Task.status` 同时表示目标、执行和归档；
- 没有 `selectedExecutionId` 就把最新 Execution 当最终结果；
- 没有 Workspace 隔离/互斥就允许多个可写 Execution；
- 把多个 Execution 的结果自动合并。

## 3. AD-02：Principal、Workspace、Task 角色

### 3.1 Principal

```text
principalId        不可变 ID，不使用显示名/本地账户作为主键
principalType      user | agent | system
displayName        仅展示，不用于授权
status             active | disabled
createdAt / updatedAt
```

- `principalId` 由 Hub 生成或由认证适配器映射，不接受调用方在自己的 payload 中冒充其他 Principal。
- Agent 是独立 Principal，不因“服务 Alice”自动继承 Alice 的全部权限。
- `system:migration`、`system:hub` 等系统 Principal 只用于审计/迁移，不能登录或调用业务 API。

### 3.2 Workspace 与成员

```text
Workspace:
  workspaceId
  name
  root                    可执行根目录；v3 中新建 Workspace 必填
  ownerPrincipalId        与唯一 owner 成员一致
  isolationPolicy         mutex | worktree | copy
  createdByPrincipalId
  createdAt / updatedAt

WorkspaceMember:
  workspaceId + principalId   复合唯一
  role                        owner | admin | operator | viewer
  status                      active | revoked
  grantedByPrincipalId
  createdAt / updatedAt / revokedAt
```

- **Workspace.ownerPrincipalId 与成员角色 owner 是同一事实的两个投影**：Store 必须校验 owner 成员存在、唯一且角色为 owner；不能出现两个不一致的 owner。
- Admin 可以有多个；Owner 默认唯一，转移必须显式并审计。
- User 与 Agent 分别建立成员关系。Agent 的成员权限不能从用户成员关系继承。
- 角色只决定 Workspace 级能力；Task 级控制权由 Controller 决定。

### 3.3 Task 角色字段

```text
Task:
  taskId
  workspaceId
  ownerPrincipalId
  requestedByPrincipalId       User 或 null
  createdByPrincipalId         实际调用者
  controllerPrincipalId        当前唯一控制者
  controllerDelegationId       当前 Controller 委托来源，可空
  controlState                 active | frozen（AD-08）
  controllerFrozenReason
  controllerFrozenAt
  visibility                   workspace | private
  goalStatus
  lifecycle
  latestExecutionId
  selectedExecutionId
  delegationId               创建 Task 时的委托来源，可空
  workingDirectory           Workspace root 下的相对路径；legacy 任务可为空
  legacyCwd                 仅迁移保留的旧绝对目录；不作为新 Workspace root
  archivedAt / deletedAt
  deletedFrom                live | archived（AD-07，删除前 lifecycle）
  createdAt / updatedAt
  legacy                    可选的迁移元数据（来源版本/原状态）
```

决定：

1. `createdByPrincipalId` 是不可变审计字段，记录实际认证调用者。
2. `requestedByPrincipalId` 是不可变审计字段，记录被代表的用户；Agent 自主操作时为 null。
3. `ownerPrincipalId` 是业务负责人；默认规则：
   - 有 requestedBy：默认 owner = requestedBy；
   - 无 requestedBy：默认 owner = createdBy（允许 Agent 自主 Task）。
4. `controllerPrincipalId` 是唯一控制者；默认：
   - 用户直接创建：controller = 用户；
   - Agent 受委托创建：controller = Agent；
   - Agent 自主创建：controller = Agent。
5. `owner` 和 `controller` 可以不同；转移由 owner/admin 显式执行，记录 before/after、actor、时间、原因。
6. `controller` 必须是有 `operator` 或更高 Workspace 角色的活动成员；不能通过修改一个字符串绕过成员校验。
7. `createdBy`、`requestedBy` 不可变；`owner`、`controller` 可变但必须留审计事件。
8. `owner`、`requestedBy`、`controller` 必须是对应 Workspace 的 active 成员；跨 Workspace 访问必须走未来的显式 grant，不能只靠 Task 字段。
9. 不允许“因为 Agent 知道 taskId，就自动成为 controller”。

### 3.4 Workspace Operator 与 Task Controller 的边界

Phase 2.0 的角色表把 Operator 描述为“创建 Task、控制 Execution”。本决策将其精确化为：

- Operator 可以创建 Task；
- Operator 创建 Task 后成为该 Task 的 controller（如果是直接调用）；
- Operator **不能**仅凭 Workspace 角色控制其他 Principal 的 Task；
- Workspace Owner/Admin 可以管理权限和转移 controller，但执行/取消仍建议通过 controller；Owner/Admin 也可以显式接管，必须审计；
- Viewer 只能读 workspace 可见资源，不能执行。

这样保留“单一 Task Owner/Controller”，同时不把 Workspace Operator 变成隐式的多 Agent 控制权。

### 3.5 委托授权

```text
DelegationGrant:
  delegationId
  workspaceId
  delegatorPrincipalId       User
  delegatePrincipalId        Agent
  scopes                     task:create/read/execute/control, artifact:read/write
  taskId                     可选，限定单个 Task
  createdAt
  expiresAt
  revokedAt
  createdByPrincipalId
```

有效权限 = 用户当前权限 ∩ Agent 当前权限 ∩ grant 仍在有效期/未撤销 ∩ 请求范围。

- Agent 不得自行声明 `requestedBy`；由认证连接和 grant 推导。
- 用户委托和 Agent 自主操作必须可区分：`requestedBy=null` 表示自主，非 null 表示代表用户。
- 委托不能超过 delegator 自身权限；权限撤销后立即失效。
- 需要记录 `delegationId` 到 Task 和审计事件；只存 `requestedBy` 不足以证明授权来源。

## 4. AD-03：私有 Task 与委托访问

### 4.1 可见性定义

**新建 Task 默认 `visibility=private`。** `workspace` 必须显式选择，避免误公开。

#### workspace

- Workspace 内所有 active 成员（viewer/admin/operator/owner）可读；
- 控制仍只属于 controller/owner/admin；
- 不因可读而获得执行、取消、转移 controller 的权限。

#### private

可读主体：

1. Task owner；
2. Task requestedBy（若有）；
3. Task controller；
4. Workspace Owner/Admin；
5. 持有有效 `DelegationGrant` 且 scope 包含 `task:read` 的 Agent，且该 Agent 仍是成员；
6. 显式 `TaskGrant`（未来 restricted 能力；Phase 2.1B 不开放任意 ACL）。

**`createdBy` 本身不自动获得 private 读权。** 如果 createdBy 是 Agent，它必须同时是 controller、owner，或持有有效委托。这样避免“Agent 创建过 Task 就永久拥有所有私有内容”。

### 4.2 控制权限

`startExecution`、`dispatchQueued`、`cancelExecution`、`cancelTask`、`selectExecution`、`completeTask`、转移 controller 需要：

- controller，或
- owner/admin 的显式管理操作（并记录接管原因）。

Workspace Operator 不是充分条件；私有与 workspace 可见性都不改变控制权。

### 4.3 委托场景决策

Alice 通过 AstrBot 创建私有 Task：

```text
requestedBy = Alice
createdBy   = AstrBot
owner       = Alice
controller  = AstrBot
visibility  = private
delegationId = grant-...
```

- Alice 可读，因为她是 owner/requestedBy；
- AstrBot 可读/执行，因为它是 controller 且有 grant；
- 另一个 Agent 不能仅凭 workspace operator 读取；
- AstrBot 不能把 Task 转给另一个 Agent，除非 Alice 或 Workspace Admin 授权；
- 若 grant 撤销，AstrBot 的 controller 身份不自动保留；必须显式转移或冻结。

Agent 自主创建：

```text
requestedBy = null
createdBy   = Agent
owner       = Agent
controller  = Agent
```

Workspace Owner/Admin 仍可审计和管理；普通用户不自动可见。

### 4.4 API 授权上下文

- 授权主体由连接/认证上下文中获得，不从 `args` 里的 `principalId`、`createdBy`、`acknowledgedBy` 读取。
- 所有读方法（`getTask/listTasks/getExecution/listExecutions/getEvents/subscribeEvents`）在同一个授权层过滤；不能只保护写操作。
- `acknowledgeIntegrityAlerts` 的 `acknowledgedBy` 由连接主体生成，payload 只能提供 note，不能提供 actor。
- 本地 stdio 兼容模式如果保留，只能绑定显式配置的 `bootstrapPrincipalId` 和受限 Workspace；不提供“无身份=全权限”的 fallback。

### 4.5 Legacy 任务可见性

Phase 1.1 没有 owner/requestedBy/visibility。迁移不得从 `cwd`、Windows 账户或 `taskId` 推断这些字段。

决策：

- 迁移必须显式提供 `workspaceId`、`ownerPrincipalId`（User）和可选 `workspaceRoot`；
- legacy Task 默认 `visibility=private`；
- `createdByPrincipalId=system:migration`；
- `requestedByPrincipalId=null`；
- `ownerPrincipalId=迁移指定的 owner`；
- `controllerPrincipalId=迁移指定的 owner`（初始不自动给 Agent）；
- 之后由 Owner/Admin 显式 claim/grant。

这样旧任务不会因为“默认 workspace”而泄漏，也不会伪造委托关系。

## 5. AD-04：Artifact 独立授权与默认继承

### 5.1 实体

```text
Artifact:
  artifactId
  workspaceId
  sourceTaskId              可空；迁移/外部导入可能没有
  sourceExecutionId         可空
  ownerPrincipalId
  storageRef                不透明引用；不暴露本机绝对路径
  sha256
  size
  mime
  visibility                workspace | private
  permissionMode            snapshot | explicit
  createdAt
  deletedAt
  retentionPolicy

ArtifactReference:
  artifactId + taskId + executionId + relation(produced|referenced)
  唯一约束按引用记录

ArtifactGrant:
  grantId
  artifactId
  granteePrincipalId 或 granteeTaskId
  scope                     read | write
  grantedByPrincipalId
  createdAt
  expiresAt
  revokedAt
```

`permissionMode` 的含义：

- `snapshot`：创建时按来源 Task 生成初始可见性；之后的访问由 Artifact 自身可见性和显式 grants 决定；Phase 2.1B 只使用该模式；
- `explicit`：创建时不继承，只按显式 grants 授权；预留给特殊导入/跨 Workspace 场景，Phase 2.1B 不开放。

### 5.2 默认继承的精确定义

> **AD-06 已修订 Artifact ACL 与 Task 角色变化的关系。** 读取时不再按当前 Task 角色动态判断；创建时物化 owner/visibility/grant，Controller 转移/冻结有明确的 grant 同步。完整规则见 `docs/phase-2.0.2-architecture-decisions.md` 第 1 节。

**默认继承是创建时快照，不是动态继承。**

- Artifact 创建时，若来源 Task 为 private，则 Artifact 默认 `visibility=private`；
- 若来源 Task 为 workspace，则默认 `visibility=workspace`；
- 之后 Task 的 visibility 改变，不自动改变 Artifact；
- 需要扩大或缩小 Artifact 可见性时，使用显式 `publishArtifact` / `restrictArtifact` / `ArtifactGrant`；
- 任何 Task 可见性变化都必须审计，但不能隐式改写其他 Task 引用 Artifact 的权限。

这解决了 Phase 2.0 基线中的矛盾：默认继承保留为创建默认值；多个 Task 引用同一文件时，访问权由 Artifact 自身的 ACL/grant 决定，不由任一 Task 动态决定。

### 5.3 Artifact 读取规则

#### private

- Artifact owner；
- 创建事务中物化的 `origin=task-snapshot-requester` / `origin=task-snapshot-controller` grant；
- Workspace Owner/Admin；
- 显式 ArtifactGrant 的 grantee；
- 通过有效委托访问来源 Task 的 Agent，且 scope 包含 `artifact:read`。

#### workspace

- Workspace 内 active 成员（viewer+）；
- 显式跨 Workspace grant 的 grantee（以后实现）；
- 引用不自动授予读取权。

### 5.4 Artifact 与 Task 生命周期

- Task archive/delete 不删除 Artifact；
- Task delete 不自动删除其他 Task 引用的文件；
- Artifact 有独立 `deletedAt` 和保留策略；
- 删除 Task 后，Artifact 的读取权仍由 Artifact ACL 和显式 grant 决定；来源 Task 的 owner/admin 作为审计角色保留；
- 跨 Workspace 共享必须使用 ArtifactGrant，记录来源/目标、scope、grantor、有效期、撤销时间。

### 5.5 Artifact 来源与 Adapter 能力

- 只接受显式注册的 Artifact（执行器产生事件、`registerArtifact` API 或受信任的适配器）；
- **不扫描 cwd 自动推断 Artifact**，避免路径逃逸和误归属；
- DSH ACP 当前没有证明 `getArtifacts` 能力，Phase 2.5 必须先做 capability probe；
- 不支持时返回明确的 `UNSUPPORTED`/空集合，不伪造 Artifact；
- Hub 的 Artifact 读取通过 `storageRef` 和 Hub 权限层完成，不把本机绝对路径作为客户端可见字段。

## 6. AD-05：Phase 1.1 → Phase 2 Store/API 迁移

### 6.1 版本策略

决定：

- 新增 **Store v3**，使用新的 `state-v3.json` 和 v3 锁；v2 文件只读保留，不原地改写；
- 新增 **API v3**（`protocolVersion:3`）；v2 客户端不能静默获得 v3 语义；
- `taskId`、`executionId` 继续作为 v3 内部规范 ID 名，避免无收益的全局重命名；Phase 2.0 文档中的 `Task.id`/`Execution.id` 视为外部别名，v3 contracts 明确二者关系；
- v2 的 `status`、`activeExecutionId`、`Task.result` 不再作为 v3 权威字段，只作为兼容投影/迁移来源；
- 不引入第二套数据库/队列；v3 仍为单所有者原子快照，容量策略另行评审。

### 6.2 Store v3 集合

```text
principals
workspaces
workspaceMembers
delegations
tasks
executions
bindings
requests
artifacts
artifactReferences
artifactGrants
workspaceLeases（AD-11）
events
```

### 6.3 字段映射

#### Task

| v2 | v3 | 规则 |
|---|---|---|
| `taskId` | `taskId` | 保留 |
| `cwd` | `legacyCwd` + `workingDirectory` | 不推断 Workspace root |
| `objective` | `title`/`description` | 保留原文；不拆出未经确认的语义 |
| `lifecycle` | `lifecycle` | `closed` → `archived`（保留 legacyClosed 标记） |
| `status` | `goalStatus` + `legacyStatus` | 不把执行终态自动当目标终态 |
| `latestExecutionId` | `latestExecutionId` | 保留 |
| `activeExecutionId` | 派生 `activeExecutionIds` | 不再作为权威单值 |
| `unresolvedExecutionIds` | 派生 | 保留风险 |
| `result` | `legacyResult`/兼容投影 | 不自动设 selected |
| `sessionId` | legacy 投影 | v3 以 Binding 为准 |
| 无 | `workspaceId` | 迁移必须显式指定 |
| 无 | `ownerPrincipalId` | 迁移必须显式指定 User |
| 无 | `requestedByPrincipalId` | 默认 null，不猜测 |
| 无 | `createdByPrincipalId` | `system:migration` |
| 无 | `controllerPrincipalId` | 初始为迁移 owner |
| 无 | `visibility` | 默认 private |
| 无 | `selectedExecutionId` | 默认 null |
| 无 | `archivedAt`/`deletedAt` | 由迁移显式/legacy 标记 |

`legacyCwd` 只用于审计保留。旧 Task 若要启动新 Execution，必须先由 Owner/Admin 将其归一化到 Workspace root 下的 `workingDirectory`；不允许继续以旧绝对目录作为新执行目录。

#### Execution

| v2 | v3 | 规则 |
|---|---|---|
| `executionId` | `executionId` | 保留 |
| `prompt` | `input.prompt` | 原文保留 |
| Task `cwd` | `input.cwd` | 记录当时目录 |
| `requestKey` | `requestKey` | 保留 |
| `status/submission` | 同名 | 保留可靠性语义 |
| `result/resultIntegrity/completionEvidence` | 同名 | 不伪造证据 |
| `bindingId` | `bindingId` | 保留 |
| `cancel/diagnostics` | 同名 | 保留 |
| `startedAt/deadlineAt` | 同名 | 有则保留 |
| 无 | `finishedAt` | 仅在有可信终态时填写；不拿 `updatedAt` 冒充 |
| 无 | `createdByPrincipalId` | `system:migration` |
| 无 | `executorId` | `legacy` 或显式映射 |
| 无 | `workspaceSnapshot` | legacy 为 null；新执行必须显式 |

#### Binding / Request / Event

> **AD-09/AD-10 已修订本段。** Event 的 workspace/system scope 与游标见 2.0.2 第 4 节；requestKey 的委托作用域见 2.0.2 第 5 节。

- Binding：补 `executionId`；无法归属的执行标记 `legacy_unbound`，不猜测。
- Request：v2 全局 key 迁移为 `scope=legacy`；新 key 使用 `(workspaceId, actorPrincipalId, delegationId, operation, key)`；旧 key 重放必须重新授权。
- Event：补 `workspaceId`、`scope`、`schemaVersion=1`；`correlationId/causationId=null`；保留原 eventId/sequence；不重写历史事件内容。
- Artifact：v2 没有 Artifact，迁移不生成 Artifact；不把 `Task.result` 文本自动当文件产物。

### 6.4 状态映射（关键）

Phase 1.1 的 Task.status 是 Execution 投影，不是目标决定，因此：

| v2 Task 状态 | v3 goalStatus | 说明 |
|---|---|---|
| `queued` | `active` | 已有 queued Execution；按 AD-01 open 只保留给无 Execution 的草稿 |
| `running` | `active` | 有活动执行 |
| `completed` | `awaiting_decision` | 不自动判定目标完成 |
| `failed` | `awaiting_decision` | 需 Owner/Controller 决定目标失败 |
| `cancelled` | `awaiting_decision` | 执行取消不等于目标取消 |
| `interrupted` | `awaiting_decision` | 不确定，需决策 |
| `unknown` | `awaiting_decision` | 保留 unresolved 风险 |
| `lifecycle=closed` | `lifecycle=archived` | 保留 legacyClosed，不伪造归档决定 |

所有 v2 终态 Task 的 `selectedExecutionId=null`，除非迁移配置明确指定“选择某个 Execution”（默认不指定）。

### 6.5 迁移步骤

1. 停止 Hub，取得 v2 Store 独占锁，记录 revision/sequence/校验和。
2. 对 v2 目录做只读备份；迁移只在副本上进行。
3. 显式提供 `workspaceId`、`ownerPrincipalId`（User）、可选 `workspaceRoot`；缺失 owner/workspace 则迁移失败，不猜测账户。若 `workspaceRoot` 缺失，legacy Task 只读可用，但在 Owner/Admin 归一化 root 前不得启动新 Execution。
4. 创建 `system:migration` 与 Workspace/Owner/Membership。
5. 按表映射 Task/Execution/Binding/Request/Event；不生成 Artifact，不伪造终态/时间/委托。
6. 运行 v3 不变量校验：
   - Workspace owner 成员唯一且一致；
   - Task workspace/owner/controller 有效；
   - private Task 至少有一个可读 owner；
   - archived/deleted Task 不得有 queued/running Execution；冲突时迁移失败而不是静默改写；
   - Execution 的 taskId/workspaceId/bindingId 归属正确；
   - Binding 的 executionId 唯一且不跨 Task；
   - Request scope 有效；
   - Event workspace 关联完整；
   - v2 Task/Execution/Event 数量与迁移输入一致，无静默丢弃。
7. 在副本写入 `state-v3.json`，原子发布；保留 v2 备份为只读。
8. 新 Hub 只启动 v3；回滚时停止 v3、恢复 v2 备份，不覆盖 v3 新增执行。
9. 迁移失败保持 v2 原文件不动；不允许半迁移目录被读取。

### 6.6 API v3 兼容

- `protocolVersion:3`；v2 请求不自动解释为 v3。
- v3 Task 返回 `goalStatus`、`lifecycle`、`executionSummary`、`selectedExecutionId`；
- `Task.status` 作为兼容投影：`lifecycle` 为 archived/deleted 时返回对应值，否则返回 `goalStatus`；
- `Task.result` 作为兼容投影：仅当 `selectedExecutionId` 存在时返回其 result；否则返回 `legacyResult`/null，不把 latest 冒充 selected；
- `activeExecutionId` 仅在恰好一个活动 Execution 时返回，否则 null；新客户端必须读 `activeExecutionIds`；
- v2 的 `acknowledgeIntegrityAlerts` payload 不再接受 `acknowledgedBy` 作为身份，改由认证上下文提供；
- 旧客户端在 v3 上只读兼容模式可以保留一个迁移窗口，但必须经过授权层，不能绕过 private 过滤。

### 6.7 迁移验收

必须新增（设计验收，不是本轮代码）：

- 从每种 v2 Task 状态迁移的 fixture，断言 `goalStatus`、`legacyStatus`、`selectedExecutionId=null`、owner/visibility；
- 未知/中断/closed 任务迁移后仍不可自动执行；
- Binding 无 executionId 的 legacy 记录被标记而非猜测；
- Request 旧 key 不能绕过 v3 授权；
- Event 数量、ID、sequence 保持；
- 迁移失败不修改 v2，回滚可用；
- 同一 v2 Store 不产生两个不同 v3 结果（确定性）。

## 7. 跨决策的统一不变量

1. **单一权威**：每个概念只有一个写入来源；Workspace Owner 字段/成员角色、Task owner/controller 不能互相矛盾。
2. **默认关闭**：新 Task 默认 private；新 Workspace 默认 mutex；新 Controller 必须有明确授权。
3. **不猜测 legacy**：不从 `cwd`、本机账户、显示名、`taskId` 推断 Principal/owner/visibility。
4. **授权先于读取**：所有 Task/Execution/Artifact/Event 读取都经过同一 AuthorizationContext。
5. **不伪造终态**：迁移不把执行完成升级为目标完成，不生成 Artifact，不生成缺失证据。
6. **并行不等于共享**：并行 Execution 必须有独立工作区或显式互斥；没有能力就降级排队。
7. **Artifact 权限独立**：Task 可见性只提供创建默认值，不动态改写其他引用者的权限。

## 8. 本轮明确不做

- 不实现 Store v3、API v3、迁移脚本或任何业务代码；
- 不修改 Phase 1.1 Contracts、Store、Executor、ACP Transport；
- 不实现 Workspace/Artifact/Delegation 表；
- 不实现多 Agent 协商、控制权转移协议、跨 Workspace 共享；
- 不决定 Artifact 的最终存储后端、加密或 OS 级隔离；
- 不接入 Cyrene、AstrBot、QQ/NapCat 或 Bilibili。

## 9. 进入 Phase 2.1 的前置条件

| 阶段 | 前置决策 |
|---|---|
| Phase 2.1A Identity & Workspace | AD-02 的 Principal/Membership/Delegation 字段和授权上下文冻结 |
| Phase 2.1B Task Access & Lifecycle | AD-01、AD-03、AD-04 冻结；AD-05 迁移映射通过独立评审 |
| Phase 2.2 Message & Event | AD-03 的读过滤、AD-05 的 Event workspace 关联冻结 |
| Phase 2.3 Execution Feedback | `awaiting_input` 是 Execution 状态还是 InputRequest 单独状态已确认；DSH 能力探测结果明确 |
| Phase 2.5 DSH Adapter | AD-01 的 WorkspaceSnapshot/隔离能力、AD-04 的 Artifact 能力探测冻结 |

## 10. 后续可细化项与已冻结边界

以下仍可在后续 AD 中细化，但不能改变本文件已经冻结的边界：

- **已经冻结**：Workspace 只有一个 owner principal；Admin 可多个。多 Owner 需要新增 AD，不在 Phase 2.0.1 内。
- Controller 是否需要租约/超时；如果需要，另行新增 AD；
- Artifact 的物理存储后端和跨 Workspace 传输方式；
- 复杂 `restricted` ACL、MFA、审批流；
- Message 传输协议和 Automation 的调度实现。

## 11. 结论

本文件把 Phase 2.0 的五个 P0 方向转化为可实施的设计边界：

1. 多 Execution 不再依赖单一 `activeExecutionId`，而是显式并行模型 + 隔离能力 + 独立 SessionBinding；
2. Task 目标状态、执行状态和生命周期分离，`completed` 只能由显式目标决策产生；
3. Principal/Workspace/Delegation 成为一级模型，Agent 不自动继承用户权限；
4. private Task 使用明确可见性矩阵，Task Owner 与 Controller 可不同但必须审计；
5. Artifact 使用独立授权，Task 可见性只提供创建时默认值；
6. v2→v3 使用离线、可验证、可回滚的迁移，不静默改写旧 Store。

在这些决策被独立审查接受前，Phase 2.1B 及之后的实现不应开始。
