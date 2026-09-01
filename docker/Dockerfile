FROM python:3.13-slim

WORKDIR /app

# 本 Dockerfile 位于 docker/ 子目录，构建上下文是项目根（见 docker-compose.yml 的 build.context），
# 因此 COPY 的相对路径基于项目根（server.py、webapp 在根目录）。
# 仅复制应用代码。离线资源（课程资料 + ECDICT 词典）统一放在项目目录 data/
# 子目录，通过 docker-compose 卷挂载到 /data，不打进镜像（升级镜像无需重传词库）。
COPY server.py ./
COPY webapp ./webapp

ENV EP_HOST=0.0.0.0 \
    EP_PORT=8787 \
    EP_DATA_DIR=/data

EXPOSE 8787

# 容器内固定监听 0.0.0.0，数据目录由环境变量 EP_DATA_DIR 指定
CMD ["python3", "server.py", "--host", "0.0.0.0", "--port", "8787"]
