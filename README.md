# AI 图片编辑器

自然语言指令驱动的图片编辑 Agent，支持多工具调用（背景替换、裁剪、画笔等）。

## 启动

1. 复制 `.env.example` 为 `.env`，填入 DashScope API Key
2. 启动本地代理：`node server/proxy.js`
3. 浏览器打开 `index.html`

## 目录说明

- `src/` — Agent 规划（`agent.js`）、工具集（`tools.js`）、编辑器（`editor.js`）、模型调用（`llm.js`）、示例与入口
- `server/proxy.js` — 本地 API 代理
- `assets/styles.css` — 样式
- `docs/screenshots/` — 界面截图
- `test/` — 冒烟与代理测试脚本

模型名可在设置面板或 `.env` 中配置（`PLANNER_MODEL` / `IMAGE_MODEL` / `IMAGE_SIZE`）。
