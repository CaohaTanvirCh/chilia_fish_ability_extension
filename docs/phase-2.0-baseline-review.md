# Phase 2.0 基线 × Phase 1.1 实现审查

日期：2026-11-10（Asia/Hong_Kong）。审查对象：用户提供的 **Phase 2.0 Architecture Baseline / Draft v2.0**（781 行）与当前仓库 Phase 1.1 实现/设计文档。被审查代码基线：`a83e52f3ec9d03718411680ee1d6f1516729a4d5`。

审查性质：只读设计审查；未修改业务代码、Store、Executor、ACP Transport、状态机或测试。本文是 Phase 2.0 的设计输入，不是 Phase 2 实现或验收。

## 0. 结论

Phase 1.1 的可靠性基础（Task/Execution 分离、不可覆盖历史、unknown 不自动重发、单 Store 所有者、事件游标）可以作为 Phase 2.0 的地基，但 **不能把 Phase 2.0 当作 Phase 1.1 模型的无损增量**。

存在 5 个 P0 级阻断项：

1. Phase 1.1 是“每 Task 最多一个活动 Execution”，Phase 2.0 要求“一个 Task 可并行多个 Execution”。
2. Phase 1.1 的 Task 状态就是 Execution 状态；Phase 2.0 的 Task 状态是目标级决策状态，二者语义和枚举都不同。
3. Phase 1.1 没有 Principal/Workspace/授权上下文；当前 Hub 的 `getTask`、`listTasks`、`getExecution`、`listExecutions`、`getEvents` 没有访问过滤，`acknowledgedBy` 只是调用方字符串。
4. Phase 2.0 的 Task Owner / `createdBy` / `requestedBy` / Controller 语义未冻结，却计划在 Phase 2.1B 实现私有 Task；委托用户的可见性没有可落地规则。
5. Artifact 没有实体和权限模型；Phase 1.1 只有 `Execution.result` 文本和共享 `cwd`，无法实现“Task 私有产物继承”和“多 Task 引用同一文件时独立授权”。

在这些 P0 关闭前，Phase 2.1A 可以继续做身份/Workspace 的接口原型，但不应开始 Phase 2.1B 的私有 Task、Artifact 权限或真实多用户接入。

## 1. 兼容性总表

| 领域 | Phase 2.0 基线 | Phase 1.1 当前实现 | 结论 |
|---|---|---|---|
| 身份 | Principal（User/Agent）、Workspace 成员、RBAC、委托访问 | 单 stdio 客户端；无 Principal/身份参数；无认证 | P0 |
| Task 归属 | owner、createdBy、requestedBy、Controller | Task 无 owner/creator/requester/controller 字段 | P0 |
| Task 可见性 | workspace / private | 无 visibility；list/get 返回全部 | P0 |
| Task 状态 | open/active/awaiting_decision/completed/failed/cancelled/archived | `TaskStatus = ExecutionStatus`；completed 表示最新 Execution 正常结束 | P0 |
| 多 Execution | 同一 Task 可并行多个 | 同一 Task 最多一个活动 Execution；单 `activeExecutionId` | P0 |
| 工作区隔离 | 并行 Execution 不共享可写目录 | 所有 Execution 使用 Task `cwd`；多个 Task 可同时写同一目录 | P1（并行时升 P0） |
| 选定结果 | `selectedExecutionId` | 无 selected；`Task.result` 等于最新 Execution 结果 | P1 |
| 归档/删除 | archivedAt/deletedAt，可恢复 | lifecycle open/closed；closeTask 后不能恢复 | P1 |
| Artifact | 归属、权限继承、跨 Task 引用独立检查 | 无 Artifact 实体；只有 result 文本；共享 cwd | P1（权限模型 P0） |
| Execution feedback | awaiting_input、Input/Decision Request | Execution 无 awaiting_input；一次 prompt 单向等待 | P1 |
| Message/Command | Envelope、ACK、至少一次投递 | 只有紧凑 DomainEvent，无 Message/Command | P2（Phase 2.2 新能力） |
| Event | 稳定 ID/version/correlation/causation、workspace 关联 | eventId/sequence/revision/time；无 workspace/correlation/causation | P2 |
| DSH Adapter | createExecution/resumeExecution/getArtifacts/interactiveInput 等 | 现有 DshAcpExecutor；无 execution replay/artifacts/input | P1 |
| 存储迁移 | 要求兼容现有 Store，不破坏 | Store 强校验 latest/result/active 单值投影 | P1 |
| API 查询授权 | 按 Principal/Workspace/可见性过滤 | 按 ID 直接查询；事件全局序列 | P0 |

## 2. P0：实现前必须冻结的阻断项

### P0-1 单活动 Execution 与并行 Execution 的直接冲突

**基线要求：**

- Phase 2.0 §4.1：Task 可以存在多个 Execution，包括并行 Execution。
- §4.3：并行 Execution 有独立状态和结果；活跃 Execution 通过状态查询获得，而不是只保留一个 `activeExecutionId`。
- §4.4：并行 Execution 不应默认共享同一个可写工作目录。

**Phase 1.1 现状：**

- `docs/architecture.md:22` 明确“每 Task 最多一个活动 Execution”。
- `docs/phase-1.1-clarifications.md:29` 明确“Task 一次最多一个活动 Execution”。
- `packages/contracts/v2.d.ts:4` 只有单一 `TaskStatus`；Task 的 `activeExecutionId`、`latestExecutionId` 是单值字段。
- `packages/dsh-acp-v2/index.mjs:59` 用 `gate(taskId)` 串行化 `startExecution`；`:62` 若 Task 有未结算操作直接 `BUSY`；`:69` 只检查 `latest` 是否活动。
- `packages/task-store-v2/index.mjs:41` 用 `attempts.find(...)` 取第一个活动 Execution；`:196` 要求 `activeExecutionId` 等于这一个值。
- `docs/contracts.md:31` 的 Task 投影仍以“活动 Execution 状态，否则最新 Execution 状态”计算。

**影响：**

- 不能持久化两个同时 `running` 的 Execution 并保持有意义的 Task 投影。
- `cancelTask`、`closeTask` 只处理 `activeExecutionId` 指向的一个 Execution；并行时语义不成立。
- `SessionBinding` 是 Task 级绑定，当前设计是顺序复用；并行 Execution 需要每个 Execution 独立的 Session/绑定，且 Store 需要相应的所有权和唯一性规则。
- `Task.result` 只能对应一个 Execution；如果并行结果不同，最新结果不等于选定结果。

**需要先决定：**

- Task 是否需要 `activeExecutionIds`，还是完全通过 Execution 状态查询；
- 并行 Execution 的 SessionBinding 基数是“每 Execution 一个”还是“每 Task 一个池”；
- `cancelTask` 对多个活动的行为（全部取消、只取消 Controller 指定项，还是要求显式 executionId）；
- Store 的 `activeExecutionId` 是否保留为兼容投影，以及多活动时如何验证。

### P0-2 Task 状态机与 Execution 状态机被错误合并

**基线要求：**

- Phase 2.0 §4.5：Task 状态为 `open / active / awaiting_decision / completed / failed / cancelled / archived`。
- §4.3：某个 Execution 完成不代表 Task 自动完成；失败也不代表 Task 自动失败。
- §4.5：Task 状态不应简单等同于某个 Execution 状态。

**Phase 1.1 现状：**

- `packages/contracts/v2.d.ts:3-4` 直接定义 `TaskStatus = ExecutionStatus`；没有 `open/active/awaiting_decision/archived`。
- `docs/phase-1.1-design.md:25` 明确 `completed` 只表示最新执行正常结束，不证明自然语言目标完成。
- `docs/contracts.md:31` 把 Task 投影定义为活动 Execution 或最新 Execution 的状态。
- `packages/dsh-acp-v2/index.mjs:35` 的 `project()` 直接生成这套投影。

**影响：**

- Phase 2.0 的 `completed` 是“目标被明确判定完成”，Phase 1.1 的 `completed` 是“最新 Execution 正常结束”。同名不同义，不能直接迁移。
- `active` 不能由 `running` 直接替代：一个 Execution 完成、另一个仍运行时，Task 仍应为 active；一个 Execution 完成且另一个 unknown 时，Task 可能应进入 awaiting_decision，而不是 unknown 或 completed。
- `open` 与 `queued`、`archived` 与 `lifecycle=closed` 不是同义词，不能靠别名解决。
- `unknown` 在 Phase 1.1 是“历史未解决执行”的聚合；Phase 2.0 没有把 unknown 列为 Task 状态，需要定义 unknown Execution 如何影响 Task。

**需要先决定：**

- 采用 `Task.goalStatus` 与 `Execution.status` 两个独立类型，还是保留 `Task.status` 但彻底重定义；
- `Task.status` 和 `Task.lifecycle` 的职责边界；
- 多个 Execution 的聚合矩阵，包括 active、partial failure、unknown、decision pending；
- `Task.completed` 的唯一决策入口和审计事件。

### P0-3 Phase 1.1 没有授权上下文，当前读接口无法承载私有 Task

**基线要求：**

- Phase 2.0 §2.1：Principal 独立 ID，Agent 不因服务某个用户自动获得该用户全部权限。
- §2.3/§3.1：Workspace 成员、角色、默认隔离、显式共享。
- §3.3：private Task 仅创建者、Workspace Owner/Admin 可见。
- §12：记录谁发起、谁执行、谁授权。

**Phase 1.1 现状：**

- `docs/architecture.md:52` 明确没有 HTTP 监听口、多 bot 身份或多调用方路由。
- `apps/companion-hub/main.mjs` 的 stdio 命令直接调用 `executor[method]`，没有 Principal 参数或连接身份。
- `packages/dsh-acp-v2/index.mjs:198-202` 的 `getTask/listTasks/getExecution/listExecutions/getEvents` 不做任何访问过滤。
- `packages/dsh-acp-v2/index.mjs:193` 的 `acknowledgeIntegrityAlerts` 直接接受调用方提供的 `acknowledgedBy` 字符串。
- `docs/phase-1.1-final-review.md:362` 已指出任何能写 stdio 的本机客户端都可以确认，不能把 `acknowledgedBy` 当可信身份。

**影响：**

- 只要知道 taskId，就能读取 private Task；`listTasks` 和 `getEvents` 会直接暴露所有 Workspace 的数据。
- 不能在 Hub 内部“最后再加一层 if”解决：所有读方法、事件订阅、幂等重放和确认操作都需要 Principal 上下文。
- `acknowledgedBy` 由调用方伪造，无法作为 Phase 2.0 的审计主体。
- 如果把 `principalId` 直接加到每个公共方法，会破坏当前 API，并让身份校验散落在业务方法中；需要明确的认证连接上下文和授权层。

**需要先决定：**

- Principal 来自哪里（连接认证、Agent Connector session、还是 Hub 进程的显式上下文）；
- 读接口是否统一接收授权上下文，还是 Hub 内部用不可伪造的 ExecutionContext；
- `getEvents`/`subscribeEvents` 的 Workspace/Task 过滤和权限撤销后的游标行为；
- 是否保留无身份的本地 stdio 兼容模式，以及它只能访问哪个受限 Workspace。

### P0-4 Task Owner、createdBy、requestedBy、Controller 与私有可见性未对齐

**基线要求：**

- §2.4：委托访问同时检查用户 Workspace 权限、Agent 调用权限和委托授权范围；区分用户委托与 Agent 自主操作。
- §4.1：Task 有 `createdBy`、`requestedBy`、`owner`。
- §3.3：private Task 仅“创建者”、Workspace Owner/Admin 可见。
- §11：初期采用单一 Task Owner / Controller。
- §15：Task Owner 与 createdBy 的区别、私有时委托用户与 Agent 的访问关系，均仍未最终决定。

**Phase 1.1 现状：**

- `Task` 有 `taskId`、`cwd`、`objective`、`lifecycle`、`status` 等执行投影字段，但没有 owner/createdBy/requestedBy/controller/visibility。
- `createTask` 只接收 `cwd/prompt/requestKey/taskId/defer`。
- 没有 Principal 表、Workspace 成员表、委托授权记录或审计主体。

**核心矛盾：**

基线同时使用四个不同角色，但没有定义它们的值域和关系：

1. `owner`：业务负责人；
2. `createdBy`：实际调用 Hub 的 Agent/技术主体；
3. `requestedBy`：委托的用户；
4. Controller：当前有权控制 Task 的单一主体。

Alice 通过 AstrBot 创建 Task 时，合理的语义是：

```text
requestedBy = Alice
createdBy    = AstrBot
owner        = Alice（或 Workspace 指定的负责人）
controller   = AstrBot（受 Alice 委托，或 Alice 明确指定）
```

但基线 §3.3 的 private 规则写的是“创建者、Workspace Owner/Admin 可见”。如果“创建者”解释为 `createdBy`，Alice 可能看不到自己的 Task；如果解释为 `requestedBy`，AstrBot 又可能在没有委托的情况下看到 Alice 的私有内容。二者都不是安全的默认值。

此外，单个 `owner` 无法表达“owner 是 User、controller 是 Agent、多个 Agent 只有其中一个有控制权”的组合；`§11` 的“单一 Task Owner / Controller”与字段 `owner` 也不是同一概念。

**需要先决定：**

- `owner` 是否允许是 Agent；User 与 Agent 的 private 可见性分别是什么；
- private 可见集合的精确定义（至少覆盖 owner、requestedBy、active delegated Agent、Workspace Owner/Admin）；
- Controller 是否单独持久化、如何转移/租约/撤销；是否允许与 owner 不同；
- 委托授权是否需要 `delegationId`、scope、有效期、撤销时间，而不只是 `requestedBy` 两个字段；
- 没有这些字段的 Phase 1.1 Task 如何迁移：不得从 `cwd`、进程账户或 `taskId` 猜测 owner/requester，必须显式标记 legacy unknown 或由迁移输入指定；
- `visibility` 的默认值：基线只规定 `workspace/private` 两种值，没有说明新建 Task 默认哪一种；默认隔离原则暗示 private，但 Phase 2.1B 不能靠猜测决定。

### P0-5 Artifact 权限继承没有可落地的数据模型

**基线要求：**

- §3.2：普通文件属于 Workspace；Task 产物保留来源关系；Task 私有产物默认继承 Task 私有可见性；多个 Task 引用同一文件时权限独立检查。
- §3.4：跨 Workspace 共享要记录来源/目标/资源类型/范围/授权人/有效期/撤销时间。
- §5.3：删除 Task 不应删除其他 Task 也在使用的文件。

**Phase 1.1 现状：**

- 没有 `Artifact` 实体、Artifact Store、文件引用、hash、owner/visibility 或删除标记。
- Execution 没有 Artifact 引用或文件清单，只有 `result` 字段；`Task.result` 是文本投影。
- `Task.cwd` 是执行目录；多个 Task 可以指向同一 cwd；没有 Workspace root、文件租约或写隔离。
- `docs/architecture.md:52` 明确没有文件级隔离；应用层权限检查不等于 OS 隔离。

**基线自身的矛盾：**

- “Task 私有产物默认继承 Task 私有可见性”暗示动态继承；
- “多个 Task 引用同一文件时权限独立检查”要求每个引用有独立授权；
- 如果 Task 的 visibility 变更会自动改变产物权限，那么一个 Task 变公开会泄漏其他引用者的私有文件；如果不变，则“继承”只是创建时快照，不是动态继承。

**影响：**

没有 Artifact 实体时，Phase 2.1B 的“Artifact 权限继承”只能停留在文档；如果直接按 Task visibility 动态判断，会产生跨 Task 私有文件泄漏。Phase 1.1 的共享 cwd 还会让“应用层 Artifact 权限”与执行器实际文件访问范围脱节。

**需要先决定：**

- Artifact 的字段与存储位置（`artifactId`、`workspaceId`、`sourceTaskId`、`createdByExecutionId`、`storageRef`、`sha256`、`visibility`、`deletedAt` 等）；
- 权限是创建时快照、独立 ACL、还是显式授权表；不能只做动态 Task 继承；
- 跨 Task 引用时，引用者是否获得独立 grant，以及 Task 归档/软删除对 Artifact 的影响；
- 执行器的文件访问边界如何与 Hub 的 Artifact 权限对齐；当前共享 cwd 不足以支撑 private Artifact。

## 3. P1：进入相应阶段前必须补齐

### P1-1 `selectedExecutionId`、`Task.result` 与归档/删除

Phase 2.0 §4.1/§4.3 要求 `selectedExecutionId`，而 Phase 1.1 只有 `latestExecutionId`，`Task.result` 强制等于最新 Execution 的结果（`packages/task-store-v2/index.mjs:200-201`）。多个并行结果中“最新”不等于“选定”，且当前没有选择 API、权限、事件或审计。

同时，Phase 1.1 的 `lifecycle=open/closed` 与 `closeTask` 是单向关闭；Phase 2.0 的 `archivedAt/deletedAt` 要求可恢复。必须定义：

- 选择 Execution 的主体、权限、幂等键和事件；
- `Task.result` 是删除、废弃，还是保留为 selected 的兼容投影；
- `lifecycle`、`status=archived`、`deletedAt` 三者的组合规则；
- 恢复归档/软删除时是否恢复执行能力，以及旧 Session/unknown 的处理。

### P1-2 Workspace root、cwd 与并行写隔离

Phase 2.0 的 Task 建议字段没有 `cwd`/`prompt`，Workspace 建议字段没有根目录；但 DSH 的 `session/new` 需要 cwd（Phase 1.1 `packages/dsh-acp-v2/index.mjs:111`），Execution 的 `workspaceSnapshot` 也没有具体表示。

Phase 1.1 的 `maxConcurrent=8` 允许不同 Task 并行，而多个 Task 可以指向同一个 `cwd`；没有工作副本或互斥。Phase 2.0 §4.4 明确不允许默认共享可写目录。必须定义 Workspace root、每个 Execution 的工作副本/锁，以及 `workspaceSnapshot` 是 commit、manifest 还是目录快照。否则并行 Execution 只能降级为串行或使用互斥。

### P1-3 Execution feedback / `awaiting_input`

Phase 2.0 §4.6/§8 要求 `awaiting_input`、Decision Request/Input Request；Phase 1.1 的 Execution 状态没有 `awaiting_input`，`DshAcpExecutor.run()` 只发送一次 `session/prompt` 并等待终态，没有把新的用户输入送回同一 Execution 的通路。

必须先定义：

- `awaiting_input` 是否属于 Execution 状态，还是单独的 `inputRequest` 状态；
- 输入请求的 ID、超时、幂等、权限和审计；
- Agent 决策与用户确认的区分；
- DSH ACP 是否真的支持运行中输入；如果不支持，Phase 2.3 只能做“结束当前 Execution 后新建 Execution”，不能伪装成同一 Execution 续接。

### P1-4 Event/Message 的 Workspace 隔离与关联链

Phase 1.1 的 `DomainEvent` 有 `eventId/sequence/revision/time`，但没有 `workspaceId`、`correlationId`、`causationId`，`getEvents` 返回全局序列（`packages/dsh-acp-v2/index.mjs:202`）。Phase 2.0 §6/§12 要求 Message/Event/Command 分离、稳定版本、关联链和权限撤销后的订阅失效。

如果直接复用当前全局事件游标，private Task 的事件会跨 Workspace 泄漏；如果给事件补 `workspaceId`，还需要定义旧事件的迁移/标记方式。Phase 2.2 应在消息模型冻结前先定义事件可见性和游标语义。

### P1-5 requestKey 的作用域与多 Principal 幂等

Phase 1.1 的 requestKey 在整个 Store 全局唯一（`packages/dsh-acp-v2/index.mjs:49/61`），没有 Principal/Workspace 作用域。多用户/多 Agent 接入后：

- Alice 和 Bob 可能生成相同 key；
- 幂等重放返回原 Execution 前没有重新检查调用者权限；
- Agent 的 key 可能与用户委托 key 混淆。

需要决定 requestKey 是 `(workspaceId, principalId, key)` 还是全局但必须绑定授权主体；重放必须重新做权限检查，不能因为知道 key 就返回旧 Execution。

### P1-6 DSH Adapter 接口与 Phase 2.5 的顺序

Phase 2.0 §10 建议 `createExecution/resumeExecution/cancelExecution/streamEvents/getResult/getArtifacts/interactiveInput`，但 Phase 1.1 的实际接口是 `createTask/startExecution/dispatchQueued/getExecution/...`，并且：

- `resumeTask` 只恢复上下文，不接受 prompt，不能恢复某个 Execution 的结果；
- 没有 `getArtifacts`；
- 没有 `interactiveInput`；
- `getResult` 实际是 `getExecution.result`，且带 `resultIntegrity`，不是一个简单的 result 查询；
- DSH ACP 没有 execution 级结果回放（Phase 1.1 已反复确认）。

Phase 2.0 将 DSH Adapter 放在 Phase 2.5，而 Phase 2.3 已经要求 Execution Feedback。若 2.3 必须端到端真实执行，则顺序倒置；若 2.3 只做 Hub 侧接口/模拟，应明确“真实 DSH feedback 在 2.5 才接入”。此外 2.5 不是全新 Adapter，而是对现有 Phase 1.1 Executor 的能力补齐/重构，阶段描述应相应调整。

### P1-7 Store/API 迁移没有独立阶段

Phase 2.0 §4.2 要求结合 Phase 1.1 数据模型迁移，但阶段计划没有“数据模型迁移/兼容层”阶段。至少需要处理：

- `taskId -> id`、`executionId -> id` 的 API 命名；
- `Task.status` 重新定义、`selectedExecutionId`、archive/delete 字段；
- `SessionBinding` 的 Task 级/Execution 级基数；
- 旧 Task 没有 workspace/owner/visibility 的迁移；
- `Task.result` 与 selected Execution 结果的关系；
- 现有 Store 严格投影（latest=最后创建、result=latest、active 单值）如何演进。

这些不是“实现细节”，会改变公共 API 和持久化格式，应在 Phase 2.1A/2.1B 之前冻结迁移策略。

### P1-8 Task/Workspace Owner 与角色重复

Phase 2.0 的 Workspace 同时有 `owner` 字段和成员角色 `Owner`；Task 同时有 `owner` 字段和“单一 Owner/Controller”表述。需要指定唯一权威来源：

- Workspace Owner 是 `workspace.owner` 还是 `workspaceMembers` 中的 Owner 角色；两者不一致时以谁为准；
- Task Owner 是否可变、是否可转移、转移需要什么权限；
- `createdBy`/`requestedBy`/`owner`/`controller` 哪些是不可变审计字段，哪些是可变更授权字段。

否则 Phase 2.1A 的 RBAC 和 Phase 2.1B 的 private 可见性会各自实现一套判断。

## 4. P2：文档精确性与后续阶段问题

### P2-1 Phase 1.1 文档内部仍有已撤回的分支

- `docs/phase-1.1-design.md:3` 明确“特别撤回 interrupted→completed 的同事务收据恢复路径”，但同文件 `:55` 的状态图仍保留 `interrupted --> completed`。
- `docs/phase-1.1-design.md:113` 说 close/resume 可作为“回合边界”，而 `docs/contracts.md:39` 说 close/resume 本身不被当成通用回合屏障。
- `docs/phase-1.1-design.md:103` 写 `startExecution(new requestKey, retryOf, acknowledgeUnknownExecutionId)`，实际契约是 `acknowledgeUnknownExecutionIds` 数组，没有 `retryOf`；`docs/contracts.md` 和 `packages/contracts/v2.d.ts` 与设计文不一致。
- 设计文提到 `ordinal`、`inputHash`、`sessionBindingId`，实际 `Execution` 使用 `bindingId`，没有 `ordinal`/`inputHash` 持久字段。

这些是文档/实现命名或历史残留，不改变 Phase 1.1 的主要结论，但会让 Phase 2 设计者误以为存在额外证据或 API。应在本报告后单独修文档，或在 Phase 2.0 冻结时明确以 contracts/types 为准。

### P2-2 基线字段仍是“建议字段”，不足以作为实现契约

Phase 2.0 多处使用“建议字段”，且 §15 明确 Owner/委托、多 Execution 聚合、归档控制等仍未最终决定。Phase 2.0 可以作为方向，但不能作为 Phase 2.1B 的逐字段实现规格。建议在 Phase 2.0 输出中增加：

- 每个字段的存在性、可空性、不可变性、索引/唯一性；
- 状态迁移矩阵和非法迁移错误码；
- 每个新 API 的幂等键、权限、错误码；
- 兼容/迁移规则。

### P2-3 Message/Event/Command 的协议和 ACK 尚未定义

基线 §6 的 Envelope、投递状态、ACK、至少一次、顺序、多订阅者都是正确方向，但没有：

- Message 持久化 schema 和幂等键；
- ACK/lease/重投策略；
- Event 与 Message 的 ID 关系；
- 权限撤销后订阅失效的具体行为；
- 旧 `DomainEvent` 的迁移。

这是 Phase 2.2 的设计输入，不应被当作 Phase 2.0 已冻结的接口。当前 Phase 1.1 的紧凑事件模型可以作为 Event 的基础，但不能直接声称已满足 Phase 2.0 的 Message/Command/ACK 要求。

### P2-4 Phase 2 阶段顺序需要标明“接口/模拟/真实”

Phase 2.3 Execution Feedback 与 Phase 2.5 DSH Adapter 的依赖关系未说明；Phase 2.4 Automation 依赖 Message/Event，但未说明事件可见性和权限。建议每个阶段明确：

- 本阶段只做 Hub 侧接口/状态机/模拟；
- 真实 DSH 能力在哪个阶段接入；
- 哪些能力需要 ACP 能力探测；
- 未支持时的降级行为（例如无 artifacts、无 interactive input、不能 resume execution）。

### P2-5 Phase 1.1 没有 Workspace/Artifact/Message 概念，属于新能力而不是“已实现”

这一点应在 Phase 2.0 的差距说明中显式列出，避免读者把 Phase 1.1 的 `Task.cwd` 当作 Workspace、把 `Task.result` 当作 Artifact、把 `DomainEvent` 当作 Message。当前仓库没有任何 `Workspace`、`Artifact`、`Principal`、`Message` 表或字段；这些都需要新增，而不是映射已有对象。

## 5. 四个重点专题的结论

### 5.1 Task Owner

**结论：P0。** Phase 2.0 已经正确区分 `owner` 与 `createdBy`，但还缺少 `requestedBy` 与 Controller 的完整关系；private 规则却只写“创建者”。在 Alice → AstrBot 的委托场景中，任意一种简单解释都会错：

- 用 `createdBy` 当创建者 → Alice 可能看不到自己的 Task；
- 用 `requestedBy` 当创建者 → Agent 可能越权看到私有 Task；
- 只允许 Workspace Owner/Admin → 单人 Workspace 之外的实际委托人无法访问。

必须在 Phase 2.1B 前冻结可见性矩阵和委托授权结构。不能从 Phase 1.1 的 `cwd` 或本地账户推断 owner。

### 5.2 多 Execution

**结论：P0。** Phase 1.1 支持“多个历史 Execution、每 Task 最多一个活动 Execution”；Phase 2.0 支持“同一 Task 多个并行 Execution”。这不是字段增加，而是 Store 投影、Executor 门禁、Session Binding、取消/关闭和 Task 状态的整体变化。需要先设计并迁移，不能直接在现有 `activeExecutionId` 旁边加一个数组作为展示字段。

### 5.3 Private Task 的委托访问

**结论：P0。** 需要同时记录并校验：实际用户、调用 Agent、Task Owner、Controller、委托 grant、Workspace 角色。只增加 `requestedBy` 字符串不够；还需要委托范围/有效期/撤销和“Agent 自主操作”标记。所有读取（`getTask`、`listTasks`、`getExecution`、`listExecutions`、`getEvents`、`subscribeEvents`）必须在同一授权层过滤，不能只保护写操作。

### 5.4 Artifact 权限继承

**结论：P0（权限模型）/P1（存储实现）。** 需要一个 Artifact 实体和独立的授权表示。建议不要做“动态继承 Task.visibility”这种单值规则，因为：

- Task 变公开会改变所有引用它的 Artifact 可见性；
- 多 Task 引用同一文件时，无法满足“每个引用独立检查”；
- Task 软删除/归档后，Artifact 生命周期不明确。

建议在 Artifact 创建时记录来源 Task/Execution、Workspace、存储引用和显式 ACL/可见性快照；跨 Task 引用新建独立 grant。任务可见性变化不应隐式扩大其他引用者的权限。

### 5.5 接口可落地性清单

| 基线接口/概念 | 当前可依据的实体 | 可落地性判断 |
|---|---|---|
| Task `owner`/`createdBy`/`requestedBy`/Controller | 无 Principal、无 Task 归属字段 | 不可直接实现；先冻结角色模型 |
| Task `visibility` private | 无 Principal、无读过滤 | 不可直接实现；会泄漏或误隐藏 |
| `selectedExecutionId` | 只有 `latestExecutionId`/latest result | 需新增字段、选择 API、权限和事件 |
| `getArtifacts` | 无 Artifact 实体；ACP 未证明文件产物接口 | 不可承诺；先做能力探测和 Artifact 模型 |
| `interactiveInput`/`awaiting_input` | 只有一次 `session/prompt` 等待终态 | 当前 DSH 路径不可直接实现 |
| `resumeExecution` | 只有 `resumeTask` 上下文恢复，无 execution replay | 不能恢复原 Execution 结果 |
| Workspace root | Workspace 字段无根目录；Task 无 `cwd` | Execution 无法确定可写目录 |
| `workspaceSnapshot` | 无 Git/worktree/manifest 表示 | 需先定义快照格式和责任边界 |
| Message/ACK/Command | 只有紧凑 DomainEvent | Phase 2.2 新能力，不能冒充已实现 |
| `Task.status=awaiting_decision` | 无 Decision/Input Request 模型 | 需 Phase 2.3 的决策实体承接 |

这些不是“实现时再补”的细节，而是会改变公共 API、权限边界或持久化格式的接口。必须先冻结，再进入对应阶段。

## 6. 建议的冻结顺序

在开始 Phase 2.1B 之前，建议按以下顺序形成设计决策（不要求本轮实现）：

1. **Principal/Workspace/RBAC + 委托授权模型**：字段、认证上下文、权限矩阵、审计主体。
2. **Task 角色模型**：owner / requestedBy / createdBy / controller / delegation 的值域、可空性、不可变性和迁移。
3. **Task/Execution 状态机分离**：目标级 Task 状态、Execution 状态、聚合矩阵、`selectedExecutionId` 决策入口。
4. **并行 Execution 与 Workspace 隔离**：SessionBinding 基数、工作副本/锁、`workspaceSnapshot` 表示、取消/关闭语义。
5. **Artifact/文件权限**：实体、存储、ACL 快照、跨 Task 引用、删除/归档生命周期。
6. **Event/Message/Command 与授权查询**：可见性过滤、事件 envelope、ACK、游标和权限撤销。
7. **迁移**：Phase 1.1 `Task/Execution/Binding` 到 Phase 2 字段的显式映射；legacy owner/visibility 不猜测。
8. **DSH Adapter 能力探测**：先确认 artifacts/interactive input/execution resume 是否真实支持；不支持的接口必须在 API 中显式降级，不得先定义后假设。

## 7. 本次没有修改的内容

- 未修改 `packages/` 下任何业务代码、Contracts、Store、Executor 或 ACP Transport。
- 未修改 Phase 1.1 既有设计/验收/独立审查结论。
- 未开始 Phase 2 实现，未接入 Cyrene、AstrBot、QQ/NapCat 或 Bilibili。
- 本报告是基于代码/文档的静态设计审查；没有新增真实 DSH、多用户或权限测试。Phase 2 的结论仍需后续实现和独立验收。

## 8. 最终判断

Phase 1.1 可以作为 **执行可靠性基础**，但不能直接充当 Phase 2.0 的 **身份、权限和多 Execution 基础**。Phase 2.0 的方向与 Phase 1.1 的单 Task 可靠执行不冲突；真正冲突的是：

- 单活动 Execution 与并行 Execution；
- Execution 状态与 Task 目标状态；
- 单客户端无身份与多 Principal/Workspace；
- 私有 Task 的创建者/委托者/控制者；
- 文本结果与 Artifact 权限。

因此建议：**Phase 2.0 设计可以继续，Phase 2.1A 可以做身份/Workspace 原型；Phase 2.1B 及之后的私有 Task、Artifact、多 Execution 实现必须等待上述 P0 决策冻结。** 当前状态为 **CONDITIONAL DESIGN PASS**，不是 Phase 2 实现通过。
