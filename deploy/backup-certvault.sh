#!/usr/bin/env bash
# CertVault 每日数据备份（飞牛 fnOS / 任意 Linux）
#
# 作用：把宿主机数据根目录（容器里的 /data）打成 certvault-data-<时间戳>.tar.gz，
#       校验压缩包完整性，并按保留天数清理旧包。
#
# 为什么应用内的 backup/ 不够：server 的 BACKUP_KEEP=10，只留最近 10 份，
# 而且和主数据在同一块盘 —— 误删或坏盘时一起没了。每日 tar 到另一块卷才是真备份。
#
# 用法：
#   1) chmod +x "/vol2/1000/8#Docker/CertVault/srv/deploy/backup-certvault.sh"
#   2) 手动跑一次（路径含 #，整体加引号）：
#      bash "/vol2/1000/8#Docker/CertVault/srv/deploy/backup-certvault.sh"
#   3) 挂计划任务（fnOS 面板的「计划任务」，或 root 的 crontab）：
#      30 3 * * * /bin/bash "/vol2/1000/8#Docker/CertVault/srv/deploy/backup-certvault.sh" >> "/vol2/1000/8#Docker/CertVault/backup/backup.log" 2>&1
#
# 恢复：停容器 → 把数据目录改名留档 → mkdir 新目录 → chown 1000:1000 →
#       tar -xzf certvault-data-<时间戳>.tar.gz -C "/vol2/1000/8#Docker/CertVault/data"
#       → chown -R 1000:1000 数据目录 → 起容器。详见 docs部署-NAS.md。
#
# 可用环境变量覆盖默认路径（换机器 / 本地测试用）：
#   CV_SRC=/path/to/data  CV_DST=/path/to/backup  CV_KEEP_DAYS=30
#
# 退出码：0 = 成功；非 0 = 失败（计划任务会把 stderr 一起写进日志）
set -euo pipefail

SRC="${CV_SRC:-/vol2/1000/8#Docker/CertVault/data}"
DST="${CV_DST:-/vol2/1000/8#Docker/CertVault/backup}"
KEEP_DAYS="${CV_KEEP_DAYS:-30}"
STAMP="$(date +%Y%m%d-%H%M%S)"
OUT="$DST/certvault-data-$STAMP.tar.gz"

log() { printf '[%s] %s\n' "$(date '+%F %T')" "$*"; }

[ -d "$SRC" ] || { log "ERROR 数据目录不存在：$SRC"; exit 1; }
command -v tar >/dev/null 2>&1 || { log "ERROR 找不到 tar"; exit 1; }
mkdir -p "$DST"

# 先拷到临时目录再打包：server 写 certvault.json / config.json 用的是「临时文件 + rename」
# 原子替换，直接 tar 活目录有概率把写到一半的文件打进快照。
TMP="$(mktemp -d "$DST/.tmp.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT
log "快照 $SRC → $TMP"
cp -a "$SRC/." "$TMP/"

# 归档根 = 数据根目录的内容（data/ images/ backup/ users.json config.json）
tar -C "$TMP" -czf "$OUT" .

# 完整性校验：gzip -t 只读压缩流，能发现截断/写坏
gzip -t "$OUT"
BYTES="$(wc -c < "$OUT" | tr -d ' ')"
log "生成 $OUT（$BYTES 字节）"

# 清理过期包：只动本脚本自己产出的文件名
if [ "$KEEP_DAYS" -gt 0 ] 2>/dev/null; then
  find "$DST" -maxdepth 1 -type f -name 'certvault-data-*.tar.gz' -mtime "+$KEEP_DAYS" -print -delete || true
fi

log "完成。异地备份建议：把 $DST 再同步到别的卷/NAS（rsync、rclone、fnOS 同步任务都行）。"