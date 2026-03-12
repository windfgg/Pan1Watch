# 仓库开发指南

## 项目结构
- src/agents/：Agent 业务逻辑实现。
- src/collectors/：数据采集器（行情、K 线、新闻等）。
- src/core/：核心模块（AI 客户端、调度、通知、上下文等）。
- src/web/：FastAPI Web 层（模型、路由、迁移）。
- frontend/：React + TypeScript 前端工程。
- prompts/：Agent Prompt 模板。
- config/、data/：配置与运行数据目录。
- server.py：后端入口，同时负责 Agent 和数据源注册。
- tests/：后端测试。
- Dockerfile：容器构建文件。

## 常用命令
- 一键启动（Docker）：
  docker run -d --name pan1watch -p 8000:8000 -v pan1watch_data:/app/data ghcr.io/windfgg/pan1watch:latest
- 后端本地开发：
  python -m venv .venv && source .venv/bin/activate && pip install -r requirements.txt && python server.py
- 前端本地开发：
  cd frontend && pnpm install && pnpm dev
- 前端构建：
  cd frontend && pnpm install --frozen-lockfile && pnpm build
- 后端测试：
  pytest

## 代码规范
- Python：遵循 PEP 8，4 空格缩进；新增代码建议补充类型标注。
- 命名：文件和函数使用 snake_case，类使用 PascalCase。
- Agent：放在 src/agents/，并在 server.py 的 AGENT_REGISTRY 与 seed_agents() 中注册。
- Collector：放在 src/collectors/，尽量保持无状态，返回结构化数据。
- 前端：组件使用 PascalCase.tsx，Hook 以 use 开头。

## 测试规范
- 测试文件命名为 tests/test_*.py。
- 优先为新增 Agent、Collector、核心逻辑补充单元测试。
- 避免真实网络调用，使用 mock 或替身数据。

## 提交与 PR 规范
- 提交格式：<type>: <subject>
- type 取值：feat、fix、docs、refactor、style、test
- PR 需包含：变更说明、关联 Issue（如有）、界面变更截图（如有）
- 提交前请至少验证：后端可启动、前端可构建

## 安全与配置
- 不要提交密钥与敏感配置，使用环境变量或 UI 配置。
- 关键环境变量：AUTH_USERNAME、AUTH_PASSWORD、JWT_SECRET、DATA_DIR、TZ。
- Docker 环境下 Playwright 浏览器默认安装在 DATA_DIR/playwright。
