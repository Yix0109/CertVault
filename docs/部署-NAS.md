# 部署到飞牛 fnOS（CertVault 服务器版）

> 一句话：一个 `node:20-alpine` 容器跑 `server.js`（零 npm 依赖），浏览器登录用「服务器模式」，桌面端可指向同一地址。**全部数据 = 宿主机一个目录**，整目录备份即可。

本文按本机实际目录写成（路径里含 `#` 号，这是最容易踩的坑，见 §2.2）：

| 项 | 值 |
| --- | --- |
| 代码目录（srv） | `/vol2/1000/8#Docker/CertVault/srv` |
| 数据目录（data） | `/vol2/1000/8#Docker/CertVault/data`（挂到容器 `/data`） |
| 镜像 | `certvault-nas:1.0.0`（本地构建） |
| 端口 | 宿主机 `8090` → 容器 `8080` |
| 运行用户 | `1000:1000`（`node:20-alpine` 内置 node 用户） |
| 健康检查 | `GET /api/health`（免认证） |

相关文件都在 `deploy/`：

| 文件 | 作用 |
| --- | --- |
| `docker-compose.yml` | 主部署文件（绝对路径、端口、卷、健康检查、日志上限） |
| `Dockerfile` | 镜像构建（上下文 = `srv/`） |
| `certvault.env.example` | 口令 / 环境变量模板，拷成 `certvault.env` 后改 |
| `nginx-certvault.conf.example` | 反向代理 + HTTPS 示例（含 80MB 上传上限） |
| `backup-certvault.sh` | 每日整目录备份脚本（保留 30 天） |

---

## 0. 快速开始（TL;DR）

```bash
# ① 建数据目录并归位权限（代码目录 srv 由你自己拷进去）
sudo mkdir -p "/vol2/1000/8#Docker/CertVault/data"
sudo chown -R 1000:1000 "/vol2/1000/8#Docker/CertVault/data"

# ② 代码放进 srv（整包拷贝，保留 server/ app/ deploy/ .dockerignore）

# ③ 环境变量：拷模板、改口令、收紧权限
cd "/vol2/1000/8#Docker/CertVault/srv/deploy"
cp certvault.env.example certvault.env
chmod 600 certvault.env
vi certvault.env        # 把 CV_PASS 换成强口令（≥12 位，别加引号）

# ④ 构建 + 启动
docker compose -f "/vol2/1000/8#Docker/CertVault/srv/deploy/docker-compose.yml" up -d --build

# ⑤ 看日志与健康状态
docker compose -f "/vol2/1000/8#Docker/CertVault/srv/deploy/docker-compose.yml" logs --tail=100 certvault
docker ps --filter name=certvault --format '{{.Names}} {{.Status}}'

# ⑥ 浏览器打开（注意 ?server=1）
#   http://<NAS-IP>:8090/?server=1
```

首次启动日志应出现类似：`监听 0.0.0.0:8080`、`数据目录 /data`、`静态站点 /srv/app`、`时区 Asia/Shanghai`，以及 `已创建首个管理员账号：admin`。

---

## 1. 先决条件

1. **fnOS 已启用 Docker**（应用中心安装或系统自带）：`docker --version`、`docker compose version` 都有输出。
2. **能 SSH 登录 NAS**（fnOS 设置里打开 SSH / 终端机），下文命令都假设你 `ssh 用户名@NAS-IP`。
3. **确认自己的 uid:gid**：

   ```bash
   id
   # uid=1000(fnos) gid=1000(fnos) groups=...    ← /vol2/1000 通常就是 uid 1000
   ```

   如果不是 `1000:1000`，后面所有 `chown 1000:1000` 和 compose 里的 `user: "1000:1000"` 都要换成你的值。
4. **8090 端口空闲**：

   ```bash
   ss -lntp | grep -w 8090 || echo '8090 空闲'
   ```

5. 磁盘空间：数据量 ≈ `images/` 里 PNG 总和（每条记录最多 8 张、单张 ≤ 8MB）。建议留 ≥ 2 倍数据量（数据 + 备份）。

---

## 2. 目录与权限

### 2.1 目标布局

```text
/vol2/1000/8#Docker/CertVault/
├── srv/                    # 代码（= 本仓库内容，Docker 构建上下文）
│   ├── server/             # server.js（零依赖）
│   ├── app/                # 静态站点（index.html / app.js / store-http.js …）
│   ├── deploy/             # compose、Dockerfile、env 模板、脚本
│   └── .dockerignore       # 必须在 srv 根；排除 数据/、build/、tests/、docs/ 等
└── data/                   # 数据（挂到容器 /data）
    ├── data/               # certvault.json / settings.json / audit.json / .lock
    ├── images/<记录ID>/    # 图片 PNG
    ├── backup/             # 应用内备份 JSON（只留最近 10 份）
    ├── users.json          # 账号（首次启动生成，权限 600）
    └── config.json         # 会话密钥 / TTL / 口令快照（权限 600）
```

`srv` 里**不要**放 `数据` 目录（那是业务数据，应进 `data/`）。`.dockerignore` 已排除它，但别依赖排除规则。

### 2.2 ⚠️ 路径里的 `#` 号

`/vol2/1000/8#Docker/...` 里的 `#` 是合法字符（ext4/btrfs 都允许），但它有两个特殊含义，踩一次就很难受：

| 场景 | 后果 | 做法 |
| --- | --- | --- |
| YAML 值里 `#` 后跟空格 | 之后内容被当注释，路径被截断成 `/vol2/1000/8` | 含 `#` 的值**整体加双引号**（`docker-compose.yml` 已全部加好） |
| shell 命令 | `#` 之后被当注释，命令被截断 | 路径**整体加引号**：`ls "/vol2/1000/8#Docker/..."` |
| nginx 配置 | `#` 起始注释 | 值整体加双引号，或把证书放到不含 `#` 的目录（如 `/etc/ssl/certvault/`） |
| scp 远端路径 | 远端 shell 解析，`#` 在词首才起注释 | 远端路径也加引号：`scp 源 nas:"/vol2/1000/8#Docker/..."` |

记住一条：**凡把含 `#` 的路径写进配置文件或命令行，一律整段加引号。**

### 2.3 建数据目录并归位权限

```bash
sudo mkdir -p "/vol2/1000/8#Docker/CertVault/data"
sudo chown -R 1000:1000 "/vol2/1000/8#Docker/CertVault/data"
sudo chmod 750 "/vol2/1000/8#Docker/CertVault/data"
```

容器以 `1000:1000` 运行，数据目录属主必须是 `1000:1000`，否则启动时会报写入失败（`EACCES`）。

---

## 3. 准备代码（srv）

把本仓库内容整体放到 `srv`，保留 `server/`、`app/`、`deploy/`、`.dockerignore` 四样：

```text
Windows: D:\...\CA账号管理\{server,app,deploy,.dockerignore}
     →  NAS: /vol2/1000/8#Docker/CertVault/srv/
```

三种常用方式（都在 Windows 侧发起）：

**A. SMB 共享（最省事）**：fnOS 把 `/vol2/1000` 挂成共享目录，Windows 资源管理器打开 `\\NAS\共享名`，把四个条目拷进 `CertVault\srv\`。SMB 拷贝会丢 Linux 权限，所以拷完必须回 NAS 执行 `chown`。

**B. scp**：

```powershell
# 源路径带空格/中文就加引号；远端路径含 # 也加引号
scp -r "D:\CA账号管理\server" "D:\CA账号管理\app" "D:\CA账号管理\deploy" "D:\CA账号管理\.dockerignore" nas用户@NAS-IP:"/vol2/1000/8#Docker/CertVault/srv/"
```

**C. rsync（可增量、可断点重来，需要 WSL 或另一台 Linux）**：

```bash
rsync -av --progress "/mnt/d/CA账号管理/" nas用户@NAS-IP:"/vol2/1000/8#Docker/CertVault/srv/"
```

拷完检查：

```bash
ls -la "/vol2/1000/8#Docker/CertVault/srv"
# 应看到 server  app  deploy  .dockerignore
sudo chown -R 1000:1000 "/vol2/1000/8#Docker/CertVault/srv"   # 可选：代码归登录用户，便于以后升级
```

---

## 4. 环境变量文件（口令）

```bash
cd "/vol2/1000/8#Docker/CertVault/srv/deploy"
cp certvault.env.example certvault.env
chmod 600 certvault.env
vi certvault.env
```

要点（模板注释里也写了）：

- `CV_PASS` **首次启动必须设置**。为空时容器会打印「首次启动必须设置环境变量 CV_PASS … 已拒绝启动」并以退出码 1 结束，表现为容器反复重启。
- `env_file` 的值**不做去引号处理**：写 `CV_PASS="abc"` 传进去是带引号的 5 个字符。别加引号、别留空格。
- 改 `CV_PASS` 只对「首次建号」生效；账号已存在后改密码请登录后在「用户管理」里重置。
- `CV_DATA` / `CV_PORT` / 时区由 compose 的 `environment` 固定，写进 `certvault.env` 不生效（`environment` 优先级更高）。
- 这个文件是明文口令：`chmod 600`，**不要提交 git、不要打进代码包**。

---

## 5. 部署

### 5.1 命令行（推荐，可复现）

```bash
docker compose -f "/vol2/1000/8#Docker/CertVault/srv/deploy/docker-compose.yml" up -d --build
```

首次构建要联网拉 `node:20-alpine`。NAS 访问 Docker Hub 慢的话，先在 fnOS 的 Docker 设置里加镜像加速，再重跑一次。

启动后：

```bash
docker compose -f "/vol2/1000/8#Docker/CertVault/srv/deploy/docker-compose.yml" ps
docker logs --tail=100 certvault
curl -fsS http://127.0.0.1:8090/api/health && echo
```

`docker ps` 里应显示 `certvault … (healthy)`（健康检查每 30s 一次，首次有 15s 宽限）。

### 5.2 fnOS 图形界面（不想敲命令时）

1. 打开 Docker 应用 → 找到 Compose / 项目 → 新建。
2. 名称填 `certvault`；项目目录随便给（例如 `/vol2/1000/8#Docker/CertVault`）。
3. 来源选「创建 docker-compose.yml」，把 `deploy/docker-compose.yml` 的内容**原样粘贴**（全是绝对路径，GUI 不会解析错）。
4. 勾选立即启动。以后升级代码，记得在面板里点「重新构建」，或回命令行跑一次 `up -d --build`，否则用的还是旧镜像。

> 如果面板只创建项目、不执行构建，就补一次：`docker compose -f "/vol2/1000/8#Docker/CertVault/srv/deploy/docker-compose.yml" build --pull`。

### 5.3 启动失败最常见的原因

| 日志/现象 | 原因 | 处理 |
| --- | --- | --- |
| 反复重启 + 「首次启动必须设置环境变量 CV_PASS」 | `certvault.env` 没被读到，或 `CV_PASS` 为空 | 检查 `env_file` 路径是否被 `#` 截断、文件是否 600 可读；`docker exec certvault env \| grep CV_PASS` 看不到就是没读到 |
| `EACCES: permission denied, mkdir '/data/...'` | 数据目录属主不是 1000:1000 | `sudo chown -R 1000:1000 "/vol2/1000/8#Docker/CertVault/data"` |
| `port is already allocated` | 8090 被占用 | 改 compose `ports` 左边，例如 `18090:8080` |
| 构建报拉不到 `node:20-alpine` | 无外网/无镜像加速 | 配 registry mirror 后重试 |

---

## 6. 访问与登录

浏览器打开：

```text
http://<NAS-IP>:8090/?server=1
```

- **服务器模式**：页面由服务器托管时自动进服务器模式；URL 加 `?server=1` 是显式指定（推荐，书签就用它）。也可以用 `?server=http://192.168.1.10:8090` 指定别的地址，或用 `?base=<URL>`。
- 首次账号 = `certvault.env` 里的 `CV_USER` / `CV_PASS`（默认 `admin`）。
- 「保持登录」下拉是会话时长：默认 7 天（`604800` 秒），可选 1 天 / 7 天 / 30 天 / 永久（受服务端 `maxTtlSeconds` 上限约束，默认 3650 天）。
- token 存在浏览器 localStorage 的 `cv.token`，登录过的服务器地址记在 `cv.end`。换浏览器/清缓存需重新登录；会话过期会重新弹登录框。
- 登录后顶栏有地址徽标，显示当前连的是哪台服务器，以及会话剩余时间。

**登录后建议立刻做的事：**

1.「用户管理」里改掉 `admin` 口令（改这里才持久；改 `CV_PASS` 对已有账号无效）。
2. 给家人/同事建账号：角色 `viewer`（只读）/ `editor`（可改）/ `admin`（管理）；新注册用户处于 `pending`，需管理员审批才能登录。
3. 检查「设置」里的默认值是否符合预期（与桌面版同构）。

---

## 7. 端口、防火墙与暴露面

- 容器内固定 `8080`，宿主机映射 `8090`。**不要**把 `CV_PORT` 改成 8090 —— 那只是改了容器内监听端口，端口映射和健康检查都会跟着错位。
- 只改冒号左边：`18090:8080`。
- **不要把 8090 直接映射到公网**。推荐顺序：局域网直连 → Tailscale（§9）→ 反向代理 + HTTPS（§8）。
- 若 fnOS 开了防火墙/端口策略，需放行 TCP `8090`（或你改的端口）；只想内网可用就别做端口转发。
- 服务端会用 `X-Forwarded-For` 记审计来源 IP，反代务必带上这个头（§8 的配置已带）。

---

## 8. 反向代理与 HTTPS

什么时候需要：想要稳定域名（`https://cv.example.com`）、要给桌面端写 `serverUrl`、或不想让口令在局域网里明文传输。

### 8.1 nginx（示例已给）

```bash
sudo cp "/vol2/1000/8#Docker/CertVault/srv/deploy/nginx-certvault.conf.example" /etc/nginx/conf.d/certvault.conf
sudo vi /etc/nginx/conf.d/certvault.conf     # 改 server_name 和证书路径
sudo nginx -t && sudo nginx -s reload
```

两个必须改对的点：

1. **`client_max_body_size 80m`**：服务端 `MAX_UPLOAD_BYTES = 80MB`（整库导入、批量上传）。nginx 默认只有 1m，不改会在导入备份时报 `413 Request Entity Too Large`。
2. **证书路径含 `#` 时必须整体加双引号**（nginx 里 `#` 是注释符），或者干脆把证书放到 `/etc/ssl/certvault/` 这类不含 `#` 的目录。

验证：

```bash
curl -fsS https://cv.example.com/api/health && echo
```

### 8.2 fnOS 自带反向代理（如果有）

部分 fnOS 版本在「设置 / 网络 / 外部访问」或应用中心里提供反向代理面板：源 = `https://cv.example.com`，目标 = `http://127.0.0.1:8090`，并在面板里把上传体积上限调到 ≥ 80MB。没有这个入口就用 §8.1 的 nginx，或把反代跑在别的机器上。

### 8.3 证书怎么来

| 方式 | 适用 | 备注 |
| --- | --- | --- |
| Let's Encrypt（DNS-01） | 有自己域名、不想开 80 端口 | 用 DNS 插件签，续期最稳；把 `fullchain.pem` / `privkey.pem` 放进 `/etc/ssl/certvault/` |
| Let's Encrypt（HTTP-01） | 80 端口可达 | 需要公网 80；NAS 一般不方便 |
| 自签证书 | 纯内网 | 浏览器/桌面端要手动信任，否则每次告警 |
| Tailscale 证书 | 已用 Tailscale | 见 §9，`tailscale serve` 能自动拿到 `*.ts.net` 有效证书 |

> 反代之后统一用 `https://域名/?server=1`；**不要** https 和 http 混着用同一个域名（token 存 localStorage，与来源绑定，混用会出现「登录了但一直 401」）。

---

## 9. Tailscale（推荐，最省事的远程方案）

为什么推荐：不开公网端口、设备间 WireGuard 加密、可按设备做 ACL。对家用 NAS 比端口映射安全得多。

```bash
# 安装：优先 fnOS 应用中心里的 Tailscale；没有就用官方脚本（fnOS 基于 Debian）
curl -fsSL https://tailscale.com/install.sh | sh

sudo tailscale up            # 浏览器里授权这台 NAS 加入你的 tailnet
tailscale ip -4              # 记下 100.x.y.z
```

从任意加入 tailnet 的设备访问：

```text
http://100.x.y.z:8090/?server=1
```

要 HTTPS（推荐，证书自动且受信）：

```bash
sudo tailscale serve --bg http://127.0.0.1:8090
# 首次使用需在 Tailscale 管理后台开启 HTTPS Certificates
# 然后访问 https://<机器名>.<tailnet>.ts.net/?server=1
```

- 新版命令是 `tailscale serve --bg http://127.0.0.1:8090`，老版本写成 `tailscale serve --bg 8090`。
- Tailscale ACL 里只给自己的设备放行；别把 `--advertise-routes` 随便开给陌生设备。
- 用了 Tailscale 后**不需要**再在路由器上做 8090 端口映射，也没必要暴露公网。

---

## 10. 每日备份（必做）

### 10.1 先理解两件事

1. 应用内 `backup/` 目录只保留**最近 10 份**（`BACKUP_KEEP = 10`），而且和主数据在同一块盘 —— 误删或坏盘时一起没，**不算备份**。
2. 审计日志只留 **5000 条**（`AUDIT_KEEP`），更早的审计要从备份里找。

所以必须做「整目录 → 另一个卷」的每日备份。

### 10.2 用仓库里的脚本

```bash
chmod +x "/vol2/1000/8#Docker/CertVault/srv/deploy/backup-certvault.sh"
# 先手动跑一次，确认能出包
bash "/vol2/1000/8#Docker/CertVault/srv/deploy/backup-certvault.sh"
ls -lh "/vol2/1000/8#Docker/CertVault/backup"
```

脚本做的事：`data/` 先拷到临时目录（减少与运行中服务的写入竞态）→ `tar.gz` → `gzip -t` 校验 → 删除超过 30 天的旧包。包名 `certvault-data-<yyyymmdd-HHmmss>.tar.gz`，默认落在 `/vol2/1000/8#Docker/CertVault/backup`（可用 `CV_DST` 覆盖）。

挂计划任务，每天 03:30：

```cron
30 3 * * * /bin/bash "/vol2/1000/8#Docker/CertVault/srv/deploy/backup-certvault.sh" >> "/vol2/1000/8#Docker/CertVault/backup/backup.log" 2>&1
```

- 方式一：fnOS 面板「计划任务」→ 新增「自定义脚本」→ 每天 03:30，命令填上面 `/bin/bash …` 那段。
- 方式二：`sudo crontab -e` 贴上面这一行（root 跑没问题，脚本会保留文件权限）。

### 10.3 异地与保留策略

- 目标目录尽量放在**另一块盘/另一个卷**（例如 `/vol1/…` 或挂载的 USB 盘）；同一块盘只算「防误删」。
- 默认保留 30 天（`CV_KEEP_DAYS=30`），空间不够就缩短天数，别取消备份。
- 有条件再加一层异地：`rsync -a --delete "…/backup/" 另一台机器:/backup/certvault/`，或用 fnOS 同步任务 / rclone 到网盘。
- **备份里含凭证**：`config.json`（会话签名密钥）与 `users.json`（口令 scrypt 哈希）。备份文件权限设 600，别丢公共目录。

### 10.4 恢复（含演练）

```bash
# 1) 停服务
docker stop certvault
# 2) 现有数据改名留档（不要直接删）
sudo mv "/vol2/1000/8#Docker/CertVault/data" "/vol2/1000/8#Docker/CertVault/data.broken-$(date +%Y%m%d-%H%M%S)"
# 3) 解包（脚本归档根 = 数据根目录的内容）
sudo mkdir -p "/vol2/1000/8#Docker/CertVault/data"
sudo tar -xzf "/vol2/1000/8#Docker/CertVault/backup/certvault-data-<时间戳>.tar.gz" -C "/vol2/1000/8#Docker/CertVault/data"
# 4) 归位权限 + 起服务
sudo chown -R 1000:1000 "/vol2/1000/8#Docker/CertVault/data"
docker start certvault
```

每季度至少演练一次「解包到临时目录、起个临时容器验证能登录」——没验证过的备份等于没有备份。

---

## 11. 升级与回退

### 11.1 升级

```bash
# ⓪ 先备份（见 §10.2）

# ① 给当前镜像打回退标签（新版起不来时一条命令切回去）
docker image tag certvault-nas:1.0.0 "certvault-nas:rollback-$(date +%Y%m%d)"

# ② 替换 srv 里的代码：只覆盖 server/ 与 app/，deploy/ 里别动 certvault.env
rsync -a --delete "/tmp/certvault-new/server/" "/vol2/1000/8#Docker/CertVault/srv/server/"
rsync -a --delete "/tmp/certvault-new/app/"    "/vol2/1000/8#Docker/CertVault/srv/app/"
rsync -a --exclude 'certvault.env' "/tmp/certvault-new/deploy/" "/vol2/1000/8#Docker/CertVault/srv/deploy/"
#    没有 rsync 就 cp -a 覆盖，效果一样；或用 SMB 直接覆盖

# ③ 重建 + 滚动重启
docker compose -f "/vol2/1000/8#Docker/CertVault/srv/deploy/docker-compose.yml" up -d --build

# ④ 验证
docker compose -f "/vol2/1000/8#Docker/CertVault/srv/deploy/docker-compose.yml" ps
curl -fsS http://127.0.0.1:8090/api/health && echo
docker logs --tail=100 certvault
# 然后浏览器登录，抽几条含图记录点开看看
```

想省事也可以跳过 ①②，直接改 `srv/` 后 `up -d --build` —— 但先打 `rollback-*` 标签，回退会轻松很多。

### 11.2 回退

**A. 镜像回退（代码回退，数据不动）**

```bash
docker rm -f certvault
docker run -d --name certvault --restart unless-stopped \
  -p 8090:8080 \
  --env-file "/vol2/1000/8#Docker/CertVault/srv/deploy/certvault.env" \
  -e CV_DATA=/data -e CV_PORT=8080 -e CV_TZ=Asia/Shanghai -e TZ=Asia/Shanghai \
  -u 1000:1000 --security-opt no-new-privileges:true \
  -v "/vol2/1000/8#Docker/CertVault/data:/data" \
  certvault-nas:rollback-20260101
```

回退后想回到 compose 管理：`docker rm -f certvault` 再 `up -d` 即可（compose 用的是 `certvault-nas:1.0.0` 这个 tag，所以彻底回退要重新 build 或用上面的 run 命令）。

**B. 数据回退**

```bash
docker stop certvault
sudo mv "/vol2/1000/8#Docker/CertVault/data" "/vol2/1000/8#Docker/CertVault/data.bad-$(date +%Y%m%d-%H%M%S)"
sudo mkdir -p "/vol2/1000/8#Docker/CertVault/data"
sudo tar -xzf "/vol2/1000/8#Docker/CertVault/backup/certvault-data-<时间戳>.tar.gz" -C "/vol2/1000/8#Docker/CertVault/data"
sudo chown -R 1000:1000 "/vol2/1000/8#Docker/CertVault/data"
docker start certvault
```

回退后旧的 `data.bad-*` 先留着，确认没问题再删（它可能含新版写入过的新字段）。

---

## 12. 迁移现有「数据\」目录（Windows 桌面版 → NAS）

桌面版的数据目录和服务器版**完全同构**，整目录搬过去就能读。

### 12.1 桌面版里有什么

```text
数据\
├── data\
│   ├── certvault.json     # 全部记录
│   ├── settings.json      # 设置（与服务器默认一致）
│   ├── audit.json         # 审计（最多 5000 条）
│   └── .lock              # 运行锁，迁移前删掉
├── images\<记录ID>\*.png  # 图片
├── backup\*.json          # 应用内备份（留 10 份）
└── 放这里的是全部数据（可整文件夹备份）.txt   # 说明文件，可忽略
```

### 12.2 步骤

1. **关掉桌面版**（含托盘进程），确认没有写入。桌面版里先手动做一次备份（多一份保险）。
2. 在 Windows 里把整个 `数据\` 复制到别处（如 `数据-待迁移\`），**不要直接剪走**，原目录留档。
3. 把内容传到 NAS 数据目录，三种方式任选：

   ```powershell
   # A. scp（远端路径含 # 要加引号）
   scp -r "C:\Users\你\CertVault\数据\*" nas用户@NAS-IP:"/vol2/1000/8#Docker/CertVault/data/"
   ```

   ```bash
   # B. rsync（WSL / Linux，增量可重试，大批量推荐）
   rsync -av --progress "/mnt/c/Users/你/CertVault/数据/" nas用户@NAS-IP:"/vol2/1000/8#Docker/CertVault/data/"
   ```

   ```text
   # C. SMB：文件管理 → 共享，Windows 打开 \\NAS\共享名，
   #    把 数据\ 下的 data、images、backup 三个文件夹拷进 CertVault\data\
   ```

4. **只拷 `data/`、`images/`、`backup/`**（那个 .txt 可忽略）。桌面版没有 `users.json` / `config.json`，这两个由服务器版首次启动生成，别手工造。
5. 删运行锁并归位权限：

   ```bash
   sudo rm -f "/vol2/1000/8#Docker/CertVault/data/data/.lock"
   sudo chown -R 1000:1000 "/vol2/1000/8#Docker/CertVault/data"
   sudo chmod -R u+rwX "/vol2/1000/8#Docker/CertVault/data"
   ```

6. 确认 `certvault.env` 里 `CV_PASS` 已设好（首次启动要用它建管理员），然后起容器（§5.1）。
7. 登录后核对：

   ```bash
   ls "/vol2/1000/8#Docker/CertVault/data/data"
   find "/vol2/1000/8#Docker/CertVault/data/images" -mindepth 1 -maxdepth 1 -type d | wc -l
   ls "/vol2/1000/8#Docker/CertVault/data/backup" | head
   ```

   页面里抽查 3 条含图记录能打开图片、设置项未丢；再做一次「导出备份」，确认服务器端写盘正常。
8. 迁移完成后，Windows 的 `数据\` 改成 `数据-已迁移-<日期>\` 留两周；桌面端改连服务器（§12.3）并确认无误后再删。

### 12.3 桌面端接入服务器

- **浏览器**：直接开 `http://<NAS-IP>:8090/?server=1`（或 https 域名）。
- **桌面 exe**：契约（`docs/接口契约-服务器版.md` §7）规定读 `%LOCALAPPDATA%\CertVault\host.json`，其中可写：

  ```json
  { "serverUrl": "https://cv.example.com" }
  ```

  下次启动导航到 `serverUrl + '/?server=1'`。**是否已实现看你的桌面端版本**：若 exe 不认这个文件，就先用浏览器访问，桌面端继续用本地数据（两边数据独立，别同时写）。
- 桌面端登录页也能直接填「服务器地址」（如 `http://192.168.1.10:8090`）登录，效果等同。

### 12.4 迁移的边界

- 迁移的是**数据**，不是账号。桌面版没有多用户，服务器版首次启动建一个 `admin`，其余账号在「用户管理」里建。
- 以后若要回桌面版：把 `data/`、`images/`、`backup/` 拷回 `数据\` 即可（`users.json` / `config.json` 不拷也不影响桌面版）。
- 服务器版与桌面版**不要同时写同一份数据**（同一目录只能一个进程写，同时跑会互相覆盖）。

---

## 13. 排障速查

| 现象 | 先看什么 | 处理 |
| --- | --- | --- |
| 容器 `Restarting` 循环 | `docker logs --tail=50 certvault` | 见 §5.3：`CV_PASS` 空/未读到、`/data` 不可写、端口冲突 |
| `(unhealthy)` 但页面能开 | `docker inspect --format '{{json .State.Health}}' certvault` | 健康检查打 `127.0.0.1:8080/api/health`；容器内端口被改过就会失败 |
| 页面 404 / 空白 | `docker exec certvault ls /srv/app` | 构建上下文选错（应是 `srv/`）导致 `app/` 没进镜像 |
| 登录一直 401 | 是否混用 http/https；口令是否正确 | 统一协议+域名；改密码在「用户管理」；清掉 localStorage 的 `cv.token` 重登 |
| 上传/导入报 413 | 反代上传上限 | `client_max_body_size 80m`（§8.1） |
| 页面样式是老版本 | 静态资源缓存 | 服务端对 html 是 no-cache、其它资源 `max-age=0, must-revalidate`；Ctrl+F5 强刷 |
| `EACCES` / 数据写不进 | 目录属主 | `chown -R 1000:1000 "…/data"`；`docker exec certvault id` 看容器内 uid |
| 备份文件名/审计时间差 8 小时 | 时区 | compose 里 `TZ` / `CV_TZ`；`docker exec certvault date` 对比宿主机 `date` |
| 应用内备份只剩 10 个 | `BACKUP_KEEP = 10` | 正常行为；长期留存靠 §10 的整目录 tar |
| 登录后很快掉线 | 服务器时间漂移 / 会话 TTL | 校对 NAS 时间（NTP）；「保持登录」选 7 天或更长 |
| Tailscale 访问不了 | 8090 是否只监听本机 | compose 端口映射默认 `0.0.0.0`；用 `ss -lntp \| grep 8090` 看监听地址 |
| 迁移后记录数不对 | 是否只拷了 `data/` 漏了 `images/` | 三个目录都要拷；`find …/images -mindepth 1 -maxdepth 1 -type d \| wc -l` 对比记录数 |

常用命令卡片：

```bash
CV="/vol2/1000/8#Docker/CertVault"
FC="$CV/srv/deploy/docker-compose.yml"

docker compose -f "$FC" ps                 # 状态
docker compose -f "$FC" logs --tail=100 certvault
docker compose -f "$FC" restart certvault
docker compose -f "$FC" down               # 停并删容器（不动数据）
docker compose -f "$FC" up -d --build      # 重建并启动
docker exec -it certvault sh               # 进容器（alpine 只有 sh）
du -sh "$CV/data"                         # 数据量
```

---

## 14. 上线前安全清单

- [ ] `certvault.env` 里 `CV_PASS` 是强口令，`chmod 600`，没进 git、没进代码包。
- [ ] 登录后已在「用户管理」改掉初始口令，`admin` 不再用示例值。
- [ ] 8090 **没有**映射到公网；远程访问走 Tailscale（§9）或反向代理 + HTTPS（§8）。
- [ ] 反向代理上传上限 ≥ 80MB。
- [ ] 数据目录属主 `1000:1000`，放在数据卷而不是系统盘。
- [ ] 每日 tar 备份已跑过一次并验证能解包（§10），且落在另一块盘/异地。
- [ ] 容器以非 root（`1000:1000`）运行，`no-new-privileges` 开启。
- [ ] 知道审计只留 5000 条、应用内备份只留 10 份，历史留存在外部备份里。

---

## 15. 参考

- `docs/接口契约-服务器版.md` —— 环境变量、数据目录结构、30 条 REST 端点、认证与会话（本文事实来源）。
- `docs/使用说明.md` —— 网页/桌面端日常使用。
- `deploy/docker-compose.yml`、`deploy/Dockerfile`、`deploy/certvault.env.example`、`deploy/nginx-certvault.conf.example`、`deploy/backup-certvault.sh`。
