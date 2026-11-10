# Phase 1.1 实施前澄清（2026-11-09，已获准按澄清实施）

本文覆盖 Phase B 中相冲突的表述。实施保持 Windows 原生、官方 ACP；不接入 bot。

## 通知的可验证边界

ACP session/update 携带 sessionId，但没有本项目 Execution ID。不能仅靠本地 ID 判断远端回合。为避免同一连接同一 Session 的跨轮迟到歧义，本阶段采用更保守的隔离：每次 Execution 使用一个新的 ACP Transport 连接/子进程；要沿用上下文时，在新连接 resume 原 Session。旧连接的 Session 在执行结算后关闭并停止连接；确认清理完成前不得用该 Session 开始新轮。不同 Task 可各自拥有独立连接并行运行。这是进程隔离，不把 close/resume 本身声称为协议回合屏障。

Transport 在 SDK onNotification 回调进入时立即调用本地接收器，不先经过额外异步步骤。接收器同步入每 Execution 有界队列（按到达顺序），然后批量持久化；终态响应后关闭接收窗口，等待此前已进入接收器的队列落盘，再原子提交输出与终态证据。SDK 与官方 DSH 实际顺序需通过源码核验、模拟通知屏障和真实集成测试记录；测试不能证明任意第三方服务器永远遵守顺序。

没有活动 prompt 的通知、sessionId 不匹配、终态回调后收到的通知，不作为结果：进入有限诊断隔离区。若通知发生在完成事务前，结果完整性 uncertain，Execution 不报 completed；完成事务后才发现协议违例，不修改已提交历史收据，记录独立完整性警报、阻止受影响 Task 后续自动执行，并从 Task 投影和查询暴露风险。旧连接不再被下一 Execution 复用，因此即使存在无远端 turnId 的迟到消息，也不能进入下一轮。

不按文本或 messageId 去重：messageId 可能对应多个合法 chunk。无远端事件唯一ID时，不能检测所有重复 chunk，本项目不承诺结果流 exactly-once。连接内观察顺序与独立连接隔离是依据，Execution ID 只是本地索引。

## 完成收据与原子性

删除 `interrupted → completed/cancelled（凭同事务收据）` 的普通恢复路径。结果、终态、收据、Task 投影和事件同一原子事务提交：提交成功则 Execution 已是 completed/cancelled；未成功则不存在可信本地终态收据。二者不能在正常 v2 Store 内同时成为 interrupted+可信完成收据。若格式出现矛盾，Store 校验失败而非猜测修复。

恢复时只保留已有可信终态；已可能发送且没有已提交终态，变 unknown。当前官方 ACP 的 resume 不回放原结果，因此不能把 unknown 恢复成 completed。未来若新增独立可信结果查询，必须另行定义证据和迁移，本阶段不实现。原子替换只消除本地实体分裂，不消除远端执行与本地落盘之间的不可避免窗口。

## 取消、结算和下一轮门禁

取消以 executionId 为目标，记录 requestedAt/sentAt/confirmedAt。重复取消共享一个操作。通知写入管道不是停止确认；仅 ACP cancelled 响应或能够证明从未 dispatch 的本地取消可确认 cancelled。end_turn 优先按真实完成处理，取消记为未生效。

下一轮必须同时满足：旧 Execution 有已提交可确认终态、取消发送操作已结束、旧 Session 已关闭且旧 Transport 已停止、Task 未关闭且没有未承认的 unknown/完整性警报。旧 Execution 不确定时，不复用其 Session。显式承认全部未解决 Execution ID 后可以选择新的 Session 执行一次新尝试，并保留 duplicateExecutionRisk；绝不自动重发。

## Task 投影和三类关闭

Task 一次最多一个活动 Execution；可以有多个历史 Execution。执行状态与 Task 生命周期分开：

1. `lifecycle=open/closed` 表示 Task 是否接受新执行，关闭 Task 不伪装为执行取消或成功。
2. `cancelExecution` 只请求停止指定活动尝试。
3. `closeSession` 只释放上下文；不改变既有 Execution 结果。活动执行必须先取消/结算，关闭失败不标成功。
4. `closeTask` 是取消活动执行并尝试关闭 Session，再标生命周期 closed；不清除 unknown、partial 输出或风险。失败保留诊断，允许重试；不能再启动新轮。

投影优先级：任何未解决 unknown/interrupted 或**未确认**完整性警报 → Task.status=unknown；否则活动 Execution 的 queued/running → 对应状态；否则 latestExecution.status。已确认警报保留原始记录和确认人/时间，不删除、不证明结果完整；`duplicateExecutionRisk` 继续为 true，且新执行不复用受影响 Session。activeExecutionId 单独可查询，所以有已承认旧unknown时新执行running，Task总体可回落到执行状态，但不掩盖历史风险。unresolvedExecutionIds、duplicateExecutionRisk 和 latestExecutionId 始终返回。未解决记录本阶段不提供“人工改成功”接口；完整性警报提供显式人工确认入口。

终态Execution的Binding仍为active时，恢复将Binding标为unknown并记录诊断，不伪造closed；恢复入口为resumeTask/closeSession。

## A12：容量与长任务存储

保留单所有者 Store，不引入大型队列。v2 Store 使用有上限的原子快照，每次提交仅记录精简领域事件（ID、状态、revision），不再在事件中嵌入累积完整结果。输出按 64 KiB 或 250 ms 批量落盘，终态前强制 flush，避免每 chunk 全量写盘。内存仅缓存每 Execution 未落盘批次。

实施补充：时间输出刷新至多32次，之后只按64KiB字节阈值及终态刷新，总输出提交默认约49次以内。Store默认终态预留扩大为18MiB及1024事件（32MiB硬限保持），覆盖8个并行输出及Task投影；新工作高水位约14MiB。小容量配置按比例预留，部署者必须配套降低输出/并发上限。

默认硬上限：单 Execution 输出 1 MiB UTF-8；单次未落盘队列 64 KiB（单帧可至剩余额度）；Store 快照 32 MiB；领域事件 20,000 条；任务 1,000 个；Execution 5,000 个；单Execution隔离诊断最多32条，每条最多1KiB；全局在途执行8个；Hub在途命令16个、单行1MiB UTF-8、输出缓冲4MiB。计量按字节，不按字符。达到限额明确拒绝/中断并记录 OUTPUT_LIMIT/CAPACITY；不静默截断后报成功。

Store 预留终态/故障记录空间与事件预算，达到高水位拒绝新工作而非等到无法写终态。不能保证磁盘满时写入任何诊断；此时独立 health/stderr 报 storage fault，停止自有进程，重启后把未确认 execution 变 unknown。无自动清理历史：需要停止后归档整个 Store 目录，再建立新Store；幂等键和历史只在各Store有效，归档不是允许重放旧任务。上线长期使用前需另行设计跨归档查询，本阶段明确不做无界长驻服务。

deadline 与静默分别处理：没有进度通知不等于失败；用持久 deadlineAt、分段计时或限制有效计时范围。结果写盘放大由批量输出、精简事件、硬容量边界控制，仍是小规模 PoC，不声称无限扩展。

## A13：Hub范围

只增加 getEvents 游标续读、有界字节解析、有界命令准入、明确诊断。无多bot身份、权限或多调用方路由。一个 Hub、一个 Store 所有者；底层并行 Task 不代表多入口已经可部署。

## 实施接口约定

Store v2 公共接口：open/close/snapshot/commit(expectedRevision, changes)/healthCheck；changes 包含 tasks/executions/bindings/requests 的按ID upsert、精简 events。所有引用、状态投影和终态证据在同一 commit 校验。snapshot 返回脱离内部对象的副本。Executor只通过该接口，不读Store内部文件。

旧v1 Store保留独立适配器以支持原测试和离线迁移；新入口只使用v2。迁移不捏造旧 Execution/收据，保留legacy快照与备份并标不确定。Contracts统一明确v2类型及旧接口兼容边界。
