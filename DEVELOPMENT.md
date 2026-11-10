# 开发日志

## 2026-11-09 — Phase 0/1 启动

### 需求与边界

- 阅读用户提供的 `C:\Users\26648\Desktop\prompt.md` 与 `C:\Users\26648\Desktop\chatgpt_Q_A.md` 全文。
- 本阶段实现模块化 TaskExecutor 和官方 DSH ACP 适配器 PoC；通过验收后才进入 AstrBot、Cyrene、Bilibili 集成。
- 每个运行模块必须能够独立启动、替换、测试与停用，仅通过公共接口通信。
- DSH 只承担工作执行；不修改 DSH/Cyrene 上游，不操作 QQ/NapCat，不实现主动聊天或 B 站互动，不读取其他模块内部数据库。
- 用户随后明确改为 Windows 原生实现，暂不考虑 WSL。Windows→WSL 的原始要求已由此覆盖。
- 用户要求持续维护本 Markdown 开发日志。

### 环境核实

- Windows 11 专业版，版本 10.0.26200。
- Windows Node：`C:\Software\nodejs\node.exe`，v24.18.0。
- 已安装桌面 DSH CLI：`C:\Users\26648\AppData\Local\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd`。
- CLI `--version` 实测为 0.2.2-rc.1；`--profile acp --help` 实测支持 ACP stdio 服务。
- 早期 WSL 调查发现 Ubuntu-24.04、NVM Node 24.16.0，但登录 PATH 无 dsh。曾启动项目专用 WSL DSH 安装；用户改为 Windows 后已请求取消，最终状态为 killed（取消成功）；可能留有部分下载。项目内 WSL 安装脚本已移除，该路线不再开发。

### 官方接口核实

- https://dsh.pub/zh/plugins/acp/ 固定到旧版 0.1.0-rc.5；其中不支持 list/resume/close 的描述不能用于当前版本。
- 当前发布包文档及实现：
  - https://unpkg.com/@deepseek-ai/dsh-acp@0.2.2-rc.1/README.md
  - https://unpkg.com/@deepseek-ai/dsh-acp@0.2.2-rc.1/lib/index.js
- 新版支持 session/new、prompt、cancel、list、resume、close；应以 initialize 能力协商及实测再次验证。
- session/resume 恢复持久化会话，但不回放历史消息；session/load 不支持。
- list 返回可恢复的非活跃会话，不等于完整的任务登记表；Task ID 与 Session ID 必须分离。
- close 释放活跃会话，保留持久化记录用于恢复。
- ACP 不等于桌面 UI 控制；尚未验证桌面会话可见性或同步。
- npm dist-tag 存在差异：DSH CLI latest 是 0.2.2-rc.1，而部分子包 latest 仍旧；必须锁定明确版本。

### 已完成变更

- 建立项目 package.json 和依赖锁文件。
- 安装官方 ACP SDK，最初为 0.25.1，核实后改为与当前 DSH 匹配的精确版本 1.4.0；安装禁用生命周期脚本。
- npm install 报告 0 vulnerabilities。
- 尚未完成适配器及真实生命周期测试，不能宣称验收通过。

### Windows 原生实现与第一轮验证

- initialize 实测协商 ACP v1，明确返回 list/resume/close 能力。agentInfo.version 为硬编码 0.0.1，不能据此推断实际包版本；CLI 版本实测仍是 0.2.2-rc.1。
- 第一轮真实会话创建、prompt 输出 FISH_ACP_OK、关闭、list 查询成功。完整日志：`logs/probe-session.jsonl`。
- 已实现 contracts、Windows 路径校验、task-store、acp-transport、dsh-acp 和薄 Hub 入口；各模块通过公共方法注入连接。
- task-store 使用单所有者锁、原子快照、持久化事件，崩溃后 queued/running 转 interrupted，不自动重发。
- 真实闭环成功：创建 → prompt → close → list → 停止 Runtime → 新 Runtime 恢复同一 Session → 正确返回先前口令 FISH_RECOVERY_73 → 取消另一活动 prompt → close。
- 第一轮完整日志：`logs/integration-2026-11-09T14-29-49-014Z.jsonl`。
- 初始 22 项测试全部通过；Hub 另补 3 项测试也通过。
- 权限拒绝测试首次因测试端 SDK handler 用错 ctx.request 而失败，修正为 ctx.client.request 后通过，不涉及放宽权限。

### 复查与修复

- Transport：并发 start 共享握手；连接按 generation 隔离，旧回调不影响新进程；重启前清理旧进程。
- 请求超时关闭连接并清理 SDK pending 请求及子进程；关闭/强杀等待有界，终止失败保留所有权供重试。
- Hub：启动失败也释放 store；提前安装退出处理；共享 stop promise；停机拒绝新命令；输出缓冲超限或 EPIPE 触发清理。
- 新增迟到握手、stdout 断开但进程未退出、并发启动、启动期间 stop、模拟无法终止子进程等回归测试。
- 文档已补充架构图、合约、原生部署、启停和恢复流程。

### 当前限制与验收边界

- 尚未验证 ACP Session 在 Desktop UI 中的可见性或同步；不能声称原始任务书所有验收项均已通过。没有尝试读取内部数据库或修改官方代码绕过。
- session/resume 不回放历史更新；close 不删除历史；list 仅列可恢复的非活跃会话。
- Windows UNC 仅格式测试，未在网络共享执行真实任务；WSL 映射按用户要求不做。
- 本 PoC 事件快照未做压缩，适合小规模验证；没有新增 bot 插件、自启动、主动聊天或 B 站操作。
- 修复后的最终全量测试：29 passed、0 failed，2026-11-09 22:33（Asia/Hong_Kong）。完整输出：`logs/unit-tests.txt`。
- 修复后的真实 Windows ACP 闭环再次通过，包含相同 Session ID 恢复、上下文保持与活动任务取消。日志：`logs/integration-2026-11-09T14-33-51-946Z.jsonl`；控制台完整输出：`logs/integration-console.txt`。
- 测试启动的 Runtime 均已清理，未留下常驻 Hub；未启用自启动。
- 本次交付为可运行的 Phase 0/1 Windows PoC；Desktop UI 同步仍为明确未验项，因此 Phase 2 未开始。

## 2026-11-09 — Phase 1.1：只读审查与待确认设计

- 按用户执行顺序，本轮仅开展 Phase A/B；未修改源码、Contracts、配置或测试实现。等待用户确认设计后才开展 Phase C/D。
- 重新阅读核心源码、公共合约、测试、集成脚本、架构/部署文档与既有真实运行JSONL日志。
- 复跑原 npm test：29 passed、0 failed、0 skipped，约3秒。包含单元/内存模拟18项、Transport/Hub11项；后者包含模拟子进程与纯mock，不是真实DSH验证。
- 本轮未重新运行真实DSH集成；引用Phase0/1既有真实日志，不把它描述为Phase1.1故障恢复通过。
- 内存定向复现：创建会话中close遗漏新Session；旧通知污染新一轮结果；重复顺序续接再次提交prompt。
- 模拟ACP进程复现：stop后紧跟start可能留下新Runtime；超大request timeout溢出为1ms。复现子进程已清理。
- 静态审查补充取消请求/确认混淆、延迟取消击中后续执行、持久化失败链、崩溃窗口、事件归属、上层停机/输入限制等问题，共14项。
- 审查报告：`docs/phase-1.1-audit.md`，每项记录位置、触发、现状、后果、覆盖和处理建议。
- 设计稿：`docs/phase-1.1-design.md`，包含Task/Execution/Session关系图、状态图、恢复流程、v2 Contracts与迁移方案、分类测试计划和八项架构答复。
- 核心设计：独立Execution历史、提交意图先落盘、持久化幂等键、取消意图与确认分开、结果/终态/事件原子事务；无法核实原执行终态时unknown且不自动重发。
- 明确限制：ACP session/resume不回放结果；无法消除远端完成与本地提交之间的窗口，不会通过私有协议或内部数据库绕过。
- 当前结论：不建议进入Phase2。待用户确认设计；新增故障/并发/长任务测试尚未实施，不能提前宣称验收通过。

## 2026-11-09 — Phase 1.1：设计澄清与Phase C/D实施

- 用户批准Phase C/D，要求先澄清通知归属、同事务收据、取消门禁、Task投影及A12/A13容量。已写入docs/phase-1.1-clarifications.md，撤回同事务收据使interrupted恢复completed的错误分支。
- 通知采用每Execution独立官方ACP连接，旧进程和Session清理确认、取消发送结算后才允许新轮。官方0.2.2-rc.1源码settleAfterQuiescence等待outputTail，是当前响应前通知顺序依据；close/resume不被声称为通用屏障。
- 新增packages/task-store-v2、packages/dsh-acp-v2、Contracts v2；Hub只装配v2。Task、Execution、SessionBinding、Request和精简事件同Store事务。
- requestKey持久化幂等；未知执行禁止自动重发；已确认终态不可覆盖；历史unknown始终影响Task投影并单独可查。
- 取消requested/sent/confirmed分开，end_turn可赢取消竞态；延迟取消阻止下轮与恢复；stop等待独立取消集合，避免旧operation移除后提前关闭Store。
- 修复关闭任务创建Session竞态、失败关闭重试、Transport stop/start门禁、计时溢出、恢复进程资源所有权、持久化失败后退化健康状态。
- 输出1MiB、64KiB/250ms批量；至多32次时间刷新后仅保留字节阈值及终态flush。Store32MiB/20000事件，预留18MiB/1024事件控制8个执行在途输出；事件不再保存累积完整结果。
- Hub按UTF8字节限制单行1MiB、在途命令16、输出4MiB；getEvents游标续读；未实现多bot身份/路由。
- 新增显式离线迁移scripts/migrate-v1.mjs：源锁、目的迁移锁、原始备份、暂存验证、发布不完整标记；旧结果统一unverified unknown，不伪造收据。
- 迭代测试曾复现并修复：延迟cancel跨轮、关闭失败未保持Task closed、defer绕过执行上限、33条诊断超过32限制、多字节诊断超限、stop未等待已移出operations的取消、恢复进程漏管。均有回归。
- 最终分类：单元/内存fake/迁移57 passed，模拟ACP/Hub/Transport/真实Node退出故障31 passed，总88、0失败、0跳过。日志logs/phase1.1-unit.txt和logs/phase1.1-simulated.txt。
- 真实Windows DSH v2两轮通过。最终日志logs/real-v2-2026-11-09T15-39-58-168Z.jsonl（本地23:39:58起），控制台logs/phase1.1-real-console.txt。验证创建/收据/list/新进程恢复原Session上下文/两Session并行/实际cancelled收据/真实Runtime执行中kill/重启unknown不重发。
- 故障注入真实Node进程退出使用fake ACP，不当作真实DSH崩溃证据；长任务为缩时静默/hold/低速输出测试，未宣称数小时真实浸泡通过。
- 当前版本0.1.1；默认var/tasks-v2；v1模块保留兼容基线，不被新Hub运行引用。npm test:integration切换v2，legacy脚本保留独立命令。
- 最终验收docs/phase-1.1-acceptance.md完整列出证据、8项架构答复、剩余限制。官方ACP无法回放丢失结果仍unknown；未验证Desktop UI同步和所有工具孙进程硬杀回收。
- 停止于Phase1.1，等待用户验收与下一阶段范围；没有接入bot、主动聊天、B站、WSL或私有DSH数据库。

## 2026-11-10 — Phase 1.1.1/1.1.2 独立审查修复

- 依据 docs/phase-1.1-independent-review.md 修复 N01–N09；没有进入 Phase2 或接入任何 bot。
- N01：抽出 apps/companion-hub/lifecycle.mjs；Hub stop 成功记忆化、失败清空并允许同一实例重试，并发 stop 共享同一 attempt；新增 hub-lifecycle 控制器测试和真实 Hub 子进程 + 注入 executor 的 hub-stop 测试（第一次 stop 失败、第二次成功）。main 顶层 finally 对在途失败再重试一次。
- N02：ExecutionStore.open 识别终态 Execution 仍持 active Binding 的崩溃窗口，标 binding 为 unknown、recoveryRequired=true，并在 Execution 写 TERMINAL_SESSION_UNSETTLED 诊断；不伪造 closed。新增 afterTerminalCommit 崩溃后 resumeTask 再 startExecution 的测试。
- N06：Executor 新增 retryCleanup；closeSession/closeTask/stop 会重试 cleanupFailed 的 transport，成功后才更新 binding 为 closed，失败保留诊断和操作。新增首次失败、第二次成功测试。
- N03：失败终态写 ACP_STOP_REASON 诊断（含 max_tokens 等），不伪造 completed 或完成证据；新增失败 stopReason 测试。
- N04：createTask 的 inputHash 纳入 defer；旧版本不含 defer 的 request 记录仍可按旧语义重放；新增 defer 冲突和 legacy hash 测试。
- N05：ExecutionStore 增加 latestExecutionId 必须指向最后 Execution、Task.result 与最新 Execution 一致、Task.sessionId 与最新 Binding 一致、lifecycle/submission/availability 枚举和 integrityAlerts/风险一致性校验；反例以 VALIDATION 拒绝。更新 store fixtures 并新增语义反例测试。
- N07：新增 acknowledgeIntegrityAlerts(taskId,{acknowledgedBy,note})；原警报保留并追加确认人/时间，确认不证明结果完整，duplicateExecutionRisk 继续为 true，不复用受影响 Session；新增确认后新 Session 测试。
- N08：cancelExecution 返回 {execution,cancelRequested,cancelConfirmed}；取消超时/自然完成与确认取消分开；新增成功、超时、end_turn 竞态测试。
- N09：integration-v2 将 waitRunning 改名 waitDispatchIntent，真实 kill 结果改称 runtime-kill-after-dispatch-intent，明确不证明远端执行/工具副作用；更新 acceptance 表述，旧日志原样保留。
- 本次修复不改变 Windows 原生路线、官方 ACP、单 Store 所有者、unknown 不自动重发等约束。
- 版本更新为0.1.2。最终分类：unit/store/migration 65 passed、simulated ACP/Transport/Hub/fault 35 passed，均0失败0跳过；合并npm test为100 passed、0 failed；日志logs/phase1.1.1-unit.txt、logs/phase1.1.1-simulated.txt、logs/phase1.1.2-all.txt。
- 关键竞态与故障注入测试重复3次，每次25项全部通过；日志logs/phase1.1.1-repeat.txt。
- 真实Windows DSH ACP回归通过，日志logs/real-v2-2026-11-10T05-59-41-670Z.jsonl、控制台logs/phase1.1.1-real-console.txt。该回归仍只证明dispatch intent后kill，不证明远端执行或工具副作用。
- 修复报告docs/phase-1.1.1-1.1.2-fix-report.md，验收文档已增加Phase1.1.1/1.1.2复核节并修正N09表述。
- 仍明确未验证：真实OS级不可杀进程、真实DSH终态崩溃窗口、真实工具及孙进程、长时间浸泡、Desktop UI同步、多客户端。停止等待用户审阅，不进入Phase2。
