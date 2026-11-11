# Phase 2.1A.11 Code-to-Design Traceability Audit

状态：**AUDIT ONLY / DOCS-ONLY / CODE NOT APPROVED / PHASE 2.1B NOT APPROVED**

- 基准 commit：`84236fa2ebba6c837a4571efdd22ca4b08cac466`
- 审计对象：`master` 当前 HEAD 的真实源码、调用链、持久化路径与测试
- 审计日期：2026-11-11
- 审计方式：源码静态检查 + 测试证据核对 + 路径行为运行时探测
- 本轮不修改源码、测试、Schema、配置或运行时行为

---

## 0. 结论摘要

当前仓库是一套**可工作的 Phase 1.1 v2 单用户本地 Hub**：单所有者文件 Store、同步 revision、全局事件 sequence、崩溃后 unknown 恢复、终态证据原子提交、同 key Replay、ACP 子进程清理，这些能力真实存在并有测试覆盖。

但 Phase 2.1A 冻结的目标是 **v3 身份、Workspace、授权提交、Authority Version、Revocation Fence、Reconcile、Artifact ACL 与 Workspace Lease**。这些能力在源码中**基本不存在**。不能把 v2 的 `reconcileTask` 当作 Authority Reconcile，不能把 `quarantine` 诊断当作 Fence `quarantined`，也不能把 `state-v2.json` 当作 v3 Store 的落点。

本轮共记录 **26 项问题**：

| 严重程度 | 数量 | 含义 |
|---|---:|---|
| P0 | 5 | 阻断 v3 实现或造成越权、并发写、无隔离等根本性问题 |
| P1 | 13 | 关键能力缺失或与冻结设计冲突，必须在实现前解决 |
| P2 | 8 | 可靠性、可维护性、可观测性或测试证据问题 |

总体判断：

- **v2 可靠性基础：部分可复用。**
- **Phase 2.1A 设计一致性：低。**
- **当前代码不能承载 Phase 2.1A 目标；v3 必须新建，不能在 v2 上追加可选参数。**
- **不具备直接进入 Phase 2.1B 实现的条件。**
- 本结论**不等于实现批准**。

---

## 1. 审计范围、基准与方法

### 1.1 基准核对

审计开始时：

```text
git rev-parse HEAD
84236fa2ebba6c837a4571efdd22ca4b08cac466

git status --porcelain
（空）

git merge-base --is-ancestor 84236fa... HEAD
BASELINE_IS_ANCESTOR
```

因此 HEAD 就是基准 commit，工作区干净，未覆盖或清理任何用户文件。

### 1.2 实际检查的源码

运行时入口与库：

- `apps/companion-hub/main.mjs`
- `apps/companion-hub/lifecycle.mjs`
- `packages/dsh-acp-v2/index.mjs`
- `packages/task-store-v2/index.mjs`
- `packages/acp-transport/index.mjs`
- `packages/windows-paths/index.mjs`
- `packages/contracts/v2.d.ts`

历史/兼容路径：

- `packages/dsh-acp/index.mjs`
- `packages/task-store/index.mjs`
- `scripts/migrate-v1.mjs`
- `scripts/windows-config.mjs`

测试：

- `test/*.test.mjs` 全部 118 个测试
- `test/fixtures/*.mjs`

### 1.3 实际执行的验证

- `npm test`：**118 passed / 0 failed / 0 skipped**，耗时约 7.0 秒。
- 路径行为运行时探测：对 `C:\`、`C:\Windows\System32`、UNC、`\\?\`、`\\.\`、`..`、ADS、保留设备名、结尾点/空格逐一调用 `normalizeWorkspace`。
- 未运行 `npm run test:integration`，因为它依赖本机真实 DSH/ACP 配置，不能作为可重复审计证据。
- 未执行真实断电、磁盘满、网络共享、junction/reparse、远程认证或大规模容量测试。

源码搜索证据：

```text
packages/ + apps/ 中搜索：
  principal|workspaceId|membership|delegation|authorization|
  AuthorityRevocationFence|sourceKey|sourceVersion|artifact|
  lease|fencingToken|commitAuthorized
结果：0 命中
```

这不是“文档没写”，而是**源码里没有对应实现**。

### 1.4 状态定义

| 状态 | 含义 |
|---|---|
| IMPLEMENTED | 源码已有完整路径，且行为可验证 |
| PARTIAL | 有部分能力，但语义、边界或失败路径不满足冻结设计 |
| ABSENT | 源码没有对应实现 |
| CONFLICT | 现有实现与冻结设计直接冲突 |
| UNVERIFIED | 证据不足，不能可靠判断 |

**重要原则：** 设计文档中的伪代码、接口名和状态名不视为实现。只有源码符号、调用链和测试行为才算证据。

---

## 2. 当前代码架构概览

### 2.1 运行时分层

```text
stdin NDJSON
  -> apps/companion-hub/main.mjs:commandLine()
  -> 白名单方法表 main.mjs:39
  -> executor[method](...args) main.mjs:53
  -> packages/dsh-acp-v2/index.mjs:DshAcpExecutor
  -> packages/task-store-v2/index.mjs:ExecutionStore
       -> state-v2.json
       -> store-v2.lock
  -> packages/acp-transport/index.mjs:AcpTransport
       -> 每个 Execution 启动一个 ACP 子进程
```

### 2.2 当前持久化模型

`packages/task-store-v2/index.mjs:14` 的集合是全部权威集合：

```text
tasks
executions
bindings
requests
events
```

`packages/contracts/v2.d.ts` 没有：

- Principal
- Workspace
- Membership
- Delegation
- AuthorityRevocationFence
- authorizationRevision
- Artifact
- ArtifactGrant
- ArtifactReference
- WorkspaceWriteLease

`ExecutionStore` 的 `snapshot()` 和 `commit()` 都是公开方法：

- `snapshot()`：`packages/task-store-v2/index.mjs:246`
- `commit(expectedRevision, changes)`：`packages/task-store-v2/index.mjs:248`

`DshAcpExecutor` 还把 `store` 直接放在实例上：

- `packages/dsh-acp-v2/index.mjs:21`

因此任何库消费者都可以：

```text
executor.store.snapshot()       // 读取全部任务、结果、请求
executor.store.commit(...)      // 绕过 Executor 直接写状态
```

测试本身也这样使用，例如 `test/crash-v2.test.mjs:93` 和 `:99` 直接调用 `x.store.commit(...)` 制造故障状态。

### 2.3 当前信任边界

当前只有一条本地 stdio 通道。`main.mjs` 不验证连接身份，不读取 bootstrap Principal，不建立 Workspace，也不把调用者绑定到任何 actor。

因此当前安全模型事实上是：

```text
能写 Hub stdin 的本机进程
  == 唯一调用者
  == 所有 Task 的隐式所有者
  == 所有读接口的隐式读者
```

这与设计文档第 7 节的 Connection/AuthorizationContext 不是同一模型。

### 2.4 v1 兼容路径

`packages/dsh-acp/index.mjs` 和 `packages/task-store/index.mjs` 仍存在，测试也覆盖它们。它们没有被 `apps/companion-hub/main.mjs` 使用，但仍是可导入的包。

v1 同样没有身份、Workspace、授权、Fence、Artifact 或 Lease。它不应被误认为 v3 的兼容层。

### 2.5 v1 → v2 迁移

`scripts/migrate-v1.mjs:45-52` 只做 v1 → v2：

- 每个旧 Task 生成一个 `unknown` Execution；
- `submission=dispatch_intent`；
- `LEGACY_UNVERIFIED` 诊断；
- 原始 v1 文件保存为 `legacy-v1-backup.json`。

这不是 v2 → v3 迁移，也没有 Principal/Workspace/Owner 映射。

---

## 3. 各审计领域逐项对照

### 3.1 Store 与事务

| 审计点 | 状态 | 源码证据 | 结论 |
|---|---|---|---|
| 单所有者文件锁 | IMPLEMENTED（v2） | `task-store-v2/index.mjs:63-82`；`test/store-v2.test.mjs:98-104` | 有 `wx` 锁、PID 存活检查、recovery guard；进程级所有权成立 |
| 同一进程内写串行化 | IMPLEMENTED（v2） | `commit` 全同步；`task-store-v2/index.mjs:248-274` | 单进程内无 await 窗口，提交是同步临界区 |
| 原子提交 | PARTIAL | `:226-238`；`:272-273` | 临时文件 + fsync + rename；但 rename 后的目录 fsync/close 失败会造成磁盘与内存分叉，详见 P1-05 |
| 崩溃恢复 | IMPLEMENTED（v2） | `:83-136`；`test/store-v2.test.mjs:76-88` | running/dispatch_intent 恢复为 unknown；queued/not_started 保持；终态 binding 未清理恢复为 unknown |
| revision | PARTIAL | `:15`、`:254`、`:272` | 只有全局 `revision`；没有实体 revision 强制，也没有 `authorizationRevision` |
| event sequence | IMPLEMENTED（v2） | `:240-245`、`:213-220` | 全局严格递增，事件与状态同一次持久化 |
| 数据损坏处理 | PARTIAL | `:138-221`、`:83-96` | 严格 fail closed；但没有校验和、备份、自动修复或恢复报告 |
| 容量控制 | PARTIAL | `:15`、`:222-225`、`:254` | 32 MiB / 20,000 events / 1,000 tasks / 5,000 executions；admission 保留余量 |
| `commitAuthorized` 落点 | ABSENT | 源码无 `commitAuthorized`；`commit` 在 `:248` | 没有授权参数、没有 auth revision、没有操作枚举 |
| v3 集合 | ABSENT | `:14`；`contracts/v2.d.ts:1` | 只有 v2 五集合；无 v3 identity/fence/artifact/lease |

**结论：** v2 Store 的“单所有者 + 同步原子快照”是可复用的工程基础；它**不是** v3 授权 Store，也不能通过给 `commit` 增加一个可选参数来变成 v3。

### 3.2 身份与授权

| 审计点 | 状态 | 源码证据 | 结论 |
|---|---|---|---|
| 连接身份建立 | ABSENT | `main.mjs:11`、`:39`、`:53` | 直接解析 `{id,method,args}`；没有认证、连接 actor、protocol handshake |
| Principal/Workspace/Membership/Delegation 实体 | ABSENT | `contracts/v2.d.ts`；`task-store-v2/index.mjs:14` | 无任何对应类型或集合 |
| 集中授权检查 | ABSENT | `dsh-acp-v2/index.mjs:47-75`、`:198-204` | 只有业务前置条件（Task 存在、closed、BUSY），没有 actor 权限检查 |
| 可信 AuthorizationContext | ABSENT | 全源码搜索无 `AuthorizationContext` | 没有 context、版本快照或 Store 内重算 |
| 读操作统一过滤 | ABSENT | `dsh-acp-v2/index.mjs:198-204` | `getTask/getExecution/listTasks/listExecutions` 直接返回全局状态 |
| actor 被 payload 覆盖 | CONFLICT | `dsh-acp-v2/index.mjs:193-195` | `acknowledgeIntegrityAlerts` 直接接受调用方 `acknowledgedBy` 并写入审计字段 |
| 身份字段拒绝 | ABSENT | `dsh-acp-v2/index.mjs:47-75` | 未使用的 `principalId`/`owner` 等字段会被静默忽略，不会 `UNEXPECTED_IDENTITY_FIELD` |
| bootstrap 身份配置 | ABSENT | `config/windows.json` 全文件 | 只有 command/args/env/cwd/dataDirectory/timeouts；没有 identity/workspace/owner |

**结论：** 当前根本没有“授权主体”这个概念。所有调用者共享同一全局命名空间，读接口是全局的，审计 actor 可以被调用方任意填写。

### 3.3 Authority Version 与 Revocation Fence

| 审计点 | 状态 | 源码证据 | 结论 |
|---|---|---|---|
| authority version | ABSENT | 全源码搜索无 `principalVersion`/`membershipVersion`/`delegationVersion` | Task 只有 `revision`，Execution 没有实体版本 |
| 持久化撤权事实 | ABSENT | 无 `revocationFences` 集合 | 没有 Principal/Membership/Delegation 撤权记录 |
| Fence 唯一身份 | ABSENT | 无 `fenceId`/`sourceKey`/`sourceVersion` | 没有 sourceKey 规范编码，也没有解析 |
| scope/版本绑定 | ABSENT | 无 `scope`、`sourceVersion` | 没有 global/workspace 作用域 |
| 立即识别旧权限 | ABSENT | `dsh-acp-v2/index.mjs:62-72` | 只检查 Task 当前状态；没有 controller authority version/fence 检查 |
| Fence 与源记录原子提交 | ABSENT | `task-store-v2/index.mjs:248-274` | 可以一次 commit 多集合，但没有 fence/源状态语义 |
| `quarantined` 处理 | CONFLICT | `dsh-acp-v2/index.mjs:94-96` | 同名 `quarantine` 只是通知完整性诊断，不是 Authority Fence 状态 |
| 旧版本对象/orphan | ABSENT | 无旧版本 authority 概念 | 没有低版本证据、completion 或 orphan 判定 |

**结论：** A4–A10 冻结的 Authority Version + Fence + `quarantined` + 旧版本 orphan 语义，在当前代码中没有任何实现或落点。现有 `quarantine` 名称容易误导实现者，必须在 v3 中明确区分。

### 3.4 Reconcile

| 审计点 | 状态 | 源码证据 | 结论 |
|---|---|---|---|
| 持久化 Reconcile worker | ABSENT | 无 worker/queue/fence 扫描代码 | 没有 Authority Reconcile |
| 分页/批次/幂等进度 | ABSENT | 无 `processedTaskIds`/`processedGrantIds` | 没有批次模型 |
| 三个 commit 边界 | ABSENT | 无撤权源 commit、batch commit、completion commit | 只有 v2 单次 `commit` |
| 重叠 Fence/并发撤权 | ABSENT | 无 fence | 没有并集语义 |
| quarantine/fail closed | PARTIAL | `dsh-acp-v2/index.mjs:37-41` | 只有 `storageFault` 的 fail closed，不是 authority quarantine |
| 旧版本对象/历史证据 | ABSENT | 无 authority 版本 | 无法判断 orphan |
| 当前 `reconcileTask` | CONFLICT | `dsh-acp-v2/index.mjs:157-173` | 只做 Session resume/close 与 binding 修复，不是 Authority Reconcile |

**结论：** 当前 `reconcileTask` 的语义是“恢复/关闭 ACP Session”，不是“物化撤权投影”。实现 v3 时必须使用不同名称或明确分层，避免把 Session recovery 误当 Fence completion。

### 3.5 Replay 与 RequestRecord

| 审计点 | 状态 | 源码证据 | 结论 |
|---|---|---|---|
| requestKey 作用域 | CONFLICT | `task-store-v2/index.mjs:14`、`dsh-acp-v2/index.mjs:49`、`:61` | `requests` 以单个 `key` 为 ID；全局 key，不是 workspace/actor/delegation/operation 五元组 |
| RequestRecord 持久化 | PARTIAL | `contracts/v2.d.ts:55-62`；`dsh-acp-v2/index.mjs:53`、`:74` | 只有 key/inputHash/taskId/executionId；没有 scopeHash、resultSnapshot、authorizationRevision |
| 重复提交行为 | PARTIAL | `dsh-acp-v2/index.mjs:49`、`:61` | 相同 key 且 hash 相同返回当前 Task/Execution；hash 不同抛 `IDEMPOTENCY_CONFLICT` |
| 响应丢失重放 | PARTIAL | `:49`、`:61` | 能避免再次创建/启动，但不返回原始 resultSnapshot |
| Replay 重新授权 | ABSENT | 无授权层 | 无 actor、无当前资源可见性检查 |
| Replay 重复外部副作用 | PARTIAL | `:55`、`:74` | 重放路径不调用 `launch`，不会重复 prompt；但 create/start 的 commit→launch 崩溃窗口会留下 queued |
| 操作/状态前置条件 | PARTIAL | `:49`、`:61` | Replay 在状态检查之前返回，部分符合“重放不重查状态”；但没有 resultSnapshot 与授权 |

**结论：** v2 的 requestKey 只能做到“同一全局 key 不重复创建”，不是 AD-10 的委托作用域幂等，也不是 Store v3 的“当前授权 + 原始结果快照”Replay。

### 3.6 Artifact 与 ACL

| 审计点 | 状态 | 源码证据 | 结论 |
|---|---|---|---|
| Artifact 实体 | ABSENT | `task-store-v2/index.mjs:14`；`contracts/v2.d.ts` | 无 Artifact、storageRef、sha256、size、retention |
| ArtifactReference | ABSENT | 无集合/类型 | Task 与输出没有引用关系 |
| ArtifactGrant | ABSENT | 无集合/类型 | 没有 explicit/requester/controller 区分 |
| 独立 Artifact ACL | ABSENT | 无读取授权层 | 当前读取的是 Task/Execution 的 `result` |
| Task 权限变化影响 Artifact | ABSENT（空集） | 无 Artifact | 目前没有可被影响的 Artifact；也没有快照 ACL |
| snapshot-controller Grant | ABSENT | 无 controller 字段/Grant | 无法区分 snapshot 与 explicit/requester |
| Artifact 读取/下载/删除授权 | ABSENT | `main.mjs:39` 白名单无 artifact 方法 | 没有 API |

**结论：** Artifact 域完全是空白。当前 `Task.result`/`Execution.result` 只是内联文本，不是 Artifact；不要把 `result` 当作 Artifact ACL 已实现的证据。

### 3.7 Workspace、文件系统与 Lease

| 审计点 | 状态 | 源码证据 | 结论 |
|---|---|---|---|
| Workspace root 与 Task working directory | CONFLICT | `windows-paths/index.mjs:2-4`；`dsh-acp-v2/index.mjs:48`、`:111` | `Task.cwd` 是客户端提供的绝对路径，直接传给 `session/new`；没有 Workspace root |
| 路径规范化 | PARTIAL | `windows-paths/index.mjs:3-4` | 只做 `path.win32.normalize`，无存在性、file ID、reparse、卷类型检查 |
| 目录穿越 | CONFLICT | `windows-paths/index.mjs:4`；`test/paths.test.mjs:4` | `..` 被 normalize 消除并接受，不是拒绝；测试还把它固化为正向行为 |
| UNC/设备命名空间 | CONFLICT | `windows-paths/index.mjs:3`；运行时探测 | 接受 UNC、`\\?\`、`\\.\`；IW-09 要求客户端输入拒绝 |
| 系统目录/保留名/ADS | CONFLICT | 运行时探测 | 接受 `C:\`、`C:\Windows\System32`、`C:\CON`、`C:\file:stream`、结尾点/空格 |
| 符号链接/reparse | ABSENT | 无 `lstat`/Win32 reparse/file ID 代码 | 不检测 junction、symlink、mount point |
| 不同 Task 共享工作目录 | CONFLICT | `dsh-acp-v2/index.mjs:48`；`test/executor-v2.test.mjs:26` | 没有任何 cwd 唯一性或租约；测试并发跑 3 个 Task，使用同一 cwd |
| Lease 创建/续期/释放/恢复 | ABSENT | 无 `workspaceLeases` 集合 | 没有持久化 Lease、epoch、fencingToken |
| 进程终止证据/fencing | PARTIAL | `acp-transport/index.mjs:104-125` | 会尝试 `taskkill /T /F`，但不检查退出码、不证明整棵进程树、不持久化证据 |
| OS 强制隔离 | ABSENT | `acp-transport/index.mjs:33` | 子进程以当前 OS 用户启动，没有 Job Object/AppContainer/ACL sandbox |

**结论：** 当前路径保护只有 lexical normalize 的一小部分，而且其实际行为与 IW-09 相反。DSH 子进程可以访问当前 OS 用户能访问的任意路径。不同 Task 可以同时写同一目录。

### 3.8 Event 与外部副作用

| 审计点 | 状态 | 源码证据 | 结论 |
|---|---|---|---|
| Event sequence/cursor | PARTIAL | `task-store-v2/index.mjs:213-220`、`:240-245`；`dsh-acp-v2/index.mjs:202` | 全局 sequence 持久化；cursor 只是 `afterSequence`，没有 scope/workspace |
| Event 持久化 | IMPLEMENTED（v2） | `:240-245`；`test/store-v2.test.mjs:26-35` | 事件与状态同一快照提交 |
| Event 读取重新授权 | ABSENT | `dsh-acp-v2/index.mjs:202-203` | 直接过滤全局 events |
| Event schema | CONFLICT | `contracts/v2.d.ts:70-75`；`task-store-v2/index.mjs:216`、`:242` | 没有 scope/workspaceId/actor/source/audience/schemaVersion/correlationId |
| system/workspace 分流 | CONFLICT | `task-store-v2/index.mjs:216` | 每个事件必须有存在的 `taskId`，无法表达 system 事件 |
| dispatch 在权威提交之后 | PARTIAL | `dsh-acp-v2/index.mjs:113-118` | `session/prompt` 在 `dispatch_intent` commit 之后；但 `session/new`/resume 在 binding/dispatch commit 之前 |
| dispatch_intent 与实际执行窗口 | PARTIAL | `:116-118`；`open()` `:97-105` | commit 后崩溃恢复为 unknown，不自动重发；语义保守，但无法证明 prompt 是否真的发出 |
| 重复 dispatch/丢失通知 | PARTIAL | `:59-75`、`:94-103` | gate/operations 防重入；通知隔离为 integrity alert；没有 v3 的事件投递保证 |
| 通知与执行结果混淆 | PARTIAL | `:97-104`、`:123-126` | 非文本/非 prompt 通知被忽略；异常通知会降级 unknown，不是完整的投递语义 |

**结论：** v2 的事件是“Task 级审计/诊断流”，不是 AD-09 的 Workspace/System 事件模型；外部 prompt 的提交顺序基本正确，但 Session 建立与 binding 持久化之间仍有崩溃窗口。

---

## 4. 关键调用链与数据流

### 4.1 命令入口

```text
stdin bytes
  -> main.mjs:readCommands()            60-85
  -> main.mjs:commandLine()             40-59
  -> allowed 白名单                      39
  -> executor[command.method](...args)   53
  -> output({id,result})                 54
```

在 `:53` 之前没有任何身份解析、连接绑定或授权检查。

### 4.2 createTask

```text
DshAcpExecutor.createTask()             47-57
  -> normalizeWorkspace(input.cwd)      48
  -> 查找全局 requests.find(key)        49
  -> 创建 Task + Execution              52-53
  -> 同一 Store commit:
       tasks + executions + requests + event
  -> hooks.afterCreate                 54
  -> launch(executionId)               55
```

重要事实：

- `createTask` 不只是创建 Task，它同时创建了一个 Execution；
- 默认 `defer !== true` 时立即启动；
- Task 没有 workspaceId/owner/controller/visibility；
- request 记录没有 resultSnapshot。

### 4.3 startExecution / launch

```text
startExecution()                         59-75
  -> gate(taskId)                        59
  -> 查找全局 requests.find(key)         61
  -> 检查 Task lifecycle / BUSY / 风险   62-72
  -> 创建 Execution                      71
  -> commit:
       tasks + executions + requests + event
  -> launch()                            74

launch()                                 87-92
  -> 创建 operation/transport
  -> run()                               91

run()                                    105-139
  -> transport.start()                   108
  -> session/resume 或 session/new        110-111
  -> commit binding (session.bound)       113
  -> commit dispatch_intent               116
  -> session/prompt                       118
  -> flush partial output                 122
  -> commit terminal                      126
```

### 4.4 崩溃恢复

```text
ExecutionStore.open()                    83-136
  -> 检查 MIGRATION_INCOMPLETE / .migration.lock
  -> 读取 state-v2.json
  -> validate + capacity
  -> running 或 dispatch_intent -> unknown
  -> terminal + active binding -> unknown + recoveryRequired
  -> 重算 Task projection
  -> append store.recovered
  -> persist
```

恢复是**保守的**：可能已提交的 Execution 不自动重发；queued/not_started 保持 queued，等待显式 `dispatchQueued`。

### 4.5 Replay

```text
createTask:
  requests.find(r => r.key === input.requestKey)   49
  -> 相同 hash: return this.task(previous.taskId)  49
  -> 不同 hash: IDEMPOTENCY_CONFLICT

startExecution:
  requests.find(r => r.key === input.requestKey)   61
  -> 相同 hash: return this.execution(previous.executionId)  61
  -> 不同 hash: IDEMPOTENCY_CONFLICT
```

这里返回的是**当前** Task/Execution，不是原始 `resultSnapshot`。

### 4.6 取消与终态

```text
cancelExecution()                        141-154
  -> 无 operation 且 queued/not_started:
       local_not_submitted + cancelled    143
  -> 有 operation:
       cancel.requestedAt                147
       session/cancel                    149
       等待 op.done                       150
       cancelResult                      152

run() terminal:
  end_turn -> completed                  123
  cancelled -> cancelled                 123
  其他 -> failed                         123
  op.bad -> unknown                      123
  -> 单次 commit: status/result/evidence/task/events  126
```

### 4.7 路径流

```text
main.mjs:11 读取原始 config
  -> createExecutor()                    87-100
  -> DshAcpExecutor.createTask()          47-57
  -> normalizeWorkspace(input.cwd)        48
  -> session/new { cwd: task.cwd }        111
  -> AcpTransport spawn({ cwd: config.cwd })  33
```

`AcpTransport` 进程本身的 `cwd` 来自 config；`session/new` 的 `cwd` 来自 `Task.cwd`。两者都不做 Workspace root 验证，也没有 OS 级限制。

---

## 5. 已发现的设计冲突与实现缺口

### 5.1 P0 问题（5 项）

#### P0-01：没有可信调用者身份，所有 API 都是全局、无授权的

**设计依据**

- `docs/phase-2.1A-identity-workspace-design.md` 第 7.1–7.5 节：连接绑定 `actorPrincipalId`，payload 不能自报。
- 同文件第 14.3 节：所有读方法统一过滤；写方法不使用客户端身份字段。
- `docs/phase-2.0.3-implementation-constraints.md` AD-12：入口检查不是授权证明。

**源码证据**

- `apps/companion-hub/main.mjs:11` 直接解析 config，无 identity。
- `main.mjs:39` 白名单所有方法，无 actor 参数。
- `main.mjs:53` 直接 `executor[command.method](...args)`。
- `packages/dsh-acp-v2/index.mjs:198-202`：
  - `getTask(id)` 直接 `this.state().tasks.find(...)`
  - `listTasks()` 返回全部
  - `getExecution(id)` / `listExecutions()` 返回全部
  - `getEvents()` 返回全局事件
- `packages/dsh-acp-v2/index.mjs:193-195` 接受调用方 `acknowledgedBy` 并写入 alert。
- `packages/contracts/v2.d.ts` 没有 Principal/Workspace/AuthorizationContext 类型。

**调用链/数据流**

```text
任意 stdin 命令
  -> main.mjs:53
  -> executor.getTask / listTasks / getExecution / listExecutions / getEvents
  -> 直接读 state-v2.json 的全量状态
```

`acknowledgeIntegrityAlerts` 的数据流：

```text
args[1].acknowledgedBy
  -> acknowledgeIntegrityAlerts()
  -> alert.acknowledgedBy
  -> 持久化并返回
```

**测试证据**

- `test/hub.test.mjs` 只测试方法白名单、编码和 BUSY；没有任何未认证/越权测试。
- `test/executor-v2.test.mjs:37` 直接传入 `'human-reviewer'`，证明审计主体是调用方字符串。
- 没有测试验证“第二个 actor 看不到第一个 actor 的 Task”。

**当前行为**

- 任何能写 Hub stdin 的进程可以读取全部 Task、Execution、结果、诊断和事件。
- 任何调用者可以取消、关闭、重试任意 Task。
- `getTask` 对任意 ID 返回对象；不存在与不可见没有区分。
- `acknowledgedBy` 可以被任意填写。

**与目标设计的差距**

缺少：

- Connection 认证与 `connectionId`；
- `actorPrincipalId` / `actorType`；
- Workspace Membership；
- `AuthorizationContext`；
- 读过滤；
- `commitAuthorized`；
- `UNEXPECTED_IDENTITY_FIELD` 拒绝；
- `AUTHORIZATION_*` 错误码。

**潜在风险与触发条件**

- 触发条件：任意本地调用者发送一次 `getTask`/`listTasks`；或发送 `acknowledgeIntegrityAlerts` 伪造审计人。
- 风险：IDOR、跨 Task 数据泄漏、审计不可信。
- 当前是本地 stdio 单用户模型；一旦增加远程入口或多用户，就是完整的越权路径。

**建议后续方向**

- 不要在 v2 上追加可选 `principalId`。
- 先建立 v3 Connection/AuthorizationContext 与 bootstrap Principal，再实现 `commitAuthorized` 和统一读过滤。
- 把 `acknowledgedBy` 改为 context 派生，禁止 payload 注入。
- 增加跨 actor 读/写/取消的负向测试。

---

#### P0-02：没有 v3 Store 与 commitAuthorized，且 v2 的公开 commit/snapshot 是可绕过后门

**设计依据**

- `docs/phase-2.1A.2-store-api-v3-design.md` 1.2、2.2：v3 StoreState 与 `commitAuthorized`。
- 同文件 2.3：授权检查、变更、RequestRecord、事件必须在同一 commit。
- `docs/phase-2.1A-identity-workspace-design.md` 14.2：Store 不暴露“只写 changes”的授权后门。

**源码证据**

- `packages/task-store-v2/index.mjs:14`：只有 5 个集合。
- `:246`：公开 `snapshot()`。
- `:248`：公开 `commit(expectedRevision, changes)`，没有 operation/context/auth。
- `packages/dsh-acp-v2/index.mjs:21`：`Object.assign(this, {store,...})` 将 store 暴露为公开属性。
- `packages/dsh-acp-v2/index.mjs:26`：公开 `state()`，返回完整 snapshot。
- `test/crash-v2.test.mjs:93`、`:99`：测试直接 `x.store.commit(...)` 修改 binding。

**调用链/数据流**

```text
库消费者
  -> executor.store.snapshot()
  -> 全量任务/结果/请求

库消费者
  -> executor.store.commit(anyRevision, anyValidChanges)
  -> 直接写 Task/Execution/Binding/Request/Event
```

**测试证据**

- v2 测试大量直接使用 `ExecutionStore.commit` 构造状态，证明它是对外可用的。
- 没有测试限制“只能通过 Executor 的授权方法写入”。

**当前行为**

- 任何持有 `ExecutionStore` 或 `DshAcpExecutor` 的代码都可以读取全量状态并写任意合法变更。
- 即使未来在 Executor 外层加 `authorize()`，也无法阻止直接 `store.commit`。

**与目标设计的差距**

- 没有 v3 `StoreState`；
- 没有 `authorizationRevision`；
- 没有 `commitAuthorized`；
- 没有“Store 内部重新授权”；
- 没有不可绕过的 mutation 封装。

**潜在风险与触发条件**

- 触发条件：任何库消费者、插件、测试工具或未来的 adapter 直接调用 `store.commit`。
- 风险：授权被完全绕过；终态/证据可被改写（受 v2 不变量限制，但仍可写入合法但未授权的内容）。

**建议后续方向**

- 新建 v3 Store，而不是扩展 v2。
- `commit` 变为内部/私有，公开入口只有 `commitAuthorized`。
- 把 `snapshot()` 改为受控的 read API；至少不在业务对象上暴露原始 Store。
- 为“直接 commit 必须不可达”增加架构测试。

---

#### P0-03：没有 Authority Version、Revocation Fence、撤权即时判定或 authority quarantine

**设计依据**

- `docs/phase-2.1A.4-revocation-model-closure.md` 1.2–1.4。
- `docs/phase-2.1A.5-authority-fence-decision-closure.md` 1、3。
- `docs/phase-2.1A.2-contracts-v3-design.md` 5.3、5.4、12（不变量 20/21）。
- AD-08 / AD-12-R1。

**源码证据**

- 全源码搜索 `AuthorityRevocationFence`、`sourceKey`、`sourceVersion`、`authorizationRevision`：0 命中。
- `packages/task-store-v2/index.mjs:14` 没有 `revocationFences`。
- `packages/contracts/v2.d.ts` 没有 Principal/Membership/Delegation/fence 类型。
- `packages/dsh-acp-v2/index.mjs:62-72` 只检查 Task lifecycle/BUSY/unknown，不检查 authority version。
- `packages/dsh-acp-v2/index.mjs:94-96` 的 `quarantine` 只处理通知完整性。

**调用链/数据流**

当前不存在“撤权命令 -> 源状态 + Fence + authRev + event”的调用链。

`quarantine` 的实际数据流：

```text
receive() 发现未关联通知
  -> op.quarantine.push(...)
  -> task.integrityAlerts.push(...)
  -> task.status = unknown
```

这不是 Fence 的 `quarantined`。

**测试证据**

- 没有 Principal/Membership/Delegation 撤权测试。
- 没有 fence sourceKey 编码/解析测试。
- 没有旧版本 orphan/quarantine 测试。
- `test/executor-v2-races.test.mjs` 的 quarantine 测试只验证通知诊断。

**当前行为**

- 没有可撤权的 Principal/Delegation。
- 没有可冻结的 controller。
- 没有可物化的 Fence。
- 没有 old-version 目标判定。

**与目标设计的差距**

全部核心语义缺失：

- authority version；
- canonical sourceKey；
- global/workspace scope；
- sourceVersion 精确匹配；
- 旧版本 orphan；
- `pending/reconciling/completed/failed/quarantined`；
- 撤权 commit 的原子集合；
- 即时拒绝、异步物化。

**潜在风险与触发条件**

- 触发条件：未来加入身份/委托后，撤权仍只改业务表；旧 controller/agent 继续有权。
- 风险：撤权不生效、旧权限复活、无法审计。
- 当前虽然没有身份，风险尚未以“越权用户”形式出现；一旦 v3 落地而 Fence 未实现，就是 P0 权限漏洞。

**建议后续方向**

- 严格按 A4–A10 的最终语义实现，不引入旧 `DelegationRevocationFence` 或同步枚举所有 Task 的旧方案。
- 先实现 Store 内 authority 状态与 canonical sourceKey，再实现撤权命令。
- 把“通知 quarantine”与“authority quarantine”在类型和命名上彻底分开。

---

#### P0-04：Workspace 边界不存在，路径守卫接受 IW-09 明确禁止的形式，且没有 OS 隔离

**设计依据**

- `docs/phase-2.1A-identity-workspace-design.md` 19.1.2、19.1.3、19.1.4、19.1.6。
- IW-09：Workspace root 只是 cooperative boundary，不是 OS 安全边界；客户端输入拒绝 UNC/设备路径/`..`/ADS/保留名。
- P0-02：Workspace 不是 OS 隔离。

**源码证据**

- `packages/windows-paths/index.mjs:2-4` 只有：

```js
if (... || !path.win32.isAbsolute(value) || ... ) throw ...
return path.win32.normalize(value);
```

- 没有 `existsSync`、`lstat`、file ID、volume serial、reparse、known folder 检查。
- `packages/dsh-acp-v2/index.mjs:48` 直接 `normalizeWorkspace(input.cwd)`。
- `packages/dsh-acp-v2/index.mjs:111` 把 `task.cwd` 传给 `session/new`。
- `packages/acp-transport/index.mjs:33` 以当前 OS 用户 `spawn` 子进程。
- `test/paths.test.mjs:4` 明确断言 UNC 被保留、`..` 被 normalize 消除。

**运行时探测结果**

```text
C:\                         -> 接受
C:\Windows\System32         -> 接受
C:\Users\26648              -> 接受
C:\a\..\b                   -> 接受并变为 C:\b
C:\CON                      -> 接受
C:\file:stream              -> 接受
C:\trailing.                -> 接受
\\server\share              -> 接受
\\?\C:\Windows              -> 接受
\\.\C:\Windows              -> 接受
```

**调用链/数据流**

```text
客户端 cwd
  -> main.mjs:53
  -> createTask()
  -> normalizeWorkspace()
  -> state-v2.json Task.cwd
  -> session/new { cwd }
  -> DSH 子进程
```

**测试证据**

- `test/paths.test.mjs:4` 只验证“合法路径被 normalize”，并正向接受 UNC/`..`。
- 没有 reparse/junction、系统目录、ADS、保留名、设备命名空间测试。
- 没有 OS sandbox 测试；也没有“子进程不能写出 root”的测试。

**当前行为**

- 任何绝对 Windows 路径都可以成为 Task cwd。
- `..` 不会被拒绝，而是被静默消除。
- UNC、`\\?\`、`\\.\` 被接受。
- DSH 子进程可以访问当前用户可访问的任意文件系统位置。
- 不同 Task 可以指向同一目录。

**与目标设计的差距**

- 没有 Workspace root；
- 没有 `rootIdentity`；
- 没有卷类型/known folder/重叠检测；
- 没有逐组件 no-follow；
- 没有 reparse 检测；
- 没有 OS 强制隔离；
- 没有 `WORKSPACE_PATH_*` 错误。

**潜在风险与触发条件**

- 触发条件：调用者传入 `C:\Windows\System32`、`C:\`、UNC 或设备路径；或 Task 的 cwd 中有 junction。
- 风险：Agent 读写宿主敏感目录；字符串 normalize 造成“看起来在 root 内、实际在 root 外”；`\\?\`/`\\.\` 绕过后续基于普通路径的检查。
- 当前 design 已承认 DSH 不受 cwd 限制；但实现连 lexical admission 都没有达到。

**建议后续方向**

- 先实现严格的 lexical admission（拒绝 UNC/设备/`..`/ADS/保留名/系统目录），再实现 root identity 与 native guard。
- 在 native guard 可用前，明确标记 `cooperative`，不能宣称安全隔离。
- 为每个禁止形式建立负向测试。
- 不要用 `path.normalize` 消除 `..` 后再当作合法输入。

---

#### P0-05：没有 WorkspaceWriteLease/mutex，多个 Execution 可以并发写同一目录

**设计依据**

- `docs/phase-2.0.2-architecture-decisions.md` AD-11 6.2：mutex 下每个 Workspace 最多一个 held lease；Execution 在持久化 dispatch_intent 前必须获得租约。
- `docs/phase-2.0.3-implementation-constraints.md` AD-13：没有进程终止证明或实际 fencing，不能把租约交给新执行。
- `docs/phase-2.1A.2-contracts-v3-design.md` 9.2。

**源码证据**

- `packages/dsh-acp-v2/index.mjs:17`：`maxConcurrent=8`，只有全局并发上限。
- `packages/task-store-v2/index.mjs:14`：没有 `workspaceLeases`。
- `packages/dsh-acp-v2/index.mjs:47-56`：`createTask` 不检查 cwd 是否已被其他 Execution 使用。
- `packages/dsh-acp-v2/index.mjs:87-92`：`launch` 直接创建 operation/transport，没有 lease。
- `test/executor-v2.test.mjs:26`：并发创建 3 个 Task 并让它们同时运行，使用同一测试 cwd。

**调用链/数据流**

```text
createTask A (cwd=X) -> launch A -> session/new(cwd=X) -> prompt
createTask B (cwd=X) -> launch B -> session/new(cwd=X) -> prompt
```

没有 Workspace ID、没有 lease 获取、没有排队、没有 epoch/fencingToken。

**测试证据**

- `test/executor-v2.test.mjs:26` 证明 3 个并发 Execution 可以同时写同一 cwd。
- 没有“第二个 Execution 必须等待 lease”的测试。
- 没有“unknown 后 lease frozen，禁止新执行”的测试。

**当前行为**

- 最多 8 个 Execution 并发。
- 没有 Workspace 级互斥。
- 没有持久化 lease、续期、释放、恢复。
- 没有 fencingToken，也没有执行器拒绝旧 token 的能力。

**与目标设计的差距**

- 没有 `workspaceLeases`；
- 没有 `workspaceSnapshot`；
- 没有 `writeEpoch`；
- 没有 `held/releasing/released/frozen/quarantined`；
- 没有 `releaseEvidence`。

**潜在风险与触发条件**

- 触发条件：两个 Task 使用同一 cwd 并同时收到 prompt。
- 风险：文件互相覆盖、构建产物污染、测试/工具并发写坏工作区。
- 当前测试主动演示了这个行为，而不是阻止它。

**建议后续方向**

- v3 必须引入 Workspace 实体和 lease 集合。
- `mutex` 为默认；无隔离能力时拒绝并发写。
- `dispatch_intent` 与 lease 获取同一事务。
- 在 AD-13 证据缺失时进入 frozen/quarantine，而不是自动释放。

---

### 5.2 P1 问题（13 项）

| ID | 设计依据 | 源码与调用链 | 测试证据 | 当前行为与差距 | 风险与触发 | 建议 |
|---|---|---|---|---|---|---|
| P1-01 Replay 作用域与结果快照不符合 AD-10 | AD-10 5.1–5.3；Store 4.1–4.2；Contracts 10.3 | `task-store-v2/index.mjs:14` 以 `key` 为 ID；`dsh-acp-v2/index.mjs:49`、`:61` 全局 `find`；`contracts/v2.d.ts:55-62` 无 scopeHash/resultSnapshot | `executor-v2.test.mjs:25` 只验证同 key 不重复；`:36` legacy hash；无跨 operation/actor 测试 | 同 key 不同 operation 会冲突；不同调用者共享 key；Replay 返回当前 Task/Execution，不是原始结果；没有当前授权 | 两个 operation 使用同一 key 会 `IDEMPOTENCY_CONFLICT`；响应丢失后客户端得到变化后的状态；撤权后无法拒绝旧结果 | 建立 scopeHash（workspace/actor/delegation/operation/key）；持久化有界 resultSnapshot；Replay 先授权再返回；补跨 operation/actor 测试 |
| P1-02 Event schema/读取不符合 AD-09 | AD-09 4.1–4.3；Store 5.1–5.3 | `contracts/v2.d.ts:70-75` 无 scope/workspace/actor/source/audience/schemaVersion；`task-store-v2/index.mjs:216` 要求存在 taskId；`:242` 只允许四个字段；`dsh-acp-v2/index.mjs:202-203` 全局读取 | `hub.test.mjs:35-37` 只验证空事件游标；无 scope/撤权/系统事件测试 | 事件是 Task 级；无法写 system 事件；没有 workspace/audience；读取不重新授权；订阅不会因撤权关闭 | 跨 Task 事件泄漏；无法表达授权审计；旧 cursor 可继续读；无法实现 CURSOR_EXPIRED | 引入 DomainEvent v3 字段；Store 内过滤；按 scope/workspace 查询；撤权立即关闭订阅；补事件 schema 测试 |
| P1-03 Task/Execution 状态模型与 AD-01/AD-07 冲突 | AD-01；AD-07；Contracts 6 | `contracts/v2.d.ts:3-4` `TaskStatus=ExecutionStatus`；`:8-23` 无 goalStatus/visibility/controller；`dsh-acp-v2/index.mjs:52`、`:73` 单 active/latest；`createTask` 创建 Execution | `executor-v2.test.mjs:25-39` 全部按 v2 单状态断言 | 目标状态与执行状态合一；lifecycle 只有 open/closed；没有 owner/controller/visibility；没有 complete/fail/select/archive/delete | 无法实现目标决定与执行聚合分离；无法表达 awaiting_decision；已有 API 语义会与 v3 冲突 | v3 新 Task 模型；保留兼容投影；不要把 v2 单 status 硬改为多字段 |
| P1-04 SessionBinding 不是 Execution 级 | Contracts 6.1 不变量 8；Store 1.2 | `contracts/v2.d.ts:45-54` 只有 taskId；`task-store-v2/index.mjs:149-160` 只按 task/session 校验；`dsh-acp-v2/index.mjs:72` 复用 latest binding | `executor-v2.test.mjs:25` 验证 resume/session 复用；无 execution-scoped 断言 | 一个 Binding 可被同一 Task 的多个 Execution 顺序复用；没有 executionId；generation 会覆盖 | 清理/恢复可能归错 Execution；审计无法证明哪个 Execution 使用哪个 Session | 分离 Session 与 ExecutionBinding；Binding 记录 executionId；保留 session 复用关系 |
| P1-05 rename 后的持久化失败会造成磁盘/内存分叉 | Store 1.1：“失败不替换旧文件”；AD-12 | `task-store-v2/index.mjs:226-238` 先 rename 再目录 fsync；`:272-273` persist 成功后才赋 `#state` | `store-v2.test.mjs:117-120` 只覆盖 rename 之前失败 | 目录 fsync/close 在 rename 后抛非容忍错误时，磁盘已是新状态、内存仍是旧状态；没有校验和/备份 | 下一次 commit 可能从旧 revision 覆盖已发布状态；断电/磁盘错误时不可判定 | rename 后任何错误都必须使 Store 进入 fail-closed/quarantine；增加 checksum、备份与故障注入；明确 Windows 目录 fsync 语义 |
| P1-06 Authority Reconcile 完全缺失 | A4 3；A5 3；Store 2.5 | 无 worker/fence；`dsh-acp-v2/index.mjs:157-173` 只有 Session reconcile | `crash-v2.test.mjs:43` 只验证 binding 恢复 | 没有批次、进度、完成条件、旧版本 orphan、quarantine | 撤权投影永远不物化；无法证明 fence completed；实现者可能误用 `reconcileTask` | 新建 authority reconciler；与 Session reconcile 分开命名；按 fence 批次/完成 commit 实现 |
| P1-07 AD-13 进程终止证据/fencing 缺失 | AD-13 2.2；Contracts 9.2 | `acp-transport/index.mjs:104-125` 尝试 taskkill；`:112-115` 不检查退出码；无 lease/fencing | `transport.test.mjs` 只测子进程清理；无进程树/旧 token 测试 | 能尝试杀子进程，但没有持久化证据、没有 Job Object、没有 fencing；binding 只标 unknown | 旧子进程/工具仍写同一 cwd；无法安全复用 Workspace | 记录进程树终止证据；或引入实际 fencing；否则 quarantine；禁止仅凭人工确认释放 |
| P1-08 Artifact 实体/ACL 缺失 | AD-04；AD-06；Contracts 8 | `task-store-v2/index.mjs:14` 无 artifacts；`contracts/v2.d.ts` 无类型；`main.mjs:39` 无 artifact 方法 | 无 artifact 测试 | 没有 Artifact、Grant、Reference、storageRef；`Task.result` 是内联文本 | 未来文件产物没有 ACL；无法区分 snapshot/explicit/requester；无法安全删除 | v3 新建 Artifact 集合与创建时 ACL 快照；不要用 Task ACL 替代 |
| P1-09 Store 容量/性能/保留策略不足 | Store 1.3；Contracts 12 | `task-store-v2/index.mjs:15`；`:169-208` 每个 Task 都 `executions.filter`；`:224`；`:254`；`:272` 全量 clone/JSON | `store-v2.test.mjs:107` 只测小容量；无 10k/50k 性能测试 | 每次 commit 全量 clone + stringify + O(tasks×executions) 校验；32MiB/20k，无历史修剪 | 容量上限后全部新工作失败；大 Store 提交延迟/内存放大；无法承载 v3 256MiB | 建索引、增量校验、容量/延迟基准；v3 容量参数需实测；明确保留/归档 |
| P1-10 没有 v2→v3 迁移 | Store 8；OD-11 | `scripts/migrate-v1.mjs:45-52` 只有 v1→v2；`task-store-v2/index.mjs:87-92` 只拒绝 legacy | `migration-v2.test.mjs` 只测 v1→v2 | v3 没有 state-v3；没有 workspace/owner 映射、manual recovery、回滚 | 无法从当前生产数据进入 v3；手工映射会伪造 owner | 单独设计 v2→v3 迁移；显式 workspace/owner；保留 legacy 标记；失败不发布 |
| P1-11 commit→外部副作用/恢复窗口 | AD-12；Store 3.6 commitDispatchIntent | `dsh-acp-v2/index.mjs:47-56` commit 后 `launch`；`:59-75` 同样；`:110-118` `session/new` 在 binding/dispatch commit 前；`open()` `:97-105` 只处理 running/dispatch_intent | `crash-v2.test.mjs:33` 证明 afterCreate 后 queued 且不发 prompt；`:38` replay 不重发 | commit 后崩溃会留下 queued，Replay 不恢复启动；session/new 后崩溃可能留下孤儿 Session | 任务永久排队；远端 Session 泄漏；状态与外部事实不一致 | 将 dispatch 意图与发送分离；持久化 dispatch 状态；启动扫描 queued 并显式恢复；清理孤儿 Session |
| P1-12 读 API 无分页、无视图裁剪、泄露宿主路径 | Store 2.4；API 6.1/6.3；Identity 14.3 | `dsh-acp-v2/index.mjs:198-201` 全量返回；`contracts/v2.d.ts:8-23` `cwd` 在 Task；`:45-54` Binding `cwd`；`:28-44` Execution prompt | `executor-v2.test.mjs` 只测小集合 | `listTasks/listExecutions` 无 limit/cursor；`getTask` 返回绝对 cwd/prompt/result/diagnostics；无 snapshotRevision | 大 Store 响应过大；路径/内容泄露；客户端无法判断新鲜度 | v3 readAuthorized + 分页 + view 裁剪；cwd 不进入公开视图 |
| P1-13 Bootstrap/config/protocol 没有进入运行时 | IW-10；Identity 10；API 6.1 | `main.mjs:11` 原始 `JSON.parse`；`main.mjs:110` `protocolVersion:2`；`scripts/windows-config.mjs:14` 未被 main 使用；config 无 identity | `windows-config.test.mjs` 只测脚本；`hub.test.mjs` 未测配置校验 | 配置无 schema/identity；无效配置可能被接受；ready 仍是 2；命令不校验 protocolVersion | 错误配置静默启动；v3 客户端误判；没有 bootstrap owner | 在 Hub 启动使用严格 config schema；建立 bootstrap state；ready 返回 3；拒绝错误协议/身份字段 |

---

### 5.3 P2 问题（8 项）

| ID | 设计依据 | 源码与调用链 | 测试证据 | 当前行为与差距 | 风险与触发 | 建议 |
|---|---|---|---|---|---|---|
| P2-01 Executor 将 Store `VALIDATION` 误判为 storage fault | AD-12 失败语义；Store 2.3 | `dsh-acp-v2/index.mjs:40` 允许 `VALIDATION_ERROR`/`STORE_CAPACITY`；Store 实际抛 `VALIDATION`/`IMMUTABLE_TERMINAL`（`task-store-v2/index.mjs:17`、`:266`） | `store-v2.test.mjs:58` 证明实际是 `VALIDATION`；executor 无对应测试 | 任何 Store 校验错误会把 `storageFault` 置位，health false，操作全部拒绝 | 一次可恢复的输入/状态冲突被升级为永久存储故障，需重启 | 统一错误码映射；`VALIDATION`/`IMMUTABLE_TERMINAL` 不应视为磁盘故障；补故障分类测试 |
| P2-02 诊断可能保存通知正文/路径，且无脱敏 | A4 5.3 diagnostics bounded；Identity 7.6 审计不记录正文/路径 | `dsh-acp-v2/index.mjs:94` 将 `JSON.stringify(params)` 放入 detail；`:125`、`:130` 存 error.message；`:198-201` 返回执行 | `executor-v2-races.test.mjs` 只测字节上限，不测脱敏 | 未关联通知的 params 可能含文本/路径；错误消息可能含宿主路径；没有 redaction | 结果/提示词/路径写入状态并被任意读接口返回 | 对 diagnostics 只保留 code/长度/哈希；禁止正文/路径；增加脱敏测试 |
| P2-03 subscribeEvents 的 backlog 异常会阻止订阅 | AD-09 订阅语义 | `dsh-acp-v2/index.mjs:203` 先同步调用 listener，再 `listeners.add` | 无 listener 抛错测试 | 若 backlog listener 抛错，订阅不会注册；无 auth 关闭 | 客户端错过后续事件且无明确错误 | 先注册或隔离 backlog 异常；订阅状态可查询；撤权关闭 |
| P2-04 客户端可指定 taskId，存在性探测 | Identity 14.3 错误不泄漏 | `dsh-acp-v2/index.mjs:51`：`taskId=input.taskId??randomUUID()`；`:51` 已存在 -> `TASK_EXISTS` | `task-store.test.mjs` 只测 v1；executor 无探测测试 | 任意调用者可枚举/占用 taskId；错误区分存在/不存在 | 跨 Workspace ID 探测；命名冲突 | v3 由服务端生成或按 Workspace 命名空间校验；统一 not-found 语义 |
| P2-05 错误分类与响应元数据不符合 v3 | API 6.6；Store 2.4 | `main.mjs:36` 只有 `{message,code}`；`dsh-acp-v2` 使用 `INVALID_INPUT`/`TASK_NOT_FOUND`/`BUSY`；无 `AUTHORIZATION_*`/`snapshotRevision` | 无错误矩阵测试 | 客户端无法区分授权/版本/状态；无 revision 返回 | 重试逻辑错误；无法判断陈旧 | 冻结错误枚举；响应带 revision/authRevision；补矩阵测试 |
| P2-06 v1 包仍可导入且同样无授权 | Phase 2.1A 身份边界 | `packages/dsh-acp/index.mjs:1-202`、`packages/task-store/index.mjs:1-177`；main 未使用 | `executor.test.mjs`、`task-store.test.mjs` 仍覆盖 | v1 是公开包；无 Workspace/actor；`onUpdate` 按 session 找 task | 消费者误用 v1 绕过 v2 | 标记 deprecated；从公开入口移除或加隔离提示；测试只保留迁移兼容 |
| P2-07 `store.recovered` 事件归属首个 Task | AD-09 system/workspace 事件 | `task-store-v2/index.mjs:131-132`：`taskId: changed[0].taskId` | `store-v2.test.mjs:86` 只验证类型 | 一个 store 级恢复事件被记到首个 Task；不是 system scope | 审计归属错误；跨 Task 事件泄漏 | v3 使用 system 事件；若保留 v2，明确 `recovery` 是 task-scoped 诊断 |
| P2-08 现有测试固化了与 v3 冲突的 v2 假设 | IW-09；AD-11；Identity 7 | `test/paths.test.mjs:4` 接受 UNC/`..`；`test/executor-v2.test.mjs:26` 并发同 cwd；`:37` 调用方 `acknowledgedBy` | 118/118 通过 | 测试证明 v2 行为正确，但不证明 v3 目标；其中若干断言与 IW-09/AD-11 相反 | 实现者把绿色测试当 v3 证据；回归阻止安全修复 | 将 v2 测试标为 legacy；新增 v3 负向/安全测试；不要修改已有测试来“适配” v3，除非明确迁移 |

---

## 6. 按严重程度排序的风险清单

### 6.1 P0 风险

1. **P0-01 任意本地调用者读取/控制全部 Task**：无身份、无读过滤、`acknowledgedBy` 可伪造。
2. **P0-02 公开 `store.commit` 绕过任何未来授权**：v2 Store 无 `commitAuthorized`，`store` 还是公开属性。
3. **P0-03 无 Fence/authority version**：一旦加入身份，撤权无法即时生效。
4. **P0-04 Workspace 路径与 OS 隔离缺失**：接受系统目录/UNC/设备路径/`..`；DSH 子进程全盘可访问。
5. **P0-05 无 Lease，多个 Execution 并发写同一目录**：已有测试证明 3 个并发 Task 共享 cwd。

### 6.2 P1 风险

1. **P1-01 Replay 可能返回变化后的状态，且全局 key 跨操作冲突**。
2. **P1-02 Event 无 workspace/actor/scope，读取不重新授权**。
3. **P1-03 Task/Execution 单状态模型无法承载 AD-01/AD-07**。
4. **P1-04 Binding 不是 Execution 级，恢复/审计可能归错**。
5. **P1-05 rename 后错误可造成磁盘/内存分叉**。
6. **P1-06 无 Authority Reconcile**。
7. **P1-07 无进程终止证据/fencing**。
8. **P1-08 无 Artifact ACL**。
9. **P1-09 全量 clone/JSON + O(n²) 校验，容量/性能未验证**。
10. **P1-10 无 v2→v3 迁移**。
11. **P1-11 commit 与外部 Session 建立的崩溃窗口**。
12. **P1-12 读 API 无分页、泄露 cwd/prompt/result**。
13. **P1-13 Bootstrap/config/protocol 未落地**。

### 6.3 P2 风险

1. 错误码映射错误会把可恢复校验错误升级为 sticky storage fault。
2. diagnostics 可能包含通知正文/路径。
3. 订阅 backlog 异常会丢订阅。
4. 客户端可指定 taskId 并探测存在性。
5. 错误响应缺 revision/authRevision。
6. v1 包仍可导入且无授权。
7. `store.recovered` 事件归属错误。
8. 现有测试固化 v2 冲突假设。

---

## 7. 需要进一步设计澄清的问题

以下问题**不改变**已冻结的 OD-11、AD-06-R1、AD-12-R1、A7/A8/A9 结论，只是实现前必须明确的产品/架构选择。

1. **v3 与 v2 的关系**
   - v3 是完全替换 Hub v2，还是并行运行？
   - 如果是替换，`ready.protocolVersion`、API 方法表、数据目录如何切换？
   - 是否允许 v2 客户端继续连接？如果允许，必须明确其权限降级语义。

2. **Local stdio 信任边界**
   - 设计允许本地 stdio 作为本机信任边界；产品是否接受“能写 stdin 的本机进程可冒充 bootstrap Principal”？
   - 如果不接受，必须引入独立本地认证/ACL/进程身份，而不是只加 `principalId` 参数。
   - 需要写入运维文档的准确表述。

3. **Workspace 是 cooperative 还是 os-enforced**
   - Phase 2.1A 设计已明确当前只能是 cooperative；产品是否接受？
   - 若不接受，必须先完成 native guard / OS sandbox，再谈 Artifact/Lease 的安全声明。
   - `mutex` 是否是所有现有 Task 的默认策略？

4. **Artifact 的阶段归属**
   - Artifact 实体与 ACL 是 Phase 2.1B 的一部分，还是更后阶段？
   - 当前 `Task.result` 是文本结果；是否需要把它映射为 Artifact，还是明确它是短结果、不构成文件产物？
   - 若没有 Artifact，如何满足 AD-04/AD-06 的验收？

5. **Replay 的 resultSnapshot 语义**
   - 旧 v2 RequestRecord 没有 resultSnapshot；迁移时是拒绝 Replay（`IDEMPOTENCY_CORRUPT`/manual recovery），还是允许一次性 legacy 语义？
   - 结果快照上限、保留期、与读取授权的关系需要冻结。

6. **Event 的 system scope**
   - v2 事件必须有 taskId；v3 的 `store.recovered`、`authorization.denied`、`workspace.*`、`principal.*` 如何进入 system/admin 流？
   - 谁可以订阅 system scope？审计流是否与业务事件同一 sequence？

7. **现有 v2 数据的 Workspace 映射**
   - 当前 `Task.cwd` 是绝对路径。迁移时如何选择一个 Workspace root，如何避免把不同 Task 错误合并？
   - 没有 owner/controller/visibility 的旧 Task 如何映射？
   - 旧 requestKey 的全局作用域如何转换为 v3 五元组 scope？

8. **Fence/Reconcile 实现边界**
   - A4–A10 已冻结语义，但实现时 batch 大小、调度频率、手动修复入口、完成证明的存储格式仍需设计。
   - 旧版本 orphan 的人工修复是否允许写新 Fence？必须保持“不得静默改写身份字段”。

9. **错误与审计契约**
   - `AUTHORIZATION_STALE`、`AUTHORIZATION_REVOKED`、`FORBIDDEN`、`TASK_NOT_VISIBLE` 等错误码的稳定映射。
   - 审计事件是否包含 actor/operation/target/reason/correlationId，且不包含正文/路径。

---

## 8. 后续建议的工作顺序

本轮不建议直接开始写 Fence/Reconcile 代码。建议顺序：

### 阶段 A：冻结 v3 落地边界（设计/评审）

1. 明确 v3 替换 v2 的切换方式与协议版本。
2. 明确 Local Bootstrap 的安全声明与配置 schema。
3. 明确 Artifact 的阶段归属。
4. 明确 v2→v3 迁移的 owner/workspace 映射和 manual recovery。
5. 明确 Event system scope 与 Replay 旧记录策略。

### 阶段 B：v3 骨架与测试基座

1. 新建 v3 Contracts（Principal/Workspace/Membership/Delegation/Fence/Artifact/Lease）。
2. 新建 v3 Store（独立文件/锁/集合），不修改 v2 数据。
3. 实现 `authorizationRevision`、实体 version、Store 内部校验。
4. 建立 v3 迁移的只读输入和失败关闭。

### 阶段 C：身份与授权提交

1. Connection 认证与 bootstrap Principal。
2. `AuthorizationContext` 与 Store 内重算。
3. `commitAuthorized`（operation/target/input/request）。
4. 统一读过滤与 `AUTHORIZATION_*` 错误。
5. 先做“无 Fence 的普通授权”测试，再接撤权。

### 阶段 D：Authority/Fence/Reconcile

1. canonical sourceKey 编码/解析。
2. 源状态 + Fence + authRev + 审计事件同 commit。
3. 即时拒绝路径（读/写/Replay/Event/Artifact/Execution control）。
4. 批次 Reconcile + completion + orphan/quarantine。
5. 旧版本对象与重叠 Fence 测试。

### 阶段 E：Task/Execution/Binding/Event v3

1. goalStatus/lifecycle/controller/visibility。
2. Execution 状态机、dispatch intent、lease。
3. Event scope/cursor/audience。
4. Replay resultSnapshot。

### 阶段 F：Artifact 与 Workspace 安全

1. Artifact/Reference/Grant 创建时 ACL。
2. snapshot 与 explicit/requester 区分。
3. root identity、native path guard、OS 隔离评估。
4. Lease/fencing/进程终止证据。

### 阶段 G：迁移与验收

1. v2→v3 迁移。
2. 故障注入、崩溃、并发、撤权、Replay、Event、容量、路径负向测试。
3. 独立安全评审。

**依赖关系：** B → C → D；E 可与 C/D 并行设计但写入必须依赖 C；F 依赖 D/E；G 最后。不要先写 Reconcile 再补 authority schema。

---

## 9. 本轮明确未验证的事项

以下项目**没有足够证据**，不能因为代码“看起来合理”就视为已验证：

1. v3 Store 的真实实现（不存在）。
2. 任何 Principal/Workspace/Membership/Delegation 的运行时行为（不存在）。
3. `commitAuthorized` 的原子授权行为（不存在）。
4. AuthorityRevocationFence 的 sourceKey 编码/解析、字段一致性、旧版本 orphan（不存在）。
5. Reconcile 的批次、幂等进度、completion、quarantine（不存在）。
6. Replay 的当前授权、resultSnapshot、跨 operation scope（不存在）。
7. Artifact 的存储、ACL、snapshot/explicit 区分、删除（不存在）。
8. Workspace root identity、reparse、file ID、已知目录拒绝（不存在）。
9. WorkspaceWriteLease、fencingToken、进程树终止证据（不存在）。
10. Event 的 workspace/system scope、actor、audience、撤权关闭（不存在）。
11. v2→v3 迁移（不存在）。
12. 真实 Windows 网络共享、junction、mount point、ADS、保留设备名行为（未做完整测试）。
13. 真实断电/磁盘满/rename 后目录 fsync 失败的持久化行为（未做）。
14. 大规模 Store（10k tasks / 50k executions / 256 MiB）的延迟、内存、序列化时间（未做）。
15. 真实 DSH 子进程是否能被 cwd 限制（设计已承认不能；未做 OS 级验证）。
16. 远程认证、多用户、多 Workspace 的隔离（不存在）。
17. `npm run test:integration` 的真实 ACP 集成（未运行）。
18. `npm test` 的 118 个通过测试只证明 v2 行为，不证明 Phase 2.1A 目标。

---

## 10. 总体结论

### 10.1 当前代码与 Phase 2.1A 设计的整体一致程度

**低。**

- 当前运行时代码是 Phase 1.1 v2 单用户本地 Hub。
- Phase 2.1A 的核心实体（Principal/Workspace/Membership/Delegation/Fence/Artifact/Lease）在源码中不存在。
- 授权、撤权、Reconcile、Artifact ACL、Workspace 隔离、Event scope 均未实现。
- 现有 v2 测试 118/118 通过，但它们验证的是 v2 可靠性，不是 v3 设计。

### 10.2 哪些部分已经具备实现基础

可复用的工程基础：

1. 单所有者文件锁与恢复 guard。
2. 全局 revision/sequence 与同步 commit。
3. 临时文件 + fsync + rename 的持久化骨架（但需修复 P1-05）。
4. 崩溃后 unknown 恢复、queued 不自动重发。
5. 终态结果/证据/Task/Event 同 commit 的不变量。
6. 有界事件、容量 admission、终态保留余量。
7. 同 key 的基本幂等记录（需升级为 AD-10 scope + resultSnapshot）。
8. 基础 Windows 路径语法检查和 ACP 子进程清理。
9. 现有测试对 v2 崩溃、取消、输出上限、终态证据的覆盖。

这些基础可用于 v3 的**参考**，但不能直接作为 v3 Store/授权层。

### 10.3 哪些部分需要架构调整

必须新建或重构：

- v3 Store 与 `commitAuthorized`；
- 身份/连接/AuthorizationContext；
- Principal/Workspace/Membership/Delegation；
- Authority Version + Fence + Reconcile；
- Task goalStatus/lifecycle/controller/visibility；
- Execution dispatch/lease/binding；
- Event workspace/system scope；
- Artifact/ACL；
- Workspace root identity/path guard/OS 隔离；
- Replay scope/resultSnapshot；
- v2→v3 迁移。

### 10.4 哪些设计尚缺乏足够证据

- v3 Store 容量与性能；
- Windows native path guard；
- OS 级进程/文件隔离；
- v2→v3 迁移的 owner/workspace 映射；
- ACP 进程树终止证据；
- Artifact 物理存储与保留；
- 远程认证与多用户；
- Fence/Reconcile 实现测试；
- Replay resultSnapshot 与旧 v2 请求的兼容策略。

### 10.5 是否具备进入下一阶段实现准备工作的条件

**不具备直接进入 Phase 2.1B 实现的条件。**

理由：

1. P0-01 至 P0-05 仍未解决；
2. v3 Store/身份/授权没有可落地的接口；
3. 现有测试全部是 v2 行为，不能作为 v3 验收；
4. 多个设计问题（Artifact 阶段、Local Bootstrap 安全声明、v2→v3 迁移、Event system scope）仍需要明确选择。

可以进行的下一步是：

- 以本审计为输入，完成 v3 的**实现规划与测试设计**；
- 明确第 7 节的设计澄清问题；
- 在获得明确批准后，从 v3 Store 骨架和身份/授权层开始，而不是直接实现 Fence/Reconcile。

**本结论不等于实现批准。Phase 2.1B 仍未获批准。**

---

## 11. 既有冻结决策确认

本轮审计**未改变**以下决策：

- OD-11：DECIDED，方案 A。
- AD-06-R1 / AD-12-R1：FROZEN。
- OD-09：NEEDS_USER_DECISION。
- A7-P1-01 / A7-P1-02：CLOSED。
- A8-P1-01：CLOSED。
- A9-P1-01 / A9-P1-02 / A9-P1-03：CLOSED（DESIGN）。

本轮特别确认：

- AuthorityRevocationFence 的 canonical sourceKey / sourceVersion / scope / 字段一致性语义不修改。
- `quarantined` 与旧版本 orphan 处理规则不修改。
- 撤权源 commit、Reconcile batch commit、Fence completion commit 的三层原子边界不修改。
- 不实现 Fence/Reconcile/Authorization/Replay/Store v3。
- 不修改业务源码、测试、Schema、配置或运行时行为。
- 不执行 git push。

---

## 12. 验证记录

| 项目 | 结果 |
|---|---|
| 基准 HEAD | `84236fa2ebba6c837a4571efdd22ca4b08cac466` |
| 工作区起始状态 | clean |
| `npm test` | 118 passed / 0 failed / 0 skipped |
| 测试耗时 | 约 7.0 秒 |
| 源码修改 | 无（本轮只新增本文档） |
| 测试修改 | 无 |
| Schema/配置修改 | 无 |
| 运行时行为修改 | 无 |
| `git push` | 未执行 |

**测试覆盖声明：** 118 个通过的测试是 v2 测试；没有 v3 身份、授权、Fence、Reconcile、Artifact、Lease 或 Replay 授权测试。

---

## 13. 最终判断

当前代码是**可靠的 Phase 1.1 v2 单用户本地实现**，但不是 Phase 2.1A 的实现基础。

- 可复用：单所有者 Store、原子快照骨架、崩溃 unknown 恢复、终态证据、事件 sequence、基本幂等。
- 必须新建：v3 Store、身份/授权、Fence/Reconcile、Task/Execution v3 模型、Artifact、Lease、Event scope、迁移。
- 必须修复：路径 admission、公开 commit 后门、Replay 语义、Event 读取授权、commit 持久化边界。
- 必须澄清：Local Bootstrap 安全边界、Artifact 阶段、v2→v3 迁移、Event system scope。

**Phase 2.1A.11 结论：审计完成，问题已记录；不批准实现，不批准 Phase 2.1B；等待用户对第 7 节澄清问题作出决定。**
