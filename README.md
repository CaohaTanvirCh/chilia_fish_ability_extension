# Fish Ability Extensions — Phase 1.1

Windows 原生 TaskExecutor 可靠性实现；未接入 AstrBot、Cyrene、QQ/NapCat 或 Bilibili，未开启自启动。

```powershell
Set-Location C:\Users\26648\fish_abil_ext
npm ci --ignore-scripts
npm run test:unit
npm run test:simulated
npm run test:integration
npm start
```

普通测试不调用模型；test:integration 使用真实 Windows DSH ACP 和已配置模型。当前运行入口使用 v2 Executor/Store；v1 模块保留用于旧29项覆盖和显式迁移验证，不用于新 Hub。

- [最终验收报告](docs/phase-1.1-acceptance.md)
- [实施前澄清](docs/phase-1.1-clarifications.md)
- [开发日志](DEVELOPMENT.md)
- [架构](docs/architecture.md)
- [Contracts与迁移](docs/contracts.md)
- [Windows部署](docs/deployment-windows.md)
- [v2类型](packages/contracts/v2.d.ts)

Task、Execution 和 Session 分离。每次尝试独立ACP连接，历史执行不可覆盖；结果、终态、完成证据原子提交。请求键幂等仅在本Store内有效，不承诺端到端 exactly-once。Session恢复不能取回未保存的原执行结果；不确定任务保留unknown，禁止自动重发。

本阶段完成后保持Phase2关闭，等待用户确认后续范围。
