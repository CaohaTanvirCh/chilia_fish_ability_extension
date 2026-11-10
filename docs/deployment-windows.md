# Windows 原生部署

## 前提与版本

本机验证：Windows 11 10.0.26200；Node v24.18.0；已安装 DSH Desktop CLI 0.2.2-rc.1；官方 ACP SDK 固定 1.4.0。用户已明确暂不考虑 WSL，因此没有 WSL 部署依赖或路径映射转换。

在 PowerShell 中：

```powershell
Set-Location C:\path\to\fish_abil_ext
npm ci --ignore-scripts
npm test
npm run test:integration
npm start
```

真实集成测试会调用已配置模型，产生少量模型调用费用，并创建独立测试会话和任务记录。单元测试不使用真实模型。

## 配置

先复制本机配置模板：`Copy-Item config\windows.example.json config\windows.json`，再把 command/cwd 改成这台机器的实际路径。`config/windows.json` 含机器相关绝对路径，已被 .gitignore 排除，不会被提交。它包含 enabled、command、args、env、cwd、dataDirectory 和超时。当前命令使用安装版 Electron 的 Node 模式，启动参数完全对应官方 dsh.cmd；因为 CLI 在 app.asar 内，不能简单用普通 node.exe 读取该虚拟路径。

保持工作目录为 Windows 绝对路径。路径模块覆盖盘符、空格、中文和 UNC 校验；UNC 仅做格式单元测试，未实测网络共享上的 DSH 会话运行。

数据目录相对配置 cwd 解析；日志位于项目 logs。DSH 继续使用其官方 acp profile、Home 与凭据管理。本项目不读取 DSH 数据库，不提取 API key，不复制 Desktop 私有状态。

可选 `executorModule`（相对 cwd 的本地 ESM 路径）用于替换 Hub 的执行器，模块须导出 `createExecutor({config})`。默认不设置，使用内置 `DshAcpExecutor`；该入口也被 Hub 故障注入测试使用。只应指向本机可信代码。

## 使用

Hub 就绪后，在 stdin 每行输入一个 JSON：

```json
{"id":"health-1","method":"healthCheck","args":[]}
{"id":"task-1","method":"createTask","args":[{"cwd":"C:\\path\\to\\fish_abil_ext","prompt":"只回复你好，不调用工具。","requestKey":"hello-unique-request"}]}
{"id":"list-1","method":"listTasks","args":[]}
{"id":"stop-1","method":"stop","args":[]}
```

createTask 返回 taskId。查询/取消/关闭把该 ID 放入 args 数组；恢复示例：

```json
{"id":"resume-1","method":"resumeTask","args":["实际 taskId"]}
{"id":"next-1","method":"startExecution","args":["实际 taskId",{"prompt":"继续本工作任务","requestKey":"next-unique-request"}]}
{"id":"events-1","method":"getEvents","args":[0,100]}
{"id":"ack-1","method":"acknowledgeIntegrityAlerts","args":["实际 taskId",{"acknowledgedBy":"本机操作者","note":"已检查迟到通知"}]}
```

stdout 混合事件和请求结果，按 type/id 区分；使用 Node 子进程时直接 JSON.stringify 写入 stdin，避免 shell 拼接。原始日志与 JSON 不应直接发到 QQ，Phase 2 入口需要独立整理面向用户的文本。`cancelExecution` 的 result 是 `{execution,cancelRequested,cancelConfirmed}`；只有 `cancelConfirmed=true` 才代表终止已确认。`cancelTask` 返回 Task，调用方仍需检查活动 Execution 的状态。`acknowledgeIntegrityAlerts` 只是人工确认，不代表远端结果完整，也不会消除 `duplicateExecutionRisk`。

## 停用、替换与恢复

- 当前进程：发送 stop、关闭 stdin 或 Ctrl+C；清理 ACP 子进程和任务锁。
- 下次不启用：enabled 设置为 false。未设置登录自启，也未把服务安装到任何 bot。
- 重新启用：enabled 改回 true 并重新启动。stop 后当前实例终止，重新启动使用新实例。
- 替换执行器：调整 Hub 装配时注入满足 TaskExecutor 的模块；业务命令无须依赖 ACP。
- 替换存储或 transport：只实现对应公共方法，不访问现有模块内部文件。
- 崩溃恢复：v2未提交queued保留；可能已发送但无终态收据的Execution变unknown。resumeTask仅验证已结算上下文，不取回丢失结果；不会自动重发。
- 默认新Store目录为var/tasks-v2；旧Store必须用scripts/migrate-v1.mjs显式迁入新目录，迁移说明见contracts.md。
- 每Execution独立Runtime，最多8个并行；taskTimeout默认300秒，可配置但所有派生timer必须小于Node最大计时范围；没有进度不等于失败。时间上限不表示执行被确认取消。
- 锁损坏时：先确认没有活跃 Hub，保留备份后人工处理锁；不要在另一个实例运行时删除锁。

## 验证范围

真实测试覆盖创建、任务输出、关闭、列出、重启 ACP、恢复同一 Session 并保留上下文、取消活动 prompt。纯模块测试覆盖持久化、故障、路径和拒绝权限。

ACP Session 与 Desktop UI 的同步尚未验证，不能据此声称桌面界面会展示同一个任务。当前使用公开协议恢复 ACP 自己创建的会话；不会试图控制正在运行的桌面会话。对桌面 UI 的可见性验证仍是独立待办，不影响此 PoC 的原生 ACP 通路结论。

旧的 WSL 安装尝试被取消，可能留有 `/home/<user>/.local/share/fish-abil-ext/runtime` 中的部分下载；不被当前项目运行使用，也未作为验收结果。
