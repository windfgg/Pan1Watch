# 盯盘侠 PanWatch

**私有部署的 AI 股票助手** — 实时行情监控、智能技术分析、多账户持仓管理

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
![Dashboard](docs/screenshots/dashboard.png)

|                    持仓管理                    |                     AI 建议                      |
| :--------------------------------------------: | :----------------------------------------------: |
| ![Portfolio](./docs/screenshots/portfolio.png) | ![Suggestion](./docs/screenshots/suggestion.png) |

<details>
<summary>移动端截图</summary>

<img src="./docs/screenshots/mobile.png" width="375" />

</details>

## 为什么选择盯盘侠？

- **数据私有** — 自托管部署，持仓数据不经过任何第三方
- **AI 原生** — 不是简单的指标堆砌，而是让 AI 理解你的持仓、风格和目标
- **MCP 原生** — 标准 JSON-RPC 接口，支持 Bearer/Basic 双认证，便于接入各类 MCP 客户端
- **开箱即用** — Docker 一键部署，5 分钟完成配置

## 核心功能

<details>
<summary><b>智能 Agent 系统</b></summary>

| Agent        | 触发时机     | 功能                                               |
| ------------ | ------------ | -------------------------------------------------- |
| **盘前分析** | 每日开盘前   | 综合隔夜美股、新闻消息、技术形态，给出今日操作策略 |
| **盘中监测** | 交易时段实时 | 监控异动信号，RSI/KDJ/MACD 共振时推送提醒          |
| **盘后日报** | 每日收盘后   | 复盘当日走势，分析资金流向，规划次日操作           |
| **新闻速递** | 定时采集     | 抓取财经新闻，AI 筛选与持仓相关的重要信息          |

</details>

<details>
<summary><b>专业技术分析</b></summary>

- **趋势指标**：MA 多空排列、MACD 金叉死叉、布林带突破
- **动量指标**：RSI 超买超卖、KDJ 钝化与背离
- **量价分析**：量比异动、缩量回调、放量突破
- **形态识别**：锤子线、吞没形态、十字星等 K 线形态
- **支撑压力**：自动计算多级支撑位和压力位

</details>

<details>
<summary><b>多市场 & 多账户</b></summary>

- **覆盖市场**：A 股、港股、美股实时行情
- **账户管理**：支持多券商账户独立管理，汇总展示总资产
- **交易风格**：按短线/波段/长线分别设置，AI 建议更精准

</details>

<details>
<summary><b>全渠道通知</b></summary>

Telegram / 企业微信 / 钉钉 / 飞书 / Bark / 自定义 Webhook

</details>

<details>
<summary><b>价格提醒</b></summary>

- 支持价格、涨跌幅、成交额、量比等条件组合（AND / OR）
- 支持交易时段/全天生效、冷却时间、日触发上限、重复触发模式
- 到期时间使用弹窗内日期面板 + `HH:mm` 输入，留空表示永不过期
- 可按规则选择通知渠道，不选则走系统默认渠道

</details>

## 快速开始

```bash
docker run -d \
  --name panwatch \
  -p 8000:8000 \
  -v panwatch_data:/app/data \
  ghcr.io/windfgg/pan1watch:latest
```

访问 `http://localhost:8000`，首次使用设置账号密码即可。

说明：镜像内已包含 Playwright 运行所需的系统依赖；Chromium 浏览器会在容器首次启动时自动下载并安装到挂载卷（默认 `/app/data/playwright`），首次启动可能需要几分钟且需要网络可达。

如果不需要截图等浏览器能力，可以在启动容器时设置 `PLAYWRIGHT_SKIP_BROWSER_INSTALL=1` 跳过首次 Chromium 下载/安装。

<details>
<summary>Docker Compose</summary>

```yaml
version: '3.8'
services:
  panwatch:
    image: ghcr.io/windfgg/pan1watch:latest
    container_name: panwatch
    ports:
      - "8000:8000"
    volumes:
      - panwatch_data:/app/data
    restart: unless-stopped

volumes:
  panwatch_data:
```

```bash
docker-compose up -d
```

</details>

<details>
<summary>环境变量</summary>

| 变量名                            | 说明                                          | 默认值          |
| --------------------------------- | --------------------------------------------- | --------------- |
| `AUTH_USERNAME`                   | 预设登录用户名                                | 首次访问时设置  |
| `AUTH_PASSWORD`                   | 预设登录密码                                  | 首次访问时设置  |
| `JWT_SECRET`                      | JWT 签名密钥                                  | 自动生成        |
| `DATA_DIR`                        | 数据存储目录                                  | `./data`        |
| `TZ`                              | 应用时区（影响 Agent 调度触发时间与时间展示） | `Asia/Shanghai` |
| `PLAYWRIGHT_SKIP_BROWSER_INSTALL` | 跳过首次 Chromium 安装（不需要截图时可用）    | 未设置          |

</details>

<details>
<summary>首次配置</summary>

1. 访问 Web 界面，设置登录账号
2. **设置 → AI 服务商**：配置 OpenAI 兼容 API（支持 OpenAI / 智谱 / DeepSeek / Ollama 等）
3. **设置 → 通知渠道**：添加 Telegram 或其他推送渠道
4. **持仓 → 添加股票**：添加自选股，启用对应 Agent

</details>

<details>
<summary>本地开发</summary>

**环境要求**：Python 3.10+ / Node.js 18+ / pnpm

```bash
# 后端
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
python server.py

# 前端（新终端）
cd frontend && pnpm install && pnpm dev
```

前端运行在 `http://localhost:5173`，自动代理 API 到后端。

</details>

<details>
<summary><b>技术栈</b></summary>

**后端**：FastAPI / SQLAlchemy / APScheduler / OpenAI SDK

**前端**：React 18 / TypeScript / Tailwind CSS / shadcn/ui

</details>

## MCP 接口

PanWatch 提供标准 JSON-RPC over HTTP 的 MCP 接口：`/api/mcp`。

- 认证方式：
  - Bearer：复用 Web 登录 token（推荐）
  - Basic：使用系统用户名和密码
- 协议能力：`initialize`、`tools/list`、`tools/call`
- 主要工具：持仓 CRUD、自选股查询、市场指数、Dashboard 概览、MCP 诊断工具

### MCP 客户端配置示例

Bearer：

```json
{
  "mcpServers": {
    "panwatch": {
      "url": "http://127.0.0.1:8000/api/mcp",
      "headers": {
        "Authorization": "Bearer <YOUR_TOKEN>"
      }
    }
  }
}
```

Basic：

```json
{
  "mcpServers": {
    "panwatch": {
      "url": "http://127.0.0.1:8000/api/mcp",
      "headers": {
        "Authorization": "Basic <base64(username:password)>"
      }
    }
  }
}
```

### JSON-RPC 调用示例

```bash
curl -X POST http://127.0.0.1:8000/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}'
```

```bash
curl -X POST http://127.0.0.1:8000/api/mcp \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <YOUR_TOKEN>' \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"positions.list","arguments":{"page":1,"page_size":20}}}'
```

### 常见错误

- `401 Unauthorized`：token 失效，或 Basic 用户名密码错误
- JSON-RPC `-32602`：参数不合法（请按 `tools/list` 的 `inputSchema` 传参）
- JSON-RPC `-32004`：工具名不存在

<details>
<summary><b>发布（Docker 镜像）</b></summary>

本项目内置 GitHub Actions 发布流程：

- 打 tag（例如 `0.2.3`）会自动构建并推送 Docker 镜像到 GitHub Container Registry
  - `ghcr.io/windfgg/pan1watch:0.2.3`
  - `ghcr.io/windfgg/pan1watch:latest`
- 也支持在 GitHub Actions 里手动触发（workflow_dispatch）指定版本号
- 使用内置 `GITHUB_TOKEN`，无需额外配置 Secrets

</details>

## 贡献

欢迎提交 Issue 和 PR！自定义 Agent 和数据源开发请参考 [贡献指南](CONTRIBUTING.md)。

## License

[MIT](LICENSE)
