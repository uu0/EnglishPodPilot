#!/usr/bin/env bash
# English Pod 学习器 - macOS 一键启动（双击运行）
# 本脚本位于 local/ 子目录；离线资源在项目根目录的 data/ 下（课程 + 离线词典）
cd "$(dirname "$0")/.."
nohup python3 server.py --data "$(pwd)/data" > /tmp/englishpod.log 2>&1 &
sleep 1.5
open http://127.0.0.1:8787/
echo "English Pod 学习器已启动：http://127.0.0.1:8787/"
