# 贡献指南

感谢你对 Pan1Watch 的关注。本文档用于帮助你快速参与开发与提交高质量变更。

## 目录

- 一键启动
- 本地开发
- 项目结构
- 开发流程建议
- 新增 Agent 指南
- 新增数据源指南
- 测试与提交规范

## 一键启动

适合快速体验或联调 API。

```bash
docker run -d \
  --name pan1watch \
  -p 8000:8000 \
  -v pan1watch_data:/app/data \
  ghcr.io/windfgg/pan1watch:latest
```

启动后访问：http://localhost:8000

如果你不需要截图能力，可增加环境变量：

```bash
PLAYWRIGHT_SKIP_BROWSER_INSTALL=1
```

## 本地开发

推荐环境：Python 3.10+、Node.js 18+、pnpm。

### 后端

```bash
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python server.py
```

### 前端

```bash
cd frontend
pnpm install
pnpm dev
```

前端默认地址：http://localhost:5173（会代理后端 API）。

## 项目结构

```text
Pan1Watch/
├── src/
│   ├── agents/        # Agent 实现
│   ├── collectors/    # 数据采集器
│   ├── core/          # 核心逻辑
│   └── web/           # Web API 与模型
├── frontend/          # React 前端
├── prompts/           # Prompt 模板
├── tests/             # 测试
└── server.py          # 后端入口
```

## 开发流程建议

1. 新建分支并实现功能。
2. 补充测试与文档。
3. 本地自检后提交 PR。

建议最少执行：

```bash
pytest
cd frontend && pnpm build
```

## 新增 Agent 指南

### 1. 新建文件

在 src/agents/ 新建 agent 文件，例如 my_agent.py。

### 2. 遵循接口契约

- 继承 BaseAgent。
- 实现 build_prompt(data, context) 并返回 system_prompt 与 user_content。
- analyze 内通过 context.ai_client 调用模型。
- run 返回 AnalysisResult。

### 3. 注册

- 在 server.py 的 AGENT_REGISTRY 注册。
- 在 seed_agents() 增加默认配置。

### 4. Prompt

在 prompts/ 增加对应模板文件，确保输出结构稳定、可解析。

## 新增数据源指南

### 1. 新建 Collector

在 src/collectors/ 增加采集器，尽量保持无状态。

### 2. 返回结构化数据

统一字段与类型，避免在 Agent 中做过多格式兜底。

### 3. 注册数据源

在 server.py 的 seed_data_sources() 增加数据源配置。

### 4. 可测试性

避免真实网络依赖，优先注入配置与 mock 响应。

## 测试与提交规范

### 测试规范

- 测试文件命名：tests/test_*.py
- 新增功能至少覆盖 happy path 和一个失败路径

### Commit 规范

格式：<type>: <subject>

type 取值：feat、fix、docs、refactor、style、test

示例：

```text
feat: 增加基金持仓分析过滤条件
```

### PR 要求

1. 说明改动背景和核心变更。
2. UI 变更附截图。
3. 涉及 Agent 或数据源时，附使用说明。

## 问题反馈

欢迎提交 Issue 或 PR。
