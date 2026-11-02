# Tabularium Server

[English](README.md) · 中文 · [Lingua Latīna](README.la.md)

[Tabularium](https://github.com/Violaria/Tabularium) 的服务器：架在 CouchDB 前面的 Node.js 网关，带 SQLite 应用库和网页应用。它是父仓库的子模块；Compose 文件、备份工具和测试都在父仓库，请在那里构建和运行。

## 功能

- 账户、笔记库和设备凭据。不开放注册，账户由管理员创建。每个笔记库是一个独立的 CouchDB 数据库。每台设备有自己的凭据，有效期 30 天，客户端在使用中会自动续期。
- 同步网关。Obsidian 插件和命令行客户端经 `/sync` 复制，包括长连接的变更流。网关拒绝没有端到端加密和路径混淆的文档，所以服务器只会存密文。CouchDB 只在 Compose 内部网络中可达。
- `/` 下的网页应用：管理控制台、笔记库的浏览器客户端云笔记（用笔记库的密码短语在浏览器内解密，密码短语不会到达服务器）、账户设置，以及 `/s/<地址>` 下的笔记分享页。
- 发送到 Kindle：插件和云笔记生成 EPUB，服务器通过配置的 SMTP 账户发出。
- 定时备份应用库和每个笔记库，分全量和增量，写入挂载的目录，可用 `deploy/backup/cli.ts restore-scheduled` 恢复。
- Tabularius（书记员），可选的 AI 管理员，由笔记库所有者按笔记库开启。只有开启后，服务器才会保存该笔记库的密码短语（用 `TABULARIUS_SECRET_KEY` 加密）并维护一份明文工作副本。这样它才能检索笔记、带引用作答，并提出修改建议；修改要经所有者审阅后才写回。
  - 提供商：Anthropic、OpenAI、Gemini、DeepSeek、vLLM 和 Ollama。
  - 可选工具：本地 RAGFlow 知识库、联网搜索、对登记主机的 SSH，以及运行代码的沙箱。
  - 发给提供商的文字会经过出站过滤，凭据会被遮盖。

## 目录

```text
src/main.ts          入口
src/server.ts        HTTP 路由与复制代理
src/store.ts         SQLite 结构与迁移
src/couch.ts         CouchDB 管理
src/backup/          定时备份
src/shares.ts        分享页
src/smtp.ts          发送到 Kindle 的邮件
src/tabularius/      AI 管理员：托管客户端、检索、提供商、提案、SSH、联网
src/sandbox.ts       沙箱服务（同一镜像，单独的容器，挂载 Docker socket）
ui/                  网页应用（TypeScript，由 build-ui.mjs 构建）
test/                API 与浏览器测试
Dockerfile
```

镜像里还包含 `notes-dist/`（云笔记）和 `cli-dist/`（Tabularius 使用的命令行客户端）。两者都从插件仓库构建，由父仓库的 `npm run build:notes` 和 `npm run build:cli` 完成，所以服务器不能单独构建。

## 开发

在父仓库中，使用 Node.js 24.10.0：

```bash
npm run check:server
npm run test:server            # 需要 Docker；会启动一个临时 CouchDB
npm run test:server:browser    # 无头浏览器中的管理控制台
docker compose --env-file deploy/local/.env -f deploy/local/compose.yaml up --build -d --wait
```

运行设置在网页上修改（「管理 → 服务器设置」「LLM 设置」「备份」）；`.env` 只放容器启动时需要的内容和首次启动时导入一次的值。
