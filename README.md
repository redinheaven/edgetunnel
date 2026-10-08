# edgetunnel

运行在 Cloudflare Workers 上的 VLESS over WebSocket 代理。

## 文件

| 文件 | 说明 |
|---|---|
| `src/worker-vless.js` | 主版本。TCP 转发；UDP 只支持 DNS（53 端口），通过 DoH `https://1.1.1.1/dns-query` 解析。 |
| `src/worker-with-socks5-experimental.js` | 实验版本。在主版本基础上支持 SOCKS5 出站；DNS 通过 TCP 发往 `8.8.4.4:53`。 |
| `test/worker-mock-test.mjs` | 在 Node.js 中模拟 `cloudflare:sockets`、`WebSocketPair`、`fetch` 的测试。 |

## 环境变量

| 变量 | 适用版本 | 说明 |
|---|---|---|
| `UUID` | 全部 | 用户 ID。未设置时用代码里的默认值。 |
| `PROXYIP` | 全部 | 直连目标没有返回任何数据时（例如目标是 Cloudflare IP），改连这个地址。 |
| `DEBUG` | 全部 | 设为 `true` 打开 `console.log`。默认关闭。 |
| `SOCKS5` | socks5 | 格式 `user:pass@host:port` 或 `host:port`。设置后回退走 SOCKS5，不再用 `PROXYIP`。 |
| `SOCKS5_PIPELINE` | socks5 | 设为 `true` 时，greeting、认证、CONNECT 合并成一次发送，省 1～2 个 RTT。部分 SOCKS5 服务端不支持，默认关闭。 |

## 使用

- `GET /`：返回 `request.cf` 信息。
- `GET /<UUID>`：返回 v2ray 和 clash-meta 配置。
- WebSocket 升级请求：VLESS 代理。支持通过 `sec-websocket-protocol` 传 0-RTT 早期数据（配置里的 `?ed=2048`）。

## 连接行为

- **回退**：先直连目标。直连关闭且没收到数据时，改走 `PROXYIP` 或 SOCKS5（socks5 版本设置了 `SOCKS5` 时）。
- **回退缓存**：需要回退的 host 在 isolate 内存中缓存 10 分钟，最多 1000 个。命中时跳过直连。回退也没有数据时移出缓存。
- **DNS**：
  - 主版本：每个查询独立并发请求 DoH。
  - socks5 版本：每个 WebSocket 复用一条 DNS TCP 连接，连接被关闭后自动重连。
- **缓冲上限**：客户端上行数据积压超过 16MB 时关闭 WebSocket。远端到客户端方向没有背压控制（Workers 的 WebSocket 不提供发送缓冲大小）。

## 开发与部署

```bash
npm install
npm test              # Node.js 模拟测试
npm run dev-vless     # 本地运行主版本
npm run dev-socks5    # 本地运行 socks5 版本
npm run deploy        # 部署 wrangler.toml 中 main 指定的文件
```

`wrangler.toml` 的 `[vars]` 中列出了可用的环境变量。
