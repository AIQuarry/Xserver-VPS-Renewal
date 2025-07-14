# Xserver VPS 自动续订工具

![GitHub Actions](https://img.shields.io/github/actions/workflow/status/yourusername/yourrepo/main.yml?label=自动续订)
![GitHub Last Commit](https://img.shields.io/github/last-commit/yourusername/yourrepo)

本项目使用 GitHub Actions 自动完成 Xserver 免费 VPS 的续订操作，避免手动操作带来的不便。

## ✨ 功能特性

- **自动续订**：每天在日本时间 09:45 执行续订
- **操作录屏**：全程录制操作过程作为执行凭证
- **状态通知**：通过 Server酱 推送执行结果到微信
- **错误处理**：失败时自动保存错误截图
- **安全可靠**：使用 GitHub Secrets 存储敏感信息

## 🛠️ 使用说明

### 准备工作

1. Fork 本仓库
2. 在仓库设置中添加 Secrets：
   - `EMAIL`: Xserver 登录邮箱
   - `PASSWORD`: Xserver 登录密码
   - `SCKEY_SENDKEY`: [Server酱](https://sctapi.ftqq.com/) 的 SendKey

### 配置步骤

1. **设置 Secrets**：
   - 进入仓库 Settings → Secrets → Actions
   - 添加上述三个必须的 Secrets

2. **启用 Actions**：
   - 项目默认会自动启用工作流程
   - 首次使用可手动触发一次测试运行

3. **接收通知**：
   - 绑定 Server酱 到您的微信
   - 每次执行后都会收到结果通知

### 手动触发

在 Actions 页面选择 "Xserver VPS Renewal" 工作流，点击 "Run workflow" 可手动执行。

## 📁 文件说明

- `main.mjs`: 主执行脚本（Puppeteer 自动化操作）
- `.github/workflows/main.yml`: GitHub Actions 工作流程定义
- `recording.webm`: 执行过程录屏（每次运行后生成）
- `error.png`: 错误截图（失败时生成）

## 🔍 工作原理

1. 每天 UTC 00:00（日本时间 09:45）触发工作流
2. 使用 Puppeteer 模拟浏览器操作完成续订
3. 录制整个操作过程
4. 通过 Server酱 发送执行结果通知

## 📊 执行记录

每次执行的录屏和错误截图可在 Actions 页面的 Artifacts 中下载查看。

## ⚠️ 注意事项

1. 请确保 Xserver 账户有效
2. 续订操作可能需要验证码时会失败
3. 如果 Xserver 界面改版可能需要更新脚本
4. 建议定期检查执行结果

## 📄 开源协议

MIT License © 2025 [AI]

---

**温馨提示**：本项目仅用于学习 GitHub Actions 和自动化技术，请遵守 Xserver 的服务条款。
