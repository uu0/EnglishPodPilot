/* EnglishPodPilot - 前端逻辑（原型 UI + 真实后端 API） */
(function () {
  "use strict";

  // ================= 认证与 API =================
  var token = localStorage.getItem("ep_token") || "";
  var me = null;
  var heartTimer = null;

  function api(path, opts) {
    opts = opts || {};
    var headers = {};
    for (var k in (opts.headers || {})) headers[k] = opts.headers[k];
    if (token) headers["Authorization"] = "Bearer " + token;
    if (opts.body && typeof opts.body !== "string") {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    var fopts = { method: opts.method || "GET", headers: headers };
    if (opts.body) fopts.body = opts.body;
    return fetch(path, fopts).then(function (r) {
      if (r.status === 401) { handleAuthExpired(); throw new Error("unauthorized"); }
      return r.json().catch(function () { return {}; });
    });
  }

  // ================= 工具 =================
  function $(id) { return document.getElementById(id); }
  function loadJSON(key, def) {
    try { var v = JSON.parse(localStorage.getItem(key)); return v == null ? def : v; }
    catch (e) { return def; }
  }
  function saveJSON(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : "&quot;";
    });
  }
  var fmtTime = function (s) {
    if (!isFinite(s) || s < 0) s = 0;
    s = Math.floor(s);
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  var fmtDateTime = function (t) {
    var d = new Date(t), now = new Date();
    var hm = String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
    if (d.toDateString() === now.toDateString()) return "今天 " + hm;
    if (d.toDateString() === new Date(now - 86400000).toDateString()) return "昨天 " + hm;
    return (d.getMonth() + 1) + "/" + d.getDate() + " " + hm;
  };

  /* SVG 播放图标（替代 emoji，iOS 渲染更干净） */
  var ICONS = {
    play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M6 5h4v14H6zM14 5h4v14h-4z"/></svg>',
    repeat: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z"/></svg>',
    repeatOne: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4zm-4-2V9h-1l-2 1v1h1.5v4H12z"/></svg>',
    timer: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5"/><path d="M9 2h6"/></svg>'
  };
  var LIST_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';

  // ================= 状态 =================
  var LESSONS = [];
  var state = { series: "all", status: "all", query: "", vocab: [], currentLesson: null, currentWord: null };
  var completed = loadJSON("ep_completed", {});
  var positions = loadJSON("ep_positions", {});
  var stats = {
    plays: loadJSON("ep_plays", {}),
    seconds: parseInt(localStorage.getItem("ep_seconds") || "0", 10) || 0,
    history: loadJSON("ep_history", [])
  };

  var audio = $("audio");
  var player = { currentId: null, isPlaying: false, repeat: localStorage.getItem("ep_repeat") || "off" };
  var cues = [];          // 当前课程字幕 [{start,end,text}]
  var activeCue = -1;
  var transcriptTimer = null;

  var SERIES_NAME = { standard: "标准", DC: "DC", TJI: "TJI" };
  var SERIES_CLS = { standard: "beginner", DC: "intermediate", TJI: "upper" };

  var getLesson = function (id) { return LESSONS.filter(function (l) { return l.id === id; })[0]; };
  var isDone = function (l) { return !!completed[l.id]; };
  function lessonProgress(l) { return isDone(l) ? 100 : (positions[l.id] > 0 ? 30 : 0); }

  // ================= 服务端同步（localStorage 降级） =================
  function persistProgress() {
    saveJSON("ep_completed", completed);
    saveJSON("ep_positions", positions);
    if (!token) return;
    api("/api/progress", { method: "PUT", body: { completed: completed, positions: positions } }).catch(function () {});
  }
  function persistVocabWord(w, data) {
    if (!token) return;
    api("/api/vocab", { method: "POST", body: { word: w, data: data } }).catch(function () {});
  }
  function persistVocabDelete(w) {
    if (!token) return;
    api("/api/vocab/delete", { method: "POST", body: { word: w } }).catch(function () {});
  }
  function saveStats() {
    saveJSON("ep_plays", stats.plays);
    localStorage.setItem("ep_seconds", String(stats.seconds));
    saveJSON("ep_history", stats.history.slice(0, 60));
  }
  function recordPlay(id) {
    stats.plays[id] = (stats.plays[id] || 0) + 1;
    stats.history.unshift({ id: id, t: Date.now() });
    stats.history = stats.history.slice(0, 60);
    saveStats();
  }
  function startHeartbeat() {
    if (heartTimer) return;
    heartTimer = setInterval(function () {
      if (me && token && !audio.paused && audio.currentTime > 0) {
        api("/api/activity", { method: "POST", body: { seconds: 60 } }).catch(function () {});
      }
    }, 60000);
  }
  function stopHeartbeat() { if (heartTimer) { clearInterval(heartTimer); heartTimer = null; } }

  // ================= 课程加载 =================
  function loadLessons() {
    return fetch("/api/lessons")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        LESSONS = Array.isArray(data) ? data : [];
        $("lessonCountTxt").textContent = LESSONS.length + " 节课程";
        $("lessonCountSide").textContent = LESSONS.length;
        $("statTotal").textContent = LESSONS.length;
        renderLessons();
        var last = localStorage.getItem("ep_last");
        if (last && getLesson(last)) {
          // 恢复上次课程（不自动播放，只加载文本）
          loadTranscript(getLesson(last));
          player.currentId = last;
          renderPlayer();
          renderNowTranscript();
        }
      })
      .catch(function (e) {
        $("lessonCountTxt").textContent = "加载失败";
        $("lessonList").innerHTML = '<div class="empty-state"><div class="big">⚠️</div><p>无法加载课程列表<br>请确认后端服务已启动</p></div>';
        console.error(e);
      });
  }

  // ================= 字幕/文本解析 =================
  function parseSRT(text) {
    var out = [];
    var blocks = String(text).replace(/\r/g, "").split(/\n\s*\n/);
    blocks.forEach(function (b) {
      var lines = b.split("\n").filter(function (x) { return x.trim(); });
      if (lines.length < 2) return;
      var m = lines[1].match(/(\d+):(\d+):(\d+)[,.](\d+)\s*-->\s*(\d+):(\d+):(\d+)[,.](\d+)/);
      if (!m) return;
      var st = (+m[1]) * 3600 + (+m[2]) * 60 + (+m[3]) + (+m[4]) / 1000;
      var en = (+m[5]) * 3600 + (+m[6]) * 60 + (+m[7]) + (+m[8]) / 1000;
      var tx = lines.slice(2).join(" ").replace(/<[^>]+>/g, "").trim();
      if (tx) out.push({ start: st, end: en, text: tx });
    });
    return out;
  }
  function parseTxt(text) {
    return String(text).split("\n").map(function (x) { return x.trim(); })
      .filter(function (x) { return x; })
      .map(function (x) { return { start: -1, end: -1, text: x }; });
  }
  // 简单说话人识别："Name: 内容"
  function splitSpeaker(text) {
    var m = text.match(/^([A-Za-z][A-Za-z .'-]{1,20}):\s*(.+)$/);
    if (m) return { sp: m[1], text: m[2] };
    return { sp: "", text: text };
  }
  function tokenize(text) {
    return escapeHtml(text).split(/(\s+|[.,!?;:'"()—–-])/g).map(function (tok) {
      if (/^[A-Za-z'-]+$/.test(tok)) {
        var key = tok.toLowerCase().replace(/['-]$/, "");
        return '<span class="w" data-w="' + escapeHtml(key) + '">' + tok + "</span>";
      }
      return tok;
    }).join("");
  }

  var transcriptLoading = 0;
  function loadTranscript(l) {
    cues = []; activeCue = -1;
    var my = ++transcriptLoading;
    var done = function (list) {
      if (my !== transcriptLoading) return;
      cues = list;
      renderNowTranscript();
    };
    if (l.srt) {
      fetch(l.srt).then(function (r) { return r.text(); })
        .then(function (t) { done(parseSRT(t)); })
        .catch(function () { loadTxtFallback(l, done, my); });
    } else {
      loadTxtFallback(l, done, my);
    }
  }
  function loadTxtFallback(l, done, my) {
    if (!l.txt) { done([]); return; }
    fetch(l.txt).then(function (r) { return r.text(); })
      .then(function (t) { if (my === transcriptLoading) done(parseTxt(t)); })
      .catch(function () { if (my === transcriptLoading) done([]); });
  }

  // ================= 播放器 =================
  function trackUrl(l) {
    if (!l || !l.tracks || !l.tracks.length) return "";
    var t = l.tracks.filter(function (x) { return x.suffix === l.defaultTrack; })[0] || l.tracks[0];
    return t.url;
  }
  function playLesson(id, autoplay) {
    var l = getLesson(id);
    if (!l) return;
    var url = trackUrl(l);
    if (!url) return;
    stopTranscriptTimer();
    player.currentId = id;
    state.currentLesson = l;
    localStorage.setItem("ep_last", id);
    if (audio.getAttribute("src") !== url) audio.src = url;
    // 恢复上次进度
    if (positions[id] > 0 && Math.abs(audio.currentTime - positions[id]) > 2) {
      try { audio.currentTime = positions[id]; } catch (e) {}
    }
    recordPlay(id);
    loadTranscript(l);
    renderPlayer();
    renderLessons();
    if (autoplay !== false) {
      audio.play().then(function () {
        player.isPlaying = true;
        renderPlayer();
        startTranscriptTimer();
      }).catch(function () {
        player.isPlaying = false;
        renderPlayer();
      });
    } else {
      player.isPlaying = false;
      renderPlayer();
    }
  }
  function togglePlay() {
    if (!player.currentId) {
      var up = upNextLesson();
      if (up) { playLesson(up.id); switchView("view-now"); }
      return;
    }
    if (audio.paused) {
      audio.play().catch(function () {});
    } else {
      audio.pause();
    }
  }
  function upNextLesson() {
    return LESSONS.filter(function (l) { return !isDone(l); })[0] || LESSONS[0];
  }
  function nextInQueue(id) {
    var i = LESSONS.findIndex(function (l) { return l.id === id; });
    return LESSONS[i + 1] || null;
  }
  function prevInQueue(id) {
    var i = LESSONS.findIndex(function (l) { return l.id === id; });
    return LESSONS[i - 1] || null;
  }
  function stepNext() {
    if (!player.currentId) { var up = upNextLesson(); if (up) playLesson(up.id); return; }
    var n = nextInQueue(player.currentId);
    if (n) playLesson(n.id);
  }
  function stepPrev() {
    if (!player.currentId) return;
    if (audio.currentTime > 3) { audio.currentTime = 0; return; }
    var p = prevInQueue(player.currentId);
    if (p) playLesson(p.id);
  }
  function markDone(id) {
    completed[id] = true;
    delete positions[id];
    persistProgress();
    renderLessons();
    renderNowTranscript();
    $("statLessons").textContent = Object.keys(completed).length;
  }

  audio.addEventListener("play", function () { player.isPlaying = true; renderPlayer(); startTranscriptTimer(); });
  audio.addEventListener("pause", function () {
    player.isPlaying = false;
    renderPlayer();
    stopTranscriptTimer();
    if (player.currentId && isFinite(audio.currentTime)) {
      positions[player.currentId] = Math.floor(audio.currentTime);
      persistProgress();
    }
  });
  audio.addEventListener("loadedmetadata", renderPlayer);
  audio.addEventListener("ended", function () {
    if (player.currentId) markDone(player.currentId);
    if (player.repeat === "one" && player.currentId) {
      playLesson(player.currentId);
    } else {
      var nxt = player.currentId ? nextInQueue(player.currentId) : null;
      if (nxt) playLesson(nxt.id);
      else if (player.repeat === "all" && LESSONS.length) playLesson(LESSONS[0].id);
      else { player.isPlaying = false; renderPlayer(); }
    }
  });
  // 进度 + 字幕跟随（节流到每 500ms）
  var lastTick = 0;
  audio.addEventListener("timeupdate", function () {
    var now = Date.now();
    if (now - lastTick < 500) return;
    lastTick = now;
    var t = audio.currentTime || 0;
    stats.seconds += 0.5;
    updateProgressUI(t);
    updateActiveCue(t);
  });

  function startTranscriptTimer() {
    stopTranscriptTimer();
    transcriptTimer = setInterval(function () {
      if (audio.paused) return;
      var t = audio.currentTime || 0;
      stats.seconds += 1;
      updateProgressUI(t);
      updateActiveCue(t);
    }, 1000);
  }
  function stopTranscriptTimer() {
    if (transcriptTimer) { clearInterval(transcriptTimer); transcriptTimer = null; }
  }
  function durationOf() {
    var d = audio.duration;
    return isFinite(d) && d > 0 ? d : 0;
  }
  function updateProgressUI(t) {
    var d = durationOf();
    var pct = d ? Math.min(100, t / d * 100) : 0;
    var f = $("mpProgressFill");
    if (f) f.style.width = pct + "%";
    if (player.currentId) {
      var l = getLesson(player.currentId);
      var sub = $("mpSub");
      if (sub && l) sub.textContent = l.title + " · " + fmtTime(t) + (d ? " / " + fmtTime(d) : "");
    }
  }
  function updateActiveCue(t) {
    if (!cues.length || cues[0].start < 0) return;
    var idx = -1;
    for (var i = 0; i < cues.length; i++) {
      if (t >= cues[i].start && t <= cues[i].end + 0.4) { idx = i; break; }
    }
    if (idx === activeCue) return;
    activeCue = idx;
    var box = $("nowTranscript");
    if (!box) return;
    var turns = box.querySelectorAll(".turn");
    turns.forEach(function (el) { el.classList.remove("active"); });
    if (idx >= 0 && turns[idx]) {
      turns[idx].classList.add("active");
      if (player.isPlaying) {
        try { turns[idx].scrollIntoView({ block: "center", behavior: "smooth" }); } catch (e) {}
      }
    }
  }

  function renderPlayer() {
    var l = player.currentId ? getLesson(player.currentId) : null;
    var mp = $("miniPlayer");
    mp.classList.toggle("idle", !l);
    $("mpTitle").textContent = l ? l.title : "未在播放";
    if (l) updateProgressUI(audio.currentTime || 0);
    else $("mpSub").textContent = "去“播放”页选一节课";
    $("mpPlay").innerHTML = player.isPlaying ? ICONS.pause : ICONS.play;
  }

  // ================= 播放页正文 =================
  function renderNowTranscript() {
    var box = $("nowTranscript");
    var l = player.currentId ? getLesson(player.currentId) : null;
    activeCue = -1;
    if (!l) {
      box.innerHTML = '<div class="now-empty"><div class="big">🎧</div><p>还没有在播的课程<br>去课程页点一节，直接开播并显示原文</p><button id="emptyGo">去选课</button></div>';
      $("emptyGo").addEventListener("click", function () { switchView("view-home"); });
      return;
    }
    if (!cues.length) {
      box.innerHTML = '<div class="now-empty"><div class="big">📝</div><p>《' + escapeHtml(l.title) + '》暂无文本<br>可播放音频</p></div>';
      return;
    }
    box.innerHTML = cues.map(function (c) {
      var sp = splitSpeaker(c.text);
      return '<div class="turn">' +
        (sp.sp ? '<div class="speaker">' + escapeHtml(sp.sp) + "</div>" : "") +
        '<div class="line-en">' + tokenize(sp.text) + "</div>" +
        "</div>";
    }).join("") +
      '<button class="mark-done" id="doneBtn">' + (isDone(l) ? "✓ 已播完" : "标记为已播完") + "</button>";
    if (isDone(l)) $("doneBtn").classList.add("done");
    $("doneBtn").addEventListener("click", function () {
      markDone(l.id);
      this.textContent = "✓ 已播完";
      this.classList.add("done");
    });
    box.querySelectorAll(".w").forEach(function (w) {
      w.addEventListener("click", function (ev) { ev.stopPropagation(); openSheet(w); });
    });
  }

  function renderUpNext() {
    // 原型保留：接下来播放数据（页面隐藏，仅弹层使用 renderQueueList）
  }

  // ================= 课程列表 =================
  function renderLessons() {
    var list = $("lessonList");
    var q = state.query.trim().toLowerCase();
    var items = LESSONS.filter(function (l) {
      var okSeries = state.series === "all" || l.series === state.series;
      var okStatus = state.status === "all" ||
        (state.status === "played" && isDone(l)) ||
        (state.status === "unplayed" && !isDone(l));
      var okQ = !q || l.title.toLowerCase().indexOf(q) >= 0 || l.id.toLowerCase().indexOf(q) >= 0;
      return okSeries && okStatus && okQ;
    });
    if (!items.length) {
      list.innerHTML = '<div class="empty-state"><div class="big">🔍</div><p>没有找到匹配的课程<br>换个关键词或筛选试试</p></div>';
      return;
    }
    list.innerHTML = items.map(function (l) {
      var done = isDone(l);
      var tags = "";
      if (done) tags += '<div class="played-tag">✓ 已播</div>';
      if (player.currentId === l.id) tags += '<div class="played-tag" style="background:var(--accent-soft);color:var(--accent-deep)">▶ 在播</div>';
      var meta = "<span>" + SERIES_NAME[l.series] + "</span>";
      meta += "<span>" + l.tracks.length + " 音轨</span>";
      if (l.srt) meta += "<span>字幕</span>";
      else if (l.txt) meta += "<span>文本</span>";
      return '<div class="lesson-card" data-id="' + escapeHtml(l.id) + '">' + tags +
        '<span class="level ' + (SERIES_CLS[l.series] || "beginner") + '">' + SERIES_NAME[l.series] + "</span>" +
        "<h3>" + escapeHtml(l.title) + "</h3>" +
        '<div class="en-title">' + escapeHtml(l.id) + "</div>" +
        '<div class="meta">' + meta + "</div>" +
        (stats.plays[l.id] ? '<div class="play-count">▶ 已播 ' + stats.plays[l.id] + " 次</div>" : "") +
        "</div>";
    }).join("");
    list.querySelectorAll(".lesson-card").forEach(function (c) {
      c.addEventListener("click", function () { playLesson(c.dataset.id); switchView("view-now"); });
    });
  }

  // ================= 循环 / 定时 / 中英 =================
  function renderRepeatBtn() {
    var b = $("nowRepeat");
    if (b) {
      b.innerHTML = player.repeat === "one" ? ICONS.repeatOne : ICONS.repeat;
      b.classList.toggle("active", player.repeat !== "off");
    }
    renderMpRepeat();
  }
  function cycleRepeat() {
    player.repeat = player.repeat === "off" ? "one" : player.repeat === "one" ? "all" : "off";
    localStorage.setItem("ep_repeat", player.repeat);
    renderRepeatBtn();
  }
  function renderMpRepeat() {
    var b = $("mpRepeat");
    if (!b) return;
    b.innerHTML = player.repeat === "one" ? ICONS.repeatOne : ICONS.repeat;
    b.classList.toggle("active", player.repeat !== "off");
  }
  var SLEEP_STEPS = [0, 15, 30, 60, 90];
  var sleepMin = 0, sleepTO = null;
  function renderMpTimer() {
    var b = $("mpTimer");
    if (!b) return;
    b.innerHTML = sleepMin ? '<span style="font-size:13px">' + sleepMin + "</span>" : ICONS.timer;
    b.classList.toggle("active", sleepMin > 0);
    b.title = sleepMin ? "定时 " + sleepMin + " 分钟后暂停" : "定时";
  }
  function renderMpLang() {
    var b = $("mpLang");
    if (b) b.classList.toggle("active", document.body.classList.contains("show-zh"));
  }

  // ================= 接下来播放弹层 =================
  function openQueue() {
    renderQueueList();
    $("queueSheet").classList.add("show");
    $("queueMask").classList.add("show");
  }
  function closeQueue() {
    $("queueSheet").classList.remove("show");
    $("queueMask").classList.remove("show");
  }
  function renderQueueList() {
    var box = $("queueList");
    var cur = player.currentId;
    var items = LESSONS.filter(function (l) { return l.id !== cur && !isDone(l); }).slice(0, 10);
    if (!items.length) {
      box.innerHTML = '<div class="empty-state" style="padding:24px"><p>全部播完，太棒了 🎉</p></div>';
      return;
    }
    box.innerHTML = items.map(function (l, i) {
      return '<div class="upnext-item" data-qplay="' + escapeHtml(l.id) + '">' +
        '<div class="upnext-num">' + (i + 1) + "</div>" +
        '<div class="upnext-info"><b>' + escapeHtml(l.title) + "</b><span>" + SERIES_NAME[l.series] +
        (stats.plays[l.id] ? " · 已播 " + stats.plays[l.id] + " 次" : "") + "</span></div>" +
        '<button class="upnext-play" data-qplay="' + escapeHtml(l.id) + '" aria-label="播放">' + ICONS.play + "</button>" +
        "</div>";
    }).join("");
  }

  // ================= 查词弹层 =================
  var sheet = $("sheet"), mask = $("sheetMask");
  function openSheet(wEl) {
    document.querySelectorAll(".w.lookup").forEach(function (x) { x.classList.remove("lookup"); });
    wEl.classList.add("lookup");
    var key = wEl.dataset.w;
    state.currentWord = key;
    $("sheetWord").textContent = wEl.textContent;
    $("sheetPhonetic").textContent = "…";
    $("sheetDefs").innerHTML = '<div class="def" style="color:var(--ink-3)">查词中…</div>';
    $("sheetExample").style.display = "none";
    var saved = state.vocab.some(function (v) { return v.w === key; });
    var btn = $("saveWordBtn");
    btn.textContent = saved ? "✓ 已在生词本" : "＋ 加入生词本";
    btn.classList.toggle("saved", saved);
    sheet.classList.add("show"); mask.classList.add("show");
    // 先 learners，失败降级 ecdict
    api("/api/dict?w=" + encodeURIComponent(key) + "&dict=learners").then(function (res) {
      if (res && res.defs && res.defs.length) { renderDictEntry(key, res); return; }
      return api("/api/dict?w=" + encodeURIComponent(key) + "&dict=ecdict").then(function (r2) {
        renderDictEntry(key, r2 || { defs: [] });
      });
    }).catch(function () {
      renderDictEntry(key, { defs: [] });
    });
  }
  function renderDictEntry(key, res) {
    if (state.currentWord !== key) return;
    $("sheetPhonetic").textContent = res.phonetic || "—";
    if (res && res.defs && res.defs.length) {
      $("sheetDefs").innerHTML = res.defs.map(function (d) {
        return '<div class="pos">' + escapeHtml(d.pos || "") + '</div><div class="def">' + escapeHtml(d.def || "") + "</div>";
      }).join("");
      var ex = res.defs.filter(function (d) { return d.example; })[0];
      var exEl = $("sheetExample");
      if (ex && ex.example) { exEl.innerHTML = "📌 " + escapeHtml(ex.example); exEl.style.display = ""; }
      else exEl.style.display = "none";
    } else {
      var sug = (res && res.suggestions) ? "你是不是想查：" + res.suggestions.slice(0, 5).join("、") : "未找到该词的释义。";
      $("sheetDefs").innerHTML = '<div class="def" style="color:var(--ink-3)">' + escapeHtml(sug) + "</div>";
      $("sheetExample").style.display = "none";
    }
  }
  function closeSheet() {
    sheet.classList.remove("show"); mask.classList.remove("show");
    document.querySelectorAll(".w.lookup").forEach(function (x) { x.classList.remove("lookup"); });
  }

  // ================= 生词本 =================
  function updateVocabBadges() {
    ["vocabBadge", "vocabBadgeSide", "vocabBadgeMenu"].forEach(function (id) {
      var badge = $(id);
      if (!badge) return;
      if (state.vocab.length) { badge.style.display = ""; badge.textContent = state.vocab.length; }
      else badge.style.display = "none";
    });
  }
  function renderVocab() {
    var list = $("vocabList");
    updateVocabBadges();
    $("statWords").textContent = state.vocab.length;
    $("vocabSub").textContent = state.vocab.length ? "已收藏 " + state.vocab.length + " 个生词" : "点词保存，随时回来复习";
    if (!state.vocab.length) {
      list.innerHTML = '<div class="empty-state"><div class="big">🔖</div><p>还没有收藏生词<br>去播放页点任意单词试试</p></div>';
      return;
    }
    list.innerHTML = state.vocab.map(function (v) {
      return '<div class="vocab-card">' +
        '<div class="vw">' + escapeHtml(v.w) + "</div>" +
        '<div class="vp">' + escapeHtml(v.ph || "") + "</div>" +
        '<div class="vd">' + escapeHtml(v.d || "") + "</div>" +
        (v.from ? '<div class="from">来自《' + escapeHtml(v.from) + "》</div>" : "") +
        '<button class="vocab-del" data-del="' + escapeHtml(v.w) + '" aria-label="删除">✕</button>' +
        "</div>";
    }).join("");
    list.querySelectorAll("[data-del]").forEach(function (b) {
      b.addEventListener("click", function (ev) {
        ev.stopPropagation();
        removeVocab(b.dataset.del);
      });
    });
  }
  function saveVocabLocal() { saveJSON("ep_vocab_arr", state.vocab); }
  function addVocab(entry) {
    if (state.vocab.some(function (v) { return v.w === entry.w; })) return;
    state.vocab.unshift(entry);
    saveVocabLocal();
    persistVocabWord(entry.w, { ph: entry.ph, d: entry.d, from: entry.from });
    renderVocab();
  }
  function removeVocab(w) {
    state.vocab = state.vocab.filter(function (v) { return v.w !== w; });
    saveVocabLocal();
    persistVocabDelete(w);
    renderVocab();
  }
  function loadVocab() {
    var local = loadJSON("ep_vocab_arr", []);
    if (token) {
      return api("/api/vocab").then(function (res) {
        var words = (res && res.words) || {};
        var keys = Object.keys(words);
        if (keys.length) {
          state.vocab = keys.map(function (k) {
            var d = words[k] || {};
            return { w: k, ph: d.ph || "", d: d.d || "", from: d.from || "" };
          });
        } else if (local.length) {
          state.vocab = local;
          // 本地有、服务端空：一次性上传
          local.forEach(function (v) { persistVocabWord(v.w, { ph: v.ph, d: v.d, from: v.from }); });
        } else {
          state.vocab = [];
        }
        saveVocabLocal();
        renderVocab();
      }).catch(function () {
        state.vocab = local;
        renderVocab();
      });
    }
    state.vocab = local;
    renderVocab();
    return Promise.resolve();
  }

  // ================= 统计 =================
  function renderStats() {
    var totalPlays = Object.keys(stats.plays).reduce(function (a, k) { return a + stats.plays[k]; }, 0);
    var doneCount = Object.keys(completed).length;
    $("stPlays").textContent = totalPlays;
    $("stDone").textContent = doneCount;
    $("stMinutes").textContent = Math.round(stats.seconds / 60);
    $("stWords").textContent = state.vocab.length;
    $("statLessons").textContent = doneCount;

    var ranked = Object.keys(stats.plays).map(function (id) {
      return { l: getLesson(id), c: stats.plays[id] };
    }).filter(function (x) { return x.l; }).sort(function (a, b) { return b.c - a.c; }).slice(0, 10);
    $("rankList").innerHTML = ranked.length ? ranked.map(function (x, i) {
      return '<div class="rank-item"><div class="rank-num">' + (i + 1) + '</div>' +
        '<div class="rank-info"><b>' + escapeHtml(x.l.title) + "</b><span>" + SERIES_NAME[x.l.series] + "</span></div>" +
        '<div class="rank-count">▶ ' + x.c + " 次</div></div>";
    }).join("") : '<div class="empty-state" style="padding:24px"><p>还没有播放记录</p></div>';

    $("historyList").innerHTML = stats.history.length ? stats.history.slice(0, 12).map(function (h) {
      var l = getLesson(h.id);
      return l ? '<div class="history-item"><div class="dot"></div><div class="ht">' + escapeHtml(l.title) +
        '</div><div class="htime">' + fmtDateTime(h.t) + "</div></div>" : "";
    }).join("") : '<div class="empty-state" style="padding:24px"><p>还没有播放记录</p></div>';
  }

  // ================= 导航 =================
  function switchView(viewId) {
    document.querySelectorAll(".tab").forEach(function (x) { x.classList.toggle("active", x.dataset.view === viewId); });
    document.querySelectorAll(".side-tab").forEach(function (x) { x.classList.toggle("active", x.dataset.view === viewId); });
    document.querySelectorAll(".menu-item-nav").forEach(function (x) { x.classList.toggle("active", x.dataset.view === viewId); });
    document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("active"); });
    $(viewId).classList.add("active");
    $("menuDropdown").classList.remove("open");
    $("miniPlayer").classList.remove("hidden");
    if (viewId === "view-stats") renderStats();
    if (viewId === "view-me") renderAuthArea();
    window.scrollTo(0, 0);
  }

  // ================= 登录 =================
  function renderAuthArea() {
    var box = $("authArea");
    if (!box) return;
    if (me) {
      box.innerHTML = '<div class="auth-user"><div><div class="nm">' + escapeHtml(me.username) + '</div>' +
        '<div class="rl">' + (me.role === "admin" ? "管理员" : "学习者") + '</div></div>' +
        '<button id="logoutBtn">退出</button></div>';
      $("logoutBtn").addEventListener("click", logout);
      var mh = document.querySelector("#view-me .me-head h2");
      if (mh) mh.textContent = me.username;
    } else {
      box.innerHTML = '<div class="auth-card"><h3>登录</h3>' +
        '<input id="authUser" placeholder="用户名" autocomplete="username">' +
        '<input id="authPass" type="password" placeholder="密码" autocomplete="current-password">' +
        '<button class="auth-btn" id="authBtn">登录</button>' +
        '<div class="auth-err" id="authErr"></div></div>';
      var go = function () { submitAuth(); };
      $("authBtn").addEventListener("click", go);
      $("authPass").addEventListener("keydown", function (e) { if (e.key === "Enter") go(); });
    }
  }
  function submitAuth() {
    var u = $("authUser").value.trim(), p = $("authPass").value;
    if (!u || !p) { $("authErr").textContent = "请填写用户名和密码"; return; }
    fetch("/api/login", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p })
    }).then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.status === 200 && res.data.token) {
          token = res.data.token;
          me = res.data.user;
          localStorage.setItem("ep_token", token);
          startHeartbeat();
          renderAuthArea();
          loadServerData();
        } else {
          $("authErr").textContent = (res.data && res.data.error) || "登录失败，请重试";
        }
      })
      .catch(function () { $("authErr").textContent = "网络错误，请检查服务是否运行"; });
  }
  function logout() {
    api("/api/logout", { method: "POST" }).catch(function () {});
token = "";
    me = null;
    localStorage.removeItem("ep_token");
    stopHeartbeat();
    renderAuthArea();
  }
  function handleAuthExpired() {
    if (!me) return;
token = "";
    me = null;
    localStorage.removeItem("ep_token");
    stopHeartbeat();
    renderAuthArea();
  }
  function loadServerData() {
    var ps = [
      api("/api/progress").then(function (p) {
        if (p && (Object.keys(p.completed || {}).length || Object.keys(p.positions || {}).length)) {
          completed = p.completed || {};
          positions = p.positions || {};
          persistProgress();
        } else {
          var lc = loadJSON("ep_completed", {}), lp = loadJSON("ep_positions", {});
          if (Object.keys(lc).length || Object.keys(lp).length) {
            completed = lc; positions = lp;
            persistProgress();
          }
        }
      }).catch(function () {}),
      loadVocab()
    ];
    return Promise.all(ps).then(function () {
      renderLessons();
      renderNowTranscript();
      $("statLessons").textContent = Object.keys(completed).length;
    });
  }
  function checkMe() {
    if (!token) { renderAuthArea(); return; }
    api("/api/me").then(function (res) {
      if (res && res.user) {
        me = res.user;
        startHeartbeat();
        loadServerData();
      } else {
        handleAuthExpired();
      }
      renderAuthArea();
    }).catch(function () { renderAuthArea(); });
  }

  // ================= 事件绑定 =================
  function bindEvents() {
    // 导航
    document.querySelectorAll(".tab, .side-tab, .menu-item-nav").forEach(function (t) {
      t.addEventListener("click", function () { switchView(t.dataset.view); });
    });
    document.querySelectorAll(".menu-btn").forEach(function (b) {
      b.addEventListener("click", function (e) {
        e.stopPropagation();
        $("menuDropdown").classList.toggle("open");
      });
    });
    document.addEventListener("click", function (e) {
      if (!$("menuDropdown").contains(e.target)) $("menuDropdown").classList.remove("open");
    });
    // 桌面端侧边栏折叠
    $("sideCollapse").addEventListener("click", function () { document.body.classList.add("sidebar-collapsed"); });
    $("sideExpand").addEventListener("click", function () { document.body.classList.remove("sidebar-collapsed"); });

    // 播放条
    $("mpPlay").addEventListener("click", function (ev) { ev.stopPropagation(); togglePlay(); });
    $("mpPrev").addEventListener("click", function (ev) { ev.stopPropagation(); stepPrev(); });
    $("mpNext").addEventListener("click", function (ev) { ev.stopPropagation(); stepNext(); });
    $("mpInfo").addEventListener("click", function () { switchView("view-now"); });
    $("mpLang").addEventListener("click", function () {
      document.body.classList.toggle("show-zh");
      renderMpLang();
    });
    $("mpTimer").addEventListener("click", function () {
      clearTimeout(sleepTO); sleepTO = null;
      var i = SLEEP_STEPS.indexOf(sleepMin);
      sleepMin = SLEEP_STEPS[(i + 1) % SLEEP_STEPS.length];
      if (sleepMin > 0) {
        sleepTO = setTimeout(function () {
          audio.pause();
          sleepMin = 0; renderMpTimer();
        }, sleepMin * 60000);
      }
      renderMpTimer();
    });
    $("mpRepeat").addEventListener("click", cycleRepeat);
    $("mpQueue").addEventListener("click", function (e) { e.stopPropagation(); openQueue(); });
    $("queueMask").addEventListener("click", closeQueue);
    $("queueList").addEventListener("click", function (e) {
      var t = e.target.closest("[data-qplay]");
      if (!t) return;
      closeQueue();
      playLesson(t.dataset.qplay);
      switchView("view-now");
    });

    // 顶部播放器（隐藏但保留绑定，防 null）
    var np = $("nowPlay"); if (np) np.addEventListener("click", togglePlay);
    var npr = $("nowPrev"); if (npr) npr.addEventListener("click", stepPrev);
    var nnx = $("nowNext"); if (nnx) nnx.addEventListener("click", stepNext);
    var nrp = $("nowRepeat"); if (nrp) nrp.addEventListener("click", cycleRepeat);

    // 课程筛选
    $("filters").addEventListener("click", function (e) {
      var b = e.target.closest(".chip"); if (!b) return;
      document.querySelectorAll("#filters .chip").forEach(function (c) { c.classList.remove("active"); });
      b.classList.add("active");
      state.series = b.dataset.series;
      renderLessons();
    });
    $("statusFilter").addEventListener("click", function (e) {
      var b = e.target.closest(".chip"); if (!b) return;
      document.querySelectorAll("#statusFilter .chip").forEach(function (c) { c.classList.remove("active"); });
      b.classList.add("active");
      state.status = b.dataset.status;
      renderLessons();
    });
    $("searchToggle").addEventListener("click", function () {
      var ex = $("searchExpand");
      ex.classList.toggle("open");
      if (ex.classList.contains("open")) $("searchInput").focus();
    });
    $("searchInput").addEventListener("input", function (e) {
      state.query = e.target.value;
      renderLessons();
    });

    // 查词弹层
    mask.addEventListener("click", closeSheet);
    $("saveWordBtn").addEventListener("click", function () {
      var key = state.currentWord;
      if (!key) return;
      var i = state.vocab.findIndex(function (v) { return v.w === key; });
      var btn = $("saveWordBtn");
      if (i >= 0) {
        removeVocab(key);
        btn.textContent = "＋ 加入生词本"; btn.classList.remove("saved");
      } else {
        addVocab({
          w: key,
          ph: $("sheetPhonetic").textContent === "—" ? "" : $("sheetPhonetic").textContent,
          d: $("sheetDefs").textContent.slice(0, 120),
          from: state.currentLesson ? state.currentLesson.title : ""
        });
        btn.textContent = "✓ 已在生词本"; btn.classList.add("saved");
      }
    });

    // 译文开关（播放页隐藏，保留同步）
    var zt = $("zhToggle");
    if (zt) zt.addEventListener("click", function () {
      this.classList.toggle("on");
      document.body.classList.toggle("show-zh");
      renderMpLang();
    });

    // 每 30 秒保存一次进度
    setInterval(function () {
      if (player.currentId && !audio.paused && isFinite(audio.currentTime)) {
        positions[player.currentId] = Math.floor(audio.currentTime);
        persistProgress();
      }
    }, 30000);
  }

  // ================= 初始化 =================
  function init() {
    bindEvents();
    renderRepeatBtn();
    renderMpTimer();
    renderMpLang();
    renderPlayer();
    $("miniPlayer").classList.remove("hidden");
    renderNowTranscript();
    renderVocab();
    $("statLessons").textContent = Object.keys(completed).length;
    checkMe();
    loadLessons().then(loadVocab);
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
