# TLS / 证书

<!-- bilingual-header:v1 -->

**语言 / Language:** 正文以中文为主；下方为 English summary。

**English summary:** TLS / certificate watch + gRPC remount landed from Phase K; Phase W did not change the TLS contract. Details below (CN-primary).

---
**当前快照：Phase K 起已落地 watch + gRPC remount；Phase W 未改 TLS 合同。**

适配器在 **connect** 时读证书。`watchTlsMaterial` 对文件路径做 `fs.watch`，变更后 **热重读** 到内存（不重启进程）。删文件 / 读失败记 `lastError`（`E_INVALID_CONFIG`），可测。

gRPC `tlsWatch: true` 在 PEM 文件变更后 **进程内 remount**：关掉现有 client / bidi session，用新 PEM 重建 `ChannelCredentials`，**不重启进程、不必 `mcp_update`**。正在飞的 RPC / 打开的 bidi session 会断。remount 失败（坏 PEM）时 health 记 `remount-failed`，那时才需要 **`mcp_update`**。

## 配置键

| 用途 | 接受的键（先到先用） |
| --- | --- |
| CA | `ca` `tlsCa` `caFile` `tlsCaFile` |
| 客户端证书 | `cert` `tlsCert` `certFile` `tlsCertFile` |
| 私钥 | `key` `tlsKey` `keyFile` `tlsKeyFile` |

值可以是：

- 内联 PEM（含 `-----BEGIN `）
- 文件系统路径

gRPC：`tls: true` 或任一带 PEM 的键都会开 TLS。mTLS 必须 **cert + key 成对**。实现：`src/adapters/tls-material.ts`，`credentialsFromConfig` 复用它。

Pulsar `pulsar+ssl://`：`tlsInsecure: true` 跳过服务端校验。无客户端证书热重载。

LDAP：`tls: true` 把 `ldap://` 升为 `ldaps://`；`starttls: true` 走 StartTLS。不走上述 PEM 键。

## 明确不做

- 证书轮换时静默迁移正在飞的 RPC / 打开的 bidi session（remount 会丢 session）
- remount 失败后的自动 `mcp_update`
- Pulsar `pulsar+ssl://` 客户端证书热重载
