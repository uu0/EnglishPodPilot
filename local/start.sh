#!/usr/bin/env bash
# English Pod 学习器 - 一键启动（macOS / Linux 终端）
# 本脚本位于 local/ 子目录；离线资源在项目根目录的 data/ 下（课程 + 离线词典）
set -e
cd "$(dirname "$0")/.."
echo "正在启动 English Pod 学习器…"
exec python3 server.py --data "$(pwd)/data" "$@"
