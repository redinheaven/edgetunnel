---
description: 拉取最新代码并部署 edgetunnel 到 Cloudflare Workers 或 Pages（有项目被封禁的风险，需先确认）
argument-hint: "[workers|pages] [名称] [vless|socks5] [分支]"
---

任务：在当前仓库拉取最新代码，部署到 Cloudflare。按步骤执行，每步检查结果，失败就停下并报告原因，不要猜测或绕过。

## 0. 风险确认（必须先完成）

在执行任何其他步骤前，把下面这段原文展示给我：

> - 已观察到的情况（2026-10-08）：本仓库 commit `af3bc4d` 部署到新建的 Cloudflare Pages 项目，第一次部署成功，第二次部署时报错 `Your Pages project has been blocked. Contact abusereply@cloudflare.com. [code: 8000119]`，项目被封禁。Cloudflare 没有说明封禁原因。
> - Cloudflare Self-Serve Subscription Agreement 第 2.2.1(j) 条禁止使用其服务提供 VPN 或类似代理服务。本项目是代理程序。
> - 部署后项目可能被封禁，账户也可能受牵连。部署 Workers 的情况未实测，不代表不会被封禁。

然后问我是否在了解上述风险后继续。只有我明确回答继续，才执行后续步骤。其他任何回答，或没有回答，都停止，不做任何部署操作。
不要把上述内容改写成封禁原因已证实的说法。

## 参数

本次参数：`$ARGUMENTS`

按顺序解析，缺省用默认值：

| 位置 | 含义 | 默认值 |
|---|---|---|
| 1 | TARGET：`workers` 或 `pages` | `workers` |
| 2 | NAME：Worker 名或 Pages 项目名 | `edgetunnel` |
| 3 | VARIANT：`vless` → `src/worker-vless.js`；`socks5` → `src/worker-with-socks5-experimental.js` | `vless` |
| 4 | BRANCH：要部署的分支 | `main` |

变量值从环境变量读取。不要把值写进任何文件或提交：

| 环境变量 | 对应 Worker 变量 | 说明 |
|---|---|---|
| `EDGETUNNEL_UUID` | `UUID` | 必填。未设置时先问我。 |
| `EDGETUNNEL_PROXYIP` | `PROXYIP` | 可选 |
| `EDGETUNNEL_SOCKS5` | `SOCKS5` | 可选，仅 socks5 版本 |
| `EDGETUNNEL_SOCKS5_PIPELINE` | `SOCKS5_PIPELINE` | 可选，仅 socks5 版本 |
| `EDGETUNNEL_DEBUG` | `DEBUG` | 可选 |

## 1. 更新代码

- 有未提交的改动时停止，先问我。
- `git fetch origin <BRANCH> && git checkout <BRANCH> && git pull --ff-only origin <BRANCH>`
- 打印当前 commit hash。

## 2. 安装并测试

- `npm install`
- `npm test`，必须输出 `ALL PASS`，否则停止并贴出错误。

## 3. 检查认证

- 运行 `npx wrangler whoami`。
- 未登录时：环境变量里有 `CLOUDFLARE_API_TOKEN`（以及 `CLOUDFLARE_ACCOUNT_ID`）就直接用；没有就运行 `npx wrangler login`，或让我提供 token。
- 不要把 token 写进任何文件或提交。

## 4A. TARGET=workers

- 不修改 `wrangler.toml`，用命令行参数覆盖：
  `npx wrangler deploy <入口文件> --name <NAME> --compatibility-date 2024-04-15`
- 用 secret 设置变量，不要写进 `wrangler.toml` 的 `[vars]`。每个非空变量执行：
  `echo "<值>" | npx wrangler secret put <变量名> --name <NAME>`
- 记下部署输出里的 `*.workers.dev` 地址。

## 4B. TARGET=pages

- 生成 Pages 高级模式结构：
  `mkdir -p dist && cp <入口文件> dist/_worker.js`
- 项目不存在就创建：
  `npx wrangler pages project create <NAME> --production-branch main`
- 部署：
  `npx wrangler pages deploy dist --project-name <NAME> --branch main --compatibility-date 2024-04-15`
- 每个非空变量执行：
  `echo "<值>" | npx wrangler pages secret put <变量名> --project-name <NAME>`
- 设置 secret 后再执行一次 `pages deploy`，让新变量生效。
- `dist/` 在 `.gitignore` 中，不要提交。

## 5. 验证

- `curl -s https://<域名>/` 应返回 JSON（`request.cf` 信息）。
- `curl -s https://<域名>/<UUID>` 应返回包含 `vless://` 的配置文本。
- 新部署可能需要等 30 秒左右，失败时最多重试 3 次。仍失败就报告 HTTP 状态和响应内容。

## 6. 报告

用中文简短列出：commit hash、部署目标、访问域名、已设置的变量名（不显示值）、验证结果。

不要修改仓库代码，不要 git commit 或 push。
