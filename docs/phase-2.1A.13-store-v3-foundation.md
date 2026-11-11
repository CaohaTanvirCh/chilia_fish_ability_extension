# Phase 2.1A.13 Store v3 Foundation Implementation

状态：**IMPLEMENTATION APPROVED / LIMITED SCOPE / V2 PRESERVED / NOT WIRED TO HUB**

- 基线 commit：`c5f369eb49fffef87660a9bd79284ba2244be572`
- 实现范围：仅 `packages/task-store-v3/` 与独立 v3 Store 测试
- 未接入 Hub、Executor、ACP Adapter 或生产运行路径
- 未实现授权、Fence、Reconcile、Artifact、Lease、迁移或业务 CRUD

---

## 1. 新增模块与职责

```text
packages/task-store-v3/index.mjs
```

职责：

- v3 初始快照 Schema；
- 独立 `state-v3.json` / `store-v3.lock`；
- 单所有者锁与保守 stale lock 恢复；
- 同步、串行的事务原语；
- revision 与全局 event sequence；
- 临时文件 + fsync + rename 的原子快照持久化；
- rename 前/后的失败区分与 fail-closed；
- 启动读取、损坏拒绝和基础完整性校验。

未接入：

- `apps/companion-hub/main.mjs`
- `packages/dsh-acp-v2/index.mjs`
- 任何 Hub command table 或公开 Executor API

内部事务原语使用导出的 Symbol：

```text
STORE_V3_INTERNAL_COMMIT
```

它不是 `commit(changes)`，也不是 `commitAuthorized`。它只用于本模块测试和未来 Store 内部授权写入路径。

---

## 2. v3 快照结构

初始状态：

```text
version                 3
revision                0
sequence                0
authorizationRevision   0
authorizationState      { authorizationRevision: 0 }
bootstrapState          null
```

`bootstrapState=null` 是刻意的：本轮不实现 bootstrap provisioning，也不自动创建 Principal/Workspace。未来 provisioning 写入符合 Contracts `BootstrapState` 的记录后，Store 才会校验其结构。

所有集合初始为空：

```text
principals
workspaces
workspaceMembers
membershipRevisions
membershipInvites
delegations
revocationFences
tasks
executions
sessionBindings
artifacts
artifactReferences
artifactGrants
workspaceLeases
requests
events
migrationRecords
```

基础校验包括：

- 顶层字段集合与 `version=3`；
- `revision`、`sequence`、`authorizationRevision` 为非负 safe integer；
- `authorizationRevision` 与 `authorizationState.authorizationRevision` 一致；
- 所有集合为数组；
- 有单 ID 的集合拒绝空 ID 和重复 ID；
- `workspaceMembers` 必须提供 `workspaceId` 与 `principalId`，并拒绝重复复合键；
- JSON 必须有限、无环、非稀疏数组；
- event 字段、scope/workspaceId、source/audience、schemaVersion、time、revision 和 sequence 校验；
- event 单个不超过 4 KiB；
- event sequence 必须从 1 连续，且 `events.length === sequence`。

本轮**不校验**各业务实体的完整字段、状态机、Workspace 归属或授权关系。

---

## 3. 锁与事务边界

### 3.1 锁

- 文件：`<dataDirectory>/store-v3.lock`
- 原子排他创建：`openSync(..., 'wx')`
- 锁内容：`kind`、`pid`、`token`、`createdAt`
- 第二实例：`STORE_LOCKED`
- stale lock 恢复使用 `store-v3.lock.recovery` guard；
- 旧锁 JSON 不可读、缺少 PID 或 PID 非法时拒绝回收；
- PID 存活时拒绝回收；
- 只有当前实例的 token 匹配时才释放锁；
- 正常关闭、初始化失败、进程异常退出后 stale lock 均有测试。

这不代表多用户认证，也不代表 Workspace 隔离。

### 3.2 事务原语

```text
[STORE_V3_INTERNAL_COMMIT](expectedRevision, build)
```

顺序：

1. 检查 Store 已打开且未 fail-closed；
2. 检查 `expectedRevision`；
3. 深拷贝当前快照为 draft；
4. `build(draft)` 只修改集合，并返回 event 输入数组；
5. 校验回调没有修改 `revision`、`sequence`、`authorizationRevision`、`authorizationState`、`version` 或已有 events；
6. `revision = before.revision + 1`；
7. 追加 event，分配连续 sequence 与本次 revision；
8. 校验完整新状态；
9. 持久化成功后，才替换内存权威快照。

失败时：

- draft 被丢弃；
- 原内存状态不变；
- 不产生部分集合更新；
- 不产生 event；
- `expectedRevision` 不匹配返回 `REVISION_CONFLICT`。

本轮 `authorizationRevision` 保持 0，不伪造授权版本检查。

---

## 4. 原子快照持久化与 Windows 限制

提交路径：

```text
serialize
  -> write temp file (wx)
  -> fsync temp file
  -> close temp file
  -> rename temp -> state-v3.json
  -> best-effort directory fsync
  -> update in-memory state
```

### 4.1 失败边界

**rename 前失败**

- 旧 `state-v3.json` 仍是权威；
- 内存状态不变；
- 临时文件清理；
- Store 继续可用，可重试。

覆盖的注入点：

```text
beforeWrite
afterWrite
syncTemp
closeTemp
beforeRename
rename
```

**rename 成功后失败**

- 新文件已经到达文件替换点；
- 目录同步或目录句柄关闭失败时，耐久性无法确认；
- Store 进入 fail-closed；
- 抛出 `STORE_DURABILITY_UNCERTAIN`；
- `snapshot()` 抛 `STORE_FAILED`，不回退展示旧内存；
- 禁止继续接受事务；
- `close()` 后重新 `open()` 必须从磁盘核验。

覆盖的注入点：

```text
afterRename
syncDirectory
closeDirectory
```

这意味着不会出现“rename 已成功但 Store 继续用旧状态接受写入”的未处理分叉。

### 4.2 Windows 实际行为

本机 Windows 探测结果：

```text
openSync(directory, 'r')     -> 成功
fsyncSync(directoryFd)       -> EPERM
```

因此实现将 `EISDIR/EPERM/ENOTSUP/EBADF` 视为“平台不支持目录 fsync”，不把它伪装成成功：

- 提交可以完成；
- `healthCheck().directorySyncSupported = false`；
- 不宣称目录元数据已持久化；
- 仍保留文件 fsync、rename 替换和 fail-closed 路径。

Windows 上已验证：

- 文件 fsync；
- 临时文件 rename 替换；
- 单所有者锁；
- 进程异常退出后的 stale lock 恢复；
- rename 后故障的 fail-closed 与重开核验。

未验证/不能宣称：

- 断电后 rename 元数据一定持久；
- 目录 fsync 的 POSIX 级保证；
- 网络共享、ReFS、压缩目录、杀毒软件/文件索引器对 rename 的影响；
- 磁盘满、硬件写入缓存、真实掉电；
- Windows Job Object / OS sandbox。

因此当前保证是“进程级原子替换 + 可检测的 fail-closed”，不是“任何断电情况下零丢失”。

---

## 5. 恢复与损坏处理

- 首次启动创建初始 v3 快照。
- 正常重启读取最近一次已提交快照。
- 非法 JSON -> `STORE_CORRUPT`，释放锁。
- 不支持 version -> `STORE_VERSION_UNSUPPORTED`，释放锁。
- 缺失集合、非法 revision/sequence、authorization projection 不一致 -> `STORE_CORRUPT`。
- 临时文件残留不会成为权威快照。
- 损坏/无法证明状态不自动覆盖。
- v3 不读取 `state-v2.json`，也不改写 v2 文件。
- 无 v2→v3 迁移。

---

## 6. 故障注入测试结果

新增 `test/store-v3.test.mjs`，26 个测试全部通过。

覆盖：

- 初始快照与集合结构；
- 提交、关闭、重开持久化；
- revision 严格递增；
- event sequence 全局严格递增；
- stale `expectedRevision`；
- 非 JSON/循环/函数值拒绝；
- 事务回调不能改元数据或已有 events；
- event schema 与 4 KiB 上限；
- 第二实例锁；
- 正常关闭释放锁；
- 存活锁、不可读锁保留；
- 非本实例锁不可删除；
- 死进程锁回收；
- 提交前/提交后进程退出；
- 损坏 JSON、错误 version、缺失集合、非法 revision/sequence；
- 临时文件残留；
- v2 文件共存且不被改写；
- rename 前 6 个故障点；
- rename 后 3 个故障点；
- 首次初始化写入失败；
- 首次初始化 rename 后失败；
- 非法事务回调。

回归：

```text
npm run test:unit      107 passed / 0 failed
npm run test:simulated  37 passed / 0 failed
npm test               144 passed / 0 failed
```

v2 测试未修改断言。

---

## 7. 尚未实现的能力与后续依赖

本轮明确未实现：

- Principal / Workspace / Membership / Delegation 业务实体；
- `AuthorizationContext` 与 `commitAuthorized`；
- AuthorityRevocationFence / Reconcile；
- Artifact / Grant / Reference；
- WorkspaceWriteLease / fencing；
- Replay 五元组与 resultSnapshot；
- Event Workspace/System 授权读取；
- v2→v3 迁移；
- Hub/Executor/ACP Adapter 接入；
- OS sandbox / native path guard；
- 容量上限、历史保留、性能基准。

后续依赖：

1. 先冻结 bootstrap provisioning 与 v3 写入入口；
2. 实现 `commitAuthorized`，复用本模块的内部事务与 fail-closed 边界；
3. 再实现 authority/Fence/Reconcile；
4. 最后做 v2→v3 迁移和运行路径切换。

---

## 8. 代码与测试入口

```text
packages/task-store-v3/index.mjs
test/store-v3.test.mjs
test/fixtures/store-v3-crash.mjs
```

`package.json` 的 `test:unit` 已加入 `test/store-v3.test.mjs`，确保回归命令实际执行 v3 测试。

不修改：

- `packages/task-store-v2/`
- `packages/contracts/v2.d.ts`
- `apps/companion-hub/`
- `packages/dsh-acp-v2/`
- v2 数据文件或锁
