# Cloudflare Workers 迁移实现计划

> **面向 AI 代理的工作者：** 本计划在当前会话内执行，不使用 git commit。代码变更必须保持原 Node/VPS 版本可回退，Cloudflare 版放在独立目录。

**目标：** 新增一套可部署到 Cloudflare Workers 的五人斗地主版本，使用 Durable Objects 承载实时房间状态，使用 D1 承载用户和历史数据。

**架构：** Worker 负责 HTTP API、静态资源和 WebSocket 升级入口；`GameHub` Durable Object 负责房间、在线连接、广播和 AI 流程；D1 负责账号、昵称、头像、积分、历史和运行配置。前端复用现有页面，通过新增轻量 Socket.IO 兼容客户端把 `socket.emit/on` 转成原生 WebSocket 消息。

**技术栈：** Cloudflare Workers、Durable Objects、D1、原生 WebSocket、Web Crypto、Vitest、Wrangler。

---

## 文件结构

- 创建 `cloudflare/wrangler.toml`：Cloudflare Workers 配置、D1 绑定、Durable Object 绑定、静态资源绑定。
- 创建 `cloudflare/schema.sql`：D1 表结构，与当前 `db.js` 的用户、历史和配置能力对齐。
- 创建 `cloudflare/package.json`：Cloudflare 版开发、测试、部署脚本。
- 创建 `cloudflare/src/worker.js`：Worker 主入口，负责路由、认证、静态资源、WebSocket 转发。
- 创建 `cloudflare/src/d1-store.js`：D1 数据访问层，封装用户、历史、AI 设置。
- 创建 `cloudflare/src/auth.js`：密码哈希、JWT 类 token、账号校验。
- 创建 `cloudflare/src/game-hub.js`：Durable Object，实现房间和对局实时逻辑。
- 创建 `cloudflare/src/socket-client.js`：浏览器端 Socket.IO 兼容层。
- 创建 `cloudflare/src/shared.js`：共享工具函数。
- 创建 `cloudflare/test/*.test.js`：认证、D1 store、WebSocket 协议和房间逻辑测试。
- 修改 `public/index.html`、`public/admin.html`：允许 Cloudflare 版加载新的 Socket 兼容层；Node 版继续加载原 Socket.IO。

## 任务 1：项目骨架和测试基础

**文件：**
- 创建：`cloudflare/package.json`
- 创建：`cloudflare/wrangler.toml`
- 创建：`cloudflare/schema.sql`
- 创建：`cloudflare/src/shared.js`
- 创建：`cloudflare/test/shared.test.js`

- [ ] 写失败测试：校验账号名、房间设置归一化、Socket 消息格式。
- [ ] 运行 `npm --prefix cloudflare test`，预期因模块不存在失败。
- [ ] 实现 `shared.js` 最小逻辑。
- [ ] 再运行测试，预期通过。

## 任务 2：认证与 D1 访问层

**文件：**
- 创建：`cloudflare/src/auth.js`
- 创建：`cloudflare/src/d1-store.js`
- 创建：`cloudflare/test/auth.test.js`
- 创建：`cloudflare/test/d1-store.test.js`

- [ ] 写失败测试：注册时用户名/昵称唯一、登录校验密码、昵称每月修改一次、token 可签发和验证。
- [ ] 运行相关测试，预期失败。
- [ ] 用 Web Crypto 实现 PBKDF2 密码哈希和 HMAC token；用 D1 prepared statements 封装用户/历史/AI 设置。
- [ ] 再运行相关测试，预期通过。

## 任务 3：Worker HTTP API

**文件：**
- 创建：`cloudflare/src/worker.js`
- 创建：`cloudflare/test/worker-api.test.js`

- [ ] 写失败测试：`/api/register`、`/api/login`、`/api/profile`、`/api/leaderboard`、`/api/history`、管理 AI 设置接口。
- [ ] 运行测试，预期失败。
- [ ] 实现 JSON 路由、Bearer 鉴权、管理鉴权、CORS/缓存策略和错误响应。
- [ ] 再运行测试，预期通过。

## 任务 4：Durable Object 房间协议

**文件：**
- 创建：`cloudflare/src/game-hub.js`
- 创建：`cloudflare/test/game-hub.test.js`

- [ ] 写失败测试：创建房间、加入房间、准备、房主确认开始、5 人座位不遗漏、玩家退出后 AI 可接管、玩家重连可接回座位。
- [ ] 运行测试，预期失败。
- [ ] 复用 `game/engine.js` 和 `game/ai.js`，实现房间 Map、连接 Map、广播和 Socket 事件处理。
- [ ] 再运行测试，预期通过。

## 任务 5：前端 Socket 兼容层和资源加载

**文件：**
- 创建：`cloudflare/src/socket-client.js`
- 修改：`public/index.html`
- 修改：`public/admin.html`
- 创建：`cloudflare/test/socket-client.test.js`

- [ ] 写失败测试：`io({ auth })`、`socket.emit(event,payload,callback)`、`socket.on(event,handler)`、断线错误事件。
- [ ] 运行测试，预期失败。
- [ ] 实现兼容客户端，并让 Cloudflare 静态资源路径 `/socket.io/socket.io.js` 返回此文件。
- [ ] 再运行测试，预期通过。

## 任务 6：本地验证与 Cloudflare 部署准备

**文件：**
- 修改：`cloudflare/package.json`
- 修改：`cloudflare/wrangler.toml`

- [ ] 运行 `npm --prefix cloudflare test`，预期所有测试通过。
- [ ] 运行 `npx --prefix cloudflare wrangler deploy --dry-run`，预期构建通过。
- [ ] 创建 D1 数据库和执行 schema 前，按项目规则请求生产操作确认。
- [ ] 确认后使用临时环境变量部署到 Cloudflare，不把 token 写入文件。

