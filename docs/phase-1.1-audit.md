# Phase 1.1 / Phase A — 可靠性审查报告

日期：2026-11-09。结论：现有 PoC 的正常 ACP 通路成立，但尚不足以满足 Phase 1.1 的结果确定性、幂等重试和取消确认要求。不建议进入 Phase 2。本次不修改实现；设计见 [Phase B](phase-1.1-design.md)，等待用户确认。

## 审查范围与证据等级

已读核心实现、Contracts、现有全部测试模块（执行器、Store、Transport、Hub及路径）、集成脚本、开发日志、架构/接口/部署文档、配置及上一轮真实 JSONL 集成日志。

证据分为：静态代码路径确认；内存 fake transport 的定向复现；模拟 ACP 子进程复现；既有真实 DSH 日志。模拟不能证明真实 DSH 一定产生某种异常通知。

本轮复跑原 npm test：29 passed、0 failed、0 skipped，约3秒。分类为18项单元/内存模拟（Store9、Executor7、路径2），11项Transport/Hub测试（Transport8、Hub3，其中包含模拟无法终止对象与无效命令检查，并非每项都是真实协议对话）。本轮没有重新运行真实 DSH；既有真实日志为 [22:33集成日志](../logs/integration-2026-11-09T14-33-51-946Z.jsonl)。29项通过仅是原覆盖基线，不是Phase1.1验收。

旧 unit-tests.txt 由先前 PowerShell 输出为非UTF-8，read工具不能直接读取；本轮依据重新执行的工具输出核实通过数，没有把解码失败当作测试失败。

## 已成立的基础

- Store 在一次快照原子替换中保存 Task 与事件，先 fsync 临时文件再 rename，失败时不发布新内存状态：[Store:117](../packages/task-store/index.mjs#L117)、[Store:158](../packages/task-store/index.mjs#L158)。已有失败替换测试。
- 有单所有者锁和死PID回收；同一Store的两个Hub不能合法并行写入。
- Executor重启不会自动重放旧prompt，但将所有queued与running统一改interrupted，粒度不足。
- Transport已具备连接世代隔离、默认拒绝权限、超时清理、失败终止有界等待。
- 真实日志证明关闭后重启并恢复相同Session可保留上下文，不证明异常退出时能恢复丢失结果。

## 问题清单

以下位置均为审查时源码行号。P1为正确性/资源所有权高优先级，P2为接口和可用性完善。每项均描述触发、现状、后果、覆盖与建议。

### A01 / P1：没有独立Execution，续接覆盖当前结果

位置：[Contracts:4](../packages/contracts/index.d.ts#L4)、[Executor:156](../packages/dsh-acp/index.mjs#L156)，特别是164行。

触发：完成后resumeTask携带新prompt，包括随后resume失败或进程退出。

现状：直接覆盖Task.prompt并清空result/error，没有attempt/executionId。旧值仍在事件快照中，因此不是全部历史物理丢失；但无正式Execution接口可查询、关联或判断完整性。

后果：上层拿到空结果或最新一轮，不能稳定追溯每次尝试、取消或终态证据。

覆盖：Executor测试55行只检查复用Session，未检查历史结果。建议引入独立不可覆盖的Execution历史，Task仅维护投影与指针。

### A02 / P1：取消请求被误当作取消确认

位置：[Executor:132](../packages/dsh-acp/index.mjs#L132)、139、169–181。

触发：cancel标志置位后，prompt正常返回end_turn；或取消期间返回执行错误。

现状：operation.cancelled优先于实际stopReason，catch也可用该标志标cancelled。请求意图和发送/确认均无持久化字段。

后果：实际已经完成/未确认停止的工作被报为取消；重启丢失取消意图。

覆盖：Executor62行仅模拟cancel立即返回cancelled，没有end_turn竞态。建议记录请求、发送、确认，按协议终态裁决；未确认保留unknown。

### A03 / P1：取消未结束时新一轮可进入，取消可能击中后续执行

位置：[Executor:169](../packages/dsh-acp/index.mjs#L169)、[Executor:156](../packages/dsh-acp/index.mjs#L156)。

触发：notify延迟，旧prompt已结算并从operations删除，此时resume启动下一轮；稍后session/cancel送达。并发重复cancel也各自通知与升级停机。

后果：旧请求误伤新Execution；一个任务取消超时会停共享Runtime，其他Task也被中断。

覆盖：没有延迟notify、重复取消或多任务测试。建议每Execution取消single-flight；恢复/新执行受取消送达与结算门禁约束；明确强停影响全部自有Session。

### A04 / P1：Session创建期间close可返回closed却泄漏会话（已复现）

位置：[Executor:185](../packages/dsh-acp/index.mjs#L185)，188行在await cancel前取快照；119–123行稍后建立绑定。

触发：session/new延迟 → closeTask → 新Session响应。

现状：旧快照sessionId=null，跳过session/close，最终closed=true但owned仍含Session。

内存复现结果：calls仅session/new，Task cancelled/closed=true，owned含s。覆盖：现有只测stop与创建竞态，无close竞态。建议短互斥保护，取消后重读绑定，关闭确认与本地标记分开。

### A05 / P1：通知缺少执行归属与完整性检查（已复现）

位置：[Executor:142](../packages/dsh-acp/index.mjs#L142)。

触发：同Session续接时上一轮文本迟到、重复；恢复阶段通知；终态后迟到。

现状：只按sessionId与operations.has筛选，文本直接拼接。复现：续接结果含late-oldlate-old。恢复阶段收到文本又可能在128行清空，operation删除后迟到则被丢弃。

后果：跨轮污染、重复输出、无法判断结果是否完整。原fake仅同步发送一个chunk后返回end_turn，没有异常顺序覆盖。

建议：固定Execution绑定、连接世代、接受阶段与通知处理队列，终态等待已接收队列落盘。ACP无可重放执行事件流，不能单靠本地executionId解决无turnId迟到消息，也不能按文本或messageId盲目去重。

### A06 / P1：创建/提交/完成均存在跨进程崩溃窗口

位置：[Executor:91](../packages/dsh-acp/index.mjs#L91)、119–121、128–133；[Store:88](../packages/task-store/index.mjs#L88)。

触发：Task创建后退出；远端Session已创建映射未写；running已落盘prompt未发送；远端完成本地终态未写。

现状：只有Task状态，没有持久化提交意图与完成收据；queued/running全部interrupted。

后果：不自动重发这点安全，但不能区分未发送和已执行；孤立Session不能通过cwd猜测归属。恢复Session不能取得未保存结果。

覆盖：Store子进程退出仅制造running记录；真实集成21–24行是完成后的优雅重启，非故障恢复。建议显式submission阶段、不可消除窗口记unknown；本地终态/结果/事件同事务，承认ACP无法回放结果。

### A07 / P1：重试不幂等，重复续接可再次执行（已复现）

位置：[Contracts:16](../packages/contracts/index.d.ts#L16)、[Executor:160](../packages/dsh-acp/index.mjs#L160)、[Hub:39](../apps/companion-hub/main.mjs#L39)。

触发：调用已执行但响应丢失，调用方用相同请求再次resume(prompt)；create不提供taskId时也会新建。

现状：Hub id只响应关联，未存请求映射；仅阻止当前operations重叠。内存复现相同续接顺序两次产生两次prompt（含初始共3次）。

覆盖：只有重叠恢复被拒绝测试。现有v1未承诺幂等，这是本阶段缺口。建议持久化requestKey+输入hash+executionId，同key返回原结果，冲突明确拒绝。

### A08 / P1：持久化故障可能使任务留running或故障清理不完整

位置：[Executor:66](../packages/dsh-acp/index.mjs#L66)、106、133–139、147–154、47–60；[Transport:54](../packages/acp-transport/index.mjs#L54)。

触发：磁盘满/原子替换失败发生在输出、终态、disconnect或stop状态提交。

现状：catch仍用同一change再写一次；第二次失败则operation.done拒绝但create未等待/注册统一错误sink。disconnect循环中一个写入失败可阻断后续任务abort；Transport会吞掉callback异常。stop finally中的disconnected抛错可阻止后续store.close。

后果：持久记录可能仍running、健康状态不反映存储故障、未处理拒绝或清理链中断。输出处理失败后仍收到end_turn时缺少resultIntegrity门禁。

覆盖：Store单层失败写入有测试，但无Executor+Store组合失败注入。建议存储故障隔离、逐任务abort不被单点异常中断、禁止发布未提交成功、明确degraded health。

### A09 / P1：stop与随后start交错可留下新Runtime（模拟ACP复现）

位置：[Transport:124](../packages/acp-transport/index.mjs#L124)，128行只截取当时starting；26–31行新start等待旧cleanup后再spawn。

触发：已启动t；const stopped=t.stop(); const restarted=t.start(); await stopped。

现状：stop完成后health仍true，新pid存活；复现结束已显式清理。现有测试12行仅start→stop，不覆盖反向交错。

后果：独立模块stop不保证停用边界。建议生命周期epoch/门禁明确停机期间拒绝start，停完后再显式启用。

### A10 / P2：恢复与关闭失败会污染已完成记录，终态缺少单次提交约束

位置：[Executor:117](../packages/dsh-acp/index.mjs#L117)、127、139、153、194。

触发：completed Task无prompt恢复时Session不存在/占用；disconnect与catch分别更新。

现状：恢复错误可将原completed变failed；重复interrupted事件和错误覆盖；inactive close只标本地closed，没有远端关闭证据。

后果：混淆执行结果与Session可用性。覆盖：仅unsupported capability，没有已完成Session恢复失败。建议绑定状态独立、终态不可变、协调无变化不重复事件。

### A11 / P2：Store只验证形状，未验证最终快照与事件一致、Session唯一性

位置：[Store:101](../packages/task-store/index.mjs#L101)、158–167；[Contracts:66](../packages/contracts/index.d.ts#L66)。

触发：格式合法但Task末态不同于其最后事件；两个Task同sessionId；错误调用从终态任意转换。

现状：验证事件序号/身份，但不比较末事件与Task，允许sessionId/cwd等任意patch。

后果：受支持调用路径外或迁移错误可产生语义损坏，onUpdate.find仅取首个匹配。正常create路径通常生成不同Session，不能据此声称已发生真实串线。

覆盖：有格式/不可变ID校验，无多实体语义校验。建议Store公共事务校验关联与revision，迁移中保守保留legacy证据。

### A12 / P2：长任务成本、超时与资源清理契约不足

位置：[Store:122](../packages/task-store/index.mjs#L122)、132、162；[Executor:14](../packages/dsh-acp/index.mjs#L14)、117–119、129；[Transport:70](../packages/acp-transport/index.mjs#L70)。

触发：长输出/多事件/多任务，或超大timeout。

现状：每块输出复制全历史、把累积result嵌入事件并同步重写全文件，可能二次增长并阻塞事件循环。session创建/恢复借用cancelTimeoutMs；Executor与request调用参数未全面限制JS最大timer，超大值可能退化为极短计时。

后果：延迟、磁盘压力、意外超时、任务互相影响。现有只有10ms超时测试，没有静默长任务。建议分离超时、分段deadline、限制记录/输出容量，必要时在Store内部优化；不引入大型队列。

### A13 / P2：Hub事件恢复与多调用方接口尚未具备

位置：[Hub:17](../apps/companion-hub/main.mjs#L17)、26、30–41。

现状：只有一条stdio、自动live事件转发，无getEvents游标命令；没有调用方身份/权限和持久化请求幂等；命令不限制pending数量，行长度检查发生在readline已缓冲之后。

后果：客户端重连不能按公共Hub接口续读；两个bot各自启动会争Store锁；输入压力可堆积。覆盖：Hub只disabled/startup/health-stop三项。

建议：本阶段补事件查询、命令admission和有界输入；多入口身份/接入留到明确Phase2设计，不现在接bot。

### A14 / P2：上层stop等待启动结束，关闭失败无法通过同实例重试

位置：[Executor:47](../packages/dsh-acp/index.mjs#L47)、[Hub:9](../apps/companion-hub/main.mjs#L9)。

触发：initialize长时间无响应时退出，或Transport强制终止失败。

现状：Executor先await starting再调用transport.stop，不能利用Transport已有的启动中止能力；默认可能等待30秒，超大合法startupTimeout会更久。Executor/Hub永久缓存rejected stopPromise，而Transport自身支持重试清理；finally还可能在子进程终止未确认时释放Store锁。

后果：停用延迟、上层无法重试清理、资源所有权与Store所有权不一致。覆盖：Transport层有start→stop和模拟kill失败测试，上层没有对应覆盖。建议立即中止启动，整体stop有界，失败保留清理状态与诊断，明确何时释放Store所有权。

补充A12的定向复现：向request传2147483648毫秒，Node报告TimeoutOverflowWarning并设为1ms；模拟ACP进程约23ms内被超时关闭。该复现不调用真实DSH。即使两个超时各自不溢出，求和也需要验证。

## 测试证据的边界

[集成脚本:25](../scripts/integration.mjs#L25) 等待任意running事件且无deadline，没有限定taskId；失败发生在running前会一直等。取消发生在本地running后极短时间，不能证明真实长任务运行或取消所有工具副作用。

[Executor测试:74](../test/executor.test.mjs#L74) 允许failed或interrupted任一结果，未固定超时的确认语义。需要用确定性屏障替换“多个结果都算通过”的弱断言。

原测试并未覆盖用户要求的多Task交错、完成未落盘崩溃、取消中Hub退出、重复恢复/重试、无通知长任务。下一阶段测试计划和每个崩溃窗口的预期见PhaseB；本报告未宣称这些测试已通过。

## 本轮交付与建议

已提交审查报告与状态/恢复设计；源码、Contracts、配置和测试文件未改动。建议批准设计后实施PhaseC/D，验收之前保持Phase2关闭。核心接受限制：当ACP不能返回此前Execution终态时只能unknown，任何“问模型刚才做完了吗”的回答都不能升级为原Execution完成证据。
