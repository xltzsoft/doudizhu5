# 五人斗地主 (doudizhu5)

支持 5 人同桌对战的斗地主 Web 游戏，含发牌动画、要地主流程、明牌、加倍、AI 陪玩、观战与后台管理。提供两种部署形态：**本地 Node.js 服务器** 与 **Cloudflare Workers 版**。

线上地址：<https://doudizhu5.xltz.workers.dev>

## 玩法规则

- 5 名玩家，两副半牌（含大小王），每人 31 张，剩余 7 张为地主底牌
- **要地主**：系统指定"大地主"候选人，可**盲要地主**或**先查看手牌**（查看后要或不要均可）；不要则身份依次传给下家，轮完一圈回到原点时必须接受；选择要地主后 7 张底牌**明牌公示 8 秒**
- 大地主随后选择**明牌**，并可确定一名"小地主"（暗地主）形成阵营
- 支持加倍、亮手牌（reveal）、牌型提示、记牌器等辅助功能
- 房主可在要地主阶段重新洗牌发牌；支持 AI 补位与 AI 托管

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 前端 | 原生 HTML/CSS/JS（`public/`，两版部署共用） |
| 本地服务器 | Node.js + Express + Socket.IO + sql.js（SQLite 文件持久化） |
| Cloudflare 版 | Workers + Durable Objects（房间/对局状态）+ D1（用户数据）+ Workers Assets（静态资源） |
| 测试 | Vitest（`@cloudflare/vitest-pool-workers`）+ 引擎自测脚本 |

## 目录结构

```
├── game/            # 游戏引擎与 AI（两版部署共用）
│   ├── engine.js    # 发牌、牌型识别、出牌校验、要地主/明牌/加倍流程
│   └── ai.js        # AI 玩家决策
├── public/          # 前端（页面、样式、客户端逻辑、发牌动画）
├── server.js        # 本地服务器入口（Express + Socket.IO）
├── db.js            # 本地 SQLite 持久化（sql.js）
├── test.js          # 引擎与牌型测试脚本
└── cloudflare/      # Cloudflare 版
    ├── src/worker.js     # Worker 入口
    ├── src/game-hub.js   # Durable Object：房间与对局中枢
    ├── schema.sql        # D1 表结构
    ├── wrangler.toml
    └── test/             # Vitest 测试（引擎/hub/API/鉴权等）
```

## 本地运行

```bash
npm install
node server.js
# 打开 http://localhost:3000
```

可选环境变量：`PORT`（默认 3000）、`ADMIN_USERNAME`、`ADMIN_PASSWORD_HASH`、`JWT_SECRET`。

## Cloudflare 部署

```bash
cd cloudflare
npm install

# 首次部署需先创建 D1 数据库并执行建表
npx wrangler d1 create doudizhu5            # 将返回的 database_id 填入 wrangler.toml
npx wrangler d1 execute doudizhu5 --remote --file=schema.sql

npx wrangler deploy
```

需要在 `wrangler.toml` 或 Worker 环境变量中配置 `ADMIN_PASSWORD`、`JWT_SECRET`、`LLM_API_KEY` 等敏感项（勿提交到仓库）。

## 测试

```bash
node test.js                 # 引擎/牌型测试
cd cloudflare && npm test    # Vitest：hub、API、鉴权、AI 等
```

## 许可证

ISC
