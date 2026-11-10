# Phase 1.1 验收报告

2026-11-09 23:40（Asia/Hong_Kong），Windows原生，版本0.1.1。结论：Phase C/D的本地可靠性实现和分类回归通过；官方ACP无法回放未落盘结果等限制明确保留。停止于本阶段，未开始Phase2。

## 交付与设计澄清

- [Phase A审查](phase-1.1-audit.md)保留14项问题与位置。
- [实施前澄清](phase-1.1-clarifications.md)覆盖用户四项要求和A12/A13。
- [当前架构图/状态图/恢复图](architecture.md)、[Contracts与迁移](contracts.md)、[v2类型](../packages/contracts/v2.d.ts)、[Windows部署](deployment-windows.md)。
- 新Executor、Store独立目录，通过transportFactory/Store接口注入；旧v1实现不作为新Hub运行路径，保留兼容测试。

通知：每Execution独立连接；旧进程清理完成和取消发送结束前阻止下一轮。已经进入回调的匹配通知先同步入有界批次，响应后关闭接收窗口并flush，然后结果/终态/收据/事件同事务。迟到或无归属通知隔离，必要时Task完整性警报，不污染下一轮。不是本地executionId推测远端归属，也不是声称close/resume构成通用屏障。

依据：官方[@deepseek-ai/dsh-acp 0.2.2-rc.1实现](https://unpkg.com/@deepseek-ai/dsh-acp@0.2.2-rc.1/lib/index.js)的AcpSession.settleAfterQuiescence等待outputTail，close等待idle/outputTail/flush；官方SDK回调内本地接收发生在额外await前。模拟wire测试验证响应前两条通知完整保存，真实测试验证输出事件先于完成事务。无远端事件唯一ID，不能可靠去重所有重复chunk，不能保证任何非合规服务器的顺序。

收据：没有普通interrupted→completed路径。同事务成功已是completed，失败没有额外可信收据；恢复可能提交的记录unknown。取消请求与确认分别记录，end_turn可赢得取消竞态。

Task：未解决unknown优先于新执行成功，activeExecutionId单独查询；历史不会覆盖。取消Execution、关闭Session、关闭Task分别定义。closeTask先落盘closed意图，即使清理失败也禁止新轮，允许显式重试清理。

## 最终测试结果（完整日志）

| 分类 | 结果 | 证据 |
| --- | --- | --- |
| 单元、内存fake与迁移 | 57 passed / 0 failed / 0 skipped | [完整输出](../logs/phase1.1-unit.txt) |
| 模拟ACP、Hub/Transport子进程、故障注入 | 31 passed / 0 failed / 0 skipped | [完整输出](../logs/phase1.1-simulated.txt) |
| 真实Windows DSH ACP | 一条回归流程的8组检查全部通过 | [JSONL](../logs/real-v2-2026-11-09T15-39-58-168Z.jsonl)、[控制台](../logs/phase1.1-real-console.txt) |

本地合计88项通过，不把真实流程8组检查混算为8个node:test。迁移单元中使用真实文件系统和锁，但不是DSH。模拟故障中Node进程真实退出/被杀，协议执行器为fake；不称真实DSH崩溃验证。

旧29项基线处理：v1 Executor7、Store9、路径2保持；Transport旧8保持并新增4；Hub旧3中的“无效二进制启动失败”按lazy per-execution架构更新为“无任务不启动DSH”和构造失败不泄锁，其余行为保持。旧测试通过不代表v1可靠性问题被原地修复，新Hub只使用v2。

## 覆盖矩阵

| 用户场景 | 证据与预期 |
| --- | --- |
| 创建后Hub退出 | crash-v2 afterCreate真Node退出：queued保留、原key重试不发prompt |
| 提交后退出 | beforePrompt提交意图后退出：unknown、无自动重发；runtime-death 在本地持久化 dispatch intent 后断连，同样 unknown；不证明 DSH 已收到或执行 Prompt |
| DSH完成、本地终态写入前退出 | beforeTerminalCommit模拟完成后真实进程退出：partial/unknown，无收据 |
| 终态写入后、应答前退出 | afterTerminalCommit退出：保留completed，原key返回同执行 |
| Runtime在 dispatch intent 后退出 | 模拟及真实DSH均覆盖“本地已持久化 dispatch intent 后 kill”；unknown、不伪造收据。未证明 DSH 已开始执行或发生工具副作用 |
| ACP断开进程存活 | 模拟官方SDK wire及Transport测试：清理后才返回/替换 |
| 恢复失败/重复恢复/恢复中停机 | recovery-v2：新连接、不新增Execution、不改旧终态；停机拥有并清理恢复进程 |
| 取消中Hub退出 | 子进程kill：保留取消请求，unknown，没有confirmedAt |
| 多Task/Session交错 | 内存交错输出隔离；真实两Session并行且各自完成 |
| 重复cancel、resume、stop | delayed cancel门禁、single-flight、重复上下文恢复、Transport start/stop两向竞态 |
| 长任务/长时间无通知 | 缩时模拟静默、可控hold、deadline和无确认取消；低速40批输出+大块字节落盘 |
| 长任务持久化与重启 | 模拟silent完成保存；真实已存在Session在新进程恢复并验证上下文 |
| Store/Session不一致 | 绑定唯一性、恢复失败不覆盖终态、可能提交unknown、原子提交失败后重新打开unknown |
| 并发启动/准入 | Store单所有者、Hub16条命令上限、8个执行门禁与defer dispatch限额 |

“长任务”是确定性缩时/静默/超时路径验证，没有进行数小时真实DSH浸泡测试；本报告不把150ms模拟静默称为真实长时间稳定运行。真实Runtime kill发生在持久化 dispatch_intent 之后；它证明本地已决定发送后的中断处理，**不能证明 DSH 已收到/执行 Prompt，也不能证明工具副作用发生**。所有真实prompt要求不调用工具。该证据边界已按 Phase 1.1.2 N09 修正。

## 容量与I/O

- 单执行1MiB UTF8，超限unknown且保存已接受partial，不截断后报成功。
- 默认64KiB/250ms批量，时间刷新最多32次；字节刷新继续有效、终态flush，默认输出提交上限约49次。事件不嵌累积结果。
- Store硬32MiB/20,000事件/1000Tasks/5000Executions；预留18MiB和1024events供8个并行执行及终态，过高水位拒新工作。
- Store硬失败/磁盘I/O故障通过独立health报告STORAGE_FAULT，停止进程；本地未保存完成不能对外成功，重启unknown。
- 依然是有界全快照Store，批量减少I/O而不是无限伸缩。无自动历史清理；离线归档和新Store会改变幂等键作用域，必须人工管理。

## 八个架构问题

1. **Store是否唯一权威？** 是本地已提交状态的唯一登记，不是DSH执行结果的全知来源；无证据unknown。
2. **映射是否完整恢复？** 已保存Binding可恢复；session/new响应和本地绑定事务之间仍可能留下孤立Session，禁止猜测关联。
3. **Execution ID是否必要？** 已引入，每次尝试独立历史、请求键、取消和证据。
4. **通知能否可靠追踪进度？** 能保存已观察消息；没有可靠百分比、丢失重放或所有重复消息检测保证。
5. **哪些可自动恢复？** 未发送queued、已提交终态保持；可能发送无收据unknown，不自动重发。
6. **重复执行风险？** 本地原key不重发；官方无远端幂等提交，显式新尝试仍可能重复副作用，必须逐个承认unknown，风险在Task/Execution可查。
7. **可同时给Cyrene/AstrBot调用？** 尚不能按两个独立Hub方式部署。只有单stdio客户端与Store单所有者，未实现多bot身份/路由（按用户范围禁止）。
8. **集成前必需什么？** 用户确认验收和Phase2范围；再设计单Hub接入、身份授权、请求键生成与事件游标使用。若要长期无人值守，还需真实长时间浸泡、归档策略及完整工具子进程回收验证。

## 未解决限制与验收判定

- 官方ACP无法取回仅在DSH内、从未被本地保存的原执行结果；“完成未落盘后自动恢复成功”不可实现。替代unknown+诊断+人工处理，未降低标准伪造通过。
- 任意通知重复/恶意迟到且无远端turn ID不能完全识别。独立连接阻止跨Execution污染；完整性警报阻止继续自动执行。
- Windows断电/磁盘损坏不属于跨进程exactly-once保证。fsync+rename只保证本地原子发布策略。
- 未验证真实工具孙进程在所有硬杀情况下均被回收；真实测试使用无工具prompt。
- 未验证Desktop UI与ACP同步，也未开展数小时真实长任务浸泡。
- 迁移把旧结果标legacy-unverified/unknown；完整原事件备份保留，不假称可精确重建v1所有Execution。

验收结论：Task/Execution/Session边界、取消确认、幂等门禁、原子持久化、并发隔离、故障恢复、容量及测试分类已交付；受ACP限制的不可恢复结果明确未实现。建议接受为Phase1.1有明确限制的完成版本。是否进入Phase2由用户决定，本次不启动任何集成。

## Phase 1.1.1 / 1.1.2 修复后复核

独立审查 N01–N09 的主要修复见 `docs/phase-1.1.1-1.1.2-fix-report.md`；最终审查仍指出 N02 的 `recoveryRequired` 闭环和 N05 的投影 fail-closed 残余，已在 Phase 1.1.3 关闭（`docs/phase-1.1.3-fix-report.md`）。当前版本 0.1.2 的复核结果：

| 类别 | 结果 | 日志 |
| --- | --- | --- |
| Unit/store/migration | 65 passed / 0 failed | `logs/phase1.1.1-unit.txt` |
| Simulated ACP/Transport/Hub/fault | 35 passed / 0 failed | `logs/phase1.1.1-simulated.txt` |
| Real Windows DSH ACP | PASS；8 组检查 | `logs/phase1.1.1-real-console.txt`、`logs/real-v2-2026-11-10T05-59-41-670Z.jsonl` |
| 关键竞态重复运行 | 3 次 × 25 项全部通过 | `logs/phase1.1.1-repeat.txt` |
| 合并全量本地测试 | 100 passed / 0 failed | `logs/phase1.1.2-all.txt` |

本节的 65/35 是 Phase 1.1.2 修复后数量；上方 57/31 是 Phase 1.1 当时的历史结果，不应混用。N09 证据边界以本节和修复报告为准：真实 kill 仅证明 dispatch intent 后中断，不证明 DSH 已执行 Prompt 或发生工具副作用。其余未验证项（真实长任务、工具及孙进程、Desktop UI、多客户端）仍保持未验证。

## Phase 1.1.3 修复后复核

最终审查的 N02（`closed + recoveryRequired=true` 未闭环）与 N05（未知 Execution 投影可省略而 fail-open）已修复。当前版本 0.1.3 的自测结果：

| 类别 | 结果 | 日志 |
| --- | --- | --- |
| Unit/Store/迁移 | 76 passed / 0 failed | `logs/phase1.1.3-unit.txt` |
| Simulated ACP/Transport/Hub/fault | 37 passed / 0 failed | `logs/phase1.1.3-simulated.txt` |
| 合并全量本地测试 | 113 passed / 0 failed | `logs/phase1.1.3-all.txt` |
| N02/N05 关键反例重复运行 | 3 次 × 20 项全部通过 | `logs/phase1.1.3-repeat.txt` |
| 真实 Windows DSH ACP | PASS；8 组检查 | `logs/phase1.1.3-real-console.txt`、`logs/real-v2-2026-11-10T06-34-55-196Z.jsonl` |

本阶段仍为 CONDITIONAL PASS，开发自测不替代独立验收。N02 的真实 DSH 崩溃窗口、N01/N06 的真实 OS 不可杀进程、真实长任务/工具副作用/Desktop UI/多客户端仍未验证。
