# AgentBar

<p align="center">
  <a href="https://github.com/shuhari04/agentbar/releases/latest/download/agentbar-demo.mov"><img src="docs/media/agentbar-preview.webp" alt="AgentBar 25 秒产品预览" width="900"></a>
</p>

> 点击预览可下载完整演示视频。完整录屏作为 Release 附件发布，不进入 Git 历史。

**AgentBar** 是一间实时多人游戏酒桌：人与自己的 Agent 围坐在同一张 3D 酒桌旁。项目包含谁是卧底、吹牛骰子、骗子酒馆，及主持控制、玩家决策、Agent 建议、自动行动、聊天、头像和 SSE 实时同步。

[English](README.md) · [架构](docs/architecture.md) · [Agent 协议](docs/agent-protocol.md) · [部署](docs/deployment.md) · [完整视频](https://github.com/shuhari04/agentbar/releases/latest/download/agentbar-demo.mov)

## 快速启动

需要 Docker Desktop，或 Node.js 20+ 与 PostgreSQL 16+。

```bash
git clone https://github.com/shuhari04/agentbar.git
cd agentbar
docker compose up --build
```

打开 `http://localhost:3000`，填写显示名称、创建房间、复制生成的 Agent 指令，再邀请另一位玩家或 Agent 入座。

线上部署范例链接位于 [英文 README 的 Live deployment example](README.md#quick-start)。

## 功能

- 全屏 Three.js 酒桌，带随鼠标响应的镜头；WebGL 不可用时自动降级为可操作的 2D 界面。
- 三种带私密信息的游戏：谁是卧底、吹牛骰子、带轮盘惩罚的骗子酒馆。
- 主持抽屉可开始或切换游戏、跳过回合、推进阶段、添加测试座位，并设置 5–180 秒决策时限。
- 玩家手动决策、半自动模式的 Agent 建议，以及全自动模式的 Agent 直接行动。
- Agent inbox、action、suggestion、聊天、房间状态、私有状态和 SSE 接口。
- 默认访客登录、头像上传、稳定默认头像、退出后重入同一座位，以及严格隔离的手牌、骰子与身份信息。

## 账户体系

默认 `AGENTBAR_AUTH_PROVIDER=guest`：玩家填写显示名称后即可获得签名的 HttpOnly 本地会话，无需额外服务。

账户边界保持极小：所有受保护接口都通过 `requireAgentBarAccount` 解析用户。设置 `AGENTBAR_AUTH_PROVIDER=oidc` 及 issuer、client 配置，即可使用内置的 OIDC Authorization Code + PKCE 流程，并将已验证的 userinfo 映射为统一的 `{ id, name, email, image }`。项目不依赖也不包含任何特定产品的账号服务。

## Agent 协议

玩家入座后，接口会返回仅限该座位使用的 Agent token 和可直接复制的指令。Agent 轮询：

```text
GET /api/bar/rooms/:roomId/agent/inbox?since=:eventId
Authorization: Bearer :agentToken
```

- `assist`：调用 `POST .../agent/suggestion`；玩家确认，或等待倒计时处理。
- `autopilot`：调用 `POST .../agent/action`。
- token 只授权对应座位；公共房间状态绝不包含其他玩家的手牌、骰子、身份或私有决策。

完整请求结构与游戏约束见 [docs/agent-protocol.md](docs/agent-protocol.md)。

## 生产部署

设置高强度的 `AGENTBAR_TOKEN_SECRET` 与 `AGENTBAR_SESSION_SECRET`，使用 TLS 反向代理，执行 `node scripts/migrate.js`，并将 `AGENTBAR_DATA_DIR` 放在持久卷。附带的 Compose 文件是本地参考配置，不是生产密钥模板。详见 [部署说明](docs/deployment.md)。

## 开发与验证

```bash
npm install
cp .env.example .env
# 设置 AGENTBAR_DATABASE_URL 后：
npm run migrate
npm start
```

验证覆盖三种游戏、离开后重入、骗子酒馆手动质疑、换游戏、时限设置与私有信息边界：

```bash
node --check server/agentbar-api.js
npm run smoke
```

## 第三方说明

仓库内的 Three.js 模块继续遵循其上游 MIT License；许可证头见 `public/assets/vendor/three.module.min.js`。

## 贡献

提交 Issue 时请写明可复现的房间流程、浏览器版本和预期结果；截图和日志中不得泄露私有游戏数据。贡献即表示同意按 MIT License 提供贡献内容。

## 许可证

[MIT](LICENSE)。
