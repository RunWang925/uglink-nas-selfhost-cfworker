<div align="center">
  <h1>UGLINK NAS Selfhost</h1>
  <p><strong>用自己的域名和服务器，访问绿联 NAS 上的 Web 服务。</strong></p>
  <p>基于 <a href="https://github.com/Leonis-Q-F/uglink-worker-nas">Leonis-Q-F/uglink-worker-nas</a> 修改的自托管版本。</p>
</div>

## 这是什么

一个绿联 NAS 远程访问网关：为 NAS 上不同端口的 Web 服务配置访问入口，全部通过一个控制台管理。提供两条访问路线，可以只配一条，也可以都配：

| 路线 | 走哪 | 入口样式 |
| --- | --- | --- |
| **Cloudflare** | Cloudflare Worker 中继 | `https://子域名.你的域名`（域名需已托管到 Cloudflare） |
| **自建服务** | 你自己的公网服务器网关 | `http://服务器IP:端口`（域名可后期自行解析） |

每个服务可选两种访问模式：

- **代理模式**：全部流量经 Cloudflare / 自建服务器转发到 NAS，地址始终是你的域名，速度受所走线路影响。
- **绿联跳转**：访问自己的域名后马上跳转到绿联官方服务域名（如 `*.ug.link`）验证身份，之后流量走绿联中继、不占用你的线路流量，更安全但多一步。

## 相对原版的主要改动

- **双路线**：在原 Cloudflare 路线之外，新增自建服务器网关路线（免 Cloudflare 也能用）
- **访问模式**：每个服务可选「代理模式 / 绿联跳转」（原版为固定的代理入口）
- **界面重构**：服务列表按服务分框、只读/编辑双态、搜索过滤、首次配置引导、NAS 验证连接
- **多人访问优化**：绿联跳转在多人同时进入时自动等待重试，无需手动刷新

## 快速开始

完整步骤（含 NAS 上直接粘贴的 Compose 配置）见 **[NAS 部署指南](docs/nas-deployment.md)**，三步：

1. **部署控制台**（NAS Docker 项目，拉取镜像 `ghcr.io/runwang925/uglink-nas-selfhost-cfworker:latest`）
2. **按引导配置**：先配访问路线（Cloudflare / 自建服务），再连接绿联 NAS（有「验证连接」可提前确认凭据）
3. **添加服务**：填服务名 + NAS 端口，选路线和模式，点「保存更改」发布

只用自建服务路线、不想碰 Cloudflare 也可以，服务器网关的部署同样写在指南里。

## 文档

| 文档 | 内容 |
| --- | --- |
| [NAS 部署指南（简明版）](docs/nas-deployment.md) | 从零到能用的完整步骤、节流规则、常见问题 |
| [配置说明](docs/configuration.md) | 配置字段、访问方式（代理模式 / 绿联跳转）详细规则 |
| [部署与运维（详细版）](docs/deployment.md) | Cloudflare 权限细节、备份迁移、故障诊断 |
| [安全策略](SECURITY.md) | 凭据处理、服务暴露边界 |

## 安全提示

- 控制台默认监听所有网络接口，仅供可信局域网使用；公网暴露请自行加身份验证和 HTTPS
- 映射到公网的 NAS 应用请保留自身认证，敏感服务建议套 Cloudflare Access
- 绿联跳转模式每次签发相当于一次绿联登录，默认同一账号 5 分钟内只签发一次（可用 `UGLINK_TICKET_THROTTLE_SECONDS` 调整），这是保护你的账号不被风控

## 致谢

本项目基于 **[Leonis-Q-F/uglink-worker-nas](https://github.com/Leonis-Q-F/uglink-worker-nas)** 修改而来，感谢原作者的优秀工作和 [linux.do](https://linux.do/) 社区的讨论分享。原版的架构设计、Cloudflare 网关实现和文档是本项目的基础；本仓库在其之上做了自托管路线、访问模式与控制台界面的扩展，若原版更符合你的需求请直接使用原项目。

## 许可证

[MIT](LICENSE)
