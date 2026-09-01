#!/usr/bin/env bash
# English Pod 部署包自检：上传飞牛前后跑一次，确认离线资源与配置齐备
# 用法: bash test/check.sh
cd "$(dirname "$0")/.."
ok=0; fail=0

check() { # check <描述> <路径>
  if [ -e "$2" ]; then echo "  ✓ $1"; ok=$((ok+1));
  else echo "  ✗ $1（缺失: $2）"; fail=$((fail+1)); fi
}

echo "== 离线资源 =="
check "课程音频 audio/"           "data/audio"
check "字幕 srt/"                  "data/srt"
check "文本 txt/"                  "data/txt"
check "PDF pdf/（可选）"           "data/pdf"
check "离线词典 ecdict.csv"        "data/dict/ecdict.csv"

echo "== 代码与配置 =="
check "后端 server.py"             "server.py"
check "前端 webapp/"               "webapp/index.html"
check "词典/代理配置 config.json"  "config.json"
check "Dockerfile"                 "docker/Dockerfile"
check "docker-compose.yml"         "docker/docker-compose.yml"

echo "== 配置合法性 =="
if command -v python3 >/dev/null 2>&1 && python3 -c "import json;json.load(open('config.json'))" 2>/dev/null; then
  echo "  ✓ config.json 是合法 JSON"; ok=$((ok+1));
else
  echo "  ✗ config.json 解析失败（JSON 语法错误）"; fail=$((fail+1));
fi

echo
echo "结果: $ok 项通过, $fail 项缺失"
[ "$fail" -eq 0 ] && echo "✅ 部署包完整，可上传飞牛" || echo "⚠️ 请补齐上述缺失项后再部署"
exit "$fail"
