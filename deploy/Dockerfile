# syntax=docker/dockerfile:1
# CertVault 服务器版镜像（飞牛 fnOS 部署）
# 契约：docs/接口契约-服务器版.md §1 —— node:20-alpine / WORKDIR /srv / 入口 node server.js / 容器端口 8080
#
# 构建上下文必须是 srv 目录（对应 deploy/docker-compose.yml 里的
#   context: "/vol2/1000/8#Docker/CertVault/srv"），所以下面 COPY 的路径都从 srv 算起；
# 真正进入上下文的文件由 srv/.dockerignore 放行（数据、构建产物、文档、测试都不进镜像）。
#
# 手动构建（路径含 #，shell 里必须整体加引号）：
#   docker build -t certvault-nas:1.0.0 \
#     -f "/vol2/1000/8#Docker/CertVault/srv/deploy/Dockerfile" \
#     "/vol2/1000/8#Docker/CertVault/srv"
#
# 零 npm 依赖：不执行 npm install，镜像里只有 node 运行时 + server.js + 静态站点。
FROM node:20-alpine

LABEL org.opencontainers.image.title="CertVault" \
      org.opencontainers.image.description="CA 证书与平台账号台账 · NAS 服务器版（零 npm 依赖）" \
      org.opencontainers.image.version="1.0.0"

# 时区必须在任何 Date 之前确定：server.js 用 CV_TZ 设置 process.env.TZ，
# 备份文件名 yyyymmdd-HHmmss 与审计时间都取本地时间。
ENV NODE_ENV=production \
    TZ=Asia/Shanghai \
    CV_TZ=Asia/Shanghai \
    CV_DATA=/data \
    CV_PORT=8080

WORKDIR /srv

# 只拷运行必需文件：server/package.json（声明 CommonJS，避免受仓库根 type=module 影响）、
# server.js（零依赖，仅用 Node 内置模块）、静态站点 app/。
COPY server/package.json ./package.json
COPY server/server.js ./server.js
COPY app ./app

# 数据根目录：正式部署会挂载宿主机目录到 /data；这里预建目录并交给 node 用户，
# 兼容「不挂卷直接 docker run」的临时验证场景。/srv 保持 root 所有 + 只读权限，运行时不需要写。
RUN mkdir -p /data && chown node:node /data

USER node
EXPOSE 8080

# 健康检查走免认证的 /api/health，用 Node 20 自带的 fetch，镜像里不需要 curl / wget。
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.CV_PORT||8080)+'/api/health').then(function(r){process.exit(r.ok?0:1)}).catch(function(){process.exit(1)})"

CMD ["node", "/srv/server.js"]