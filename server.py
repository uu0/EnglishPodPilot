#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
English Pod 学习网页 - 本地媒体服务器
====================================
仅使用 Python 标准库，无需安装任何依赖。

功能:
  1. 扫描 ~/Downloads/english_pod-master 目录，构建课程索引
  2. /api/lessons        -> 返回课程索引 (JSON)
  3. /media/<相对路径>    -> 流式传输音频/字幕/文本/PDF，支持 HTTP Range (拖动进度必需)
  4. 静态前端 (webapp/)   -> index.html / app.js / style.css

用法:
  python3 server.py [--data <数据目录>] [--port <端口>] [--host <地址>]
"""

import os
import re
import sys
import json
import time
import sqlite3
import secrets
import threading
import hashlib
import hmac
import mimetypes
import argparse
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from urllib.parse import urlparse, unquote, parse_qs, quote
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# ----------------------------------------------------------------------------
# 配置
# ----------------------------------------------------------------------------
SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
STATIC_DIR = os.path.join(SCRIPT_DIR, "webapp")
# 默认数据目录：部署包布局 ~/Downloads/englishpod/data
# （离线资源统一放项目目录下的 data/ 子目录：audio/ srt/ txt/ pdf/ dict/；
#   可用 --data / EP_DATA_DIR 覆盖）
DEFAULT_DATA_DIR = os.path.expanduser("~/Downloads/englishpod/data")

# 音轨后缀 -> 中文标签
TRACK_LABELS = {
    "pb": "完整课程",
    "dg": "对话",
    "rv": "讲解",
    "pr": "课程",
}

# 字幕/文本/PDF 与哪个音轨的时间轴对齐
SUBTITLE_TRACK = "pb"

# ----------------------------------------------------------------------------
# Merriam-Webster 词典 API（经本服务代理，密钥不暴露在前端）
# 优先用 Learner's Dictionary（释义更适合英语学习者），回退 Collegiate Dictionary
# 也可用环境变量 MW_LEARNERS_KEY / MW_DICT_KEY 覆盖
# ----------------------------------------------------------------------------
def _load_mw_config():
    """从 config.json 读取词典密钥（不写进源码）。"""
    cfg = {}
    cfg_path = os.path.join(SCRIPT_DIR, "config.json")
    if os.path.isfile(cfg_path):
        try:
            with open(cfg_path, encoding="utf-8") as f:
                cfg = json.load(f) or {}
        except Exception:
            cfg = {}
    return cfg

_MW_CONFIG = _load_mw_config()
# 优先级：环境变量 > config.json > 空（未配置时词典不可用，但前端会给出提示）
MW_LEARNERS_KEY = os.environ.get("MW_LEARNERS_KEY") or _MW_CONFIG.get("mw_learners_key") or ""
MW_DICT_KEY = os.environ.get("MW_DICT_KEY") or _MW_CONFIG.get("mw_dict_key") or ""
# 代理服务器（可选）：所有出站词典请求都走该代理。示例 "http://127.0.0.1:7890"，留空则直连
MW_PROXY = os.environ.get("MW_PROXY") or _MW_CONFIG.get("proxy") or ""
DICT_CACHE = {}

# ----------------------------------------------------------------------------
# 离线英汉词典（ECDICT，https://github.com/skywind3000/ECDICT）
# 词库文件：dict/ecdict.csv（76 万词条，UTF-8 CSV），首次启动自动构建 SQLite
# 索引 dict/ecdict.db 加速查询；两者都不存在时该词典不可用（前端给出提示）。
# CSV 字段：word,phonetic,definition,translation,pos,collins,oxford,
#           tag,bnc,frq,exchange,detail,audio
# ----------------------------------------------------------------------------
def _resolve_dict_dir():
    """定位离线词典目录（dict/，ECDICT 词库）。查找顺序：
    1) 数据目录下直接有 dict/（部署布局：data/ 下并列 audio/ srt/ txt/ pdf/ dict/）；
    2) 数据目录的父目录下（兜底）；
    3) 项目目录下（本地开发默认布局，dict/ 与 server.py 同级）。
    都找不到时返回项目目录下的 dict/（查询时给出词典不可用提示）。"""
    bases = []
    if Handler.data_dir:
        bases.append(Handler.data_dir)
        bases.append(os.path.dirname(os.path.abspath(Handler.data_dir)))
    bases.append(SCRIPT_DIR)
    for base in bases:
        d = os.path.join(base, "dict")
        if os.path.isdir(d):
            return d
    return os.path.join(SCRIPT_DIR, "dict")


_ECDICT_DB_WRITABLE = None  # None=未探测；False 时索引落到可写缓存目录


def _dict_paths():
    """返回 (词典目录, csv 路径, db 路径)。
    db 索引优先与 csv 同目录（用户可自行查看/删除）；若词典目录不可写
    （如 Docker 卷被挂载为 :ro），自动回退到可写缓存目录，并做一次性探测缓存。"""
    import tempfile
    global _ECDICT_DB_WRITABLE
    d = _resolve_dict_dir()
    csv_path = os.path.join(d, "ecdict.csv")
    db_path = os.path.join(d, "ecdict.db")
    if _ECDICT_DB_WRITABLE is None and os.path.isdir(d):
        probe = os.path.join(d, ".wb_probe")
        try:
            with open(probe, "w"):
                pass
            os.remove(probe)
            _ECDICT_DB_WRITABLE = True
        except OSError:
            _ECDICT_DB_WRITABLE = False
    if _ECDICT_DB_WRITABLE is False:
        cache = os.environ.get("ECDICT_DB_DIR") or tempfile.gettempdir()
        db_path = os.path.join(cache, "ecdict.db")
    return d, csv_path, db_path


_ECDICT_CONN = None  # 惰性初始化


def _strip_word(word):
    """ECDICT 的 sw 字段：去除非字母数字并转小写，用于模糊匹配。"""
    return "".join(ch for ch in word if ch.isalnum()).lower()


def _build_ecdict_db():
    """把 ecdict.csv 构建成 SQLite 索引（只构建一次，约 1 分钟）。"""
    import sqlite3
    dict_dir, csv_path, db_path = _dict_paths()
    if not os.path.isfile(csv_path):
        return None
    print("正在构建离线词典索引（首次启动，约需 1 分钟）…")
    os.makedirs(dict_dir, exist_ok=True)
    conn = sqlite3.connect(db_path)
    cur = conn.cursor()
    cur.execute("DROP TABLE IF EXISTS dict")
    cur.execute("""CREATE TABLE dict (
        word TEXT PRIMARY KEY,
        sw TEXT,
        phonetic TEXT,
        definition TEXT,
        translation TEXT,
        pos TEXT,
        collins TEXT,
        oxford TEXT,
        tag TEXT,
        bnc TEXT,
        frq TEXT,
        exchange TEXT
    )""")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_sw ON dict(sw)")
    import csv as _csv
    n = 0
    with open(csv_path, encoding="utf-8", newline="") as f:
        reader = _csv.DictReader(f)
        batch = []
        for row in reader:
            w = (row.get("word") or "").strip()
            if not w:
                continue
            batch.append((
                w,
                _strip_word(w),
                row.get("phonetic") or "",
                row.get("definition") or "",
                row.get("translation") or "",
                row.get("pos") or "",
                row.get("collins") or "",
                row.get("oxford") or "",
                row.get("tag") or "",
                row.get("bnc") or "",
                row.get("frq") or "",
                row.get("exchange") or "",
            ))
            n += 1
            if len(batch) >= 5000:
                cur.executemany("INSERT OR IGNORE INTO dict VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", batch)
                batch.clear()
        if batch:
            cur.executemany("INSERT OR IGNORE INTO dict VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", batch)
    conn.commit()
    conn.close()
    print("离线词典索引构建完成：%d 词条" % n)
    return db_path


def _get_ecdict_conn():
    """惰性获取 SQLite 连接；db 不存在时先构建。"""
    global _ECDICT_CONN
    if _ECDICT_CONN is not None:
        return _ECDICT_CONN
    _dict_dir, _csv, db_path = _dict_paths()
    if not os.path.isfile(db_path):
        _build_ecdict_db()
    if not os.path.isfile(db_path):
        return None
    import sqlite3
    _ECDICT_CONN = sqlite3.connect(db_path)
    return _ECDICT_CONN


def lookup_ecdict(word):
    """离线英汉词典查询。返回结构与其他词典一致。"""
    word = (word or "").strip()
    if not word:
        return {"dict": "ecdict", "defs": []}
    conn = _get_ecdict_conn()
    if conn is None:
        return {"dict": "ecdict", "defs": [], "error": "dictionary_not_available"}

    cache_key = "ecdict::" + word.lower()
    if cache_key in DICT_CACHE:
        return DICT_CACHE[cache_key]

    cur = conn.cursor()
    row = cur.execute("SELECT * FROM dict WHERE word = ?", (word,)).fetchone()
    if row is None:
        # 用 sw 模糊匹配兜底（处理大小写/连字符/空格变体）
        sw = _strip_word(word)
        row = cur.execute("SELECT * FROM dict WHERE sw = ? LIMIT 1", (sw,)).fetchone()
    if row is None:
        # 拼写建议：前缀 + 同 sw 前缀
        sw = _strip_word(word)
        sug = set()
        if word:
            for r in cur.execute("SELECT word FROM dict WHERE word LIKE ? LIMIT 8", (word + "%",)):
                sug.add(r[0])
        if sw:
            for r in cur.execute("SELECT word FROM dict WHERE sw LIKE ? LIMIT 8", (sw + "%",)):
                sug.add(r[0])
        result = {"dict": "ecdict", "defs": [], "suggestions": list(sug)[:12]}
        DICT_CACHE[cache_key] = result
        return result

    (w, _sw, phonetic, definition, translation, pos, collins, oxford,
     tag, bnc, frq, exchange) = row
    # 中文释义（translation）按行分割
    cn_lines = [x.strip() for x in (translation or "").splitlines() if x.strip()]
    en_lines = [x.strip() for x in (definition or "").splitlines() if x.strip()]
    if not cn_lines and not en_lines:
        result = {"dict": "ecdict", "defs": []}
        DICT_CACHE[cache_key] = result
        return result
    defs = [{"pos": "", "def": x, "example": ""} for x in cn_lines]
    if not defs:
        defs = [{"pos": "", "def": x, "example": ""} for x in en_lines[:6]]
    # exchange 解析：p:过去式 d:过去分词 i:现在分词 3:第三人称单数
    #               r:比较级 t:最高级 s:复数 0:原型
    exch_map = {}
    if exchange:
        for part in exchange.split("/"):
            if ":" in part:
                k, v = part.split(":", 1)
                exch_map[k] = v
    labels = {
        "p": "过去式", "d": "过去分词", "i": "现在分词", "3": "第三人称单数",
        "r": "比较级", "t": "最高级", "s": "复数", "0": "原型",
    }
    exchange_out = {}
    for k in ("p", "d", "i", "3", "r", "t", "s"):
        if k in exch_map:
            exchange_out[labels.get(k, k)] = exch_map[k]
    result = {
        "dict": "ecdict",
        "phonetic": phonetic or "",
        "pos": pos or "",
        "defs": defs,
        "en": en_lines[:8],
        "tags": [x for x in tag.split() if x] if tag else [],
        "collins": collins or "",
        "oxford": bool(oxford),
        "bnc": bnc or "",
        "frq": frq or "",
        "exchange": exchange_out,
    }
    DICT_CACHE[cache_key] = result
    return result


def _build_opener():
    """按配置的代理构建 urllib opener；未配置代理则直连。"""
    if MW_PROXY:
        return urllib.request.build_opener(
            urllib.request.ProxyHandler({"http": MW_PROXY, "https": MW_PROXY})
        )
    return urllib.request.build_opener()


_MW_OPENER = _build_opener()


def _fetch_json(url):
    """带代理支持地抓取 JSON（超时 10s）。"""
    req = urllib.request.Request(url, headers={"User-Agent": "englishpod/1.0"})
    with _MW_OPENER.open(req, timeout=10) as resp:
        return json.loads(resp.read().decode("utf-8"))

_VIS_TAG = re.compile(r"\{it\}(.*?)\{/it\}", re.S)
_MW_TAG = re.compile(r"\{[^}]*\}")


def _clean_mw(text):
    if not text:
        return ""
    text = _VIS_TAG.sub(r"\1", text)   # {it}X{/it} -> X
    text = _MW_TAG.sub("", text)        # 移除其余 {bc}/{a_link|...} 等标记
    return re.sub(r"\s+", " ", text).strip()


def _collect_vis(node, out):
    """递归收集 sseq 中 vis 字段的例句文本。"""
    if isinstance(node, list):
        if len(node) >= 2 and node[0] == "vis" and isinstance(node[1], list):
            for item in node[1]:
                if isinstance(item, dict) and isinstance(item.get("t"), str):
                    out.append(_clean_mw(item["t"]))
        else:
            for it in node:
                _collect_vis(it, out)
    elif isinstance(node, dict):
        for v in node.values():
            _collect_vis(v, out)


def _parse_entry(entry):
    pos = entry.get("fl") or ""
    prs = (entry.get("hwi") or {}).get("prs") or []
    phonetic = (prs[0].get("mw") or prs[0].get("ipa") or "") if prs else ""
    defs = []
    if entry.get("app-shortdef") and entry["app-shortdef"].get("def"):
        defs = entry["app-shortdef"]["def"]
    elif entry.get("shortdef"):
        defs = entry["shortdef"]
    examples = []
    for d in entry.get("def", []):
        _collect_vis(d, examples)
    return pos, phonetic, defs, [e for e in examples if e]


# 两个在线词典（Merriam-Webster）的端点和对应 key
_DICT_SOURCES = {
    "learners":   "https://www.dictionaryapi.com/api/v3/references/learners/json/%s?key=%s",
    "collegiate": "https://www.dictionaryapi.com/api/v3/references/collegiate/json/%s?key=%s",
}
_DICT_KEYS = {
    "learners": lambda: MW_LEARNERS_KEY,
    "collegiate": lambda: MW_DICT_KEY,
}


def lookup_word(word, dict_name="learners"):
    """查询词典。dict_name: learners / collegiate（在线 MW）/ ecdict（离线英汉）。"""
    word = (word or "").strip().lower()
    if dict_name == "ecdict":
        return lookup_ecdict(word)
    d = dict_name if dict_name in _DICT_SOURCES else "learners"
    if not word:
        return {"dict": d, "defs": []}
    api_key = _DICT_KEYS[d]()
    if not api_key:
        return {"dict": d, "defs": [], "error": "dictionary_not_configured"}

    cache_key = d + "::" + word
    if cache_key in DICT_CACHE:
        return DICT_CACHE[cache_key]

    try:
        url = _DICT_SOURCES[d] % (quote(word), api_key)
        data = _fetch_json(url)
    except Exception:
        return {"dict": d, "defs": [], "error": "network_error"}

    # 返回的不是 JSON 数组（如 "Invalid API key..."）= 密钥无权限/未订阅
    if not isinstance(data, list):
        result = {"dict": d, "defs": [], "error": "dictionary_not_configured"}
    # 字符串数组 = 拼写建议
    elif data and isinstance(data[0], str):
        result = {"dict": d, "defs": [], "suggestions": data[:12]}
    elif data:
        defs_out = []
        phonetic = ""
        for entry in data[:3]:
            if not isinstance(entry, dict):
                continue
            p, ph, defs, examples = _parse_entry(entry)
            if not phonetic and ph:
                phonetic = ph
            for i, x in enumerate(defs[:6]):
                defs_out.append({
                    "pos": p,
                    "def": _clean_mw(x),
                    "example": examples[i] if i < len(examples) else (examples[0] if examples else ""),
                })
            result = {"dict": d, "phonetic": phonetic, "defs": defs_out}
    else:
        result = {"dict": d, "defs": []}
    DICT_CACHE[cache_key] = result
    return result


# ----------------------------------------------------------------------------
# 构建课程索引
# ----------------------------------------------------------------------------
def build_index(data_dir):
    audio_dir = os.path.join(data_dir, "audio")
    srt_dir = os.path.join(data_dir, "srt")
    txt_dir = os.path.join(data_dir, "txt")
    pdf_dir = os.path.join(data_dir, "pdf")

    lessons = {}

    # 1) 扫描音频文件
    if os.path.isdir(audio_dir):
        for fn in os.listdir(audio_dir):
            if not fn.lower().endswith(".mp3"):
                continue
            base = fn[:-4]  # 去掉 .mp3
            if not base.startswith("englishpod_"):
                continue
            rest = base[len("englishpod_"):]
            m = re.match(r"^(.+?)([a-z]{2})$", rest)
            if not m:
                continue
            lid, suffix = m.group(1), m.group(2)
            if lid not in lessons:
                is_standard = lid.isdigit()
                sort_key = int(lid) if is_standard else 10_000
                if lid.startswith("DC"):
                    sort_key = 20_000 + (int(lid[2:]) if lid[2:].isdigit() else 0)
                elif lid.startswith("TJI"):
                    sort_key = 30_000 + (int(lid[3:]) if lid[3:].isdigit() else 0)
                series = "standard" if is_standard else ("DC" if lid.startswith("DC") else "TJI")
                lessons[lid] = {
                    "id": lid,
                    "series": series,
                    "number": int(lid) if is_standard else None,
                    "sortKey": sort_key,
                    "tracks": {},
                    "srt": None,
                    "txt": None,
                    "pdf": None,
                }
            rel = "audio/" + fn
            lessons[lid]["tracks"][suffix] = {
                "label": TRACK_LABELS.get(suffix, suffix),
                "url": "/media/" + rel,
            }

    # 2) 关联 srt / txt (仅标准课程有)
    for sub_dir, key in ((srt_dir, "srt"), (txt_dir, "txt")):
        if not os.path.isdir(sub_dir):
            continue
        for fn in os.listdir(sub_dir):
            m = re.match(r"^englishpod_(\d+)\.(srt|txt)$", fn)
            if not m:
                continue
            lid = m.group(1)
            # 补齐前导零到 4 位，与音频命名一致
            lid = lid.zfill(4)
            if lid in lessons:
                lessons[lid][key] = "/media/" + os.path.relpath(
                    os.path.join(sub_dir, fn), data_dir
                ).replace(os.sep, "/")

    # 3) 关联 pdf
    if os.path.isdir(pdf_dir):
        for root, _dirs, files in os.walk(pdf_dir):
            for fn in files:
                if not fn.lower().endswith(".pdf"):
                    continue
                m = re.match(r"^englishpod_(\d+)\.pdf$", fn)
                if not m:
                    continue
                lid = m.group(1).zfill(4)
                if lid in lessons:
                    lessons[lid]["pdf"] = "/media/" + os.path.relpath(
                        os.path.join(root, fn), data_dir
                    ).replace(os.sep, "/")

    # 4) 规整输出
    result = []
    for lid, les in lessons.items():
        # 决定默认播放音轨
        if "pb" in les["tracks"]:
            default_track = "pb"
        elif "pr" in les["tracks"]:
            default_track = "pr"
        else:
            default_track = next(iter(les["tracks"]), None)

        # 音轨按固定顺序排列
        ordered = []
        for suf in ("pb", "dg", "rv", "pr"):
            if suf in les["tracks"]:
                t = les["tracks"][suf]
                t["suffix"] = suf
                ordered.append(t)

        result.append({
            "id": lid,
            "series": les["series"],
            "number": les["number"],
            "sortKey": les["sortKey"],
            "title": ("第 " + lid + " 课") if les["series"] == "standard" else lid,
            "tracks": ordered,
            "defaultTrack": default_track,
            "subtitleTrack": SUBTITLE_TRACK if les["srt"] else None,
            "srt": les["srt"],
            "txt": les["txt"],
            "pdf": les["pdf"],
            "hasDoc": bool(les["pdf"] or les["txt"] or les["srt"]),
        })

    result.sort(key=lambda x: (x["sortKey"], x["id"]))
    return result


# ----------------------------------------------------------------------------
# 多用户：账号 / 会话 / 学习进度 / 生词本 / 学习时长
# 数据存 SQLite（app.db），路径可用环境变量 EP_APP_DB 覆盖（Docker 卷挂载）。
# 密码 PBKDF2-SHA256 加盐哈希；登录签发随机 token（30 天有效）。
# ----------------------------------------------------------------------------
APP_DB = os.environ.get("EP_APP_DB") or os.path.join(SCRIPT_DIR, "app.db")
_DB_LOCK = threading.Lock()
SESSION_DAYS = 30


def _db_conn():
    conn = sqlite3.connect(APP_DB, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def _db_init():
    """建表（幂等）。启动时调用一次。"""
    with _DB_LOCK:
        conn = _db_conn()
        try:
            conn.executescript("""
            CREATE TABLE IF NOT EXISTS users (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                username TEXT UNIQUE NOT NULL,
                pass_hash TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT 'user',
                is_active INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS sessions (
                token TEXT PRIMARY KEY,
                user_id INTEGER NOT NULL,
                expires_at TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS progress (
                user_id INTEGER NOT NULL,
                lesson TEXT NOT NULL,
                completed INTEGER NOT NULL DEFAULT 0,
                position REAL NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, lesson)
            );
            CREATE TABLE IF NOT EXISTS vocab (
                user_id INTEGER NOT NULL,
                word TEXT NOT NULL,
                data TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (user_id, word)
            );
            CREATE TABLE IF NOT EXISTS activity (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id INTEGER NOT NULL,
                seconds INTEGER NOT NULL,
                ts TEXT NOT NULL
            );
            """)
            conn.commit()
        finally:
            conn.close()


def _now_iso():
    return datetime.now().strftime("%Y-%m-%d %H:%M:%S")


def _hash_password(password, salt_hex=None):
    if salt_hex is None:
        salt_hex = secrets.token_hex(16)
    digest = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), bytes.fromhex(salt_hex), 120000)
    return "%s$%s" % (salt_hex, digest.hex())


def _verify_password(password, stored):
    try:
        salt_hex, _ = stored.split("$", 1)
        return hmac.compare_digest(_hash_password(password, salt_hex), stored)
    except Exception:
        return False


def users_exist():
    with _DB_LOCK:
        conn = _db_conn()
        try:
            return conn.execute("SELECT COUNT(*) c FROM users").fetchone()["c"] > 0
        finally:
            conn.close()


def create_user(username, password, role="user"):
    username = (username or "").strip()
    if not username or not password:
        return None, "用户名和密码不能为空"
    with _DB_LOCK:
        conn = _db_conn()
        try:
            if conn.execute("SELECT 1 FROM users WHERE username=?", (username,)).fetchone():
                return None, "用户名已存在"
            conn.execute(
                "INSERT INTO users(username,pass_hash,role,is_active,created_at) VALUES(?,?,?,1,?)",
                (username, _hash_password(password), role, _now_iso()))
            conn.commit()
            uid = conn.execute("SELECT id FROM users WHERE username=?", (username,)).fetchone()["id"]
            return {"id": uid, "username": username, "role": role, "is_active": 1}, None
        finally:
            conn.close()


def delete_user(uid):
    """删除用户及其全部学习数据（级联清理）。"""
    with _DB_LOCK:
        conn = _db_conn()
        try:
            for t in ("sessions", "progress", "vocab", "activity"):
                conn.execute("DELETE FROM %s WHERE user_id=?" % t, (uid,))
            conn.execute("DELETE FROM users WHERE id=?", (uid,))
            conn.commit()
        finally:
            conn.close()


def set_user_active(uid, active):
    with _DB_LOCK:
        conn = _db_conn()
        try:
            conn.execute("UPDATE users SET is_active=? WHERE id=?", (1 if active else 0, uid))
            if not active:
                conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            conn.commit()
        finally:
            conn.close()


def reset_password(uid, password):
    if not password:
        return "密码不能为空"
    with _DB_LOCK:
        conn = _db_conn()
        try:
            conn.execute("UPDATE users SET pass_hash=? WHERE id=?", (_hash_password(password), uid))
            conn.execute("DELETE FROM sessions WHERE user_id=?", (uid,))
            conn.commit()
        finally:
            conn.close()
    return None


def login_user(username, password):
    with _DB_LOCK:
        conn = _db_conn()
        try:
            row = conn.execute("SELECT * FROM users WHERE username=?", ((username or "").strip(),)).fetchone()
            if not row or not _verify_password(password or "", row["pass_hash"]):
                return None, "用户名或密码错误"
            if not row["is_active"]:
                return None, "账号已停用，请联系管理员"
            token = secrets.token_hex(24)
            exp = (datetime.now() + timedelta(days=SESSION_DAYS)).strftime("%Y-%m-%d %H:%M:%S")
            conn.execute("INSERT INTO sessions(token,user_id,expires_at) VALUES(?,?,?)", (token, row["id"], exp))
            conn.commit()
            return {"token": token,
                    "user": {"id": row["id"], "username": row["username"], "role": row["role"]}}, None
        finally:
            conn.close()


def logout_token(token):
    with _DB_LOCK:
        conn = _db_conn()
        try:
            conn.execute("DELETE FROM sessions WHERE token=?", (token,))
            conn.commit()
        finally:
            conn.close()


def auth_user(token):
    """按 token 返回 user dict；无效/过期/停用返回 None。"""
    if not token:
        return None
    with _DB_LOCK:
        conn = _db_conn()
        try:
            row = conn.execute(
                "SELECT u.id,u.username,u.role,u.is_active FROM sessions s "
                "JOIN users u ON u.id=s.user_id WHERE s.token=?", (token,)).fetchone()
            if not row or not row["is_active"]:
                return None
            return {"id": row["id"], "username": row["username"], "role": row["role"]}
        finally:
            conn.close()


def get_user_progress(uid):
    """返回 {completed: {lesson: true}, positions: {lesson: 秒}}。"""
    with _DB_LOCK:
        conn = _db_conn()
        try:
            rows = conn.execute("SELECT lesson,completed,position FROM progress WHERE user_id=?", (uid,)).fetchall()
        finally:
            conn.close()
    completed, positions = {}, {}
    for r in rows:
        if r["completed"]:
            completed[r["lesson"]] = True
        if r["position"]:
            positions[r["lesson"]] = r["position"]
    return {"completed": completed, "positions": positions}


def save_user_progress(uid, completed, positions):
    """全量覆盖该用户进度（前端内存对象为权威）。"""
    completed = completed or {}
    positions = positions or {}
    with _DB_LOCK:
        conn = _db_conn()
        try:
            now = _now_iso()
            conn.execute("DELETE FROM progress WHERE user_id=?", (uid,))
            for lesson, done in completed.items():
                if done:
                    pos = positions.get(lesson) or 0
                    conn.execute(
                        "INSERT OR REPLACE INTO progress(user_id,lesson,completed,position,updated_at) "
                        "VALUES(?,?,?,?,?)", (uid, lesson, 1, pos, now))
            for lesson, pos in positions.items():
                if pos:
                    conn.execute(
                        "INSERT OR REPLACE INTO progress(user_id,lesson,completed,position,updated_at) "
                        "VALUES(?,?,?,?,?)", (uid, lesson, 1 if completed.get(lesson) else 0, pos, now))
            conn.commit()
        finally:
            conn.close()


def get_user_vocab(uid):
    with _DB_LOCK:
        conn = _db_conn()
        try:
            rows = conn.execute("SELECT word,data FROM vocab WHERE user_id=?", (uid,)).fetchall()
        finally:
            conn.close()
    out = {}
    for r in rows:
        try:
            out[r["word"]] = json.loads(r["data"])
        except Exception:
            out[r["word"]] = {}
    return out


def set_user_vocab(uid, word, data):
    word = (word or "").strip().lower()
    if not word:
        return
    with _DB_LOCK:
        conn = _db_conn()
        try:
            conn.execute(
                "INSERT OR REPLACE INTO vocab(user_id,word,data,updated_at) VALUES(?,?,?,?)",
                (uid, word, json.dumps(data or {}, ensure_ascii=False), _now_iso()))
            conn.commit()
        finally:
            conn.close()


def delete_user_vocab(uid, word):
    with _DB_LOCK:
        conn = _db_conn()
        try:
            conn.execute("DELETE FROM vocab WHERE user_id=? AND word=?", (uid, (word or "").strip().lower()))
            conn.commit()
        finally:
            conn.close()


def bulk_user_vocab(uid, words):
    """批量导入生词：words = {word: data}，逐个 INSERT OR REPLACE。"""
    with _DB_LOCK:
        conn = _db_conn()
        try:
            now = _now_iso()
            for w, d in (words or {}).items():
                w = (w or "").strip().lower()
                if not w:
                    continue
                conn.execute(
                    "INSERT OR REPLACE INTO vocab(user_id,word,data,updated_at) VALUES(?,?,?,?)",
                    (uid, w, json.dumps(d or {}, ensure_ascii=False), now))
            conn.commit()
        finally:
            conn.close()


def add_activity(uid, seconds):
    with _DB_LOCK:
        conn = _db_conn()
        try:
            conn.execute("INSERT INTO activity(user_id,seconds,ts) VALUES(?,?,?)",
                         (uid, max(0, int(seconds or 0)), _now_iso()))
            conn.commit()
        finally:
            conn.close()


def admin_stats():
    """每用户统计：学习时长合计、完成课程数、生词数、最近活跃。"""
    with _DB_LOCK:
        conn = _db_conn()
        try:
            rows = conn.execute("""
                SELECT u.id, u.username, u.role, u.is_active, u.created_at,
                       COALESCE((SELECT SUM(seconds) FROM activity a WHERE a.user_id=u.id),0) AS secs,
                       COALESCE((SELECT COUNT(*) FROM progress p WHERE p.user_id=u.id AND p.completed=1),0) AS done,
                       COALESCE((SELECT COUNT(*) FROM vocab v WHERE v.user_id=u.id),0) AS words,
                       COALESCE((SELECT MAX(ts) FROM activity a WHERE a.user_id=u.id),'') AS last_seen
                FROM users u ORDER BY u.id
            """).fetchall()
        finally:
            conn.close()
    return [dict(r) for r in rows]


def list_users():
    with _DB_LOCK:
        conn = _db_conn()
        try:
            rows = conn.execute(
                "SELECT id,username,role,is_active,created_at FROM users ORDER BY id").fetchall()
        finally:
            conn.close()
    return [dict(r) for r in rows]


# ----------------------------------------------------------------------------
# HTTP 处理器
# ----------------------------------------------------------------------------
class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    data_dir = DEFAULT_DATA_DIR
    index_cache = None

    def log_message(self, fmt, *args):
        # 精简日志
        sys.stdout.write("· " + (fmt % args) + "\n")

    # ---- 工具 ----
    def _send_headers(self, code, headers):
        self.send_response(code)
        for k, v in headers.items():
            self.send_header(k, v)
        self.end_headers()

    def _safe_path(self, base, rel):
        full = os.path.normpath(os.path.join(base, unquote(rel)))
        if not full.startswith(os.path.normpath(base)):
            return None
        return full

    # ---- 认证 / JSON 工具 ----
    def _auth(self):
        """从 Authorization: Bearer <token> 解析用户；未登录返回 None。"""
        h = self.headers.get("Authorization") or ""
        if h.startswith("Bearer "):
            return auth_user(h[7:].strip())
        return None

    def _require_auth(self):
        u = self._auth()
        if u:
            return u
        self._send_json(401, {"error": "unauthorized", "code": "unauthorized"})
        return None

    def _require_admin(self):
        u = self._auth()
        if u and u["role"] == "admin":
            return u
        self._send_json(403, {"error": "forbidden", "code": "forbidden"})
        return None

    def _read_json_body(self):
        try:
            n = int(self.headers.get("Content-Length") or 0)
            if n <= 0 or n > 1024 * 1024:
                return None
            return json.loads(self.rfile.read(n).decode("utf-8"))
        except Exception:
            return None

    def _send_json(self, code, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send_headers(code, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(body)),
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        })
        self.wfile.write(body)

    # ---- 账号与登录 API ----
    def _api_me(self):
        """当前登录用户；未登录时区分「首次部署(无管理员)」与「未登录」。"""
        u = self._auth()
        if u:
            self._send_json(200, {"user": u})
            return
        if not users_exist():
            self._send_json(401, {"error": "unauthorized", "code": "setup_required"})
        else:
            self._send_json(401, {"error": "unauthorized", "code": "unauthorized"})

    def _api_setup(self):
        """首次部署：创建管理员账号并直接登录。已有用户时拒绝。"""
        if users_exist():
            self._send_json(403, {"error": "already_setup"})
            return
        body = self._read_json_body() or {}
        user, err = create_user(body.get("username", ""), body.get("password", ""), role="admin")
        if err:
            self._send_json(400, {"error": err})
            return
        token, _ = login_user(body.get("username", ""), body.get("password", ""))
        self._send_json(200, {"token": token["token"], "user": token["user"]})

    def _api_login(self):
        body = self._read_json_body() or {}
        res, err = login_user(body.get("username", ""), body.get("password", ""))
        if err:
            self._send_json(401, {"error": err})
            return
        self._send_json(200, res)

    def _api_logout(self):
        h = self.headers.get("Authorization") or ""
        if h.startswith("Bearer "):
            logout_token(h[7:].strip())
        self._send_json(200, {"ok": True})

    # ---- 学习进度 / 生词本 / 学习时长 API ----
    def _api_get_progress(self):
        u = self._require_auth()
        if not u:
            return
        self._send_json(200, get_user_progress(u["id"]))

    def _api_put_progress(self):
        u = self._require_auth()
        if not u:
            return
        body = self._read_json_body() or {}
        save_user_progress(u["id"], body.get("completed"), body.get("positions"))
        self._send_json(200, {"ok": True})

    def _api_get_vocab(self):
        u = self._require_auth()
        if not u:
            return
        self._send_json(200, {"words": get_user_vocab(u["id"])})

    def _api_post_vocab(self):
        u = self._require_auth()
        if not u:
            return
        body = self._read_json_body() or {}
        set_user_vocab(u["id"], body.get("word", ""), body.get("data"))
        self._send_json(200, {"ok": True})

    def _api_delete_vocab(self):
        u = self._require_auth()
        if not u:
            return
        body = self._read_json_body() or {}
        delete_user_vocab(u["id"], body.get("word", ""))
        self._send_json(200, {"ok": True})

    def _api_bulk_vocab(self):
        u = self._require_auth()
        if not u:
            return
        body = self._read_json_body() or {}
        bulk_user_vocab(u["id"], body.get("words"))
        self._send_json(200, {"ok": True})

    def _api_activity(self):
        u = self._require_auth()
        if not u:
            return
        body = self._read_json_body() or {}
        add_activity(u["id"], body.get("seconds", 0))
        self._send_json(200, {"ok": True})

    # ---- 管理员 API：用户管理 + 工作台 ----
    def _api_admin_users_get(self):
        u = self._require_admin()
        if not u:
            return
        self._send_json(200, {"users": list_users()})

    def _api_admin_users_post(self):
        u = self._require_admin()
        if not u:
            return
        body = self._read_json_body() or {}
        user, err = create_user(body.get("username", ""), body.get("password", ""), role="user")
        if err:
            self._send_json(400, {"error": err})
            return
        self._send_json(200, {"ok": True, "user": user})

    def _api_admin_user_delete(self):
        u = self._require_admin()
        if not u:
            return
        body = self._read_json_body() or {}
        uid = int(body.get("id") or 0)
        if uid == u["id"]:
            self._send_json(400, {"error": "不能删除自己的账号"})
            return
        delete_user(uid)
        self._send_json(200, {"ok": True})

    def _api_admin_user_reset(self):
        u = self._require_admin()
        if not u:
            return
        body = self._read_json_body() or {}
        err = reset_password(int(body.get("id") or 0), body.get("password", ""))
        if err:
            self._send_json(400, {"error": err})
            return
        self._send_json(200, {"ok": True})

    def _api_admin_user_toggle(self):
        u = self._require_admin()
        if not u:
            return
        body = self._read_json_body() or {}
        uid = int(body.get("id") or 0)
        if uid == u["id"]:
            self._send_json(400, {"error": "不能停用自己的账号"})
            return
        set_user_active(uid, bool(body.get("active")))
        self._send_json(200, {"ok": True})

    def _api_admin_stats(self):
        u = self._require_admin()
        if not u:
            return
        self._send_json(200, {"stats": admin_stats()})

    # ---- 路由 ----
    def do_GET(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/lessons":
            self._serve_json(self.index_cache or [])
            return
        if path == "/api/dict":
            q = parse_qs(parsed.query)
            w = q.get("w", [""])[0]
            d = q.get("dict", ["learners"])[0]
            self._serve_json(lookup_word(w, d))
            return
        if path == "/api/rebuild":
            Handler.index_cache = build_index(self.data_dir)
            self._serve_json({"ok": True, "count": len(Handler.index_cache)})
            return
        if path == "/api/me":
            self._api_me()
            return
        if path == "/api/progress":
            self._api_get_progress()
            return
        if path == "/api/vocab":
            self._api_get_vocab()
            return
        if path == "/api/admin/users":
            self._api_admin_users_get()
            return
        if path == "/api/admin/stats":
            self._api_admin_stats()
            return
        if path.startswith("/media/"):
            self._serve_media(path[len("/media/"):])
            return

        if path in ("/", "/index.html"):
            path = "/index.html"
        self._serve_static(path)

    # PUT 与 POST 使用同一套路由（/api/progress 全量保存用 PUT 语义）
    def do_PUT(self):
        self.do_POST()

    def do_POST(self):
        parsed = urlparse(self.path)
        path = parsed.path

        if path == "/api/setup":
            self._api_setup()
            return
        if path == "/api/login":
            self._api_login()
            return
        if path == "/api/logout":
            self._api_logout()
            return
        if path == "/api/progress":
            self._api_put_progress()
            return
        if path == "/api/vocab":
            self._api_post_vocab()
            return
        if path == "/api/vocab/delete":
            self._api_delete_vocab()
            return
        if path == "/api/vocab/bulk":
            self._api_bulk_vocab()
            return
        if path == "/api/activity":
            self._api_activity()
            return
        if path == "/api/admin/users":
            self._api_admin_users_post()
            return
        if path == "/api/admin/users/delete":
            self._api_admin_user_delete()
            return
        if path == "/api/admin/users/reset":
            self._api_admin_user_reset()
            return
        if path == "/api/admin/users/toggle":
            self._api_admin_user_toggle()
            return
        self._send_json(404, {"error": "not_found"})

    def _serve_json(self, data):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self._send_headers(200, {
            "Content-Type": "application/json; charset=utf-8",
            "Content-Length": str(len(body)),
            "Cache-Control": "no-store",
            "Access-Control-Allow-Origin": "*",
        })
        self.wfile.write(body)

    def _serve_static(self, path):
        rel = unquote(path).lstrip("/")
        full = self._safe_path(STATIC_DIR, rel)
        if not full or not os.path.isfile(full):
            self.send_error(404, "Not found: " + path)
            return
        mime = mimetypes.guess_type(full)[0] or "application/octet-stream"
        size = os.path.getsize(full)
        self._send_headers(200, {
            "Content-Type": mime,
            "Content-Length": str(size),
            "Cache-Control": "no-cache",
        })
        with open(full, "rb") as f:
            self._copyfile(f, size)

    def _serve_media(self, rel):
        full = self._safe_path(self.data_dir, rel)
        if not full or not os.path.isfile(full):
            self.send_error(404, "Media not found")
            return
        mime = mimetypes.guess_type(full)[0] or "application/octet-stream"
        size = os.path.getsize(full)
        rng = self.headers.get("Range")

        if rng:
            m = re.match(r"bytes=(\d+)-(\d*)$", rng)
            if m:
                start = int(m.group(1))
                end = int(m.group(2)) if m.group(2) else size - 1
                end = min(end, size - 1)
                if start > end:
                    self.send_error(416, "Range Not Satisfiable")
                    return
                length = end - start + 1
                self._send_headers(206, {
                    "Content-Type": mime,
                    "Content-Range": "bytes %d-%d/%d" % (start, end, size),
                    "Accept-Ranges": "bytes",
                    "Content-Length": str(length),
                    "Cache-Control": "no-cache",
                })
                with open(full, "rb") as f:
                    f.seek(start)
                    self._copyfile(f, length)
                return

        self._send_headers(200, {
            "Content-Type": mime,
            "Accept-Ranges": "bytes",
            "Content-Length": str(size),
            "Cache-Control": "no-cache",
        })
        with open(full, "rb") as f:
            self._copyfile(f, size)

    def _copyfile(self, f, remaining):
        while remaining > 0:
            chunk = f.read(min(65536, remaining))
            if not chunk:
                break
            try:
                self.wfile.write(chunk)
            except (BrokenPipeError, ConnectionResetError):
                break
            remaining -= len(chunk)


# ----------------------------------------------------------------------------
# 启动
# ----------------------------------------------------------------------------
def main():
    _db_init()
    print("用户数据文件: %s" % APP_DB)
    ap = argparse.ArgumentParser(description="English Pod 学习网页服务器")
    ap.add_argument("--data", default=os.environ.get("EP_DATA_DIR", DEFAULT_DATA_DIR),
                    help="数据目录 (english_pod-master)，也可用环境变量 EP_DATA_DIR")
    ap.add_argument("--port", type=int, default=int(os.environ.get("EP_PORT", "8787")), help="端口号")
    ap.add_argument("--host", default=os.environ.get("EP_HOST", "127.0.0.1"), help="监听地址")
    args = ap.parse_args()

    data_dir = os.path.expanduser(args.data)
    if not os.path.isdir(data_dir):
        print("错误: 数据目录不存在: %s" % data_dir)
        sys.exit(1)

    Handler.data_dir = data_dir
    print("正在扫描课程资料: %s" % data_dir)
    Handler.index_cache = build_index(data_dir)
    print("已建立索引，共 %d 个课程/音频集合" % len(Handler.index_cache))

    port = args.port
    httpd = None
    for attempt in range(10):
        try:
            httpd = ThreadingHTTPServer((args.host, port), Handler)
            break
        except OSError:
            port += 1
    if httpd is None:
        print("无法绑定端口")
        sys.exit(1)

    url = "http://%s:%d/" % (args.host, port)
    print("=" * 56)
    print("  English Pod 学习网页已启动")
    print("  请在浏览器打开: %s" % url)
    print("  停止服务: 在终端按 Ctrl+C")
    print("=" * 56)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\n服务已停止")


if __name__ == "__main__":
    main()
