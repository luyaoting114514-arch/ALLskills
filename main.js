/* SkillAtlas — data-driven directory over the GitHub-collected dataset. */
(function () {
  'use strict';

  var PAGE_SIZE = 24;
  var savedProfile = {};
  try { savedProfile = JSON.parse(localStorage.getItem('skillatlas-profile') || '{}'); } catch (ignore) {}
  var state = { data: null, cat: '全部', sort: 'trend', q: '', verifiedOnly: false, skillOnly: false, page: 1, dailyOffset: 0, rank: 'trend', goal: savedProfile.goal || 'build', pref: savedProfile.pref || '编程开发', live: [], liveStatus: 'idle' };

  var CAT_COLOR = {
    '编程开发': '#2563eb', '文档办公': '#0f766e', '科研学术': '#7c3aed', '生物医药': '#0d9488',
    '数据科学': '#0284c7', '浏览器自动化': '#ea580c', '设计创意': '#db2777', '写作内容': '#9333ea',
    '集成连接': '#0891b2', '效率工具': '#4f46e5', 'Agent 框架': '#16a34a', '其他': '#6b7280'
  };

  var $ = function (s) { return document.querySelector(s); };
  var esc = function (v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  };
  var num = function (n) {
    n = Number(n || 0);
    if (n >= 1000000) return (n / 1000000).toFixed(1) + 'M';
    if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
    return String(n);
  };
  /* Exact counts with separators, so headline numbers never disagree with the list. */
  var exact = function (n) { return Number(n || 0).toLocaleString('en-US'); };
  var GOALS = {
    build: ['编程开发', 'Agent 框架', '集成连接', '数据科学'],
    research: ['科研学术', '数据科学', '生物医药', '写作内容'],
    create: ['设计创意', '写作内容', '文档办公', '浏览器自动化'],
    automate: ['浏览器自动化', '效率工具', '集成连接', 'Agent 框架']
  };
  function ago(iso) {
    if (!iso) return '—';
    var days = (Date.now() - new Date(iso).getTime()) / 86400000;
    if (days < 1) return '今天';
    if (days < 30) return Math.round(days) + ' 天前';
    if (days < 365) return Math.round(days / 30) + ' 个月前';
    return (days / 365).toFixed(1) + ' 年前';
  }
  function toast(msg) {
    var el = $('#toast');
    el.textContent = msg;
    el.classList.add('show');
    clearTimeout(window.__t);
    window.__t = setTimeout(function () { el.classList.remove('show'); }, 2200);
  }
  function avatar(skill, size) {
    var src = skill.avatar ? ' src="' + esc(skill.avatar) + '" loading="lazy"' : '';
    var style = size ? ' style="width:' + size + 'px;height:' + size + 'px"' : '';
    return '<img' + src + style + ' alt="" onerror="this.style.visibility=\'hidden\'" />';
  }
  function saveProfile() { localStorage.setItem('skillatlas-profile', JSON.stringify({ goal: state.goal, pref: state.pref })); }
  function categoryFor(text) {
    text = String(text || '').toLowerCase();
    if (/browser|playwright|selenium|scrap|crawl/.test(text)) return '浏览器自动化';
    if (/research|paper|arxiv|literature|citation/.test(text)) return '科研学术';
    if (/design|figma|image|video|creative|ui|ux/.test(text)) return '设计创意';
    if (/mcp|integration|connector|notion|slack/.test(text)) return '集成连接';
    if (/agent|claude|codex|framework|skill/.test(text)) return 'Agent 框架';
    if (/data|sql|analytics|visual/.test(text)) return '数据科学';
    return '编程开发';
  }
  function personalScore(skill) {
    var score = 0;
    if (skill.category === state.pref) score += 44;
    if ((GOALS[state.goal] || []).indexOf(skill.category) !== -1) score += 26;
    if (skill.verified) score += 12;
    if (skill.skillSignal) score += 8;
    var pushed = skill.pushedAt ? (Date.now() - new Date(skill.pushedAt).getTime()) / 86400000 : 365;
    score += Math.max(0, 10 - pushed / 5);
    return Math.round(score);
  }

  /* ---------- data ---------- */
  function loadData() {
    if (window.SKILL_DATA && window.SKILL_DATA.skills && window.SKILL_DATA.skills.length) {
      return Promise.resolve(window.SKILL_DATA);
    }
    return fetch('data/skills.json')
      .then(function (r) { return r.json(); })
      .catch(function () { return null; });
  }

  function sortSkills(list, sort) {
    var copy = list.slice();
    if (sort === 'stars') copy.sort(function (a, b) { return b.stars - a.stars; });
    else if (sort === 'recent') copy.sort(function (a, b) { return new Date(b.pushedAt) - new Date(a.pushedAt); });
    else if (sort === 'new') copy.sort(function (a, b) { return new Date(b.createdAt) - new Date(a.createdAt); });
    else if (sort === 'skills') copy.sort(function (a, b) { return (b.skillCount || 0) - (a.skillCount || 0) || b.stars - a.stars; });
    else if (sort === 'name') copy.sort(function (a, b) { return a.fullName.toLowerCase().localeCompare(b.fullName.toLowerCase()); });
    else copy.sort(function (a, b) { return (b.trendScore || 0) - (a.trendScore || 0); });
    return copy;
  }
  function recommendedSkills() {
    return state.data.skills.slice().sort(function (a, b) {
      return personalScore(b) - personalScore(a) || (b.trendScore || 0) - (a.trendScore || 0);
    });
  }
  function renderProfile() {
    var goalNames = { build: '构建产品', research: '做研究', create: '做内容', automate: '自动化' };
    document.querySelectorAll('[data-goal]').forEach(function (el) { el.classList.toggle('active', el.getAttribute('data-goal') === state.goal); });
    document.querySelectorAll('[data-pref]').forEach(function (el) { el.classList.toggle('active', el.getAttribute('data-pref') === state.pref); });
    $('#preferenceSummary').textContent = '正在为「' + goalNames[state.goal] + '」筛选，优先推荐「' + state.pref + '」方向的活跃 Skills。';
    var score = Math.min(98, 58 + Math.round((recommendedSkills()[0] ? personalScore(recommendedSkills()[0]) : 0) / 2));
    $('#personalScore').textContent = score;
    document.querySelector('.why-meter i').style.width = score + '%';
  }

  function renderFresh() {
    var now = Date.now();
    var all = state.live.concat(state.data.skills).filter(function (s, index, arr) { return arr.findIndex(function (x) { return x.id === s.id; }) === index; });
    var list = all.slice().sort(function (a, b) {
      var af = a.pushedAt ? new Date(a.pushedAt).getTime() : 0;
      var bf = b.pushedAt ? new Date(b.pushedAt).getTime() : 0;
      var ap = personalScore(a), bp = personalScore(b);
      return (bf - af) * .6 + (bp - ap) * 86400000 * 3;
    }).slice(0, 5);
    $('#freshFeed').innerHTML = list.map(function (s, i) {
      var hours = s.pushedAt ? Math.max(1, Math.round((now - new Date(s.pushedAt).getTime()) / 3600000)) : 0;
      var freshness = hours < 24 ? '今天更新' : hours < 168 ? Math.round(hours / 24) + ' 天内更新' : ago(s.pushedAt);
      var delta = s.starsPerDay ? '+' + Math.max(1, Math.round(s.starsPerDay)) + '★/日' : '新信号';
      return '<article class="fresh-item reveal" data-id="' + esc(s.id) + '">' +
        '<span class="fresh-dot"></span><div class="fresh-main"><b>' + esc(s.name) + '</b><small>' + esc(s.fullName) + ' · ' + esc(s.category) + '</small><p>' + esc(s.description || '作者未填写描述。') + '</p></div>' +
        '<div class="fresh-delta"><strong>' + delta + '</strong><small>' + freshness + '</small></div></article>';
    }).join('');
  }
  function renderPulse(status, extra) {
    var text = $('#pulseText');
    if (status === 'loading') { text.textContent = '正在读取 GitHub 公开信号…'; return; }
    if (status === 'ok') {
      text.textContent = '刚刚同步 · 公开 GitHub API';
      $('#pulseNew').textContent = '+' + (extra.newCount || 0);
      $('#pulseHot').textContent = extra.hot || '活跃';
      $('#pulseLatency').textContent = (extra.latency || 0) + 'ms';
      return;
    }
    if (status === 'offline') { text.textContent = '实时通道暂不可用 · 正在使用本地快照'; $('#pulseNew').textContent = '快照'; $('#pulseHot').textContent = '可用'; $('#pulseLatency').textContent = '—'; return; }
    var meta = state.data.meta;
    text.textContent = '快照生成于 ' + new Date(meta.generatedAt).toLocaleString('zh-CN', { hour12: false });
    $('#pulseNew').textContent = '—'; $('#pulseHot').textContent = '待同步'; $('#pulseLatency').textContent = '—';
  }
  function normalizeLiveRepo(repo) {
    var text = [repo.name, repo.full_name, repo.description, (repo.topics || []).join(' ')].join(' ');
    var ageDays = Math.max(1, (Date.now() - new Date(repo.created_at || Date.now()).getTime()) / 86400000);
    var category = categoryFor(text);
    return { id: repo.full_name, name: repo.name, owner: (repo.owner || {}).login || repo.full_name.split('/')[0], fullName: repo.full_name, url: repo.html_url, homepage: repo.homepage || '', description: repo.description || '', category: category, topics: repo.topics || [], language: repo.language || '', license: (repo.license || {}).spdx_id || '', stars: repo.stargazers_count || 0, forks: repo.forks_count || 0, createdAt: repo.created_at, pushedAt: repo.pushed_at, ageDays: ageDays, starsPerDay: (repo.stargazers_count || 0) / ageDays, verified: false, skillSignal: /skill|claude|agent|mcp|codex/i.test(text), skillCount: null, trendScore: (repo.stargazers_count || 0) * .45 + (repo.stargazers_count || 0) / ageDays * 55, avatar: (repo.owner || {}).avatar_url || '', live: true };
  }
  function syncGitHub() {
    var btn = $('#syncNow');
    btn.classList.add('is-loading'); btn.disabled = true; state.liveStatus = 'loading'; renderPulse('loading');
    var began = performance.now();
    var q = state.goal === 'research' ? 'research agent skills' : state.goal === 'create' ? 'creative AI skills' : state.goal === 'automate' ? 'automation agent skills' : 'claude skills';
    var endpoint = 'https://api.github.com/search/repositories?q=' + encodeURIComponent(q + ' fork:false') + '&sort=updated&order=desc&per_page=12';
    fetch(endpoint, { headers: { 'Accept': 'application/vnd.github+json' } })
      .then(function (r) { if (!r.ok) throw new Error(String(r.status)); return r.json(); })
      .then(function (payload) {
        state.live = (payload.items || []).map(normalizeLiveRepo);
        var known = state.data.skills.reduce(function (m, s) { m[s.id] = 1; return m; }, {});
        var newCount = state.live.filter(function (s) { return !known[s.id]; }).length;
        var hottest = state.live.slice().sort(function (a, b) { return b.starsPerDay - a.starsPerDay; })[0];
        renderFresh(); renderPulse('ok', { newCount: newCount, hot: hottest ? '+' + Math.round(hottest.starsPerDay) + '★/日' : '活跃', latency: Math.round(performance.now() - began) });
        toast('已同步 ' + state.live.length + ' 个 GitHub 实时信号');
      })
      .catch(function () { renderPulse('offline'); toast('GitHub 暂未响应，保留本地快照'); })
      .finally(function () { btn.classList.remove('is-loading'); btn.disabled = false; });
  }

  /* ---------- render ---------- */
  function renderStats(meta, skills) {
    var verified = skills.filter(function (s) { return s.verified; });
    var counted = skills.reduce(function (sum, s) { return sum + (s.skillCount || 0); }, 0);
    var cats = Object.keys(meta.categoryCounts || {}).length;
    var stars = skills.reduce(function (sum, s) { return sum + (s.stars || 0); }, 0);
    $('#stats').innerHTML = [
      ['收录仓库', exact(skills.length), '已过滤非 AI 仓库 ' + exact(meta.reposFilteredOut || 0) + ' 个'],
      ['已核验仓库', exact(verified.length), '占收录 ' + (skills.length ? Math.round(verified.length / skills.length * 100) : 0) + '%'],
      ['发现技能文件', exact(counted), 'GitHub 文件树 + 镜像索引核验'],
      ['Skills 仓库', exact(meta.skillSignalRepos || 0), '名称/描述/topic 含 skill'],
      ['覆盖分类', String(cats), '自动归类'],
      ['累计星标', num(stars), '采集时快照']
    ].map(function (row) {
      return '<div class="stat"><span>' + esc(row[0]) + '</span><strong>' + esc(row[1]) + '</strong><small>' + esc(row[2]) + '</small></div>';
    }).join('');
  }

  function card(skill) {
    var facts = [
      '<span class="fact">★ ' + num(skill.stars) + '</span>',
      '<span class="fact">' + esc(skill.category) + '</span>'
    ];
    if (skill.verified) facts.push('<span class="fact ok">✓ ' + skill.skillCount + ' SKILL.md</span>');
    facts.push('<span class="fact">更新 ' + ago(skill.pushedAt) + '</span>');
    return '<article class="card" data-id="' + esc(skill.id) + '">' +
      '<div class="who">' + avatar(skill) +
        '<div><b>' + esc(skill.name) + '</b><small>' + esc(skill.fullName) + '</small></div>' +
      '</div>' +
      '<p>' + esc(skill.description || '作者未填写描述。') + '</p>' +
      '<div class="facts">' + facts.join('') + '</div>' +
      '</article>';
  }

  function renderDaily() {
    var pool = recommendedSkills().filter(function (s) { return s.verified; });
    if (pool.length < 3) pool = state.data.skills;
    /* Rotate deterministically by calendar day so "today" really changes each day. */
    var dayIndex = Math.floor(Date.now() / 86400000);
    var span = Math.max(pool.length - 2, 1);
    var start = ((dayIndex + state.dailyOffset * 3) % span + span) % span;
    var picks = pool.slice(start, start + 3);
    if (picks.length < 3) picks = picks.concat(pool.slice(0, 3 - picks.length));
    $('#dailyGrid').innerHTML = picks.map(function (s, i) {
      var facts = ['<span class="fact">★ ' + num(s.stars) + '</span>', '<span class="fact">' + esc(s.category) + '</span>'];
      facts.push(s.verified
        ? '<span class="fact ok">✓ ' + s.skillCount + ' SKILL.md</span>'
        : '<span class="fact">待核验</span>');
      return '<article class="daily-card">' +
        '<span class="daily-tag">PICK ' + (i + 1) + '</span>' +
        '<div class="who">' + avatar(s) + '<div><b>' + esc(s.name) + '</b><small>' + esc(s.owner) + '</small></div></div>' +
        '<p>' + esc(s.description || '作者未填写描述。') + '</p>' +
        '<div class="facts">' + facts.join('') + '<span class="fact ok">匹配 ' + personalScore(s) + '%</span></div>' +
        '<div class="daily-actions">' +
          '<button class="btn primary" data-open="' + esc(s.id) + '">查看详情</button>' +
          '<a class="btn" href="' + esc(s.url) + '" target="_blank" rel="noopener">GitHub ↗</a>' +
        '</div></article>';
    }).join('');
    var day = new Date().toISOString().slice(0, 10);
    $('#dailyNote').textContent = '按日期轮换 · ' + day + ' · 优先展示已核验 Skills';
  }

  function renderRanking() {
    var list = sortSkills(state.data.skills, state.rank).slice(0, 12);
    var rows = list.map(function (s, i) {
      var rank = i + 1;
      var cls = rank === 1 ? 'top1' : rank === 2 ? 'top2' : rank === 3 ? 'top3' : '';
      return '<div class="rank-row" data-id="' + esc(s.id) + '">' +
        '<span class="rk ' + cls + '">' + (rank < 10 ? '0' + rank : rank) + '</span>' +
        '<span class="rname">' + avatar(s) + '<span><b>' + esc(s.name) + '</b><small>' + esc(s.fullName) + '</small></span></span>' +
        '<span class="num col-stars">★ ' + num(s.stars) + '</span>' +
        '<span class="num col-skill">' + (s.verified ? '✓ ' + s.skillCount : '—') + '</span>' +
        '<span class="num col-updated">' + ago(s.pushedAt) + '</span>' +
        '<span class="cat-pill">' + esc(s.category) + '</span>' +
        '</div>';
    }).join('');
    $('#rankTable').innerHTML =
      '<div class="rank-row head"><span>#</span><span>仓库</span><span class="col-stars">Stars</span>' +
      '<span class="col-skill">SKILL.md</span><span class="col-updated">更新</span><span class="cat-pill">分类</span></div>' + rows;
  }

  function renderCategories() {
    var counts = state.data.meta.categoryCounts || {};
    var entries = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; });
    $('#catGrid').innerHTML = entries.map(function (name) {
      var color = CAT_COLOR[name] || '#6b7280';
      return '<button class="cat-tile" data-cat="' + esc(name) + '" style="--c:' + color + '">' +
        '<span class="dot"></span><b>' + esc(name) + '</b><small>' + counts[name] + ' repos</small></button>';
    }).join('');
    var chips = ['全部'].concat(entries);
    $('#catChips').innerHTML = chips.map(function (name) {
      var count = name === '全部' ? state.data.skills.length : counts[name];
      return '<button class="chip' + (state.cat === name ? ' active' : '') + '" data-cat="' + esc(name) + '">' +
        esc(name) + '<i>' + count + '</i></button>';
    }).join('');
  }

  function filtered() {
    var q = state.q.trim().toLowerCase();
    var list = state.data.skills.filter(function (s) {
      if (state.verifiedOnly && !s.verified) return false;
      if (state.skillOnly && !s.skillSignal) return false;
      if (state.cat !== '全部' && s.category !== state.cat) return false;
      if (!q) return true;
      return [s.name, s.fullName, s.description, s.category, s.owner, (s.topics || []).join(' '), s.language]
        .join(' ').toLowerCase().indexOf(q) !== -1;
    });
    if (state.sort === 'personal') return list.sort(function (a, b) { return personalScore(b) - personalScore(a) || (b.trendScore || 0) - (a.trendScore || 0); });
    return sortSkills(list, state.sort);
  }

  function renderBrowse() {
    var list = filtered();
    var shown = list.slice(0, state.page * PAGE_SIZE);
    $('#cards').innerHTML = shown.length
      ? shown.map(card).join('')
      : '<div class="empty">没有匹配的 Skill，试试其它关键词或清除筛选。</div>';
    $('#browseNote').textContent = '匹配 ' + list.length + ' 个仓库，已显示 ' + shown.length + ' 个';
    var more = $('#loadMore');
    more.disabled = shown.length >= list.length;
    more.textContent = more.disabled ? '已显示全部' : '加载更多（剩余 ' + (list.length - shown.length) + '）';
  }

  function renderAbout(meta) {
    var src = meta.verifiedBySource || {};
    $('#aboutGrid').innerHTML =
      '<div class="about-card"><h3>数据来源</h3><p>通过 GitHub Search API 以 ' + meta.queries +
      ' 组关键词抓取 <code>topic:claude-skills</code>、<code>topic:agent-skills</code>、<code>SKILL.md in:readme</code> 等目标，共扫描 ' +
      exact(meta.reposFilteredOut + meta.reposKept) + ' 个仓库，剔除与 AI 无关的 ' + exact(meta.reposFilteredOut) +
      ' 个，保留 ' + exact(meta.reposKept) + ' 个。</p></div>' +
      '<div class="about-card"><h3>SKILL.md 核验</h3><p>两条通道互相印证：<code>GitHub Git Tree API</code> 逐仓库递归读取文件树，是最权威的口径（' +
      exact(src['github-tree'] || 0) + ' 个）；<code>jsDelivr 文件索引</code> 免配额覆盖全部仓库（' +
      exact(src.jsdelivr || 0) + ' 个）。合计核验出 ' + exact(meta.verifiedRepos) + ' 个仓库、' +
      exact(meta.skillsCounted) + ' 个 <code>SKILL.md</code> 文件。GitHub 口径优先于镜像口径。</p></div>' +
      '<div class="about-card"><h3>榜单口径</h3><ul><li>趋势 = 星标 × 0.45 + 日均星标 × 55 + Fork × 0.5 + 活跃度 × 25</li>' +
      '<li>分类由仓库名、描述与 topic 关键词自动判定</li><li>数据为采集时快照，非实时</li>' +
      '<li>镜像口径可能与 GitHub 官方统计存在少量差异</li></ul></div>';
  }

  function renderSide(meta) {
    $('#sideMeta').textContent = exact(meta.reposKept) + ' 个仓库 · 核验 ' + exact(meta.verifiedRepos) +
      ' 个 · ' + new Date(meta.generatedAt).toLocaleString('zh-CN', { hour12: false });
    $('#footStamp').textContent = '数据集生成于 ' + new Date(meta.generatedAt).toLocaleString('zh-CN', { hour12: false });
  }

  function openModal(id) {
    var s = state.data.skills.filter(function (x) { return x.id === id; })[0];
    if (!s) return;
    var sourceLabel = s.verifiedSource === 'github-tree' ? 'GitHub Tree API 核验'
      : s.verifiedSource === 'jsdelivr' ? '镜像索引核验' : '未核验';
    var topics = (s.topics || []).map(function (t) { return '<span class="topic">' + esc(t) + '</span>'; }).join('');
    $('#modalBody').innerHTML =
      '<h2>' + esc(s.name) + '</h2>' +
      '<div class="modal-sub">' + esc(s.fullName) + ' · ' + esc(s.category) + '</div>' +
      '<p class="desc">' + esc(s.description || '作者未填写描述。') + '</p>' +
      '<div class="kv">' +
        '<div><span>Stars</span><b>' + num(s.stars) + '</b></div>' +
        '<div><span>Forks</span><b>' + num(s.forks) + '</b></div>' +
        '<div><span>SKILL.md</span><b>' + (s.verified ? s.skillCount : '未核验') + '</b></div>' +
        '<div><span>日均星标</span><b>' + Number(s.starsPerDay || 0).toFixed(2) + '</b></div>' +
        '<div><span>最近更新</span><b>' + ago(s.pushedAt) + '</b></div>' +
        '<div><span>创建于</span><b>' + ago(s.createdAt) + '</b></div>' +
      '</div>' +
      (topics ? '<div class="topics">' + topics + '</div>' : '') +
      '<div class="facts">' +
        '<span class="fact">' + esc(s.language || '未知语言') + '</span>' +
        '<span class="fact">' + esc(s.license || '未声明协议') + '</span>' +
        '<span class="fact">趋势分 ' + exact(s.trendScore) + '</span>' +
        '<span class="fact' + (s.verified ? ' ok' : '') + '">' + esc(sourceLabel) + '</span>' +
      '</div>' +
      '<div class="daily-actions" style="margin-top:16px">' +
        '<a class="btn primary" href="' + esc(s.url) + '" target="_blank" rel="noopener">打开 GitHub 仓库 ↗</a>' +
        (s.homepage ? '<a class="btn" href="' + esc(s.homepage) + '" target="_blank" rel="noopener">项目主页</a>' : '') +
      '</div>';
    $('#modal').classList.add('open');
  }

  function renderAll() {
    renderStats(state.data.meta, state.data.skills);
    renderDaily();
    renderRanking();
    renderCategories();
    renderBrowse();
    renderAbout(state.data.meta);
    renderSide(state.data.meta);
    renderProfile();
    renderFresh();
    renderPulse('idle');
  }

  /* ---------- events ---------- */
  document.addEventListener('click', function (e) {
    var el;
    if ((el = e.target.closest('[data-id]'))) { openModal(el.getAttribute('data-id')); return; }
    if ((el = e.target.closest('[data-open]'))) { openModal(el.getAttribute('data-open')); return; }
    if ((el = e.target.closest('[data-cat]'))) {
      var target = el.getAttribute('data-cat');
      state.cat = state.cat === target ? '全部' : target;
      state.page = 1;
      renderCategories(); renderBrowse();
      document.getElementById('browse').scrollIntoView({ behavior: 'smooth' });
      return;
    }
    if ((el = e.target.closest('[data-rank]'))) {
      state.rank = el.getAttribute('data-rank');
      [].forEach.call(document.querySelectorAll('#rankSeg button'), function (b) { b.classList.toggle('active', b === el); });
      renderRanking();
      return;
    }
    if ((el = e.target.closest('[data-goal]'))) {
      state.goal = el.getAttribute('data-goal'); state.page = 1; saveProfile();
      renderProfile(); renderDaily(); renderFresh(); renderBrowse();
      syncGitHub();
      return;
    }
    if ((el = e.target.closest('[data-pref]'))) {
      state.pref = el.getAttribute('data-pref'); state.page = 1; saveProfile();
      renderProfile(); renderDaily(); renderFresh(); renderBrowse();
      return;
    }
    if ((el = e.target.closest('[data-shuffle]'))) { state.dailyOffset++; renderDaily(); return; }
    if ((el = e.target.closest('[data-jump]'))) {
      var id = el.getAttribute('data-jump');
      if (el.classList.contains('nav-item')) {
        [].forEach.call(document.querySelectorAll('.nav-item'), function (b) { b.classList.toggle('active', b === el); });
      }
      document.getElementById(id).scrollIntoView({ behavior: 'smooth' });
    }
  });

  $('#modalX').addEventListener('click', function () { $('#modal').classList.remove('open'); });
  $('#modal').addEventListener('click', function (e) { if (e.target.id === 'modal') $('#modal').classList.remove('open'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') $('#modal').classList.remove('open');
    if (e.key === '/' && document.activeElement !== $('#searchInput')) { e.preventDefault(); $('#searchInput').focus(); }
  });

  var t;
  $('#searchInput').addEventListener('input', function (e) {
    clearTimeout(t);
    t = setTimeout(function () { state.q = e.target.value; state.page = 1; renderBrowse(); }, 150);
  });
  $('#sortSelect').addEventListener('change', function (e) { state.sort = e.target.value; state.page = 1; renderBrowse(); });
  $('#verifiedOnly').addEventListener('change', function (e) { state.verifiedOnly = e.target.checked; state.page = 1; renderBrowse(); });
  $('#skillOnly').addEventListener('change', function (e) { state.skillOnly = e.target.checked; state.page = 1; renderBrowse(); });
  $('#loadMore').addEventListener('click', function () { state.page++; renderBrowse(); });
  $('#refreshData').addEventListener('click', function () { location.reload(); });
  $('#syncNow').addEventListener('click', syncGitHub);

  /* ---------- boot ---------- */
  loadData().then(function (data) {
    if (!data || !data.skills || !data.skills.length) {
      $('#stats').innerHTML = '<div class="empty" style="grid-column:1/-1">未找到数据集。请先运行 <code>python tools/collect_skills.py</code> 生成 <code>data/skills.js</code>，然后刷新页面。</div>';
      return;
    }
    state.data = data;
    var meta = data.meta || {};
    if (!meta.categoryCounts) {
      meta.categoryCounts = {};
      data.skills.forEach(function (s) { meta.categoryCounts[s.category] = (meta.categoryCounts[s.category] || 0) + 1; });
    }
    /* Deep links: ?q=keyword, ?cat=分类, ?skill=owner/repo */
    var params = new URLSearchParams(location.search);
    if (params.get('q')) { state.q = params.get('q'); $('#searchInput').value = state.q; }
    if (params.get('cat') && meta.categoryCounts[params.get('cat')]) state.cat = params.get('cat');
    renderAll();
    setTimeout(syncGitHub, 500);
    var wanted = params.get('skill');
    if (wanted && data.skills.some(function (s) { return s.id === wanted; })) openModal(wanted);
  });
})();
