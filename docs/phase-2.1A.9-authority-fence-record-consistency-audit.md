# Phase 2.1A.9 Authority Fence Record Consistency & Canonical Source Identity Audit

状态：**A9-P1-01..P1-03 CLOSED (DESIGN) / DOCS-ONLY / IMPLEMENTATION NOT APPROVED / OD-09 OPEN**

日期：2026-11-11（Asia/Shanghai）

范围：docs-only 设计修正。不修改源码、测试、Schema、配置或运行时行为；不实现 Fence/Reconcile/授权；不批准 Phase 2.1B。

依据：

- 基线 commit：`3ef6932b0daddb117a7be5d2d9b959f6c2beeb4b`
- `docs/phase-2.1A.2-contracts-v3-design.md`
- `docs/phase-2.1A.2-store-api-v3-design.md`
- `docs/phase-2.1A.2-design-review.md`
- `docs/phase-2.1A.3-implementation-readiness.md`
- `docs/phase-2.1A.4-revocation-model-closure.md`
- `docs/phase-2.1A.5-authority-fence-decision-closure.md`
- `docs/phase-2.1A.6-reconcile-target-identity-audit.md`
- `docs/phase-2.1A.7-delegation-membership-binding-audit.md`
- `docs/phase-2.1A.8-authority-fence-source-identity-audit.md`
- `docs/phase-2.0.3-implementation-constraints.md`（AD-12-R1）

---

## 0. 本轮发现与修订记录

### 0.1 A9-P1-01：Fence 内部身份字段缺少一致性校验

**发现：** `AuthorityRevocationFence` 同时保存 `sourceKind`、`sourceKey`、`sourceVersion`、`scope`、`principalId`、`delegationId`。A8 规定了 sourceKey 解析，但没有完整规定冗余字段必须与解析结果一致。

**修订：**

- sourceKey 是规范身份编码；principalId/delegationId/scope 必须与解析结果一致。
- Principal：scope global、workspaceId=null、principalId=解析值、delegationId=null。
- Membership：scope workspace、workspaceId/principalId=解析值、delegationId=null。
- Delegation：scope workspace、delegationId=解析值、principalId=null、workspaceId=权威 Delegation.workspaceId。
- 任一不一致 -> `status=quarantined`，不得 completed、不得跳过目标、不得静默改写身份字段。

### 0.2 A9-P1-02：sourceKey 编码/解析歧义

**发现：** 原 sourceKey 形如 `principal:<id>` / `membership:<ws>:<pid>` / `delegation:<id>`，但 ID 是 opaque，未规定 `:` 等分隔字符是否允许；直接 split 有歧义。

**修订：**

- 保持 ID opaque，不改变所有实体 ID 格式。
- sourceKey 的 ID 分量使用 UTF-8 百分号编码（仅保留 unreserved，`%XX` 大写）。
- 固定段数解析；严格解码；解码后重编码必须逐字节相等。
- 拒绝空字段、额外分隔符、非法 `%`、小写十六进制、未编码的 `:`、大小写折叠/截断/归一化。
- sourceKey 比较使用完整规范字符串。

### 0.3 A9-P1-03：旧版本 Fence 与版本不匹配对象

**发现：** A8 场景 9 说“V4 对象不属于 V5 Fence，由对应 V4 Fence/当前授权处理”，隐含假设 V4 Fence 必然存在。不能把“不匹配当前 Fence”直接解释为“安全、无需处理”。

**修订：**

- 当前 Fence 只精确命中 `sourceVersion`。
- 低于 current sourceVersion 的对象必须有历史 Fence completed/物化或有效 frozen/revoked 证据；否则 orphan/quarantine，当前 Fence 不得 completed。
- 高于 sourceVersion 的对象不属于当前 Fence，但不得被覆盖。
- 缺少历史 Fence/历史数据不完整 -> `quarantined`/manual recovery，不能乐观完成。

**结论：A9-P1-01..P1-03 在设计层关闭；实现测试未开始。**

---

## 1. AuthorityRevocationFence 字段一致性

### 1.1 规范结构

```text
AuthorityRevocationFence:
  fenceId
  sourceKind                 principal | membership | delegation
  sourceKey                  canonical sourceKey
  sourceVersion              number
  scope:
    kind                     global | workspace
    workspaceId              WorkspaceId | null
  principalId                PrincipalId | null
  delegationId               DelegationId | null
  cause                      disabled | deleted | revoked | expired
  effectiveAt                Timestamp
  authorizationRevision      number
  status                     pending | reconciling | completed | failed | quarantined
  processedTaskIds           string[]
  processedGrantIds          string[]
  lastError
  quarantineReason           string | null
  diagnostics                string[]      // bounded
  createdAt / completedAt
```

### 1.2 一致性矩阵

| sourceKind | sourceKey 解析 | scope.kind | scope.workspaceId | principalId | delegationId |
|---|---|---|---|---|---|
| principal | principalId | global | null | = 解析 principalId | null |
| membership | workspaceId + principalId | workspace | = 解析 workspaceId | = 解析 principalId | null |
| delegation | delegationId | workspace | = 权威 Delegation.workspaceId | null | = 解析 delegationId |

附加约束：

- `sourceKey` 前缀必须等于 `sourceKind`。
- `sourceVersion` 必须为正整数，且等于失效前源记录 version；不是 commit 后新 version。
- 权威 Delegation 无法解析、Workspace 不一致、ID 不一致、字段缺失/非预期非空：`quarantined`。
- `quarantined` 状态下 effective 拒绝仍有效；不得把对象当非目标跳过；不得 completed；不得静默重写 sourceKey/principalId/delegationId/scope。
- 修复只能通过显式权威数据校验流程（manual repair），并保留诊断/审计。
- `failed` 是可重试操作错误；`quarantined` 不自动 retry。

---

## 2. sourceKey 规范编码与解析

### 2.1 编码

```text
encodeComponent(value):
  UTF-8 bytes
  unreserved = A-Z a-z 0-9 - . _ ~
  all other bytes -> %XX（大写十六进制）

sourceKey:
  principal:<encodeComponent(principalId)>
  membership:<encodeComponent(workspaceId)>:<encodeComponent(principalId)>
  delegation:<encodeComponent(delegationId)>
```

- ID 仍是 opaque；不改变 `prn_`/`ws_` 等实体 ID 格式。
- ID 中的 `:` 编码为 `%3A`；`%` 编码为 `%25`；空格编码为 `%20`（不使用 `+`）。
- 其他文档中的 `principal:<id>` 等写法是示意；实际 sourceKey 必须使用本节的编码形式。
- 不做 Unicode NFC/NFKC 归一化；ID 按原始码点/字节精确比较。

### 2.2 解析

1. 按原始 `:` 分割。
2. principal 必须 2 段，membership 必须 3 段，delegation 必须 2 段；其他段数拒绝。
3. 每段必须非空；严格百分号解码；非法 `%`、非大写十六进制、解码失败拒绝。
4. 解码后重新按 2.1 编码，必须与输入段逐字节相等；否则非规范，拒绝。
5. sourceKind 必须等于第一段；sourceKey 规范化后完整字符串用于比较。
6. 禁止大小写折叠、截断、前缀匹配、模糊匹配、把 ID 直接拼接。

### 2.3 失败处理

- 创建 Fence 时无法规范化 -> 拒绝创建或 `quarantined`；不得写入非规范 sourceKey。
- 读取已有 Fence 时非规范/解析失败 -> `quarantined`；不得猜测。
- sourceKey 与冗余字段不一致 -> `quarantined`；不得 completed、不得跳过目标。

---

## 3. 旧版本 Fence 与版本不匹配对象

### 3.1 精确命中

- 当前 Fence 只把 `version == sourceVersion` 且 source identity/scope 匹配的对象作为目标。
- 对象 version < sourceVersion 或 > sourceVersion 都不是当前 Fence 的目标。
- 但“不是当前目标”不等于“安全、无需处理”。

### 3.2 低版本对象

对于同一 source identity、`objectVersion < fence.sourceVersion`：

| 条件 | 处理 |
|---|---|
| 存在对应 `objectVersion` 的历史 Fence，status=completed，且目标已 frozen/revoked | 旧对象已被覆盖；当前 Fence 可跳过 |
| 旧对象已有有效 frozen/revoked 证据（含来源/审计） | 可跳过；证据必须可审计 |
| 历史 Fence pending/reconciling/failed | 当前 Fence 不得 completed；等待历史 Fence 完成 |
| 历史 Fence 不存在 | orphan；当前 Fence 不得 completed；`quarantined`/manual recovery |
| 历史数据不完整/无法证明 | `quarantined`；不得乐观完成 |

- 当前权威 source version 与对象 binding 不一致时，effective 授权必须 fail closed（frozen/拒绝）。
- 即使对象已经被 effective 拒绝，如果没有物化证据/历史 Fence，仍不能把派生状态视为已完成。

### 3.3 高版本对象

- `objectVersion > fence.sourceVersion`：不属于当前 Fence。
- 当前 Fence 不得覆盖新 binding、不得写回 active、不得删除新 Grant。
- 新对象按当前授权/新 Fence 独立处理。

### 3.4 completion 条件

当前 Fence 标记 `completed` 前必须：

- 精确命中并处理所有 `objectVersion == sourceVersion` 的目标；
- 对同 source identity 的所有 `objectVersion < sourceVersion` 对象，证明历史 Fence completed/物化或有效 frozen/revoked；
- 无法证明 -> orphan/quarantine，不得 completed；
- 不得用 processed IDs 替代上述证明。

---

## 4. 版本序列场景

### 4.1 V4 对象，V4 Fence 已完成，随后 V5 Fence

| 维度 | 结果 |
|---|---|
| 权威状态 | D1 V4 revoke 已完成；V5 是新 Fence |
| V4 对象 | 已被 V4 Fence 物化 frozen/revoked |
| V5 Fence | 只精确命中 V5 对象 |
| completion | V5 可跳过 V4 对象（历史证据完整），处理 V5 目标后完成 |
| 风险 | 不能因 V5 完成而清除 V4 证据 |

### 4.2 V4 对象，V4 Fence 不存在，随后 V5 Fence

| 维度 | 结果 |
|---|---|
| 权威状态 | 当前 D1 已 V5；V4 Fence 缺失 |
| V4 对象 | orphan；effective 因 version 不匹配 frozen |
| V5 Fence | 不精确命中 V4；不能直接跳过 |
| completion | V5 不得 completed；V4 orphan 需 quarantine/manual recovery |
| 风险 | 派生状态可能仍 active，不能把 effective 拒绝当作物化完成 |

### 4.3 V4 对象，V4 Fence pending，V5 Fence 同时创建

| 维度 | 结果 |
|---|---|
| 权威状态 | V4 Fence pending；V5 Fence 存在 |
| V4 对象 | 由 V4 Fence 处理；当前仍应 frozen/拒绝 |
| V5 Fence | 只处理 V5 目标；不得因 V4 pending 而跳过 |
| completion | V5 必须等待/证明 V4 已覆盖，否则不得 completed |
| 风险 | 两个 Fence 并集；一个完成不能清除另一个 |

### 4.4 V5 对象，V5 Fence 创建后发生 transfer

| 维度 | 结果 |
|---|---|
| 权威状态 | V5 Fence；transfer 为具体 taskId 写新 binding |
| 旧 V5 对象 | transfer 后旧 binding 不再目标；旧 snapshot Grant 同事务撤销 |
| V5 Fence | 仅对该 taskId 条件跳过；不覆盖新 controller |
| completion | 新 binding 不受旧 Fence；旧目标已冻结/撤销后可完成 |

### 4.5 同一 Delegation ID 多次 revoke/reissue

| 维度 | 结果 |
|---|---|
| 设计规则 | Delegation 变更必须新建 delegationId；同一 ID 的 reissue 不是合法授权记录 |
| 合法序列 | D1 V4 revoked -> D2 V5 created；旧 Task 仍 D1/V4 |
| 同一 ID 重复 reissue | 视为不一致/不合法 -> `quarantined`/manual repair；不得猜成新 grant |
| completion | 旧 D1/V4 目标必须由 D1 Fence 覆盖；D2 不替代旧 Task binding |

### 4.6 Fence 记录缺失、历史数据不完整或无法证明

| 维度 | 结果 |
|---|---|
| 权威状态 | 当前 source version V5；没有 V4 Fence/审计证据 |
| 旧对象 | orphan；effective 可能 frozen，但派生未证明 |
| 当前 Fence | 不得 completed；`quarantined`/manual recovery |
| 处理 | 通过权威数据校验/修复恢复历史证据；不得静默改写/删除对象 |

补充：A8 的 12 个数值碰撞场景继续有效；A7 的 re-add/new Delegation/transfer/source snapshot/double Fence 场景继续有效；A9 增加 fence 内部一致性和旧版本覆盖要求。

---

## 5. 跨文档一致性复核

| 文档 | 检查点 | 结论 |
|---|---|---|
| `phase-2.1A.2-contracts-v3-design.md` | Fence 字段一致性矩阵；sourceKey 规范编码；旧版本 orphan；quarantined | 一致 |
| `phase-2.1A.2-store-api-v3-design.md` | sourceKey 规范解析；字段一致性；quarantined；旧版本 completion | 一致 |
| `phase-2.1A.2-design-review.md` | Fence 一致性、sourceKey、旧版本、batch/completion | 一致 |
| `phase-2.1A.3-implementation-readiness.md` | 同左；实现未批准 | 一致 |
| `phase-2.1A.4-revocation-model-closure.md` | Fence 结构/状态；sourceKey；旧版本 completion | 一致 |
| `phase-2.1A.5-authority-fence-decision-closure.md` | 状态机含 quarantined；sourceKey 一致性；旧版本条件 | 一致 |
| `phase-2.1A.6-reconcile-target-identity-audit.md` | 旧版本 orphan/quarantine；quarantined 状态 | 一致 |
| `phase-2.1A.7-delegation-membership-binding-audit.md` | 双端 binding；sourceKey/ID/Workspace/version；batch 边界 | 一致 |
| `phase-2.1A.8-authority-fence-source-identity-audit.md` | 12 碰撞场景；旧版本场景 9 已收紧 | 一致 |
| `phase-2.0.3-implementation-constraints.md` | AD-12-R1 源级 commit；未引入同步物化 | 一致 |

搜索检查：

- 未发现只比较 version、不检查 source identity/scope 的规则。
- 未发现所有 Fence 批次被写成单一事务。
- 未发现把旧版本对象直接视为“安全非目标”。
- 未发现 sourceKey 直接 split 原始 opaque ID。
- 未发现大小写折叠/截断/模糊匹配。

---

## 6. P0 / P1 / P2 剩余问题

### 6.1 本轮关闭

| ID | 问题 | 状态 |
|---|---|---|
| A9-P1-01 | Fence 内部身份字段一致性 | **CLOSED（设计）**；实现测试未做 |
| A9-P1-02 | sourceKey 规范编码/解析 | **CLOSED（设计）**；实现测试未做 |
| A9-P1-03 | 旧版本 Fence/版本不匹配对象 | **CLOSED（设计）**；实现测试未做 |

### 6.2 仍开放

**P0：**

- P0-01：v2 不能承载 v3；必须新建 v3。
- P0-02：Workspace 不是 OS 隔离；真实隔离需 native helper/OS sandbox，或明确接受 cooperative。

**P1：**

- P1-03：Store v3 容量/JSON 写放大。
- P1-04：Windows native path guard。
- P1-05：v2→v3 migration manual recovery。
- P1-06：ACP unknown/无 replay/取消不确认。
- P1-07：Artifact 物理存储/保留。
- P1-08：Delegation/Principal 到期/撤权物化调度。
- Reconcile/Replay 实现测试：sourceKey 规范编码碰撞、字段一致性、旧版本 orphan、双端 binding、batch/completion 崩溃恢复。
- P2：API 错误/分页、Event schema、title/description、容量参数、Message/ACK、跨 Workspace Artifact。
- OD-09：`NEEDS_USER_DECISION`（独立，不阻塞）。

---

## 7. 实现准入结论

- **OD-11：DECIDED（方案 A）。**
- **AD-06-R1 / AD-12-R1：FROZEN。**
- **A7-P1-01 / A7-P1-02：保持关闭。**
- **A8-P1-01：保持关闭。**
- **A6 target identity/owner/事件分层：继续有效。**
- **OD-09：NEEDS_USER_DECISION（独立）。**
- **代码实现：NOT APPROVED。**
- **Phase 2.1B：未获批准。**

设计层：Fence 内部字段一致性、sourceKey 规范编码、旧版本 orphan/completion 已闭合，可作为实现输入。

实现前置条件：

1. Phase 2.1B 单独批准。
2. v3 新入口实现，不在 v2 打补丁。
3. OS 隔离实现或明确接受 cooperative。
4. Store 容量/写放大基准。
5. sourceKey 编码/解析、Fence 字段一致性、旧版本 orphan 测试。
6. Reconcile batch/completion 崩溃恢复/幂等/双 Fence 测试。
7. Replay/resultSnapshot 并发/撤权交叉测试。
8. Path guard、migration manual recovery、ACP 限制、Artifact 存储、到期物化等 P1 验收。

本文件不开始 Phase 2.1B，不实现代码，不推送远程。
