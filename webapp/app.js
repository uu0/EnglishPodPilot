/* English Pod 学习器 - 前端逻辑 */
(function () {
  "use strict";

  // ---------- 状态 ----------
  var ALL = [];
  var view = [];
  var current = null;
  var currentTrack = null;
  var cues = [];
  var activeCue = -1;
  var abLoop = null;
  var vocabSearch = "";
  var vocabLessonFilter = "all";
  var completed = loadJSON("ep_completed", {});
  var positions = loadJSON("ep_positions", {});
  var vocab = loadJSON("ep_vocab", {});
  var lastLesson = localStorage.getItem("ep_last");
  var theme = localStorage.getItem("ep_theme") || "light";
  // 播放控制：循环模式（off 顺序停止 / all 列表循环 / one 单课循环 / shuffle 随机）
  var loopMode = localStorage.getItem("ep_loop") || "off";
  var sleepEndAt = 0;      // 定时停止的截止时间戳（ms），0 = 未激活
  var sleepTimer = null;   // 每秒倒计时的 interval

  // ---------- 多用户认证状态 ----------
  var token = localStorage.getItem("ep_token") || "";
  var me = null;          // {id, username, role}
  var authMode = "login"; // "login" | "setup"
  var heartTimer = null;

  // ---------- DOM ----------
  var $ = function (id) { return document.getElementById(id); };
  var audio = $("audio");
  var listEl = $("lessonList");
  var listEmpty = $("listEmpty");
  var popup = $("wordPopup");

  // ---------- 工具 ----------
  function loadJSON(key, def) {
    try { return JSON.parse(localStorage.getItem(key)) || def; }
    catch (e) { return def; }
  }
  function saveJSON(key, val) { localStorage.setItem(key, JSON.stringify(val)); }

  // ---------- 服务端 API（带登录 token；401 时回到登录界面） ----------
  function api(path, opts) {
    opts = opts || {};
    var headers = Object.assign({}, opts.headers || {});
    if (token) headers["Authorization"] = "Bearer " + token;
    if (opts.body && typeof opts.body !== "string") {
      headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(opts.body);
    }
    return fetch(path, Object.assign({}, opts, { headers: headers }))
      .then(function (r) {
        if (r.status === 401) { handleAuthExpired(); throw new Error("unauthorized"); }
        return r.json().catch(function () { return {}; });
      });
  }
  // 进度/生词的服务端持久化（内存对象仍是前端权威，写操作同步到服务器）
  function persistProgress() {
    if (!token) return Promise.resolve();
    return api("/api/progress", { method: "PUT", body: { completed: completed, positions: positions } })
      .catch(function () {});
  }
  function persistVocabWord(w) {
    if (!token || !vocab[w]) return Promise.resolve();
    return api("/api/vocab", { method: "POST", body: { word: w, data: vocab[w] } }).catch(function () {});
  }
  function persistVocabDelete(w) {
    if (!token) return Promise.resolve();
    return api("/api/vocab/delete", { method: "POST", body: { word: w } }).catch(function () {});
  }
  function persistVocabBulk(words) {
    if (!token) return Promise.resolve();
    return api("/api/vocab/bulk", { method: "POST", body: { words: words } }).catch(function () {});
  }

  function fmt(t) {
    if (!isFinite(t)) t = 0;
    t = Math.max(0, Math.floor(t));
    var h = Math.floor(t / 3600);
    var m = Math.floor((t % 3600) / 60);
    var s = t % 60;
    var mm = (m < 10 ? "0" : "") + m;
    var ss = (s < 10 ? "0" : "") + s;
    return (h > 0 ? h + ":" + mm : mm) + ":" + ss;
  }
  function escapeHtml(s) {
    return s.replace(/[&<>]/g, function (c) {
      return c === "&" ? "&amp;" : c === "<" ? "&lt;" : "&gt;";
    });
  }
  // 将文本中的英文单词包成可交互的 <span class="word">
  function highlightHTML(text) {
    var esc = escapeHtml(text);
    return esc.replace(/([A-Za-z][A-Za-z'\u2019-]*)/g, function (m) {
      return '<span class="word" data-w="' + m.toLowerCase() + '">' + m + "</span>";
    });
  }
  function isVocab(w) { return Object.prototype.hasOwnProperty.call(vocab, w); }

  // ---------- 词典（经后端 /api/dict 代理，密钥不暴露在前端）----------
  // 三个标签页：学习词典 / 大学词典（Merriam-Webster 在线）、英汉词典（ECDICT 离线）。
  // 结果缓存到 localStorage（ep_dict），离线后也能复用；查不到/离线时优雅降级。
  var DICTS = [
    { id: "learners", label: "学习词典" },
    { id: "collegiate", label: "大学词典" },
    { id: "ecdict", label: "英汉词典" }
  ];
  var popupWord = "";
  var popupDict = "learners";
  var lastPopupSp = null;
  var dictCache = loadJSON("ep_dict", {});

  function lookupDict(word, dictId) {
    word = (word || "").toLowerCase();
    dictId = dictId || "learners";
    if (!word) return Promise.resolve(null);
    var key = dictId + "::" + word;
    if (Object.prototype.hasOwnProperty.call(dictCache, key)) return Promise.resolve(dictCache[key]);
    return fetch("/api/dict?w=" + encodeURIComponent(word) + "&dict=" + encodeURIComponent(dictId))
      .then(function (r) { if (!r.ok) throw new Error("notfound"); return r.json(); })
      .then(function (res) {
        dictCache[key] = res || null;
        saveJSON("ep_dict", dictCache);
        return res || null;
      })
      .catch(function () { return null; });
  }

  function dictTabsHtml(activeId) {
    return '<div class="wp-dict-tabs">' + DICTS.map(function (d) {
      return '<button class="wp-dict-tab' + (d.id === activeId ? " active" : "") + '" data-dict="' + d.id + '">' +
        d.label + "</button>";
    }).join("") + "</div>";
  }

  // 查询条：输入框 + 查询按钮，默认值为当前词；可手动改成任意单词或词组（如 give up）回车重查。
  // 词组判断：查不到时的兜底词典优先级见 doQuery 中的自动切换逻辑。
  function dictHeadHtml(word, activeId) {
    return '<div class="wp-qbar">' +
      '<input id="wpQ" class="wp-qinput" value="' + escapeHtml(word) + '" ' +
      'placeholder="查单词或词组，如 give up" spellcheck="false" autocomplete="off" />' +
      '<button id="wpQGo" class="wp-qgo" type="button">查询</button></div>' +
      dictTabsHtml(activeId);
  }

  function bindQueryBar() {
    var q = $("wpQ"), go = $("wpQGo");
    if (!q || !go) return;
    function doQuery() {
      var v = (q.value || "").trim().toLowerCase();
      if (!v) return;
      if (v === popupWord) { q.value = popupWord; return; } // 相同词不做重复查询
      popupWord = v;
      // 词组（含空格）优先用离线英汉词典：ECDICT 内置 36 万词组词头，覆盖比在线 learners 全
      if (popupDict === "learners" && v.indexOf(" ") >= 0) popupDict = "ecdict";
      var inp = $("wpInput");
      if (inp) inp.value = ""; // 换了查询词，清掉旧词自动释义，等新结果回填
      initDictBox(popupWord, popupDict);
    }
    go.onclick = function (e) { e.stopPropagation(); doQuery(); };
    q.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); doQuery(); }
      else if (e.key === "Escape") { e.stopPropagation(); hidePopup(); }
    });
  }

  function sugBtns(words, dictId) {
    return words.map(function (s) {
      return '<button class="wp-sug-btn" data-dict="' + dictId + '" data-w="' + escapeHtml(s) + '">' +
        escapeHtml(s) + "</button>";
    }).join(" ");
  }

  function dictBodyHtml(res, dictId) {
    if (!res) return '<span class="wp-note">未找到释义（可能离线，或单词为专有名词/拼写变体）。可在下方手动输入。</span>';
    if (res.error === "dictionary_not_configured") {
      return '<span class="wp-note">在线词典未配置：请在 config.json 或环境变量 MW_LEARNERS_KEY / MW_DICT_KEY 中填入 Merriam-Webster API key。</span>';
    }
    if (res.error === "dictionary_not_available") {
      return '<span class="wp-note">离线英汉词典不可用：缺少 dict/ecdict.csv。请从 github.com/skywind3000/ECDICT 下载词库（约 66MB）放入 dict/ 目录后重启服务，首次启动会自动构建索引。</span>';
    }
    if (res.suggestions && res.suggestions.length && !(res.defs && res.defs.length)) {
      return '<div class="wp-note">未找到精确匹配，您是否想查：</div>' +
        '<div class="wp-sug">' + sugBtns(res.suggestions.slice(0, 12), dictId) + "</div>";
    }
    if (!res.defs || !res.defs.length) return '<span class="wp-note">未找到释义。可修改上方查询框重查其他单词或词组。</span>';
    var html = "";
    if (res.phonetic) html += '<div class="wp-phon">/' + escapeHtml(res.phonetic) + "/</div>";
    res.defs.forEach(function (d) {
      html += '<div class="wp-mean"><span class="wp-pos">' + escapeHtml(d.pos || "") + "</span> " +
        escapeHtml(d.def) +
        (d.example ? ' <span class="wp-dex">“' + escapeHtml(d.example) + '”</span>' : "") + "</div>";
    });
    if (dictId === "ecdict") {
      // 英文释义（若有）
      if (res.en && res.en.length) {
        html += '<div class="wp-en"><span class="wp-en-label">英文释义</span>' +
          res.en.map(function (s) { return '<div class="wp-en-line">' + escapeHtml(s) + "</div>"; }).join("") +
          "</div>";
      }
      // 标签 / 词频
      var chips = [];
      if (res.pos) chips.push('<span class="wp-chip">' + escapeHtml(res.pos) + "</span>");
      (res.tags || []).forEach(function (t) { chips.push('<span class="wp-chip">' + escapeHtml(t) + "</span>"); });
      if (res.collins) chips.push('<span class="wp-chip">柯林斯 ' + escapeHtml(res.collins) + "★</span>");
      if (res.oxford) chips.push('<span class="wp-chip">牛津3000</span>');
      if (res.bnc) chips.push('<span class="wp-chip">BNC ' + escapeHtml(res.bnc) + "</span>");
      if (res.frq) chips.push('<span class="wp-chip">COCA ' + escapeHtml(res.frq) + "</span>");
      if (chips.length) html += '<div class="wp-chips">' + chips.join("") + "</div>";
      // 词形变化（点击可再查）
      var exch = res.exchange || {};
      var exParts = [];
      ["过去式", "过去分词", "现在分词", "第三人称单数", "比较级", "最高级", "复数"].forEach(function (k) {
        if (exch[k]) exParts.push(k + " " + exch[k]);
      });
      if (exParts.length) {
        html += '<div class="wp-exch"><span class="wp-en-label">词形</span> ' + exParts.map(function (s) {
          var i = s.indexOf(" "), label = s.slice(0, i), w = s.slice(i + 1);
          return '<button class="wp-sug-btn" data-dict="ecdict" data-w="' + escapeHtml(w) + '">' + escapeHtml(s) + "</button>";
        }).join(" ") + "</div>";
      }
    }
    return html;
  }

  // 在弹窗里初始化词典区（含查询条 + 标签页）。manualDef 为用户自存的手动释义（若有）。
  function initDictBox(word, dictId, manualDef) {
    popupWord = word;
    popupDict = dictId;
    var box = $("wpDict");
    if (!box) return;
    box.innerHTML = dictHeadHtml(word, dictId) + '<div class="wp-dict-body">' +
      (manualDef ? '<div class="wp-manual">📝 手动释义：' + escapeHtml(manualDef) + "</div>" : "") +
      '<span class="wp-loading">查询释义中…</span></div>';
    bindQueryBar();
    fillDictTab(word, dictId);
  }

  function switchDictTab(dictId) {
    if (!popupWord) return;
    initDictBox(popupWord, dictId); // 重建查询条 + 标签页 + 内容（manual 释义不跨 tab 保留，与旧行为一致）
  }

  function fillDictTab(word, dictId) {
    lookupDict(word, dictId).then(function (res) {
      var box = $("wpDict");
      if (!box || popupWord !== word || popupDict !== dictId) return; // 已切走则丢弃
      var body = box.querySelector(".wp-dict-body");
      if (!body) return;
      body.innerHTML = dictBodyHtml(res, dictId);
      // 新增生词时，第一个返回的释义自动填入输入框（用户可编辑）
      var inp = $("wpInput");
      if (inp && !inp.value && res && res.defs && res.defs.length) {
        inp.value = res.defs.map(function (d) { return (d.pos ? d.pos + ". " : "") + d.def; }).join("; ");
      }
      if (lastPopupSp) positionPopup(lastPopupSp);
    });
  }

  // 抓取某个单词所在的整句（用于生词例句）。字幕里取所在 cue 文本；文本稿里按句号/问号/感叹号/换行切句。
  function sentenceAround(sp) {
    if (sp.closest) {
      var cue = sp.closest(".cue");
      if (cue) {
        var c = cue.cloneNode(true);
        var ct = c.querySelector(".ct");
        if (ct) ct.remove();
        return (c.textContent || "").replace(/\s+/g, " ").trim();
      }
    }
    var panel = sp.closest ? sp.closest("#transcriptPanel") : null;
    if (!panel) return "";
    var text = panel.textContent || "";
    var w = sp.dataset.w || "";
    var lower = text.toLowerCase();
    var i = lower.indexOf(w);
    if (i < 0) return "";
    function isB(ch) { return ch === "." || ch === "!" || ch === "?" || ch === "\n"; }
    var s = i;
    while (s > 0 && !isB(text[s - 1])) s--;
    var e = i;
    while (e < text.length && !isB(text[e])) e++;
    return text.slice(s, e).replace(/\s+/g, " ").trim();
  }

  // ---------- 认证 / 用户界面 ----------
  function showAuth(mode) {
    authMode = mode || "login";
    $("authModal").classList.remove("hidden");
    var setup = authMode === "setup";
    $("authTitle").textContent = setup ? "🎧 首次部署：创建管理员" : "🎧 English Pod 学习器";
    $("authSub").textContent = setup
      ? "系统尚无账号。请设置管理员用户名和密码，之后由管理员在后台添加其他用户。"
      : "账号由管理员分配，不支持自助注册。";
    $("authUser").placeholder = setup ? "管理员用户名" : "用户名";
    $("authBtn").textContent = setup ? "创建并登录" : "登录";
    $("authErr").textContent = "";
    $("authUser").value = "";
    $("authPass").value = "";
    setTimeout(function () { $("authUser").focus(); }, 60);
  }
  function hideAuth() { $("authModal").classList.add("hidden"); }
  function submitAuth() {
    var u = $("authUser").value.trim(), p = $("authPass").value;
    if (!u || !p) { $("authErr").textContent = "请填写用户名和密码"; return; }
    var path = authMode === "setup" ? "/api/setup" : "/api/login";
    fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: u, password: p })
    })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.status === 200 && res.data.token) {
          token = res.data.token;
          me = res.data.user;
          localStorage.setItem("ep_token", token);
          hideAuth();
          renderUserBox();
          startHeartbeat();
          loadServerData().then(function () {
            if (!ALL.length) loadLessons();
            else { updateProgress(); refreshVocab(); renderList(); }
          });
        } else {
          $("authErr").textContent = res.data.error || "操作失败，请重试";
        }
      })
      .catch(function () { $("authErr").textContent = "网络错误，请检查服务是否运行"; });
  }
  function logout() {
    api("/api/logout", { method: "POST" }).catch(function () {});
    token = ""; me = null;
    localStorage.removeItem("ep_token");
    stopHeartbeat();
    renderUserBox();
    showAuth("login");
  }
  function handleAuthExpired() {
    if (me) {
      token = ""; me = null;
      localStorage.removeItem("ep_token");
      stopHeartbeat();
      renderUserBox();
      showAuth("login");
    }
  }
  function renderUserBox() {
    var box = $("userBox");
    if (!box) return;
    if (!me) { box.innerHTML = ""; return; }
    box.innerHTML =
      '<span class="ub-user">👤 ' + escapeHtml(me.username) + "</span>" +
      (me.role === "admin" ? '<button id="adminBtn" class="ub-btn" title="管理后台">⚙️ 管理</button>' : "") +
      '<button id="logoutBtn" class="ub-btn" title="退出登录">退出</button>';
    $("logoutBtn").onclick = logout;
    if (me.role === "admin") $("adminBtn").onclick = openAdmin;
  }
  // 播放中每 60 秒心跳上报一次学习时长
  function startHeartbeat() {
    if (heartTimer) return;
    heartTimer = setInterval(function () {
      if (me && !audio.paused && audio.currentTime > 0) {
        api("/api/activity", { method: "POST", body: { seconds: 60 } }).catch(function () {});
      }
    }, 60000);
  }
  function stopHeartbeat() {
    if (heartTimer) { clearInterval(heartTimer); heartTimer = null; }
  }

  // ---------- 管理员后台：用户管理 + 学习工作台 ----------
  function openAdmin() {
    $("adminModal").classList.remove("hidden");
    switchAdminTab("users");
  }
  function closeAdmin() { $("adminModal").classList.add("hidden"); }
  function switchAdminTab(tab) {
    document.querySelectorAll("#adminModal .atab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.atab === tab);
    });
    $("adminUsers").classList.toggle("hidden", tab !== "users");
    $("adminStats").classList.toggle("hidden", tab !== "stats");
    if (tab === "users") loadAdminUsers();
    else loadAdminStats();
  }
  function loadAdminUsers() {
    api("/api/admin/users").then(function (res) {
      renderAdminUsers(res.users || []);
    }).catch(function () {});
  }
  function renderAdminUsers(users) {
    var box = $("adminUsers");
    var rows = users.map(function (u) {
      return "<tr>" +
        "<td>" + escapeHtml(u.username) + (u.role === "admin" ? ' <span class="ub-role">管理员</span>' : "") + "</td>" +
        "<td>" + (u.is_active ? "✅ 启用" : "⛔ 停用") + "</td>" +
        "<td>" + escapeHtml(u.created_at) + "</td>" +
        '<td class="ub-ops">' +
        '<button data-op="toggle" data-id="' + u.id + '" data-active="' + u.is_active + '">' + (u.is_active ? "停用" : "启用") + "</button>" +
        '<button data-op="reset" data-id="' + u.id + '">重置密码</button>' +
        '<button data-op="del" data-id="' + u.id + '" class="ub-danger">删除</button>' +
        "</td></tr>";
    }).join("");
    box.innerHTML =
      '<div class="ub-add">' +
      '<input id="ubNewUser" class="auth-input" placeholder="新用户名" autocomplete="off" />' +
      '<input id="ubNewPass" class="auth-input" type="password" placeholder="初始密码" />' +
      '<button id="ubAddBtn" class="auth-btn">＋ 添加用户</button>' +
      "</div>" +
      '<table class="ub-table"><thead><tr><th>用户名</th><th>状态</th><th>创建时间</th><th>操作</th></tr></thead>' +
      "<tbody>" + rows + "</tbody></table>" +
      '<div class="ub-hint">新用户只能由管理员添加；删除用户会同时清除其学习进度与生词本。</div>';
    $("ubAddBtn").onclick = addUser;
    $("ubNewUser").addEventListener("keydown", function (e) { if (e.key === "Enter") addUser(); });
    $("ubNewPass").addEventListener("keydown", function (e) { if (e.key === "Enter") addUser(); });
    box.querySelectorAll("button[data-op]").forEach(function (b) {
      b.onclick = function () {
        var id = parseInt(b.dataset.id, 10);
        if (b.dataset.op === "del") {
          if (confirm("确定删除该用户？其学习进度与生词本将一并清除。")) {
            api("/api/admin/users/delete", { method: "POST", body: { id: id } }).then(loadAdminUsers);
          }
        } else if (b.dataset.op === "reset") {
          var np = prompt("为该用户设置新密码：");
          if (np) api("/api/admin/users/reset", { method: "POST", body: { id: id, password: np } }).then(loadAdminUsers);
        } else if (b.dataset.op === "toggle") {
          api("/api/admin/users/toggle", { method: "POST", body: { id: id, active: b.dataset.active !== "1" } }).then(loadAdminUsers);
        }
      };
    });
  }
  function addUser() {
    var u = $("ubNewUser").value.trim(), p = $("ubNewPass").value;
    if (!u || !p) { alert("请填写用户名和初始密码"); return; }
    api("/api/admin/users", { method: "POST", body: { username: u, password: p } })
      .then(function (res) {
        if (res.error) alert(res.error);
        else { $("ubNewUser").value = ""; $("ubNewPass").value = ""; loadAdminUsers(); }
      });
  }
  function loadAdminStats() {
    api("/api/admin/stats").then(function (res) {
      renderAdminStats(res.stats || []);
    }).catch(function () {});
  }
  function renderAdminStats(stats) {
    var rows = stats.map(function (s) {
      return "<tr>" +
        "<td>" + escapeHtml(s.username) + (s.role === "admin" ? ' <span class="ub-role">管理员</span>' : "") + "</td>" +
        "<td>" + fmt(parseInt(s.secs || 0, 10)) + "</td>" +
        "<td>" + s.done + "</td>" +
        "<td>" + s.words + "</td>" +
        "<td>" + (s.last_seen ? escapeHtml(s.last_seen) : "—") + "</td>" +
        "</tr>";
    }).join("");
    $("adminStats").innerHTML =
      '<div class="ub-hint">学习时长由播放中每 60 秒心跳累加；完成课程数按「已完成」标记统计。</div>' +
      '<table class="ub-table"><thead><tr><th>用户</th><th>学习时长</th><th>完成课程</th><th>生词数</th><th>最近活跃</th></tr></thead>' +
      "<tbody>" + (rows || '<tr><td colspan="5" class="ub-empty">暂无用户</td></tr>') + "</tbody></table>";
  }

  // ---------- 初始化 ----------
  function loadLessons() {
    return fetch("/api/lessons")
      .then(function (r) { return r.json(); })
      .then(function (data) {
        ALL = data;
        updateProgress();
        renderList();
        if (lastLesson) {
          var found = ALL.filter(function (l) { return l.id === lastLesson; })[0];
          if (found) selectLesson(found.id);
        }
      })
      .catch(function (e) {
        $("emptyState").textContent = "无法加载课程列表，请确认服务器已启动。";
        console.error(e);
      });
  }
  // 登录后拉取服务端进度/生词；服务端为空且本机有旧数据时一次性迁移上传
  function loadServerData() {
    return Promise.all([
      api("/api/progress").then(function (p) {
        if (p && Object.keys(p.completed || {}).length + Object.keys(p.positions || {}).length > 0) {
          completed = Object.assign({}, p.completed || {});
          positions = Object.assign({}, p.positions || {});
        } else {
          var lc = loadJSON("ep_completed", {});
          var lp = loadJSON("ep_positions", {});
          if (Object.keys(lc).length || Object.keys(lp).length) {
            completed = lc; positions = lp;
            persistProgress();
          }
        }
      }).catch(function () {}),
      api("/api/vocab").then(function (v) {
        if (v && v.words && Object.keys(v.words).length) {
          vocab = v.words;
        } else {
          var lv = loadJSON("ep_vocab", {});
          if (Object.keys(lv).length) { vocab = lv; persistVocabBulk(vocab); }
        }
      }).catch(function () {})
    ]).then(function () {
      updateProgress();
      refreshVocab();
      renderVocabPanel();
    });
  }
  // 启动流程：校验登录状态 → 首次部署显示设置向导 → 未登录显示登录界面
  function boot() {
    var h = token ? { "Authorization": "Bearer " + token } : {};
    fetch("/api/me", { headers: h })
      .then(function (r) { return r.json().then(function (d) { return { status: r.status, data: d }; }); })
      .then(function (res) {
        if (res.status === 200 && res.data.user) {
          me = res.data.user;
          renderUserBox();
          startHeartbeat();
          loadServerData().then(loadLessons);
        } else if (res.status === 401 && res.data.code === "setup_required") {
          showAuth("setup");
        } else {
          token = "";
          localStorage.removeItem("ep_token");
          showAuth("login");
        }
      })
      .catch(function () { showAuth("login"); });
  }
  function init() {
    applyTheme(theme);
    renderLoop();
    bindEvents();
    boot();
    // 生词弹窗：点击空白处 / 滚动时隐藏
    document.addEventListener("click", function (e) {
      if (popup.classList.contains("show") &&
          !popup.contains(e.target) &&
          !(e.target.classList && e.target.classList.contains("word"))) {
        hidePopup();
        return;
      }
      // 词典标签页切换
      var dtab = e.target.closest && e.target.closest(".wp-dict-tab");
      if (dtab) { switchDictTab(dtab.dataset.dict); return; }
      // 拼写建议 / 近反义词按钮：点按即用该词重新查询（保持当前词典）
      var sug = e.target.closest && e.target.closest(".wp-sug-btn");
      if (sug) {
        var box = $("wpDict");
        var w = sug.dataset.w;
        var dictId = sug.dataset.dict || popupDict;
        if (box && w) {
          popupWord = w;
          popupDict = dictId;
          box.innerHTML = dictTabsHtml(dictId) + '<div class="wp-dict-body"><span class="wp-loading">查询释义中…</span></div>';
          fillDictTab(w, dictId);
        }
      }
    });
    // 滚动时隐藏弹窗，但弹窗自身内部滚动除外（防止长释义滚动时按钮被误关）
    window.addEventListener("scroll", function (e) {
      if (e.target && (e.target === popup || popup.contains(e.target))) return;
      hidePopup();
    }, true);
  }

  // ---------- 列表 ----------
  function renderList() {
    var q = $("search").value.trim().toLowerCase();
    var f = document.querySelector("#filters button.active").dataset.filter;
    view = ALL.filter(function (l) {
      if (f !== "all" && l.series !== f) return false;
      if (q && l.id.toLowerCase().indexOf(q) === -1) return false;
      return true;
    });
    listEl.innerHTML = "";
    view.forEach(function (l) {
      var li = document.createElement("li");
      li.dataset.id = l.id;
      if (current && l.id === current.id) li.className = "active";
      if (completed[l.id]) li.className += " done";
      var tag = l.series === "standard" ? "标准" : (l.series === "DC" ? "DC" : "TJI");
      li.innerHTML =
        '<span class="lid">' + l.id + "</span>" +
        '<span class="ltag">' + tag + "</span>" +
        (l.hasDoc ? '<span class="doc-dot">📄</span>' : "");
      li.onclick = function () { selectLesson(l.id); };
      listEl.appendChild(li);
    });
    listEmpty.classList.toggle("hidden", view.length > 0);
  }

  function updateProgress() {
    var n = Object.keys(completed).length;
    $("progress").textContent = "已完成 " + n + " / " + ALL.length;
  }

  // ---------- 选择课程 ----------
  function selectLesson(id) {
    var les = ALL.filter(function (l) { return l.id === id; })[0];
    if (!les) return;
    current = les;
    localStorage.setItem("ep_last", id);
    hidePopup();
    closeDrawer(); // 移动端选课后收起课单抽屉
    document.querySelectorAll("#lessonList li").forEach(function (li) {
      li.classList.toggle("active", li.dataset.id === id);
    });

    $("emptyState").classList.add("hidden");
    $("lessonView").classList.remove("hidden");
    $("playerBar").classList.remove("hidden");
    $("lessonTitle").textContent = les.title;

    var badges = "";
    if (les.series === "standard") badges += '<span class="badge">标准课程</span>';
    if (les.series === "DC") badges += '<span class="badge">DC 系列</span>';
    if (les.series === "TJI") badges += '<span class="badge">TJI 系列</span>';
    if (les.pdf) badges += '<span class="badge green">含 PDF 文档</span>';
    if (les.srt) badges += '<span class="badge">含字幕</span>';
    $("lessonBadges").innerHTML = badges;

    setCompleteBtn(completed[id]);
    renderTracks(les);
    setTrack(les.defaultTrack);
    loadTranscript(les);
    loadPdf(les);
    loadSubtitles(les);
    updateNav();
  }

  function renderTracks(les) {
    var box = $("trackTabs");
    box.innerHTML = "";
    les.tracks.forEach(function (t) {
      var b = document.createElement("button");
      b.dataset.suffix = t.suffix;
      b.innerHTML = t.label + '<span class="dur" data-dur="' + t.suffix + '"></span>';
      b.onclick = function () { setTrack(t.suffix); };
      box.appendChild(b);
    });
  }

  function setTrack(suffix) {
    if (!current) return;
    var t = current.tracks.filter(function (x) { return x.suffix === suffix; })[0];
    if (!t) return;
    currentTrack = suffix;
    document.querySelectorAll("#trackTabs button").forEach(function (b) {
      b.classList.toggle("active", b.dataset.suffix === suffix);
    });
    abLoop = null;
    updateAbState();
    audio.src = t.url;
    audio.playbackRate = parseFloat($("speed").value);
    var pos = positions[current.id];
    if (pos) {
      var onMeta = function () {
        try { audio.currentTime = Math.min(pos, audio.duration - 1); } catch (e) {}
        audio.removeEventListener("loadedmetadata", onMeta);
      };
      audio.addEventListener("loadedmetadata", onMeta);
    }
    activeCue = -1;
    renderSubtitles();
  }

  // ---------- 字幕 ----------
  function loadSubtitles(les) {
    cues = [];
    if (!les.srt) { renderSubtitles(); return; }
    fetch(les.srt)
      .then(function (r) { return r.text(); })
      .then(function (txt) { cues = parseSRT(txt); renderSubtitles(); })
      .catch(function () { renderSubtitles(); });
  }

  function parseSRT(text) {
    var out = [];
    var blocks = text.replace(/\r/g, "").trim().split(/\n\s*\n/);
    blocks.forEach(function (b) {
      var lines = b.split("\n");
      var ti = lines.find(function (l) {
        return /^\d{2}:\d{2}:\d{2}[,\.]\d{3}\s*-->\s*\d{2}:\d{2}:\d{2}/.test(l);
      });
      if (!ti) return;
      var m = ti.match(/(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,\.](\d{3})/);
      if (!m) return;
      var start = +m[1] * 3600 + +m[2] * 60 + +m[3] + +m[4] / 1000;
      var end = +m[5] * 3600 + +m[6] * 60 + +m[7] + +m[8] / 1000;
      var txt = lines.slice(lines.indexOf(ti) + 1).join("\n");
      out.push({ start: start, end: end, text: txt });
    });
    return out;
  }

  function renderSubtitles() {
    var panel = $("subtitlePanel");
    panel.innerHTML = "";
    if (!current) return;

    var synced = current.subtitleTrack && currentTrack === current.subtitleTrack;
    if (!current.srt) {
      panel.innerHTML = '<div class="panel-note">该课程没有字幕文件（DC / TJI 系列为纯音频）。</div>';
      return;
    }
    if (!synced) {
      var lbl = function (s) { return (current.tracks.filter(function (t) { return t.suffix === s; })[0] || {}).label; };
      var note = document.createElement("div");
      note.className = "sub-note";
      note.textContent = "提示：字幕与「" + lbl(current.subtitleTrack) +
        "」音轨时间轴同步；当前播放的是「" + lbl(currentTrack) + "」，点击字幕不会跳转。";
      panel.appendChild(note);
    }
    if (!cues.length) {
      panel.appendChild(Object.assign(document.createElement("div"),
        { className: "panel-note", textContent: "字幕加载中…" }));
      return;
    }
    cues.forEach(function (c, i) {
      var div = document.createElement("div");
      div.className = "cue";
      div.dataset.idx = i;
      div.innerHTML = '<span class="ct">' + fmt(c.start) + "</span>" + highlightHTML(c.text);
      if (synced) {
        div.onclick = function () { audio.currentTime = c.start + 0.01; audio.play(); };
      }
      panel.appendChild(div);
    });
    wireWords(panel);
    refreshVocab();
    activeCue = -1;
  }

  function highlightCue(t) {
    if (!current || !current.subtitleTrack || currentTrack !== current.subtitleTrack) return;
    var idx = -1;
    for (var i = 0; i < cues.length; i++) {
      if (t >= cues[i].start && t < cues[i].end) { idx = i; break; }
    }
    if (idx === activeCue) return;
    var items = $("subtitlePanel").querySelectorAll(".cue");
    if (activeCue >= 0 && items[activeCue]) items[activeCue].classList.remove("active");
    activeCue = idx;
    if (idx >= 0 && items[idx]) {
      items[idx].classList.add("active");
      items[idx].scrollIntoView({ block: "center", behavior: "smooth" });
    }
  }

  // ---------- 文本 ----------
  function loadTranscript(les) {
    var panel = $("transcriptPanel");
    if (!les.txt) {
      panel.innerHTML = '<div class="panel-note">该课程没有文本稿（DC / TJI 系列为纯音频）。</div>';
      return;
    }
    panel.innerHTML = '<div class="panel-note">加载中…</div>';
    fetch(les.txt)
      .then(function (r) { return r.text(); })
      .then(function (txt) {
        panel.innerHTML = highlightHTML(txt);
        wireWords(panel);
        refreshVocab();
      })
      .catch(function () { panel.innerHTML = '<div class="panel-note">文本加载失败。</div>'; });
  }

  // ---------- PDF ----------
  function loadPdf(les) {
    var tabPdf = document.querySelector('#tabs button[data-tab="pdf"]');
    if (!les.pdf) {
      tabPdf.style.display = "none";
      $("pdfFrame").src = "about:blank";
      return;
    }
    tabPdf.style.display = "";
    $("pdfOpen").href = les.pdf;
    if (!$("pdfPanel").classList.contains("hidden")) $("pdfFrame").src = les.pdf;
  }

  // ---------- 生词本 ----------
  function wireWords(container) {
    container.querySelectorAll(".word").forEach(function (sp) {
      sp.addEventListener("mouseenter", function () { if (isVocab(sp.dataset.w)) showDef(sp); });
      sp.addEventListener("mouseleave", scheduleHide);
      sp.addEventListener("click", function (e) { e.stopPropagation(); onWordClick(sp); });
    });
  }
  function refreshVocab() {
    document.querySelectorAll(".word").forEach(function (sp) {
      sp.classList.toggle("vocab", isVocab(sp.dataset.w));
    });
  }
  function onWordClick(sp) {
    if (isVocab(sp.dataset.w)) showDef(sp);
    else showAdd(sp);
  }
  function showDef(sp) {
    var w = sp.dataset.w, v = vocab[w];
    popupWord = w;
    // 词组词条默认落英汉词典（离线词组库最全），普通单词默认学习词典
    popupDict = w.indexOf(" ") >= 0 ? "ecdict" : "learners";
    lastPopupSp = sp;
    popup.innerHTML =
      '<div id="wpDict" class="wp-dict"></div>' +
      (v.example ? '<div class="wp-example">📌 ' + escapeHtml(v.example) + "</div>" : "") +
      (v.lesson ? '<div class="wp-meta">来自 ' + escapeHtml(v.lesson) + "</div>" : "") +
      '<div class="wp-actions"><button id="wpEdit">编辑释义</button></div>';
    openPopup(sp);
    initDictBox(popupWord, popupDict, v.def || "");
    $("wpEdit").onclick = function () { showAdd(sp); };
  }
  function showAdd(sp) {
    var w = sp.dataset.w;
    popupWord = w;
    popupDict = w.indexOf(" ") >= 0 ? "ecdict" : "learners"; // 词组优先英汉词典，单词默认学习词典
    var existing = vocab[w];
    var example, cueStart, lessonId;
    if (existing) {
      // 编辑模式：保留原始上下文，不被当前 cue 覆盖
      example = existing.example || null;
      cueStart = existing.cueStart != null ? existing.cueStart : null;
      lessonId = existing.lesson || null;
    } else {
      // 新增：从当前所在 cue/lesson 抓取上下文
      example = sentenceAround(sp);
      var cueEl = sp.closest && sp.closest(".cue");
      if (cueEl && cueEl.dataset.idx != null) {
        var idx = parseInt(cueEl.dataset.idx, 10);
        if (cues[idx]) cueStart = cues[idx].start;
      }
      lessonId = current ? current.id : null;
    }
    var ctx = { example: example, cueStart: cueStart, lesson: lessonId };
    lastPopupSp = sp;
    popup.innerHTML =
      '<div id="wpDict" class="wp-dict"></div>' +
      (example ? '<div class="wp-example">📌 ' + escapeHtml(example) + "</div>" : "") +
      '<input id="wpInput" class="wp-input" placeholder="可编辑释义后保存到生词本…" />' +
      '<div class="wp-actions"><button id="wpSave">保存到生词本</button><button id="wpCancel">取消</button></div>';
    openPopup(sp);
    var inp = $("wpInput");
    if (existing) inp.value = existing.def || "";
    else inp.focus();
    inp.addEventListener("keydown", function (e) {
      if (e.key === "Enter") { commitAdd(popupWord, inp.value, ctx); }
      else if (e.key === "Escape") { hidePopup(); }
    });
    $("wpSave").onclick = function () { commitAdd(popupWord, inp.value, ctx); };
    $("wpCancel").onclick = hidePopup;
    initDictBox(popupWord, popupDict);
  }
  function commitAdd(w, def, ctx) {
    ctx = ctx || {};
    var prev = vocab[w];
    vocab[w] = {
      def: (def || "").trim(),
      example: ctx.example != null ? ctx.example : (prev ? prev.example : null),
      lesson: ctx.lesson != null ? ctx.lesson : (prev ? prev.lesson : null),
      cueStart: ctx.cueStart != null ? ctx.cueStart : (prev && prev.cueStart != null ? prev.cueStart : null),
      ts: Date.now()
    };
    saveJSON("ep_vocab", vocab);
    persistVocabWord(w);
    refreshVocab();
    renderVocabPanel();
    hidePopup();
  }
  function openPopup(sp) {
    clearTimeout(hidePopup._t);
    popup.classList.add("show");
    positionPopup(sp);
    popup.onmouseenter = function () { clearTimeout(hidePopup._t); };
    popup.onmouseleave = scheduleHide;
  }
  function positionPopup(sp) {
    if (!sp) return;
    var r = sp.getBoundingClientRect();
    var pw = popup.offsetWidth || 200;
    var ph = popup.offsetHeight || 200;
    // 水平：left 对齐单词，向左右 clamp 保证弹窗不超出视口
    var x = window.scrollX + r.left;
    x = Math.max(8, Math.min(x, window.scrollX + window.innerWidth - pw - 8));
    // 垂直：优先单词上方；上方放不下则下方；最后 clamp 进视口（内容超高时弹窗内部滚动）
    var y = window.scrollY + r.top - ph - 8;
    if (y < window.scrollY + 8) y = window.scrollY + r.bottom + 8;
    y = Math.max(window.scrollY + 8, Math.min(y, window.scrollY + window.innerHeight - ph - 8));
    popup.style.left = x + "px";
    popup.style.top = y + "px";
  }
  function scheduleHide() { hidePopup._t = setTimeout(hidePopup, 260); }
  function hidePopup() { popup.classList.remove("show"); }

  function renderVocabPanel() {
    var p = $("vocabPanel");
    var keys = Object.keys(vocab);
    var html = '<div class="vocab-head">共 ' + keys.length + " 个生词</div>";
    html += '<div class="vocab-toolbar">' +
      '<button id="vocabExport" class="vt-btn"' + (keys.length ? "" : " disabled") + ">⬇ 导出备份</button>" +
      '<button id="vocabImportBtn" class="vt-btn">⬆ 导入备份</button>' +
      '<span class="vt-hint">备份含生词本 / 完成状态 / 播放进度，可迁移到其他浏览器或设备</span></div>';
    if (!keys.length) {
      html += '<div class="panel-note">还没有生词。在「字幕」或「文本」里点击任意单词即可加入生词本；也可点「导入备份」恢复之前的记录。</div>';
      p.innerHTML = html;
      $("vocabImportBtn").onclick = function () { $("vocabImport").click(); };
      return;
    }
    html += '<div class="vocab-search-row">' +
      '<input id="vocabSearch" class="vocab-search" type="text" placeholder="🔍 搜索生词 / 释义…" autocomplete="off" />' +
      '<select id="vocabLessonFilter" class="vocab-lesson-filter" title="按课程筛选生词"><option value="all">全部课程</option></select>' +
      '</div>' +
      '<ul id="vocabList" class="vocab-list"></ul>';
    p.innerHTML = html;
    $("vocabExport").onclick = exportData;
    $("vocabImportBtn").onclick = function () { $("vocabImport").click(); };
    var search = $("vocabSearch");
    search.value = vocabSearch;
    search.oninput = function () { vocabSearch = search.value.toLowerCase(); renderVocabList(); };
    var lf = $("vocabLessonFilter");
    var lessonCounts = {};
    keys.forEach(function (k) { var l = vocab[k].lesson; if (l) lessonCounts[l] = (lessonCounts[l] || 0) + 1; });
    lf.innerHTML = '<option value="all">全部课程</option>' + Object.keys(lessonCounts).sort().map(function (l) {
      return '<option value="' + escapeHtml(l) + '">' + escapeHtml(l) + " (" + lessonCounts[l] + ")</option>";
    }).join("");
    lf.value = vocabLessonFilter;
    lf.onchange = function () { vocabLessonFilter = lf.value; renderVocabList(); };
    renderVocabList();
  }
  function renderVocabList() {
    var ul = $("vocabList");
    if (!ul) return;
    var keys = Object.keys(vocab);
    if (vocabLessonFilter !== "all" && !keys.some(function (k) { return vocab[k].lesson === vocabLessonFilter; })) {
      vocabLessonFilter = "all";
    }
    var q = vocabSearch;
    if (q) {
      keys = keys.filter(function (k) {
        var v = vocab[k];
        return k.indexOf(q) >= 0 ||
          (v.def || "").toLowerCase().indexOf(q) >= 0 ||
          (v.example || "").toLowerCase().indexOf(q) >= 0;
      });
    }
    if (vocabLessonFilter !== "all") {
      keys = keys.filter(function (k) { return vocab[k].lesson === vocabLessonFilter; });
      var lfDom = $("vocabLessonFilter");
      if (lfDom) lfDom.value = vocabLessonFilter;
    }
    keys.sort(function (a, b) { return (vocab[b].ts || 0) - (vocab[a].ts || 0); });
    if (!keys.length) {
      ul.innerHTML = '<div class="panel-note">没有匹配的生词。</div>';
      return;
    }
    var html = "";
    keys.forEach(function (k) {
      var v = vocab[k];
      var exHtml = "";
      if (v.example) {
        var clickable = v.cueStart != null && v.lesson;
        exHtml = '<div class="vi-example' + (clickable ? " vi-example-clickable" : "") + '"' +
          (clickable ? ' data-w="' + escapeHtml(k) + '"' : "") + '>' +
          '📌 ' + escapeHtml(v.example) +
          (clickable ? ' <span class="vi-play">▶ 复听</span>' : "") + "</div>";
      }
      html += '<li class="vocab-item">' +
        '<div class="vi-word">' + escapeHtml(k) + "</div>" +
        '<div class="vi-body">' +
          '<div class="vi-def" contenteditable="true" data-w="' + escapeHtml(k) + '">' + escapeHtml(v.def || "") + "</div>" +
          exHtml +
          (v.lesson ? '<div class="vi-lesson">来自 ' + escapeHtml(v.lesson) + "</div>" : "") +
        "</div>" +
        '<button class="vi-del" data-w="' + escapeHtml(k) + '" title="删除">✕</button></li>';
    });
    ul.innerHTML = html;
    ul.querySelectorAll(".vi-del").forEach(function (b) {
      b.onclick = function () { var w = b.dataset.w; delete vocab[w]; saveJSON("ep_vocab", vocab); persistVocabDelete(w); refreshVocab(); renderVocabList(); };
    });
    ul.querySelectorAll(".vi-def").forEach(function (d) {
      d.addEventListener("blur", function () { vocab[d.dataset.w].def = d.textContent.trim(); saveJSON("ep_vocab", vocab); persistVocabWord(d.dataset.w); });
    });
    ul.querySelectorAll(".vi-example-clickable").forEach(function (el) {
      el.onclick = function () {
        var v = vocab[el.dataset.w];
        if (!v) return;
        playAt(v.lesson, v.cueStart);
      };
    });
  }
  // 跳到指定课程的指定时间点并播放（用于生词本「复听」）
  function playAt(lessonId, cueStart) {
    if (lessonId == null || cueStart == null) return;
    function doPlay() {
      audio.currentTime = Math.max(0, cueStart);
      audio.play().catch(function () {});
      $("playBtn").textContent = "⏸";
      var subBtn = document.querySelector('#tabs button[data-tab="subtitle"]');
      if (subBtn && current && current.srt) subBtn.click();
    }
    function onMeta() {
      audio.removeEventListener("loadedmetadata", onMeta);
      doPlay();
    }
    function ensureTrackAndListen() {
      if (current && current.subtitleTrack && currentTrack !== current.subtitleTrack) {
        setTrack(current.subtitleTrack);
      }
      if (audio.readyState >= 1) doPlay();
      else audio.addEventListener("loadedmetadata", onMeta);
    }
    if (!current || current.id !== lessonId) {
      selectLesson(lessonId);
      ensureTrackAndListen();
      return;
    }
    ensureTrackAndListen();
  }

  // ---------- 备份导出 / 导入 ----------
  function exportData() {
    var data = {
      app: "englishpod-web",
      version: 1,
      exported: new Date().toISOString(),
      vocab: vocab,
      completed: completed,
      positions: positions
    };
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "englishpod-backup-" + new Date().toISOString().slice(0, 10) + ".json";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }
  function importData(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var d = JSON.parse(reader.result);
        if (d && d.vocab) {
          for (var k in d.vocab) if (Object.prototype.hasOwnProperty.call(d.vocab, k)) vocab[k] = d.vocab[k];
          saveJSON("ep_vocab", vocab);
          persistVocabBulk(vocab);
        }
        if (d && d.completed) { completed = Object.assign({}, d.completed); saveJSON("ep_completed", completed); }
        if (d && d.positions) { positions = Object.assign({}, d.positions); saveJSON("ep_positions", positions); }
        if (d && (d.completed || d.positions)) persistProgress();
        refreshVocab();
        renderVocabPanel();
        updateProgress();
        renderList();
        var n = d && d.vocab ? Object.keys(d.vocab).length : 0;
        alert("已导入备份：共 " + n + " 个生词。\n（生词本已合并；完成状态与播放进度已恢复）");
      } catch (e) {
        alert("导入失败：文件不是有效的备份 JSON。");
      }
    };
    reader.readAsText(file);
  }

  // ---------- 导航 ----------
  function updateNav() {
    var i = view.indexOf(current);
    $("prevBtn").disabled = i <= 0;
    $("nextBtn").disabled = i < 0 || i >= view.length - 1;
  }
  function gotoRel(d) {
    var i = view.indexOf(current);
    var j = i + d;
    if (j >= 0 && j < view.length) selectLesson(view[j].id);
  }

  // ---------- 完成状态 ----------
  function setCompleteBtn(on) {
    var b = $("completeBtn");
    b.classList.toggle("on", !!on);
    b.textContent = on ? "✓ 已完成" : "✓ 标记完成";
  }
  function toggleComplete() {
    if (!current) return;
    if (completed[current.id]) delete completed[current.id];
    else completed[current.id] = true;
    saveJSON("ep_completed", completed);
    persistProgress();
    setCompleteBtn(completed[current.id]);
    updateProgress();
    renderList();
  }

  // ---------- A-B 复读 ----------
  function toggleAB() {
    if (!abLoop) {
      abLoop = { a: audio.currentTime, b: null };
      $("abBtn").classList.add("active");
      updateAbState();
    } else if (abLoop.b === null) {
      abLoop.b = Math.max(abLoop.a + 0.5, audio.currentTime);
      updateAbState();
    } else {
      abLoop = null;
      $("abBtn").classList.remove("active");
      updateAbState();
    }
  }
  function updateAbState() {
    var el = $("abState");
    if (!abLoop) { el.textContent = ""; return; }
    if (abLoop.b === null) el.textContent = "A " + fmt(abLoop.a) + " → 选 B";
    else el.textContent = fmt(abLoop.a) + " ~ " + fmt(abLoop.b);
  }

  // ---------- 循环 / 连播控制 ----------
  var LOOP_MODES = [
    { id: "off", icon: "⏹", label: "", title: "顺序播放：播放完当前课停止" },
    { id: "all", icon: "🔁", label: "列表循环", title: "列表循环：按列表顺序连播，末尾回到开头" },
    { id: "one", icon: "🔂", label: "单课循环", title: "单课循环：反复播放当前课" },
    { id: "shuffle", icon: "🔀", label: "随机播放", title: "随机播放：随机连播列表中的课程" }
  ];
  function loopInfo(mode) {
    for (var i = 0; i < LOOP_MODES.length; i++) if (LOOP_MODES[i].id === mode) return LOOP_MODES[i];
    return LOOP_MODES[0];
  }
  function renderLoop() {
    var info = loopInfo(loopMode);
    var btn = $("loopBtn");
    if (!btn) return;
    btn.textContent = info.icon;
    btn.title = info.title;
    btn.classList.toggle("active", loopMode !== "off");
    $("loopState").textContent = info.label;
  }
  function cycleLoop() {
    var order = ["off", "all", "one", "shuffle"];
    loopMode = order[(order.indexOf(loopMode) + 1) % order.length];
    localStorage.setItem("ep_loop", loopMode);
    renderLoop();
    toast(loopInfo(loopMode).title);
  }
  // 播完一课后的自动续播：单课循环重播当前；列表循环顺序下一课（末尾回开头）；
  // 随机播放随机选一课（不立即重复当前）；off 模式不自动播放
  function playNext() {
    if (!current || view.length === 0) return;
    var i = view.indexOf(current);
    if (loopMode === "one") {
      audio.currentTime = 0;
      audio.play().catch(function () {});
      $("playBtn").textContent = "⏸";
      return;
    }
    var j = -1;
    if (loopMode === "shuffle") {
      if (view.length === 1) {
        j = 0;
      } else {
        j = Math.floor(Math.random() * (view.length - 1));
        if (j >= i) j++; // 排除当前课，避免随机到同一课
      }
    } else if (loopMode === "all") {
      j = (i + 1) % view.length; // 顺序连播，末尾回到开头
    } else {
      j = -1; // off：播完当前课停止，不自动续播
    }
    if (j >= 0 && j < view.length) selectLesson(view[j].id);
  }

  // ---------- 定时停止播放 ----------
  function toggleSleepPanel(show) {
    var p = $("sleepPanel");
    if (show === undefined) show = p.classList.contains("hidden");
    p.classList.toggle("hidden", !show);
  }
  function startSleepTimer(minutes) {
    minutes = Math.max(1, Math.min(600, Math.floor(minutes || 0)));
    if (!minutes) return;
    sleepEndAt = Date.now() + minutes * 60000;
    if (!sleepTimer) sleepTimer = setInterval(tickSleep, 1000);
    $("sleepBtn").classList.add("active");
    $("sleepCancel").classList.remove("hidden");
    $("sleepPanel").classList.add("hidden");
    renderSleep();
    toast("定时 " + minutes + " 分钟后自动停止播放");
  }
  function cancelSleepTimer() {
    sleepEndAt = 0;
    if (sleepTimer) { clearInterval(sleepTimer); sleepTimer = null; }
    $("sleepBtn").classList.remove("active");
    $("sleepState").textContent = "";
    $("sleepState").classList.remove("ticking");
  }
  function tickSleep() {
    if (sleepEndAt <= 0) return;
    var remain = Math.round((sleepEndAt - Date.now()) / 1000);
    if (remain <= 0) {
      cancelSleepTimer();
      if (!audio.paused) audio.pause();
      toast("⏱ 定时结束，已停止播放");
      return;
    }
    var mm = Math.floor(remain / 60);
    var ss = (remain % 60 < 10 ? "0" : "") + (remain % 60);
    $("sleepState").textContent = "⏱ " + mm + ":" + ss;
    $("sleepState").classList.add("ticking");
  }
  function renderSleep() {
    tickSleep();
  }

  // ---------- 轻量提示 ----------
  var toastTimer = null;
  function toast(msg) {
    var el = $("toast");
    if (!el) {
      el = document.createElement("div");
      el.id = "toast";
      document.body.appendChild(el);
    }
    el.textContent = msg;
    el.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove("show"); }, 2600);
  }

  // ---------- 主题 ----------
  function applyTheme(t) {
    document.documentElement.dataset.theme = t;
    theme = t;
    var btn = $("themeBtn");
    if (btn) btn.textContent = t === "dark" ? "☀️" : "🌙";
  }

  // ---------- 移动端课单抽屉 ----------
  var drawerBackdrop = $("drawerBackdrop");
  function openDrawer() {
    $("sidebar").classList.add("open");
    drawerBackdrop.classList.remove("hidden");
  }
  function closeDrawer() {
    $("sidebar").classList.remove("open");
    drawerBackdrop.classList.add("hidden");
  }

  // ---------- 事件 ----------
  function bindEvents() {
    $("menuBtn").onclick = function () {
      if ($("sidebar").classList.contains("open")) closeDrawer(); else openDrawer();
    };
    drawerBackdrop.onclick = closeDrawer;
    $("search").addEventListener("input", renderList);
    document.querySelectorAll("#filters button").forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll("#filters button").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        renderList();
      };
    });
    $("prevBtn").onclick = function () { gotoRel(-1); };
    $("nextBtn").onclick = function () { gotoRel(1); };
    $("completeBtn").onclick = toggleComplete;
    $("abBtn").onclick = toggleAB;
    $("themeBtn").onclick = function () { applyTheme(theme === "dark" ? "light" : "dark"); localStorage.setItem("ep_theme", theme); };
    $("authBtn").onclick = submitAuth;
    $("authPass").addEventListener("keydown", function (e) { if (e.key === "Enter") submitAuth(); });
    $("adminClose").onclick = closeAdmin;
    document.querySelectorAll("#adminModal .atab").forEach(function (b) {
      b.onclick = function () { switchAdminTab(b.dataset.atab); };
    });
    $("vocabImport").addEventListener("change", function () {
      if (this.files && this.files[0]) importData(this.files[0]);
      this.value = "";
    });

    $("playBtn").onclick = function () {
      if (audio.paused) audio.play(); else audio.pause();
      this.blur();
    };
    $("speed").onchange = function () { audio.playbackRate = parseFloat(this.value); };
    $("seek").addEventListener("input", function () {
      if (audio.duration) audio.currentTime = (this.value / 1000) * audio.duration;
    });
    $("loopBtn").onclick = cycleLoop;
    $("sleepBtn").onclick = function () {
      toggleSleepPanel();
      this.blur();
    };
    $("sleepPanel").querySelectorAll(".sleep-chips button").forEach(function (b) {
      b.onclick = function () { startSleepTimer(parseInt(b.dataset.min, 10)); };
    });
    $("sleepStart").onclick = function () { startSleepTimer(parseInt($("sleepMin").value, 10)); };
    $("sleepMin").addEventListener("keydown", function (e) { if (e.key === "Enter") startSleepTimer(parseInt(this.value, 10)); });
    $("sleepCancel").onclick = function () { cancelSleepTimer(); $("sleepPanel").classList.add("hidden"); };
    document.addEventListener("click", function (e) {
      var p = $("sleepPanel");
      if (!p.classList.contains("hidden") &&
          !p.contains(e.target) && e.target.id !== "sleepBtn") {
        p.classList.add("hidden");
      }
    });

    audio.addEventListener("play", function () { $("playBtn").textContent = "⏸"; });
    audio.addEventListener("pause", function () { $("playBtn").textContent = "▶"; });
    audio.addEventListener("ended", function () {
      $("playBtn").textContent = "▶";
      if (current && !completed[current.id]) toggleComplete();
      playNext();
    });
    audio.addEventListener("loadedmetadata", function () { $("durTime").textContent = fmt(audio.duration); });
    audio.addEventListener("timeupdate", function () {
      var t = audio.currentTime;
      if (audio.duration) $("seek").value = (t / audio.duration) * 1000;
      $("curTime").textContent = fmt(t);
      highlightCue(t);
      if (current) positions[current.id] = t;
      if (abLoop && abLoop.b !== null && t >= abLoop.b) audio.currentTime = abLoop.a;
    });
    window.addEventListener("beforeunload", function () { saveJSON("ep_positions", positions); persistProgress(); });
    setInterval(function () { if (current) { saveJSON("ep_positions", positions); persistProgress(); } }, 60000);

    // 标签切换
    document.querySelectorAll("#tabs button").forEach(function (b) {
      b.onclick = function () {
        document.querySelectorAll("#tabs button").forEach(function (x) { x.classList.remove("active"); });
        b.classList.add("active");
        var tab = b.dataset.tab;
        $("subtitlePanel").classList.toggle("hidden", tab !== "subtitle");
        $("transcriptPanel").classList.toggle("hidden", tab !== "transcript");
        $("pdfPanel").classList.toggle("hidden", tab !== "pdf");
        $("vocabPanel").classList.toggle("hidden", tab !== "vocab");
        hidePopup();
        if (tab === "pdf" && current && current.pdf) $("pdfFrame").src = current.pdf;
        if (tab === "vocab") renderVocabPanel();
      };
    });

    // 键盘快捷键
    document.addEventListener("keydown", function (e) {
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
      if (e.key === "Escape") { closeDrawer(); hidePopup(); return; }
      if (!current) return;
      if (e.code === "Space") { e.preventDefault(); if (audio.paused) audio.play(); else audio.pause(); }
      else if (e.code === "ArrowRight") { audio.currentTime = Math.min(audio.duration, audio.currentTime + 5); }
      else if (e.code === "ArrowLeft") { audio.currentTime = Math.max(0, audio.currentTime - 5); }
      else if (e.key === "a" || e.key === "A") { toggleAB(); }
    });
  }

  init();
})();
