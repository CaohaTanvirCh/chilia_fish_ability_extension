# Phase 2.1A Design Review：Identity & Workspace 一致性审查

状态：**Design Review Report / Conditional Design Pass / Implementation Not Started**

日期：2026-11-10（Asia/Hong_Kong）

审查对象：`docs/phase-2.1A-identity-workspace-design.md`

审查基线：

- Phase 2.0 冻结基线：`be36ba7`（AD-01 至 AD-14）
- Phase 2.0.1：`ad736e5`
- Phase 2.0.2：`4581990`
- 当前 Phase 1.1 代码：`packages/contracts/v2.d.ts`、`packages/task-store-v2/index.mjs`、`packages/dsh-acp-v2/index.mjs`、`apps/companion-hub/main.mjs`、`scripts/windows-config.mjs`

审查性质：只读文档与代码的一致性复核。没有实现、没有运行权限测试、没有修改 Contracts/Store/Executor/ACP Transport/配置/测试。本文不是实现验收，也不是外部安全审计。

---

## 0. 结论

**CONDITIONAL DESIGN PASS。**

Phase 2.1A 设计文档可以作为 Contracts v3、Store v3、API v3 的设计输入，但必须满足以下条件：

1. 不把当前 v2 的 `commit(expectedRevision, changes)` 当作授权提交接口；实现前必须先有 `commitAuthorized` 的 v3 契约。
2. 关闭 P1：批量撤权事务容量、过期物化、Ownerless 恢复、本地 stdio 信任边界。
3. Phase 2.1B 仍不开始；Phase 2.1A 也不因本文通过而进入代码实现。

未发现 AD-01 至 AD-14 的未解释冲突。发现的主要问题不是“设计方向错误”，而是**实现前置条件和边界尚未被工程化**，尤其是撤权/过期的时间与事务边界。

### 0.1 问题分级

| 级别 | 数量 | 说明 |
|---|---:|---|
| P0 | 0 个设计冲突；1 个实现门槛 | 当前 v2 Store/API 不能承载授权提交，必须先做 v3；这是门槛，不是本文设计矛盾 |
| P1 | 4 | 批量撤权容量、过期物化、Ownerless 恢复、本地 bootstrap 信任边界 |
| P2 | 7 | Agent Admin、邀请投递、审计拒绝限流、错误码、命名、未来二次委托、AD-02 历史引用措辞 |

### 0.2 审查范围限制

- 没有真实多 Principal、多 Workspace 或 Delegation 运行测试，因为当前代码没有这些实体。
- 没有对真实 DSH ACP 做撤权/dispatch 竞态注入；第 8 节的结论来自现有 Phase 1.1 证据边界和代码路径。
- 没有验证 Windows 文件 ACL、进程树终止或 fencing；这些仍归 AD-11/AD-13。
- “独立”指基于当前仓库代码和冻结 AD 的独立复核，不代表外部第三方审计。

---

## 1. 与 AD-01 至 AD-14 的逐项核对

| AD | 核对点 | 结论 | 证据/备注 |
|---|---|---|---|
| AD-01 | Task goalStatus/lifecycle/executionSummary 分离；本设计不重新定义 | 通过 | 设计第 13.2 节；没有把 Workspace/Principal 状态塞进 Task goalStatus |
| AD-02 | Principal/Workspace/Membership/Delegation 一级实体；owner/createdBy/requestedBy/controller 分离 | 通过，带安全收紧与生命周期例外 | 设计第 4/5/6 节；Agent 不能 Owner/Admin 是额外限制；主体 disabled/deleted 后 owner/requestedBy 仅保留审计引用，必须无有效权限且 controller frozen |
| AD-03 | private Task 可见性；Agent 同时满足自身、用户、委托权限 | 通过 | 设计第 9.2 节；private 读取矩阵和 6.4 交集公式 |
| AD-04 | Artifact 独立授权；Task 可见性只在创建时提供默认值 | 通过 | 设计第 9.4 节；不按当前 Task 角色动态授权 |
| AD-05 | Store v3/API v3；v2 只读迁移；不猜测 legacy | 通过 | 设计第 14.4 节；迁移必须显式 workspace/owner |
| AD-06 | Artifact ACL 创建时物化；Controller 转移/冻结同步 | 通过 | 设计 6.8、9.4；Delegation 不替代 ArtifactGrant |
| AD-07 | Task/Execution/Lifecycle 完整矩阵 | 通过（不改动） | 设计明确 Task 详细状态归 2.1B；身份变更不产生新 goalStatus |
| AD-08 | 撤销/过期/成员失效冻结 Controller；运行中 Execution 继续 | 通过，过期物化有 P1 | 设计 4.4/6.7/11.4；撤销事务原子冻结；过期逻辑立即拒绝但持久化物化可能延迟 |
| AD-09 | Event workspace/system scope；每次重新授权 | 通过 | 设计 7.5、11.5；旧 cursor 不是凭证 |
| AD-10 | requestKey 五元组 | 通过 | 设计 7.4、12.1；重放先重新授权 |
| AD-11 | 多 Execution 数据模型与 Workspace mutex 分离 | 通过 | 设计 5.1、9.3；不改变 AD-11 的租约语义 |
| AD-12 | 授权检查与状态写入同一 Store commit | 通过 | 设计 7.3/7.4；`commitAuthorized` 是硬约束 |
| AD-13 | Lease 强制释放需要进程终止/fencing/隔离；否则 quarantine | 通过 | 设计 9.3；身份层不能绕过 evidence |
| AD-14 | interrupted 与 unknown 都进入 awaiting_decision/风险确认 | 通过（不改动） | 设计 13.2；身份撤销不创建新 Execution、不清除风险 |

### 1.1 AD-02 的“收紧”是否构成冲突

设计规定：

- Workspace Owner/Admin 必须是 User；
- Agent 只能 Operator/Viewer；
- Agent 可以自主拥有 Task，但不能自主拥有 Workspace。

AD-02/AD-03 没有要求 Agent 必须能成为 Workspace Owner/Admin，也没有把“Agent 可自主创建 Task”扩展为“Agent 可治理 Workspace”。因此这是**在冻结边界内收紧**，不是改写。需要未来若产品要求 Agent Admin，新增 AD，而不是在实现中偷偷放宽。

### 1.2 AD-08 的“立即冻结”与过期物化

设计把授权失效分成两层：

1. **逻辑失效**：Store commit 按 `now >= expiresAt` 立即拒绝新命令；读取投影把 Controller 视为 frozen。
2. **物化失效**：`controlState=frozen`、`delegation.expired` 由 reconciler 写入。

这满足“新命令不能利用过期委托”，但不满足“到期毫秒级一定已经写入 frozen 状态”。审查将其列为 P1，而不是宣称 AD-08 已完全工程化：

- 需要在 Store v3 中保证读取投影与写入检查使用同一个 effective control 计算；
- 需要有启动扫描/最早过期调度；
- 需要测试“过期后、物化前”所有写路径均拒绝。

### 1.3 AD-12 的核心核对

设计明确禁止：

```text
authorize() -> true
commit(changes)
```

要求：

```text
commitAuthorized(context, operation, target, input)
  -> 同一临界区校验 auth + 状态
  -> 同一事务写 changes/events
```

这与 AD-12 一致。需要特别防止实现时把 `context` 当成“已经验证过的凭证”：Store 必须重新查 Principal/Membership/Delegation/资源权限，不能只比较版本号。

---

## 2. 与 Phase 1.1 可靠性不变量的兼容性

| Phase 1.1 不变量 | 设计是否保持 | 审查意见 |
|---|---|---|
| 终态 Execution 不可覆盖 | 是 | 撤权/停用/成员移除都不改 Execution 终态；只冻结 Controller |
| unknown/interrupted 不自动重发 | 是 | 撤权和过期不创建新 Execution；queued 不自动 dispatch |
| 单 Store 所有者 | 是 | `commitAuthorized` 仍在单 Store 临界区；没有第二写入者 |
| 原子 commit | 是 | 身份/成员/委托与业务状态同一事务 |
| 事件单调序列 | 是 | 身份/成员/委托事件进入统一 sequence；不重写历史 |
| 不承诺 exactly-once | 是 | 第 8 节明确 commit 与外部 transport 的窗口 |
| 不伪造终态 | 是 | 撤权不把 running 改 cancelled；unknown 保持 unknown |
| requestKey 幂等 | 是 | AD-10 五元组；重放先授权 |
| `acknowledgedBy` 不可信 | 是 | 设计要求从 context 生成；当前 v2 仍接受字符串，属于未实现差距 |
| 终态清理可重试 | 是（不涉及） | Identity 不改 Binding 清理；仍由 Phase 1.1 机制处理 |

### 2.1 一个需要保持的细节

Phase 1.1 的 `startExecution` 会检查 `unresolvedExecutionIds` 并要求显式 acknowledge。Phase 2.1A 的身份/委托变更不能：

- 清空 `unresolvedExecutionIds`；
- 把 `interrupted`/`unknown` 变成 terminal；
- 因撤权自动创建新 Execution；
- 因 Owner 转移清除 `duplicateExecutionRisk`。

设计没有修改这些字段，但实现时必须确保授权层只做“拒绝/允许”，不改写执行风险事实。

---

## 3. 权限矩阵越权路径分析

### 3.1 Viewer

- 设计只允许 workspace-visible 读取；private Task 无权限。
- 控制/创建/管理全部拒绝。
- Artifact 仍按 ACL；Viewer 不因 Workspace 读取权获得 private Artifact。
- 未发现越权路径。

### 3.2 Operator

- Operator 可以创建 Task，但只有自己创建的 Task 才默认 controller。
- 设计明确“Workspace Operator 不是所有 Task 的 controller”。
- 风险点：Operator 作为 User grantor 可以创建 Delegation。设计限制为“对自己有权限的 Task”，且不能授予治理权限。需要在 Contracts 中强制 scope 依赖和 resourceScope 校验，不能只靠 UI。
- 未发现必须升级为 P0 的路径；实现时必须测试 `Operator -> Delegation -> 另一个 Agent` 不能扩权。

### 3.3 Agent（Operator 成员）

- 可以自主创建 Task；owner=controller=Agent；不能治理 Workspace。
- 不能成为 Owner/Admin；不能创建 Delegation。
- 风险点：Agent 自主创建的 private Task 只有 Agent/Workspace Owner/Admin 可读；如果 Agent 被停用，Task 会冻结，需要 Owner/Admin 接管。设计已覆盖。
- 未发现越权路径。

### 3.4 Delegated Agent

- 设计使用交集公式；要求 Agent 自身 Membership、grantor 当前权限、grant scope/resource、资源 ACL 同时满足。
- 风险点：如果实现只检查 grant，不检查 grantor 当前权限，Agent 可以在 grantor 被降权后继续操作。设计 6.4 明确要求动态检查 grantor 当前权限，必须在 Store commit 内实现。
- 风险点：`artifact:read` scope 不能替代 ArtifactGrant；设计已明确。
- 未发现设计层越权路径；实现测试必须覆盖“grantor 降权/移除/停用”。

### 3.5 Owner/Admin

- Owner/Admin 可以审计读取 private Task/Artifact，但不能仅凭角色执行/取消/修改。
- 设计要求 `task:control` 走显式 takeover，并审计 reason。
- 风险点：如果实现把 `task:control` 的 Owner/Admin 分支写成“角色即通过”，会绕开 Controller 和 Task 级审计。这是实现风险，不是设计矛盾；必须在 Store 的策略函数中区分 `takeover=true` 的显式命令。
- 风险点：Owner 转移后旧 Owner 变 Admin；旧连接必须重新授权。设计已要求 `authorizationRevision`/版本检查。
- 未发现设计层越权路径。

### 3.6 Artifact

- 设计严格遵循 AD-06：Artifact owner/visibility/ArtifactGrant，Workspace Owner/Admin 审计读取。
- Delegation 的 `artifact:read` 不替代 ArtifactGrant；这修正了 Phase 2.0.1 早期文字可能被误读为“委托直接授予 Artifact”的风险。
- 风险点：Owner/Admin 的 `artifact:grant` 可能被实现成无条件分享；设计要求显式管理操作和审计，但仍需 Phase 2.1B 冻结“审计读取”和“分享”的边界。
- P2，不是本轮 P0。

### 3.7 System

- System 不能通过业务 API 认证；只能内部操作。
- 风险点：内部 `system:recovery` 如果暴露成普通方法，会绕过所有权限。设计要求离线/内部命令与显式审计；实现时必须把它放在独立管理入口，不进入 `allowed` 方法表。
- P1 运维边界，见 5.3。

### 3.8 事件与 cursor

- Event 读取按 workspace scope 和资源可见性过滤；cursor 不授权。
- 风险点：`authorization.denied` 如果写入 workspace 事件流，可能泄漏 target 存在性；设计把它放 system/admin audience。实现需验证。
- 未发现设计层越权路径。

---

## 4. 授权与撤权竞态分析

### 4.1 TOCTOU

设计将最终检查放入 Store commit，符合 AD-12。审查确认：

- 入口检查仅是快速拒绝；
- 撤权事务同时写 grant 状态、auth revision、Task frozen、ArtifactGrant、事件；
- 写入 commit 的预期 auth revision 与当前不一致时返回 stale/revoked；
- 不允许“先 authorize 后 commit”。

**结论：设计层关闭了 AD-12 指出的 TOCTOU；实现仍需并发测试。**

### 4.2 授权提交与外部 dispatch

设计采用“commit 成功即接受，撤权不追溯”的语义 A。审查认为这是与 Phase 1.1 和 AD-12 最一致的方案：

- 不需要在 transport 前引入一个无法原子化的第二次授权；
- 不会把可能已发送的执行伪造成 cancelled；
- 仍保留 commit 后、发送前撤权的副作用窗口，但明确记录为不可消除边界；
- 不承诺 exactly-once。

语义 B 的问题是“检查后发送”仍有窗口，且可能在发送已发生但未确认时错误标为 `local_not_submitted`，违反 Phase 1.1 的 terminal evidence 约束。审查不接受把语义 B 描述为“消除竞态”。

**结论：接受语义 A；必须在实现文档/测试中保留该边界说明。**

### 4.3 撤权事务的批量化

设计要求撤销 Delegation 时在同一事务冻结所有关联 Task。当前 v2 Store 的 `maxTasks=1000`，理论上可在一个 JSON 快照中完成，但：

- 事件数量、ArtifactGrant 数量、序列化大小可能接近容量上限；
- 如果未来提高 Task 上限，事务可能不可用；
- 不能把“冻结”拆成多个事务，否则中间窗口仍有控制权。

这是 **P1**，需要在 Store v3 设计时确定：

- 最大影响集和容量拒绝策略；
- 撤权失败时 grant 是否仍保持 active（不能半撤）；
- 是否需要把“大批量冻结”设计成单独的治理事务，但仍必须原子；
- 事件是否合并为一条摘要事件以控制容量。

### 4.4 过期

设计在 commit 中按服务端时间拒绝过期 grant，并依靠 reconciler 物化 frozen。审查确认：

- 新命令不会因“尚未物化”而通过；
- 读取投影必须使用 effective control，不能只看存储的 `controlState`；
- 需要启动扫描和最早过期调度；
- 需要测试“过期后、物化前”的读/写/订阅。

**结论：设计逻辑成立，但工程化未完成，P1。**

### 4.5 Owner 转移

设计在同一事务更新 Owner 字段、两个 Membership 和 auth revision。审查确认：

- 旧 Owner 默认降为 Admin，不会留下 owner-only 权限；
- 旧连接下次请求必须重新授权；
- Task owner/controller 不自动变化，避免身份治理操作意外改变 Task 业务归属。

风险点：旧 Owner 仍是 Artifact owner 时保留 Artifact 所有权，这是 AD-06 的独立所有权，不是权限残留；必须在 UI/审计中解释清楚。P2 文档问题。

### 4.6 Membership 移除与旧 Cursor

设计要求每次续读重新授权，成员移除后返回 `AUTHORIZATION_REVOKED`，不返回空列表。这与 AD-09 一致。

风险点：已经推送/返回的数据不能追溯撤回；设计应明确 read API 的固有边界，不能声称“撤权后旧客户端看不到已缓存内容”。P2 文档边界。

---

## 5. Bootstrap 身份安全边界

### 5.1 失败关闭

设计明确：

- 无 `identity` 配置 -> 启动失败；
- Principal 不存在/disabled -> 启动失败；
- Workspace 不存在/archived -> 启动失败；
- `allowAnonymous=true` -> 启动失败；
- 配置 ID 与 bootstrap 记录不一致 -> 启动失败；
- 不自动创建、不回退到本机账户。

这关闭了“匿名 fallback/默认全权限”的 P0 风险。

### 5.2 本地 stdio 不是认证

设计明确本地 stdio 是本机信任边界：

- 能启动 Hub/写 stdin 的本机进程可以代表 bootstrap Principal；
- 不支持多用户隔离；
- 只允许单一受限 Workspace；
- 不暴露网络端口。

这是正确的边界声明。需要确保实现时：

- 不把 `config/windows.json` 的路径/内容写日志；
- 不接受第二个 stdio 客户端；
- 不在 `ready` 中返回 rootPath；
- 不把 bootstrap Principal 当作“系统管理员”跨 Workspace 使用。

### 5.3 Ownerless 恢复

设计规定：

- 正常 remove/leave/降级/disable 最后一个 Owner 被拒绝；
- 系统强制停用/删除最后一个 Owner 时，Workspace 进入 `ownerless_locked`；
- 只有 `system:recovery` 可以恢复；
- 普通 Admin 不能夺取 Owner。

审查认为这是安全的方向，但 **P1**：

- `system:recovery` 的入口、认证、审批和审计未定义；
- 如果恢复工具是本地 CLI，它可能被任何本机管理员使用；
- 需要明确“离线恢复”不是业务 API，且不能在没有审计的情况下改 Store。

### 5.4 Bootstrap 初始化的原子性

设计要求一次性 CLI 创建 system principals、User、Workspace、owner Membership、bootstrap 记录和事件。审查确认：

- 必须在一个 Store commit 中完成；
- 失败不能留下半初始化 Workspace；
- 正常启动不能自动补建；
- root 校验必须在写入前完成。

当前没有实现，属于 Phase 2.1A 代码门槛。

---

## 6. P0 / P1 / P2 清单

### 6.1 P0

#### P0-GATE：当前 v2 不能承载授权提交

**性质：** 实现门槛，不是设计冲突。

证据：

- `packages/task-store-v2/index.mjs` 的 `commit(expectedRevision, changes)` 没有 actor/authorization 参数；
- `packages/dsh-acp-v2/index.mjs` 的读写方法没有 Principal/Workspace 过滤；
- `packages/contracts/v2.d.ts` 没有 Principal/Workspace/Delegation 类型；
- `apps/companion-hub/main.mjs` 没有连接身份，`acknowledgeIntegrityAlerts` 仍接收 `acknowledgedBy`。

结论：不得在 v2 上添加可选 `principalId` 参数来“先实现”。必须先冻结 Contracts v3/Store v3/API v3；Phase 2.1A 实现仍不开始。

### 6.2 P1

#### P1-01 批量撤权事务容量

- **问题**：一个 grant 可能关联大量 Task；撤销必须在同一事务冻结全部 controller Task，并撤销 snapshot ArtifactGrant。
- **影响**：可能超过 Store 容量/事件上限；拆事务会留下中间窗口。
- **要求**：Store v3 设计必须给出最大影响集、容量拒绝、原子失败和事件合并策略；测试并发撤权。
- **状态**：未关闭。

#### P1-02 过期物化

- **问题**：逻辑过期立即拒绝，但 `controlState=frozen`/`delegation.expired` 需要 reconciler 物化。
- **影响**：读取投影可能短暂显示 active；订阅/UI 可能滞后。
- **要求**：Store/API 使用 effective control；启动扫描；最早过期调度；测试过期后、物化前的所有写路径。
- **状态**：未关闭。

#### P1-03 Ownerless 恢复

- **问题**：系统强制停用/删除最后一个 Owner 后的恢复入口、审批和审计未定义。
- **影响**：可能无法恢复，或恢复工具成为绕过治理的后门。
- **要求**：定义独立离线恢复流程、system principal、双人/本机管理员审批（如适用）、审计事件。
- **状态**：未关闭。

#### P1-04 本地 bootstrap 信任边界

- **问题**：本地 stdio 不能证明调用者是某个真实用户；同机进程可冒充 bootstrap Principal。
- **影响**：不能把本地模式宣传为多用户安全认证。
- **要求**：运维文档明确边界；不暴露网络；单客户端；配置/日志脱敏；未来远程认证单独设计。
- **状态**：接受为 Phase 2.1A 边界，但必须在实现/部署文档中显式声明。

### 6.3 P2

| ID | 问题 | 建议 |
|---|---|---|
| P2-01 | Agent 不能 Admin 是安全收紧 | 若未来需要，新增 AD；当前保持 |
| P2-02 | 邀请只支持已存在 Principal | 外部账户/邮件绑定留到身份提供方阶段 |
| P2-03 | `authorization.denied` 未定义限流/保留 | API v3 设计时冻结；避免日志 DoS 和存在性泄漏 |
| P2-04 | 错误码名称是建议值 | Contracts v3 统一，不能不同 API 不同语义 |
| P2-05 | `WorkspaceMember`/`Membership` 命名未统一 | Contracts 评审时统一，不影响语义 |
| P2-06 | 二次委托仅保留字段 | Phase 2.1A 必须拒绝；未来新增 AD 后才可实现 |
| P2-07 | AD-02 的 active 成员措辞与 disabled/deleted 历史引用 | Contracts v3 注释/校验明确“赋值时 active、历史引用无权限” |

---

## 7. 未解决冲突与边界

### 7.1 已解释的差异（不是冲突）

1. **Agent 不能 Owner/Admin**：AD-02 没有要求 Agent 必须能治理 Workspace；这是安全收紧。
2. **过期物化延迟**：逻辑授权立即失效；持久化状态由 reconciler 补齐。AD-08 的“立即失效”在安全语义上成立，但“立即写入 frozen”需要 P1 工程化。
3. **Workspace 删除是软删除**：AD-05/Phase 2.0 没有要求物理删除；保留 root/Task/Artifact 符合审计和 AD-06。
4. **Ownerless 例外**：唯一 Owner 被系统强制停用/删除时，active owner 规则有显式例外；这是为了不阻塞全局 principal 管理，同时锁定治理。Store 必须编码该例外。
5. **Delegation 不授予 Artifact**：Phase 2.0.1 早期文字提到委托 Agent 读取 Artifact；AD-06 已改为创建时 ACL 快照，本文按 AD-06 执行。
6. **disabled/deleted 主体的 Task 历史引用**：AD-02 要求 owner/requestedBy/controller 是 active 成员；设计把它解释为赋值/转移时的约束，主体事后停用/删除时保留审计引用但不保留权限。Store 必须能区分“历史引用”和“有效授权”，否则删除主体只能被迫批量改写 Task owner，反而破坏不可变审计。

### 7.2 仍需确认的假设

- 本地 bootstrap 只支持 User；本地 Agent 连接不在 Phase 2.1A。
- `maxTasks=1000` 是批量撤权的现实上限；如果 v3 改变上限，需要重审。
- Hub 服务端时钟是授权时间的权威；客户端时间不参与。
- `authorizationRevision` 全局单调，宁可让无关写入 stale，也不放宽原子性。
- Phase 2.1B 仍负责 Task/Artifact 的详细字段、可见性迁移和 `selectedExecutionId`。

---

## 8. 最终判断

Phase 2.1A 设计在以下意义上通过：

- Principal/Workspace/Membership/Delegation 的边界清楚；
- `actor`、`createdBy`、`requestedBy`、`owner`、`controller` 没有被合并；
- 写路径的最终授权被放入 Store 原子 commit；
- 读路径有统一过滤和跨 Workspace 拒绝；
- 撤权/过期/成员失效不会伪造 Execution 终态；
- bootstrap 不提供匿名 fallback；
- 与 AD-01 至 AD-14 没有未解释冲突。

但不能判定为“可实现完成”：

- 当前 v2 没有承载能力；
- P1 的批量撤权、过期物化、Ownerless 恢复和本地信任边界仍需工程化；
- Phase 2.1B 仍被冻结；
- 本轮没有代码、测试或真实多用户证据。

**建议：接受为 Phase 2.1A 设计基线，进入 Contracts v3/Store v3/API v3 设计评审；不开始 Phase 2.1A 实现，不进入 Phase 2.1B。**
