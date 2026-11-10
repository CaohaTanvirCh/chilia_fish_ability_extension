# Fish Ability Extensions — Phase 1.1.5

Windows 原生 TaskExecutor 可靠性实现；未接入 AstrBot、Cyrene、QQ/NapCat 或 Bilibili，未开启自启动。

```powershell
Set-Location C:\path\to\fish_abil_ext
npm ci --ignore-scripts
npm run test:unit
npm run test:simulated
npm run test:integration
npm start
```

普通测试不调用模型；test:integration 使用真实 Windows DSH ACP 和已配置模型。当前运行入口使用 v2 Executor/Store；v1 模块保留用于兼容覆盖和显式迁移验证，不用于新 Hub。

- [Phase 1.1.5 修复报告](docs/phase-1.1.5-fix-report.md)
- [Phase 1.1.4 修复报告](docs/phase-1.1.4-fix-report.md)
- [Phase 1.1.3 修复报告](docs/phase-1.1.3-fix-report.md)
- [Phase 1.1.1/1.1.2 修复报告](docs/phase-1.1.1-1.1.2-fix-report.md)
- [独立审查报告](docs/phase-1.1-independent-review.md)
- [验收报告](docs/phase-1.1-acceptance.md)
- [开发日志](DEVELOPMENT.md)
- [架构](docs/architecture.md)
- [Contracts与迁移](docs/contracts.md)
- [Windows部署](docs/deployment-windows.md)
- [v2类型](packages/contracts/v2.d.ts)

Task、Execution 和 Session 分离。每次尝试独立 ACP 连接，历史执行不可覆盖；结果、终态、完成证据原子提交。请求键幂等仅在本 Store 内有效，不承诺端到端 exactly-once。Session 恢复不能取回未保存的原执行结果；不确定任务保留 unknown，禁止自动重发。

取消返回 `{execution, cancelRequested, cancelConfirmed}`，调用方不得把请求当成确认。终态后崩溃残留的 active binding 会恢复为 unknown 并要求 reconcile/close；完整性警报只能人工确认且保留原始记录与重复执行风险。Store 对含 Execution 的 Task 强制要求投影字段，缺失或与 Execution 历史不一致会 fail closed，不会把缺失的 unresolved 当成空数组。

本阶段完成后保持 Phase 2 关闭，等待用户确认后续范围。
