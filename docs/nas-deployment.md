# SELFHOST 版 NAS 部署指南（简明版）

> 技术细节、备份与迁移见 [deployment.md](deployment.md)；访问方式参数说明见 [configuration.md](configuration.md)。

## 0. 先认清三个名字

| 名称 | 跑在哪 | 作用 |
|---|---|---|
| `uglink-console` | NAS Docker 容器 | 统一控制台（唯一配置入口） |
| `uglink-gateway-cf` | Cloudflare Worker | Cloudflare 路线网关 |
| `uglink-gateway-server` | 你的云服务器容器 | 自建服务路线网关（管理端口 9090） |

## 1. 前置条件

- 绿联 NAS，Docker「项目 / Compose」功能可用
- 绿联账号（UGREENlink ID、用户名、密码）
- 一台有公网 IP 的服务器（仅自建服务路线需要；开放管理端口如 9090 和服务端口 9091-9190）
- Cloudflare 账号（仅 Cloudflare 路线需要）
- 镜像 `ghcr.io/runwang925/uglink-nas-selfhost-cfworker:latest` 为 Public，可直接拉取

## 2. 部署控制台（NAS 项目）

文件管理里建文件夹 `/docker/uglink-console`，打开 Docker → 项目 → 创建项目：

- 项目名称：`uglink-console`
- 存放路径：`共享文件夹/docker/uglink-console`
- 勾选「创建完成后立即运行」

Compose 配置全文（直接粘贴）：

```yaml
name: uglink-console

services:
  console:
    image: ghcr.io/runwang925/uglink-nas-selfhost-cfworker:latest
    container_name: uglink-console
    init: true
    restart: unless-stopped
    ports:
      - "5173:8787"
    volumes:
      - uglink-data:/data
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777
    cap_drop:
      - ALL
    security_opt:
      - no-new-privileges:true
    stop_grace_period: 20s

volumes:
  uglink-data:
    name: uglink-data
```

要点：

- `5173:8787`：左边是 NAS 访问端口（可改成你原来的端口），右边 8787 是容器内部固定端口，**不要改**
- `uglink-data` 卷存放凭据和配置，**升级/重建时不要删除**，否则配置全部重填
- 个别 UGOS 版本校验严格，若 `read_only` / `cap_drop` / `tmpfs` / `security_opt` 报错，删掉这几行也能正常运行

验证：浏览器打开 `http://NAS的IP:5173`，左上角显示 `UGLINK SELFHOST · v1.3.0-selfhost.1` 即为新版。

## 3. 首次进入：设置访问密码

控制台已加访问控制，避免同一网络里其他人误改配置或看到凭据。

- **第一次打开**会显示「设置控制台访问密码」：输入至少 6 位密码并确认，点「设置密码并进入」。之后从这个网络打开控制台都需要输入密码
- 每个浏览器会话解锁后默认保持（30 天）；侧栏底部有「🔒 锁定控制台」，点它可立即锁定，下次打开需重新输入
- **忘记密码**：在 compose 的 `environment` 里加一行 `UGLINK_CONSOLE_PASSWORD: 你的新密码`，重建容器即可用新密码登录；登录成功后把这行删掉再重建一次，以后以页面设置的密码为准

设好密码后进入控制台，默认落在「服务与访问」页。第一次使用时页面中央有引导卡，按顺序点：

1. **① 配置访问路线** → 跳到「线路管理」页：配 Cloudflare（Account ID + API Token）或自建服务（服务器地址 + 令牌），也可以两条都配。两条路线随时可点「重新配置」修改
2. **② 连接绿联 NAS** → 跳到「NAS 连接」页：填 UGREENlink ID、用户名、密码，点「验证连接」确认凭据有效（此步只连绿联官方接口，与第 1 步互不依赖）
3. **③ 添加服务** → 两步完成后引导卡消失，回到「服务与访问」正常添加

### Cloudflare 凭据获取（仅 Cloudflare 路线需要）

- **Account ID**：[Cloudflare 后台](https://dash.cloudflare.com) → 账户主页右侧「账户详细信息」复制（32 位十六进制，不是机密）
- **API Token**：My Profile → API Tokens → Create Token → 从 Account 策略开始，添加两条**编辑级**权限：`Workers Scripts` 和 `Workers KV Storage`；令牌只显示一次，妥善保管

## 4. 添加服务（服务与访问页）

- 点「＋ 添加记录」，填服务名称和 NAS 端口（**端口只在新增时填，保存后不可改**，填错删掉这条重建）
- 选路线：**Cloudflare**（填托管在 Cloudflare 的域名，只填域名本身）或**自建服务**（填监听端口，可选填自定义域名）
- 填了已有服务的端口会自动归进同一个框；名称随意，同一端口的不同记录可以叫不同名字
- 编辑字段失焦即自动生效到本地草稿，最后点底部「💾 保存更改」统一发布：有改动的记录自动发布到 Cloudflare / 同步到自建服务网关
- 模式两种：**代理模式** = 全部流量经线路转发到 NAS，地址始终是你的域名；**绿联跳转** = 访问自己的域名后马上跳到绿联官方域名（如 *.ug.link）验证身份，之后流量走绿联中继、不占你的线路流量。详细规则见控制台底部说明里的链接

## 5. 绿联跳转模式的节流规则

- 每成功签发一次票据（一次完整绿联登录），签发锁保留 **5 分钟**（可用环境变量 `UGLINK_TICKET_THROTTLE_SECONDS` 调整，默认 300）
- 撞上节流窗口时，提示页**自动倒计时重试**（约每 15 秒一次，最多 20 次），无需手动刷新
- **同一设备 30 分钟内重复打开**（包括关浏览器再开）：直接复用上次跳转地址，秒进，不受节流限制
- 多人频繁访问建议选**代理模式**（会话缓存 1 小时，无签发限制）

## 6. 服务器网关（自建服务路线）

在服务器上部署网关容器（详见 [deployment.md：自托管服务器网关](deployment.md)），然后在 NAS 控制台「线路管理」页：

1. 服务器地址：`http://服务器IP:9090`
2. 管理令牌：服务器 `.env` 中的 `ADMIN_TOKEN`
3. 编辑解锁令牌：`.env` 中的 `UNLOCK_TOKEN`（留空则服务器面板只读）
4. 配置改好后点底部「保存更改」会自动同步到服务器网关，热更新、无需重启

`http://服务器IP:9090` 是只读状态屏：运行概览、端口监听状态、流量统计。配置一律回 NAS 控制台改。

## 7. 升级

- **NAS 控制台**：项目 → 重新部署（拉取最新 `:latest` 镜像），确认左上角版本号变化
- **Cloudflare Worker**：控制台改过配置才需要发布；新版网关代码需要重新发布一次才生效
- **服务器网关**：在服务器 `docker compose -f compose.node.yaml up -d --build`；数据目录保留

## 8. 常见问题

| 问题 | 原因 / 处理 |
|---|---|
| 拉取镜像失败或极慢 | GHCR 国内直连不稳；等待或给 Docker 配置加速 |
| 提示页显示"另一位访问者正在登录绿联" | 5 分钟节流窗口，页面会自动重试进入；勿关页勿刷新 |
| 跳过去的绿联地址失效 | 回入口页点「强制重新签发」，或在入口地址后加 `?force=1` |
| `Upstream proxy request failed` | 代理模式下绿联会话冷启动/登录受阻；稍后重试；持续失败检查凭据 |
| 访问白屏 | 早期版本 content-encoding 头错标；更新到最新版镜像 |
| 数据丢失 | 检查是否误删 `uglink-data` 卷（NAS）或 `gateway-server-data` 目录（服务器） |
| 升级后首次打开要求设置密码 | 正常，v1.3.0 起新增访问控制；设置一次后本浏览器长期免输，其他浏览器首次打开需输入 |
| 忘记控制台密码 | compose `environment` 加 `UGLINK_CONSOLE_PASSWORD` 重建容器重置，登录后再删掉该行重建 |
| 登录一直失败 | 确认密码大小写；绿联官方风控可能临时锁定账号，静默 30~60 分钟自行恢复 |
