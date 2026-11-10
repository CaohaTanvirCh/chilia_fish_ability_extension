# 公共接口 v2 与兼容迁移

类型：`packages/contracts/v2.d.ts`。v1 index.d.ts 及原实现保留作为兼容测试对象，新Hub只装配v2。版本是应用协议版本2，不改变官方ACP v1。

## 方法

| 方法 | 语义 |
| --- | --- |
| initialize/start | 打开Store和恢复登记；没有任务时不启动DSH |
| createTask({cwd,prompt,requestKey,taskId?,defer?}) | 原子登记Task/首Execution/请求键；默认调度，defer保留queued |
| startExecution(taskId,{prompt,requestKey,acknowledgeUnknownExecutionIds?}) | 新尝试、新Execution；旧unknown必须逐个显式承认且使用新Session |
| dispatchQueued(executionId) | 显式提交能够证明未发送的queued；重启不会自动调用 |
| getTask/listTasks | 返回总体状态、活动指针、未解决ID及风险 |
| getExecution/listExecutions | 返回不可覆盖执行历史、输出完整性、取消与证据 |
| resumeTask/reconcileTask | 仅协调/验证上下文；resume不接受prompt，旧调用MIGRATION_REQUIRED |
| cancelExecution | 返回 `{execution,cancelRequested,cancelConfirmed}`；请求与确认严格分离 |
| cancelTask | 对Task活动执行请求取消并返回Task；不承诺已确认 |
| acknowledgeIntegrityAlerts(taskId,{acknowledgedBy,note?}) | 人工确认仍保留的完整性警报；不删除原记录、不证明结果完整，风险仍保留 |
| closeSession | 取消/结算并确认上下文关闭，不删除Execution；可重试cleanup |
| closeTask | 先持久化closed意图阻止新轮，再清理Session；失败保留closed并允许重试 |
| getEvents(afterSequence=0,limit=100) | 精简持久事件续读，limit至多1000 |
| subscribeEvents | SDK内实时订阅，可选显式重放游标 |
| stop | 停用、等待取消与上下文操作，释放Store；失败保留资源并允许重试 |

stdio命令仍为 `{id,method,args:[]}`，结果 `{id,result}`，错误 `{id,error:{code,message}}`，事件 `{type:'event',event}`。id仅响应关联；requestKey才是持久化幂等键，同key不同输入拒绝。`createTask` 的输入摘要包含 `defer`；旧版本未包含 defer 的请求记录仍按旧语义重放，不会因升级而改变已提交请求。同key返回原记录，不触发自动重发，甚至原记录为queued或unknown。

## 状态与结果

七种状态保留。Execution completed要求 end_turn证据+observed_complete结果同事务；cancelled要求ACP取消响应或确定未提交的本地取消。断连、未确认超时或完成未落盘为unknown。已提交终态不可更改；诊断及取消发送时间可补充。

Task投影：有任一历史unknown/interrupted或未确认的完整性警报，整体unknown；已人工确认的警报仍保留在Task中，但不再单方面迫使状态unknown，`duplicateExecutionRisk` 仍为true。否则活动Execution状态；否则最新Execution状态。activeExecutionId独立返回。显式承认unknown后新尝试完成，不会掩盖旧unknown。lifecycle closed只表示不再接受新执行。

恢复时queued/not_started保留；可能发送且无完成事务的记录unknown，不允许interrupted凭同事务内不存在的“额外收据”变completed。恢复Session不是恢复结果。终态Execution的Binding仍为active（终态提交后、清理确认前崩溃）时，恢复标Binding为unknown并记录 `TERMINAL_SESSION_UNSETTLED`，不伪造closed；`resumeTask`或`closeSession`可确认清理后再开始新执行。

## 通知

每Execution独立ACP连接，沿用上下文仅在旧Session和进程清理确认后新连接resume。SDK进入回调即同步接受匹配Session的活动prompt文本。终态响应后关闭窗口，先flush此前已收文本，再提交完成。迟到/不匹配通知隔离，最多32项、每项1KiB；完成事务后的违例触发Task完整性警报但不篡改已提交证据。

没有远端turnId/事件去重ID，不按文本或messageId假去重，不承诺端到端exactly-once。官方0.2.2-rc.1源码的settleAfterQuiescence在响应前await outputTail，是当前观察顺序依据，真实测试亦验证文本在完成前落盘；close/resume本身不被当成通用回合屏障。

## Store与容量

公共Store为snapshot+commit(expectedRevision,changes)，原子提交Task/Execution/Binding/Request/Event。独占锁，v2文件state-v2.json；任何模块不得直接解析其他模块存储。事件只有ID/状态/字节数，不含累积结果。Store校验引用、Session/Task所有权、active唯一、`latestExecutionId`必须指向最后创建的Execution、`Task.result`与最新Execution一致、`Task.sessionId`与最新Binding一致，以及lifecycle/submission/availability枚举；不一致快照以VALIDATION拒绝，不静默修复。

默认输出1MiB/Execution；64KiB或250ms批量，至多32次时间/早期提交后停用时间刷新，字节刷新始终保留，终态强制flush；默认至多约49次输出提交。内存批次至多64KiB，允许一个大帧瞬时达到剩余额度后立即flush。Store32MiB/20,000events/1000Tasks/5000Executions；预留18MiB和1024events用于最多8个在途执行及终态。过高水位拒绝新工作，硬限失败健康状态退化，不伪造成功。无自动历史删除；应离线归档整个Store。配置更小容量时需相应降低输出/并发参数，不能把小测试限制作为生产容量保证。

## 迁移

```powershell
node scripts/migrate-v1.mjs C:\path\legacy-store C:\path\NEW-v2-store
```

停止旧Hub，源锁与目的迁移锁保证独占；保存原始字节备份，副本验证，目标必须不存在；发布期间MIGRATION_INCOMPLETE阻止读取。v1历史均导入unknown/uncertain，保存legacyReportedStatus，不伪造原始收据或猜测旧回合。原始events完整保留在legacy-v1-backup.json。自动在原目录升级被拒绝。迁移成功后修改配置目录再启动；回滚先停进程，不覆盖v2新增执行。

错误包括IDEMPOTENCY_CONFLICT、UNKNOWN_EXECUTION、SESSION_UNSETTLED、INTEGRITY_ALERT、CLEANUP_FAILED、BUSY、CAPACITY、STORAGE_FAULT、MIGRATION_REQUIRED等。关闭失败后Hub可重试；`closeTask`会重试失败的transport清理，只有成功后才标记Binding closed。Store是本地已提交事实权威，不是DSH远端执行状态的全知数据库。
