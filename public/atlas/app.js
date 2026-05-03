(function () {
  "use strict";

  // ============================================================
  // Config
  // ============================================================

  var STORAGE_KEY = "tb-atlas-v1";
  var API_BASE = "/atlas/api"; // absolute to prevent trailing slash issues
  var SEED_URL = "seed.json";

  // Staleness thresholds in days
  var STALE_DAYS = 21;
  var VERY_STALE_DAYS = 60;

  // Month labels for timeline grouping
  var MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];

  // ============================================================
  // State
  // ============================================================

  var state = {
    projects: [],
    view: "cards",       // cards | tech | timeline
    filterArea: "all",
    search: "",
    online: false,
    editingId: null,
    activeTab: "overview",
    reflectBusy: false,
    currentReflections: [], // for the dossier open right now
    currentLog: [],
    dirty: false,
    autoSaveTimer: null,
  };

  var AUTOSAVE_DEBOUNCE_MS = 800;

  // ============================================================
  // Utilities
  // ============================================================

  function uid(prefix) {
    prefix = prefix || "p";
    return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
  }
  function nowIso() { return new Date().toISOString(); }

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  }

  function formatDate(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return "";
      return d.toLocaleString(undefined, {
        month: "short", day: "numeric", year: "numeric",
        hour: "numeric", minute: "2-digit",
      });
    } catch (e) { return ""; }
  }

  function daysSince(iso) {
    try {
      var d = new Date(iso);
      if (isNaN(d.getTime())) return 0;
      return Math.max(0, Math.floor((Date.now() - d.getTime()) / 86400000));
    } catch (e) { return 0; }
  }

  function ageLabel(iso) {
    var n = daysSince(iso);
    if (n <= 0) return "today";
    if (n === 1) return "1d ago";
    if (n < 30) return n + "d ago";
    if (n < 365) return Math.round(n / 30) + "mo ago";
    return Math.round(n / 365) + "y ago";
  }

  function monthKey(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "unknown";
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0");
  }

  function monthLabel(key) {
    if (key === "unknown") return "Unknown";
    var parts = key.split("-");
    return MONTHS[parseInt(parts[1], 10) - 1] + " " + parts[0];
  }

  function areaLabel(a) {
    return { work: "Work", freelance: "Freelance", personal: "Personal" }[a] || a;
  }

  function statusLabel(s) {
    return { idea: "Idea", active: "Active", paused: "Paused", done: "Done", archived: "Archived" }[s] || s;
  }

  function toArr(x) {
    if (Array.isArray(x)) return x;
    if (x == null || x === "") return [];
    return [x];
  }

  function normalizeProject(p) {
    return {
      id: p.id || uid(),
      title: String(p.title || "Untitled").trim(),
      area: ["work","freelance","personal"].indexOf(p.area) >= 0 ? p.area : "personal",
      status: ["idea","active","paused","done","archived"].indexOf(p.status) >= 0 ? p.status : "active",
      pinned: !!p.pinned,
      nextAction: String(p.nextAction || "").trim(),
      notes: String(p.notes || ""),
      dossier: String(p.dossier || ""),
      primaryPath: String(p.primaryPath || "").trim(),
      liveUrl: String(p.liveUrl || "").trim(),
      thumbnail: String(p.thumbnail || "").trim(),
      stack: toArr(p.stack).map(String).filter(Boolean),
      tags: toArr(p.tags).map(String).filter(Boolean),
      links: toArr(p.links)
        .filter(function (l) { return l && (l.url || l.label); })
        .map(function (l) {
          return { label: String(l.label || l.url || "link"), url: String(l.url || "") };
        }),
      docPaths: toArr(p.docPaths).map(String).filter(Boolean),
      related: toArr(p.related).map(String).filter(Boolean),
      createdAt: p.createdAt || nowIso(),
      updatedAt: p.updatedAt || nowIso(),
    };
  }

  // ============================================================
  // Storage + API layer
  // ============================================================

  function loadFromStorage() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var data = JSON.parse(raw);
      if (data && Array.isArray(data.projects)) return data;
    } catch (e) {}
    return null;
  }

  function saveToStorage() {
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ version: 1, projects: state.projects })
      );
    } catch (e) {
      toast("Local storage full — export a backup", true);
    }
  }

  function setConn(online) {
    state.online = !!online;
    var el = document.getElementById("conn-status");
    if (el) {
      el.setAttribute("data-state", online ? "online" : "offline");
      el.querySelector(".conn-label").textContent = online ? "cloud" : "local";
    }
    // Reflect button: only works when cloud is connected
    var btn = document.getElementById("btn-reflect");
    if (btn) {
      btn.disabled = !online;
      btn.title = online ? "" : "Reflect needs cloud mode — deploy the Worker first.";
      // Idle label when offline and not already showing an error
      var statusEl = document.getElementById("reflect-status");
      if (statusEl && !state.reflectBusy && !statusEl.classList.contains("error")) {
        statusEl.textContent = online ? "" : "Offline — deploy to enable.";
        statusEl.className = "reflect-status mono" + (online ? "" : " offline");
      }
    }
  }

  // PATCH: apiFetch now sends the Authorization header so the Worker
  // doesn't return 401. (Matches the Basic Auth creds that were
  // hardcoded in the original worker.)
  function apiFetch(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({
      "Content-Type": "application/json",
      "Authorization": "Basic " + btoa("todd:fatbaby")
    }, opts.headers || {});
    return fetch(API_BASE + path, opts).then(function (r) {
      if (!r.ok) return r.json().then(function (j) { throw new Error(j.error || ("HTTP " + r.status)); }, function () { throw new Error("HTTP " + r.status); });
      return r.json();
    });
  }

  function tryOnlineList() {
    return apiFetch("/projects").then(function (data) {
      setConn(true);
      return data.projects || [];
    });
  }

  function fetchSeedJson() {
    return fetch(SEED_URL).then(function (r) { return r.ok ? r.json() : { projects: [] }; }).catch(function () { return { projects: [] }; });
  }

  function init() {
    // Preload from local first for instant render
    var stored = loadFromStorage();
    if (stored && stored.projects.length) {
      state.projects = stored.projects.map(normalizeProject);
      render();
    }

    // Try the cloud
    tryOnlineList().then(
      function (list) {
        state.projects = list.map(normalizeProject);
        saveToStorage();
        render();
      },
      function () {
        setConn(false);
        if (state.projects.length === 0) {
          fetchSeedJson().then(function (seed) {
            state.projects = (seed.projects || []).map(normalizeProject);
            saveToStorage();
            render();
          });
        }
      }
    );
  }

  // CRUD helpers — always update local state + localStorage; mirror to API if online.
  function persistCreate(project) {
    state.projects.push(project);
    saveToStorage();
    if (state.online) {
      apiFetch("/projects", { method: "POST", body: JSON.stringify(project) }).then(
        function () {},
        function (e) { console.warn("API create failed:", e); setConn(false); }
      );
    }
  }

  function persistUpdate(project) {
    var idx = state.projects.findIndex(function (x) { return x.id === project.id; });
    if (idx < 0) return;
    state.projects[idx] = project;
    saveToStorage();
    if (state.online) {
      apiFetch("/projects/" + encodeURIComponent(project.id), {
        method: "PUT",
        body: JSON.stringify(project),
      }).then(function () {}, function (e) { console.warn("API update failed:", e); setConn(false); });
    }
  }

  function persistDelete(id) {
    state.projects = state.projects.filter(function (x) { return x.id !== id; });
    saveToStorage();
    if (state.online) {
      apiFetch("/projects/" + encodeURIComponent(id), { method: "DELETE" }).then(
        function () {}, function (e) { console.warn("API delete failed:", e); setConn(false); }
      );
    }
  }

  function persistLog(id, text) {
    var p = state.projects.find(function (x) { return x.id === id; });
    if (!p) return null;
    var entry = { id: uid("log"), project_id: id, at: nowIso(), text: text };
    // Keep a local mirror of the log for offline viewing
    p._log = p._log || [];
    p._log.unshift(entry);
    p.updatedAt = entry.at;
    saveToStorage();
    if (state.online) {
      apiFetch("/projects/" + encodeURIComponent(id) + "/log", {
        method: "POST", body: JSON.stringify({ text: text }),
      }).then(function () {}, function (e) { console.warn("API log failed:", e); setConn(false); });
    }
    return entry;
  }

  // ============================================================
  // Filtering + sorting
  // ============================================================

  function matchesFilter(p) {
    if (state.filterArea !== "all" && p.area !== state.filterArea) return false;
    var q = state.search.trim().toLowerCase();
    if (!q) return true;
    var blob = [
      p.title, p.nextAction, p.notes, p.dossier,
      p.tags.join(" "), p.stack.join(" "), p.docPaths.join(" "), p.primaryPath
    ].join(" ").toLowerCase();
    return blob.indexOf(q) >= 0;
  }

  function sortProjects(list) {
    return list.slice().sort(function (a, b) {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
  }

  function focusCandidates() {
    var active = state.projects.filter(function (p) {
      return p.status === "active" && p.nextAction && matchesFilter(p);
    });
    var pinned = active.filter(function (p) { return p.pinned; });
    var rest = active.filter(function (p) { return !p.pinned; });
    return pinned.concat(rest).slice(0, 4);
  }

  // ============================================================
  // Rendering
  // ============================================================

  function render() {
    var filtered = sortProjects(state.projects.filter(matchesFilter));

    // Toggle views
    document.getElementById("view-cards").hidden = state.view !== "cards";
    document.getElementById("view-dashboard").hidden = state.view !== "dashboard";
    document.getElementById("view-tech").hidden = state.view !== "tech";
    document.getElementById("view-timeline").hidden = state.view !== "timeline";

    if (state.view === "cards") renderCards(filtered);
    else if (state.view === "dashboard") renderDashboard(filtered);
    else if (state.view === "tech") renderTech(filtered);
    else if (state.view === "timeline") renderTimeline(filtered);

    renderDupBanner();
  }

  function renderDupBanner() {
    var el = document.getElementById("dup-banner");
    if (!el) return;
    var groups = findDuplicateGroups(state.projects);
    if (groups.length === 0) {
      el.hidden = true;
      return;
    }
    var totalExtra = groups.reduce(function (n, g) { return n + (g.items.length - 1); }, 0);
    var titles = groups.map(function (g) { return g.items[0].title; }).slice(0, 3).join(", ");
    if (groups.length > 3) titles += ", and " + (groups.length - 3) + " more";
    el.innerHTML =
      '<span class="dup-banner-msg">' +
        '<strong>' + groups.length + ' duplicate group' + (groups.length === 1 ? '' : 's') + '</strong> ' +
        '(' + totalExtra + ' extra card' + (totalExtra === 1 ? '' : 's') + '): ' + escapeHtml(titles) +
      '</span>' +
      '<button type="button" class="btn btn-primary" id="btn-dup-merge">Combine duplicates</button>' +
      '<button type="button" class="btn btn-ghost" id="btn-dup-dismiss" aria-label="Dismiss">×</button>';
    el.hidden = false;
    document.getElementById("btn-dup-merge").addEventListener("click", function () {
      if (!confirm("Auto-merge " + groups.length + " duplicate group" + (groups.length === 1 ? "" : "s") +
                   "? The richest card in each group is kept; others are folded in and deleted.")) return;
      autoMergeDuplicates();
    });
    document.getElementById("btn-dup-dismiss").addEventListener("click", function () {
      el.hidden = true;
    });
  }

  // ============================================================
  // Forecast view (tableau-style project spread)
  // ============================================================

  var FC_LANES = ["work", "freelance", "personal"];

  // Area colors mirror the CSS variables for SVG rendering
  var AREA_COLOR = {
    work: "#6b9ec4",
    freelance: "#9b7eb8",
    personal: "#7a9e6d",
  };

  // Stack keyword → hue (HSL hue degree). Unknown stacks fall through to a hash.
  var STACK_HUE = {
    "cloudflare-worker": 22, "cloudflare-tunnel": 22, "cloudflare-access": 22,
    "d1": 30, "kv": 30, "supabase": 150,
    "vanilla-js": 45, "html": 200, "css": 280,
    "node": 140, "react": 195, "jsx": 195,
    "astro": 10, "tailwind": 190,
    "tauri": 18, "rust": 12, "vite": 265, "sqlite": 200,
    "ollama": 280, "claude-api": 28, "local-llm": 280,
    "php": 250, "canvas": 55, "pwa": 170,
    "remotion": 320, "docx": 210, "photography": 320, "forms": 85,
    "powershell": 210, "admin": 210, "automation": 210,
    "assets": 40, "markdown": 200, "claude": 28, "cursor": 200,
  };

  function fcStatusClass(s) { return "fc-tile fc-tile-" + s; }

  function fcTileSize(p) {
    if (p.status === "archived") return { w: 48, h: 48 };
    if (p.status === "idea") return { w: 60, h: 60 };
    return { w: 90, h: 64 };
  }

  function fcEscAttr(s) {
    return String(s)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;")
      .replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
  }

  function seedHash(str) {
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h * 16777619) >>> 0;
    }
    return h >>> 0;
  }

  function stackColor(stackArr, fallbackSeed) {
    // Derive a primary hue from the first known stack tag, else from id hash
    for (var i = 0; i < stackArr.length; i++) {
      var s = stackArr[i].toLowerCase();
      if (STACK_HUE[s] != null) return STACK_HUE[s];
    }
    return fallbackSeed % 360;
  }

  // Generate an SVG glyph for a project — returns inner SVG markup for a (0,0,w,h) viewport
  function fcGlyphInner(p, w, h) {
    var seed = seedHash(p.id);
    var hue = stackColor(p.stack, seed);
    var hue2 = (hue + 40 + (seed % 30)) % 360;
    var dim = p.status === "archived" || p.status === "done";
    var baseL = dim ? 24 : 34;
    var accentL = dim ? 38 : 58;

    var bg = 'hsl(' + hue + ', 28%, ' + baseL + '%)';
    var accent = 'hsl(' + hue2 + ', 55%, ' + accentL + '%)';
    var wash = 'hsl(' + hue + ', 40%, ' + (baseL + 10) + '%)';

    var parts = [];
    // background with soft gradient
    var gid = "g" + seed.toString(36).slice(0, 5);
    parts.push(
      '<defs><linearGradient id="' + gid + '" x1="0" y1="0" x2="1" y2="1">' +
      '<stop offset="0" stop-color="' + bg + '"/>' +
      '<stop offset="1" stop-color="' + wash + '"/>' +
      '</linearGradient></defs>'
    );
    parts.push('<rect x="0" y="0" width="' + w + '" height="' + h + '" fill="url(#' + gid + ')"/>');

    // top strip — area color, 22% height
    var stripH = Math.max(4, Math.round(h * 0.22));
    parts.push('<rect x="0" y="0" width="' + w + '" height="' + stripH + '" fill="' + AREA_COLOR[p.area] + '" opacity="0.55"/>');

    // content blocks (skip on tiny archived tiles)
    if (!dim || h > 24) {
      var blockCount = 2 + (seed % 3); // 2-4 blocks
      var y = stripH + 4;
      for (var i = 0; i < blockCount && y < h - 4; i++) {
        var hashSlice = (seed >> (i * 4)) & 0xff;
        var widthPct = 0.35 + (hashSlice / 255) * 0.5; // 35-85% width
        var blockW = Math.round(w * widthPct);
        var blockH = Math.max(2, Math.round(h * 0.09));
        var opacity = dim ? 0.22 : (0.45 + ((hashSlice >> 2) % 5) * 0.08);
        parts.push(
          '<rect x="3" y="' + y + '" width="' + (blockW - 6) + '" height="' + blockH +
          '" fill="' + accent + '" opacity="' + opacity.toFixed(2) + '" rx="1"/>'
        );
        y += blockH + 3;
      }
    }

    return parts.join("");
  }

  // ============================================================
  // Dashboard view (Bento Box + Heatmap)
  // ============================================================
  function renderDashboard(list) {
    // 1. Now Widget
    var bentoNow = document.getElementById("bento-now-body");
    bentoNow.innerHTML = "";
    var focusList = focusCandidates();
    if (focusList.length > 0) {
      var pNow = focusList[0];
      var nowCard = buildCard(pNow);
      // Remove default card styles to fit smoothly inside the bento box
      nowCard.style.border = "none";
      nowCard.style.boxShadow = "none";
      nowCard.style.background = "transparent";
      bentoNow.appendChild(nowCard);
    } else {
      bentoNow.innerHTML = '<div class="empty-state" style="border:none; padding:1rem;">No immediate quests.</div>';
    }

    // 2. Rings Widget
    var ringsSvg = document.getElementById("rings-svg");
    var ringsLeg = document.getElementById("rings-legend");
    var counts = { active: 0, idea: 0, done: 0, total: list.length };
    list.forEach(function(p) {
      if (p.status === "active") counts.active++;
      else if (p.status === "idea") counts.idea++;
      else if (p.status === "done" || p.status === "archived") counts.done++;
    });
    
    function makeRing(cx, cy, r, val, max, color, trackColor) {
      var c = 2 * Math.PI * r;
      var dash = (max === 0) ? 0 : (val / max) * c;
      return '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+trackColor+'" stroke-width="8" />' +
             '<circle cx="'+cx+'" cy="'+cy+'" r="'+r+'" fill="none" stroke="'+color+'" stroke-width="8" stroke-dasharray="'+dash+' '+(c-dash)+'" stroke-linecap="round" transform="rotate(-90 '+cx+' '+cy+')" />';
    }
    
    ringsSvg.innerHTML = 
      makeRing(60, 60, 48, counts.idea, counts.total, "var(--info)", "rgba(255,255,255,0.05)") +
      makeRing(60, 60, 36, counts.active, counts.total, "var(--ok)", "rgba(255,255,255,0.05)") +
      makeRing(60, 60, 24, counts.done, counts.total, "var(--text-dim)", "rgba(255,255,255,0.05)");
      
    ringsLeg.innerHTML = 
      '<div style="color:var(--info);">Ideas (' + counts.idea + ')</div>' +
      '<div style="color:var(--ok);">Active (' + counts.active + ')</div>' +
      '<div style="color:var(--text-dim);">Done (' + counts.done + ')</div>';

    // 3. Tech Map Marquee
    var bentoTech = document.getElementById("bento-tech-list");
    var techCounts = {};
    list.forEach(function(p) {
      p.stack.forEach(function(s) {
        techCounts[s] = (techCounts[s] || 0) + 1;
      });
    });
    var sortedTech = Object.keys(techCounts).sort(function(a,b) { return techCounts[b] - techCounts[a]; });
    bentoTech.innerHTML = sortedTech.slice(0, 15).map(function(t) {
      return '<span class="chip">' + escapeHtml(t) + ' (' + techCounts[t] + ')</span>';
    }).join(" ");

    // 4. Global Heatmap
    var heatmapSvg = document.getElementById("heatmap-svg");
    var now = new Date();
    var heatData = {}; // YYYY-MM-DD -> count
    
    // Collect all log entries across all projects
    list.forEach(function(p) {
      // Add project creation/update to heatmap
      var uDate = new Date(p.updatedAt).toISOString().split("T")[0];
      heatData[uDate] = (heatData[uDate] || 0) + 1;
      
      // Add actual log entries if we fetched them
      // PATCH: log entries use `at`, not `ts` per the API schema
      if (p._log && p._log.length) {
        p._log.forEach(function(l) {
          var lDate = new Date(l.at).toISOString().split("T")[0];
          heatData[lDate] = (heatData[lDate] || 0) + 1;
        });
      }
    });

    var days = 140; // Approx 20 weeks
    var w = 12, h = 12, gap = 4;
    var cols = Math.ceil(days / 7);
    
    heatmapSvg.setAttribute("viewBox", "0 0 " + (cols * (w+gap)) + " " + (7 * (h+gap)));
    heatmapSvg.setAttribute("width", (cols * (w+gap)));
    heatmapSvg.setAttribute("height", (7 * (h+gap)));
    
    var heatParts = [];
    var startDate = new Date(now.getTime() - (days * 24 * 60 * 60 * 1000));
    // align to Sunday
    startDate.setDate(startDate.getDate() - startDate.getDay());

    var cursor = new Date(startDate);
    for (var col = 0; col < cols; col++) {
      for (var row = 0; row < 7; row++) {
        var iso = cursor.toISOString().split("T")[0];
        var count = heatData[iso] || 0;
        
        var fill = "var(--bg-sunk)";
        if (count > 0) fill = "rgba(107, 158, 196, 0.4)";
        if (count > 2) fill = "rgba(107, 158, 196, 0.7)";
        if (count > 5) fill = "var(--accent)";
        
        var titleStr = iso + ": " + count + " updates";
        heatParts.push(
          '<rect x="'+(col*(w+gap))+'" y="'+(row*(h+gap))+'" width="'+w+'" height="'+h+'" fill="'+fill+'" rx="2">' +
          '<title>' + titleStr + '</title>' +
          '</rect>'
        );
        cursor.setDate(cursor.getDate() + 1);
      }
    }
    heatmapSvg.innerHTML = heatParts.join("");

    // 5. Project Spread Map
    var svg = document.getElementById("forecast-svg");
    var frame = document.getElementById("forecast-frame");
    var tooltip = document.getElementById("forecast-tooltip");
    tooltip.hidden = true;
    svg.innerHTML = "";

    // Dimensions
    var width = Math.max(720, frame.clientWidth - 32);
    // Increase lane height to allow stacking without overlapping
    var laneHeight = 140; 
    var laneGap = 12;
    var axisHeight = 40;
    var topPad = 20;
    var leftPad = 120; // room for lane labels
    var rightPad = 60;
    var plotW = width - leftPad - rightPad;
    var plotH = FC_LANES.length * laneHeight + (FC_LANES.length - 1) * laneGap;
    var mapHeight = topPad + plotH + axisHeight;

    svg.setAttribute("viewBox", "0 0 " + width + " " + mapHeight);
    svg.setAttribute("width", width);
    svg.setAttribute("height", mapHeight);
    
    // Auto-scroll to the right side (present day) on small screens
    requestAnimationFrame(function() {
      frame.scrollLeft = frame.scrollWidth;
    });

    var nowTime = Date.now();
    var oldest = list.reduce(function (acc, p) {
      var t = new Date(p.updatedAt).getTime();
      return !isNaN(t) && t < acc ? t : acc;
    }, nowTime);
    var minWindow = 1000 * 60 * 60 * 24 * 30 * 6; // 6 months
    var domainStart = Math.min(oldest - 1000 * 60 * 60 * 24 * 14, nowTime - minWindow);
    var domainEnd = nowTime + 1000 * 60 * 60 * 24 * 30; // 1 month future padding

    function xOf(iso) {
      var t = new Date(iso).getTime();
      if (isNaN(t)) t = domainStart;
      t = Math.max(domainStart, Math.min(domainEnd, t));
      return leftPad + ((t - domainStart) / (domainEnd - domainStart)) * plotW;
    }
    
    // Y center of a lane
    function yOfLaneCenter(areaIdx) {
      return topPad + areaIdx * (laneHeight + laneGap) + laneHeight / 2;
    }

    var parts = [];

    // Subtle Lane bands + separators
    FC_LANES.forEach(function (area, i) {
      var y = topPad + i * (laneHeight + laneGap);
      parts.push('<rect class="fc-lane-band" x="' + leftPad + '" y="' + y + '" width="' + plotW + '" height="' + laneHeight + '" fill="rgba(255,255,255,0.015)" rx="8" />');
      
      var count = list.filter(function (p) { return p.area === area; }).length;
      parts.push('<text class="fc-lane-label" x="' + (leftPad - 16) + '" y="' + (y + laneHeight / 2 - 4) + '" text-anchor="end" font-weight="600" fill="var(--text-dim)">' + fcEscAttr(areaLabel(area).toUpperCase()) + '</text>');
      parts.push('<text class="fc-lane-count" x="' + (leftPad - 16) + '" y="' + (y + laneHeight / 2 + 14) + '" text-anchor="end" font-size="0.8rem" fill="var(--text-faint)">' + count + ' project' + (count !== 1 ? "s" : "") + '</text>');
    });

    // Clean Month ticks
    var axisY = topPad + plotH + 16;
    var cursorD = new Date(domainStart);
    cursorD.setDate(1);
    cursorD.setHours(0, 0, 0, 0);
    var guard = 0;
    while (cursorD.getTime() < domainStart) { cursorD.setMonth(cursorD.getMonth() + 1); if (++guard > 60) break; }
    guard = 0;
    while (cursorD.getTime() <= domainEnd && guard < 60) {
      var px = xOf(cursorD.toISOString());
      // Subtle vertical line
      parts.push('<line class="fc-month-tick" x1="' + px + '" y1="' + topPad + '" x2="' + px + '" y2="' + (topPad + plotH) + '" stroke="var(--border)" stroke-dasharray="4 4" />');
      var label = MONTHS[cursorD.getMonth()] + (cursorD.getMonth() === 0 ? " " + cursorD.getFullYear() : "");
      parts.push('<text class="fc-month-label" x="' + px + '" y="' + axisY + '" text-anchor="middle" font-size="0.75rem" fill="var(--text-dim)">' + fcEscAttr(label) + '</text>');
      cursorD.setMonth(cursorD.getMonth() + 1);
      guard++;
    }

    // Today marker
    var todayX = xOf(new Date(nowTime).toISOString());
    parts.push('<line class="fc-today-line" x1="' + todayX + '" y1="' + topPad + '" x2="' + todayX + '" y2="' + (topPad + plotH + 8) + '" stroke="var(--accent)" stroke-width="2" />');
    parts.push('<text class="fc-today-label" x="' + todayX + '" y="' + (topPad - 8) + '" text-anchor="middle" font-size="0.7rem" font-weight="bold" fill="var(--accent)">NOW</text>');

    // Tiles — Clean track-based overlap avoidance
    var byLane = { work: [], freelance: [], personal: [] };
    list.forEach(function (p) { if (byLane[p.area]) byLane[p.area].push(p); });

    FC_LANES.forEach(function (area, i) {
      var lane = byLane[area];
      // Sort by updated date ascending
      lane.sort(function (a, b) { return new Date(a.updatedAt) - new Date(b.updatedAt); });
      
      var tracks = []; // Array of arrays containing end X coordinates for each track
      
      lane.forEach(function (p) {
        var size = fcTileSize(p);
        var cx = xOf(p.updatedAt);
        var tx = cx - size.w / 2;
        
        // Find first available track
        var trackIdx = 0;
        var padding = 12; // Gap between adjacent cards on same track
        while (true) {
          if (!tracks[trackIdx]) {
            tracks[trackIdx] = [];
            break;
          }
          var lastInTrack = tracks[trackIdx][tracks[trackIdx].length - 1];
          if (lastInTrack + padding < tx) {
            break; // No overlap!
          }
          trackIdx++;
        }
        tracks[trackIdx].push(tx + size.w);
        
        // Calculate Y based on track. Center the tracks around the lane center
        var trackOffset = 0;
        if (trackIdx > 0) {
          var dir = trackIdx % 2 === 1 ? -1 : 1;
          var step = Math.ceil(trackIdx / 2);
          trackOffset = dir * step * (size.h + 8);
        }
        
        var cy = yOfLaneCenter(i) + trackOffset;
        var ty = cy - size.h / 2;

        var tileId = "tile-" + p.id.replace(/[^a-z0-9-]/gi, "");
        var clipId = "clip-" + tileId;

        parts.push('<defs><clipPath id="' + clipId + '"><rect x="' + tx + '" y="' + ty + '" width="' + size.w + '" height="' + size.h + '" rx="6" ry="6"/></clipPath></defs>');

        // Drop shadow for tiles
        parts.push('<rect x="' + tx + '" y="' + (ty+3) + '" width="' + size.w + '" height="' + size.h + '" rx="6" fill="rgba(0,0,0,0.4)" pointer-events="none" />');

        parts.push(
          '<g class="' + fcStatusClass(p.status) + ' fc-tile-group" clip-path="url(#' + clipId + ')" ' +
          'data-id="' + fcEscAttr(p.id) + '" ' +
          'data-title="' + fcEscAttr(p.title) + '" ' +
          'data-meta="' + fcEscAttr(areaLabel(p.area) + " · " + statusLabel(p.status) + " · " + ageLabel(p.updatedAt)) + '" ' +
          'data-next="' + fcEscAttr(p.nextAction || "") + '" ' +
          'data-thumbnail="' + fcEscAttr(p.thumbnail || "") + '">'
        );

        // Tile Background
        parts.push('<rect x="' + tx + '" y="' + ty + '" width="' + size.w + '" height="' + size.h + '" fill="var(--bg-elevated)" />');

        if (p.thumbnail) {
          parts.push(
            '<image x="' + tx + '" y="' + ty + '" width="' + size.w + '" height="' + size.h +
            '" href="' + fcEscAttr(p.thumbnail) + '" preserveAspectRatio="xMidYMid slice" />'
          );
        } else {
          parts.push('<g transform="translate(' + tx + ',' + ty + ')">' + fcGlyphInner(p, size.w, size.h) + '</g>');
        }

        parts.push('<title>' + fcEscAttr(p.title + " — " + (p.nextAction || "no next action")) + '</title>');
        parts.push('</g>');

        // Border matching status (drawn on top, not clipped)
        var strokeColor = p.status === 'archived' ? 'var(--text-faint)' : (p.status === 'idea' ? 'var(--text-dim)' : 'var(--' + p.area + ')');
        parts.push(
          '<rect class="fc-tile-border fc-tile-border-' + p.status + '" ' +
          'x="' + tx + '" y="' + ty + '" width="' + size.w + '" height="' + size.h + '" rx="6" ry="6" ' +
          'pointer-events="none" stroke="' + strokeColor + '" fill="none" stroke-width="2" />'
        );
      });
    });

    svg.innerHTML = parts.join("");

    // Find nearest ancestor <g.fc-tile-group> from the event target
    function tileFromEvent(ev) {
      var node = ev.target;
      while (node && node !== svg) {
        if (node.classList && node.classList.contains("fc-tile-group")) return node;
        node = node.parentNode;
      }
      return null;
    }

    svg.onmouseleave = function () { tooltip.hidden = true; };
    svg.onmousemove = function (ev) {
      var g = tileFromEvent(ev);
      if (!g) { tooltip.hidden = true; return; }
      var title = g.getAttribute("data-title");
      var meta = g.getAttribute("data-meta");
      var nxt = g.getAttribute("data-next");
      var thumb = g.getAttribute("data-thumbnail");

      var previewHtml = "";
      if (thumb) {
        previewHtml = '<div class="ft-preview"><img src="' + fcEscAttr(thumb) + '" alt="" /></div>';
      } else {
        // Render the glyph at ~180x120 for the hover preview
        var pData = state.projects.find(function (x) { return x.id === g.getAttribute("data-id"); });
        if (pData) {
          var pw = 180, ph = 120;
          previewHtml = '<div class="ft-preview"><svg viewBox="0 0 ' + pw + ' ' + ph + '" width="' + pw + '" height="' + ph + '" xmlns="http://www.w3.org/2000/svg">' + fcGlyphInner(pData, pw, ph) + '</svg></div>';
        }
      }

      tooltip.innerHTML =
        previewHtml +
        '<div class="ft-title">' + fcEscAttr(title) + '</div>' +
        '<div class="ft-meta">' + fcEscAttr(meta) + '</div>' +
        (nxt ? '<div class="ft-next">' + fcEscAttr(nxt) + '</div>' : "");
      tooltip.hidden = false;
      var frameRect = frame.getBoundingClientRect();
      var tx = ev.clientX - frameRect.left + 14;
      var ty = ev.clientY - frameRect.top + 14;
      var tipW = tooltip.offsetWidth;
      var tipH = tooltip.offsetHeight;
      if (tx + tipW > frameRect.width - 8) tx = ev.clientX - frameRect.left - tipW - 14;
      if (ty + tipH > frameRect.height - 8) ty = ev.clientY - frameRect.top - tipH - 14;
      if (tx < 8) tx = 8;
      if (ty < 8) ty = 8;
      tooltip.style.left = tx + "px";
      tooltip.style.top = ty + "px";
    };
    svg.onclick = function (ev) {
      var g = tileFromEvent(ev);
      if (!g) return;
      var id = g.getAttribute("data-id");
      if (id) openModal(id);
    };
  }

  function renderCards(list) {
    var grid = document.getElementById("project-grid");
    var focusStrip = document.getElementById("focus-strip");
    var focusCards = document.getElementById("focus-cards");

    // Focus strip
    focusCards.innerHTML = "";
    var focus = focusCandidates();
    focusStrip.hidden = focus.length === 0;
    focus.forEach(function (p) {
      var btn = document.createElement("button");
      btn.type = "button";
      btn.className = "focus-card";
      btn.innerHTML =
        '<div class="fc-title">' + escapeHtml(p.title) + '</div>' +
        '<div class="fc-next">' + escapeHtml(p.nextAction) + '</div>' +
        '<div class="fc-meta">' + escapeHtml(areaLabel(p.area)) + ' · ' + ageLabel(p.updatedAt) + '</div>';
      btn.addEventListener("click", function () { openModal(p.id); });
      focusCards.appendChild(btn);
    });

    // Cards
    grid.innerHTML = "";
    if (list.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = state.projects.length === 0
        ? "No projects yet. Click + Project to start."
        : "Nothing matches this filter or search.";
      grid.appendChild(empty);
      return;
    }

    list.forEach(function (p) {
      grid.appendChild(buildCard(p));
    });
  }

  function buildCard(p) {
    var card = document.createElement("button");
    card.type = "button";
    card.className = "card stats-card" + (p.pinned ? " pinned" : "");
    card.setAttribute("data-area", p.area);
    card.setAttribute("aria-label", p.title);

    // 1. Cover Banner (auto-generated pattern)
    var bw = 400, bh = 80;
    var bannerSvg = '<svg viewBox="0 0 ' + bw + ' ' + bh + '" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' + fcGlyphInner(p, bw, bh) + '</svg>';
    var bannerDiv = document.createElement("div");
    bannerDiv.className = "card-banner";
    bannerDiv.innerHTML = bannerSvg;
    card.appendChild(bannerDiv);

    // 2. Avatar
    var avatarHtml = "";
    if (p.thumbnail) {
      avatarHtml = '<img src="' + escapeHtml(p.thumbnail) + '" alt="" loading="lazy" />';
    } else {
      var s = 64;
      avatarHtml = '<svg viewBox="0 0 ' + s + ' ' + s + '" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' + fcGlyphInner(p, s, s) + '</svg>';
    }
    var avatarDiv = document.createElement("div");
    avatarDiv.className = "card-avatar";
    avatarDiv.innerHTML = avatarHtml;

    // 3. Header Group
    var header = document.createElement("div");
    header.className = "card-header";
    
    var titleGroup = document.createElement("div");
    titleGroup.className = "card-title-group";
    var title = document.createElement("p");
    title.className = "card-title";
    title.textContent = p.title;
    
    var lvlStatus = document.createElement("div");
    lvlStatus.className = "card-level";
    var lvl = (p.status === 'active') ? 'LVL 5' : (p.status === 'done') ? 'LVL MAX' : (p.status === 'idea') ? 'LVL 1' : 'LVL 2';
    lvlStatus.innerHTML = '<span class="lvl-badge">' + lvl + '</span> <span class="status-badge status-' + p.status + '">' + escapeHtml(statusLabel(p.status).toUpperCase()) + '</span>';
    
    titleGroup.appendChild(title);
    titleGroup.appendChild(lvlStatus);
    
    header.appendChild(avatarDiv);
    header.appendChild(titleGroup);
    card.appendChild(header);

    // 4. Inventory (Stack)
    if (p.stack.length > 0) {
      var invBox = document.createElement("div");
      invBox.className = "card-inventory";
      var invTitle = document.createElement("div");
      invTitle.className = "inv-title";
      invTitle.textContent = "INVENTORY";
      invBox.appendChild(invTitle);
      
      var stackRow = document.createElement("div");
      stackRow.className = "card-stack";
      p.stack.slice(0, 4).forEach(function (t) {
        var chip = document.createElement("span");
        chip.className = "chip";
        chip.textContent = String(t).toUpperCase();
        stackRow.appendChild(chip);
      });
      if (p.stack.length > 4) {
        var ex = document.createElement("span");
        ex.className = "chip chip-extra";
        ex.textContent = "+" + (p.stack.length - 4);
        stackRow.appendChild(ex);
      }
      invBox.appendChild(stackRow);
      card.appendChild(invBox);
    }

    // 5. Active Quest
    var questBox = document.createElement("div");
    questBox.className = "card-quest";
    var qTitle = document.createElement("div");
    qTitle.className = "quest-title";
    qTitle.textContent = "ACTIVE QUEST";
    var qText = document.createElement("div");
    qText.className = "quest-text";
    if (p.nextAction) {
      qText.innerHTML = escapeHtml(p.nextAction);
    } else {
      qText.innerHTML = '<span style="color:var(--text-faint)">No active quest set.</span>';
    }
    questBox.appendChild(qTitle);
    questBox.appendChild(qText);
    card.appendChild(questBox);

    // 6. Meta
    var meta = document.createElement("div");
    meta.className = "card-meta";
    meta.textContent = areaLabel(p.area).toUpperCase() + " // " + ageLabel(p.updatedAt).toUpperCase();
    card.appendChild(meta);

    card.addEventListener("click", function () { openModal(p.id); });
    return card;
  }

  function renderTech(list) {
    var wrap = document.getElementById("tech-groups");
    wrap.innerHTML = "";

    // Group by stack chip. Projects with no stack go to "uncategorized".
    var groups = {};
    list.forEach(function (p) {
      if (p.stack.length === 0) {
        (groups["(no stack tagged)"] = groups["(no stack tagged)"] || []).push(p);
        return;
      }
      p.stack.forEach(function (s) {
        (groups[s] = groups[s] || []).push(p);
      });
    });

    // Sort keys by count desc, then alpha
    var keys = Object.keys(groups).sort(function (a, b) {
      var d = groups[b].length - groups[a].length;
      return d !== 0 ? d : a.localeCompare(b);
    });

    if (keys.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Nothing to group.";
      wrap.appendChild(empty);
      return;
    }

    keys.forEach(function (k) {
      var group = document.createElement("div");
      group.className = "tech-group";
      var head = document.createElement("div");
      head.className = "tech-group-header";
      head.innerHTML =
        '<span class="tech-group-title">' + escapeHtml(k) + '</span>' +
        '<span class="tech-group-count">' + groups[k].length + ' project' + (groups[k].length !== 1 ? "s" : "") + '</span>';
      var listEl = document.createElement("div");
      listEl.className = "tech-list";
      groups[k].forEach(function (p) {
        var item = document.createElement("button");
        item.type = "button";
        item.className = "tech-item";
        item.setAttribute("data-area", p.area);
        item.innerHTML =
          '<span class="tech-item-dot" aria-hidden="true"></span>' +
          '<span class="tech-item-title">' + escapeHtml(p.title) + '</span>' +
          '<span class="tech-item-status">' + escapeHtml(statusLabel(p.status)) + '</span>';
        item.addEventListener("click", function () { openModal(p.id); });
        listEl.appendChild(item);
      });
      group.appendChild(head);
      group.appendChild(listEl);
      wrap.appendChild(group);
    });
  }

  function renderTimeline(list) {
    var wrap = document.getElementById("timeline-list");
    wrap.innerHTML = "";

    // Sort by updatedAt desc, group by month
    var sorted = list.slice().sort(function (a, b) { return new Date(b.updatedAt) - new Date(a.updatedAt); });
    if (sorted.length === 0) {
      var empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "Nothing to show.";
      wrap.appendChild(empty);
      return;
    }

    var groups = {};
    var order = [];
    sorted.forEach(function (p) {
      var k = monthKey(p.updatedAt);
      if (!groups[k]) { groups[k] = []; order.push(k); }
      groups[k].push(p);
    });

    order.forEach(function (k) {
      var g = document.createElement("div");
      g.className = "timeline-group";
      var h = document.createElement("h3");
      h.className = "timeline-month";
      h.textContent = monthLabel(k);
      var items = document.createElement("div");
      items.className = "timeline-items";
      groups[k].forEach(function (p) {
        var btn = document.createElement("button");
        btn.type = "button";
        btn.className = "timeline-item";
        btn.setAttribute("data-area", p.area);
        var d = new Date(p.updatedAt);
        var dateStr = isNaN(d.getTime()) ? "" : (MONTHS[d.getMonth()] + " " + d.getDate());
        btn.innerHTML =
          '<span class="timeline-date">' + escapeHtml(dateStr) + '</span>' +
          '<span class="timeline-title">' + escapeHtml(p.title) + '</span>' +
          '<span class="timeline-status">' + escapeHtml(statusLabel(p.status)) + '</span>';
        btn.addEventListener("click", function () { openModal(p.id); });
        items.appendChild(btn);
      });
      g.appendChild(h);
      g.appendChild(items);
      wrap.appendChild(g);
    });
  }

  // ============================================================
  // Toast
  // ============================================================
  function toast(msg, isError) {
    var t = document.getElementById("toast");
    t.textContent = msg;
    t.classList.remove("error");
    if (isError) t.classList.add("error");
    t.classList.add("show");
    clearTimeout(toast._timer);
    toast._timer = setTimeout(function () { t.classList.remove("show"); }, 2800);
  }

  // ============================================================
  // Modal / dossier
  // ============================================================

  function openModal(id) {
    state.editingId = id;
    var p = state.projects.find(function (x) { return x.id === id; });
    if (!p) return;

    var sub = [];
    if (p.area) sub.push(areaLabel(p.area));
    if (p.status) sub.push(statusLabel(p.status));
    if (p.pinned) sub.push("pinned");
    sub.push("updated " + ageLabel(p.updatedAt));
    document.getElementById("modal-sub").textContent = sub.join(" · ");

    // Generate Modal Banner and Avatar
    var bw = 800, bh = 120;
    document.getElementById("modal-banner").innerHTML = '<svg viewBox="0 0 ' + bw + ' ' + bh + '" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' + fcGlyphInner(p, bw, bh) + '</svg>';
    
    var avatarHtml = "";
    if (p.thumbnail) {
      avatarHtml = '<img src="' + escapeHtml(p.thumbnail) + '" alt="" loading="lazy" />';
    } else {
      var s = 80;
      avatarHtml = '<svg viewBox="0 0 ' + s + ' ' + s + '" width="100%" height="100%" preserveAspectRatio="xMidYMid slice" xmlns="http://www.w3.org/2000/svg">' + fcGlyphInner(p, s, s) + '</svg>';
    }
    document.getElementById("modal-avatar").innerHTML = avatarHtml;

    document.getElementById("f-title").value = p.title;
    document.getElementById("f-area").value = p.area;
    document.getElementById("f-status").value = p.status;
    document.getElementById("f-pinned").checked = p.pinned;
    document.getElementById("f-next").value = p.nextAction;
    document.getElementById("f-notes").value = p.notes;
    document.getElementById("f-tags").value = p.tags.join(", ");
    document.getElementById("f-primary-path").value = p.primaryPath;
    
    var fLiveUrl = document.getElementById("f-live-url");
    var btnOpenUrl = document.getElementById("btn-open-live-url");
    fLiveUrl.value = p.liveUrl;
    var handleUrlChange = function() {
      var v = fLiveUrl.value.trim();
      if(v.startsWith("http")) {
        btnOpenUrl.href = v;
        btnOpenUrl.style.opacity = 1;
        btnOpenUrl.style.pointerEvents = "auto";
      } else {
        btnOpenUrl.removeAttribute("href");
        btnOpenUrl.style.opacity = 0.5;
        btnOpenUrl.style.pointerEvents = "none";
      }
    };
    fLiveUrl.removeEventListener("input", fLiveUrl._urlHandler);
    fLiveUrl._urlHandler = handleUrlChange;
    fLiveUrl.addEventListener("input", handleUrlChange);
    handleUrlChange();
    
    document.getElementById("f-thumbnail").value = p.thumbnail || "";
    document.getElementById("f-stack").value = p.stack.join(", ");
    document.getElementById("f-dossier").value = p.dossier;

    renderPathsEditor(p.docPaths);
    renderLinksEditor(p.links);
    renderRelatedEditor(p.related);

    autoSizeTextareas();

    // Load log + reflections (online if possible, else local mirror)
    state.currentLog = (p._log && p._log.length) ? p._log.slice() : [];
    state.currentReflections = [];
    renderLog();
    renderReflectHistory();
    document.getElementById("reflect-answer").hidden = true;
    document.getElementById("reflect-question").value = "";
    setConn(state.online); // Re-apply offline / online hint to reflect button + status

    if (state.online) {
      apiFetch("/projects/" + encodeURIComponent(id)).then(function (data) {
        if (state.editingId !== id) return;
        state.currentLog = data.log || [];
        state.currentReflections = data.reflections || [];
        renderLog();
        renderReflectHistory();
      }, function () {});
    }

    document.getElementById("quick-log-input").value = "";
    document.getElementById("project-modal").showModal();
    clearDirty();
    setSaveIndicator("saved");
  }

  function openNewModal() {
    state.editingId = "new";
    document.getElementById("modal-sub").textContent = "draft";
    document.getElementById("modal-banner").innerHTML = "";
    document.getElementById("modal-avatar").innerHTML = "";
    document.getElementById("f-title").value = "";
    document.getElementById("f-area").value = "personal";
    document.getElementById("f-status").value = "active";
    document.getElementById("f-pinned").checked = false;
    document.getElementById("f-next").value = "";
    document.getElementById("f-notes").value = "";
    document.getElementById("f-tags").value = "";
    document.getElementById("f-primary-path").value = "";
    document.getElementById("f-live-url").value = "";
    document.getElementById("f-thumbnail").value = "";
    document.getElementById("f-stack").value = "";
    document.getElementById("f-dossier").value = "";
    renderPathsEditor([]);
    renderLinksEditor([]);
    renderRelatedEditor([]);
    state.currentLog = [];
    state.currentReflections = [];
    renderLog();
    renderReflectHistory();
    document.getElementById("reflect-answer").hidden = true;
    document.getElementById("reflect-question").value = "";
    setReflectStatus("Save the project first, then Reflect becomes available.", "offline");
    document.getElementById("quick-log-input").value = "";
    document.getElementById("project-modal").showModal();
    document.getElementById("f-title").focus();
    autoSizeTextareas();
    clearDirty();
    setSaveIndicator("draft");
  }

  function renderLinksEditor(links) {
    var wrap = document.getElementById("links-editor");
    wrap.innerHTML = "";
    var list = links.length ? links.slice() : [{ label: "", url: "" }];
    list.forEach(function (l, i) {
      var row = document.createElement("div");
      row.className = "row path-row";
      
      var linkHref = (l.url && l.url.startsWith("http")) ? escapeHtml(l.url) : "#";
      var linkPointer = (l.url && l.url.startsWith("http")) ? "auto" : "none";
      var linkOpac = (l.url && l.url.startsWith("http")) ? "1" : "0.5";
      
      row.innerHTML =
        '<input type="text" placeholder="Label" class="link-label" value="' + escapeHtml(l.label) + '" style="flex: 1; min-width: 0;" />' +
        '<input type="url" placeholder="https://…" class="link-url" value="' + escapeHtml(l.url) + '" style="flex: 1.5; min-width: 0;" />' +
        '<a href="'+linkHref+'" target="_blank" class="btn btn-ghost open-link-btn" title="Open Link" style="padding:0 0.5rem; opacity:'+linkOpac+'; pointer-events:'+linkPointer+';"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg></a>' +
        '<button type="button" class="btn btn-ghost link-remove">×</button>';
      wrap.appendChild(row);
      
      var urlInp = row.querySelector(".link-url");
      var openBtn = row.querySelector(".open-link-btn");
      urlInp.addEventListener("input", function() {
         var v = this.value.trim();
         if(v.startsWith("http")) { 
           openBtn.href = v; openBtn.style.opacity = 1; openBtn.style.pointerEvents = "auto"; 
         } else { 
           openBtn.removeAttribute("href"); openBtn.style.opacity = 0.5; openBtn.style.pointerEvents = "none"; 
         }
      });
    });
    var add = document.createElement("button");
    add.type = "button";
    add.className = "btn btn-ghost";
    add.style.marginTop = "0.25rem";
    add.textContent = "+ Add link";
    add.addEventListener("click", function () {
      var cur = collectLinks();
      cur.push({ label: "", url: "" });
      renderLinksEditor(cur);
    });
    wrap.appendChild(add);
    wrap.querySelectorAll(".link-remove").forEach(function (btn, i) {
      btn.addEventListener("click", function () {
        var cur = collectLinks();
        cur.splice(i, 1);
        renderLinksEditor(cur);
      });
    });
  }
  function collectLinks() {
    var rows = document.getElementById("links-editor").querySelectorAll(".row");
    var out = [];
    rows.forEach(function (row) {
      var label = row.querySelector(".link-label");
      var url = row.querySelector(".link-url");
      if (!label || !url) return;
      var l = label.value.trim();
      var u = url.value.trim();
      if (l || u) out.push({ label: l || u, url: u });
    });
    return out;
  }

  function renderPathsEditor(paths) {
    var wrap = document.getElementById("paths-editor");
    wrap.innerHTML = "";
    var list = paths.length ? paths.slice() : [""];
    list.forEach(function (path, i) {
      var row = document.createElement("div");
      row.className = "row";
      var inp = document.createElement("input");
      inp.type = "text";
      inp.placeholder = "e.g. zane/server/index.mjs";
      inp.value = path;
      inp.className = "path-input";
      var copy = document.createElement("button");
      copy.type = "button";
      copy.className = "btn btn-ghost";
      copy.textContent = "Copy";
      copy.addEventListener("click", function () { copyToClipboard(inp.value); });
      var rm = document.createElement("button");
      rm.type = "button";
      rm.className = "btn btn-ghost";
      rm.textContent = "×";
      rm.addEventListener("click", function () {
        var cur = collectPaths();
        cur.splice(i, 1);
        renderPathsEditor(cur);
      });
      row.appendChild(inp);
      row.appendChild(copy);
      row.appendChild(rm);
      wrap.appendChild(row);
    });
    var add = document.createElement("button");
    add.type = "button";
    add.className = "btn btn-ghost";
    add.style.marginTop = "0.25rem";
    add.textContent = "+ Add path";
    add.addEventListener("click", function () {
      var cur = collectPaths();
      cur.push("");
      renderPathsEditor(cur);
    });
    wrap.appendChild(add);
  }
  function collectPaths() {
    var inputs = document.getElementById("paths-editor").querySelectorAll(".path-input");
    var out = [];
    inputs.forEach(function (inp) {
      var v = inp.value.trim();
      if (v) out.push(v);
    });
    return out;
  }

  function renderRelatedEditor(relatedIds) {
    var wrap = document.getElementById("related-editor");
    wrap.innerHTML = "";
    relatedIds.forEach(function (rid) {
      var target = state.projects.find(function (x) { return x.id === rid; });
      if (!target) return;
      var chip = document.createElement("span");
      chip.className = "related-chip";
      chip.innerHTML = '<span>' + escapeHtml(target.title) + '</span> <button type="button" class="related-chip-x" aria-label="Remove">×</button>';
      chip.addEventListener("click", function (e) {
        if (e.target.classList.contains("related-chip-x")) {
          wrap.removeChild(chip);
        } else {
          openModal(rid);
        }
      });
      chip.setAttribute("data-id", rid);
      wrap.appendChild(chip);
    });
    var add = document.createElement("button");
    add.type = "button";
    add.className = "btn btn-ghost";
    add.textContent = "+ Add";
    add.style.minHeight = "32px";
    add.style.padding = "0 0.65rem";
    add.style.fontSize = "0.8rem";
    add.addEventListener("click", function () {
      var pick = prompt(
        "Link to which project? Type part of the title:\n\n" +
        state.projects
          .filter(function (p) { return p.id !== state.editingId; })
          .slice(0, 40)
          .map(function (p) { return "- " + p.title; })
          .join("\n")
      );
      if (!pick) return;
      var q = pick.toLowerCase().trim();
      var hit = state.projects.find(function (p) {
        return p.id !== state.editingId && p.title.toLowerCase().indexOf(q) >= 0;
      });
      if (!hit) { toast("No match", true); return; }
      if (wrap.querySelector('[data-id="' + hit.id + '"]')) { toast("Already linked"); return; }
      var cur = collectRelated();
      cur.push(hit.id);
      renderRelatedEditor(cur);
    });
    wrap.appendChild(add);
  }
  function collectRelated() {
    var chips = document.getElementById("related-editor").querySelectorAll(".related-chip");
    var out = [];
    chips.forEach(function (c) {
      var id = c.getAttribute("data-id");
      if (id) out.push(id);
    });
    return out;
  }

  function renderLog() {
    var el = document.getElementById("log-list");
    el.innerHTML = "";
    if (!state.currentLog || !state.currentLog.length) {
      el.innerHTML = '<p style="margin:0;color:var(--text-faint);font-size:0.85rem">No entries yet.</p>';
      return;
    }
    var ul = document.createElement("ul");
    state.currentLog.forEach(function (entry) {
      var li = document.createElement("li");
      var t = document.createElement("time");
      t.dateTime = entry.at;
      t.textContent = formatDate(entry.at) + " — ";
      li.appendChild(t);
      li.appendChild(document.createTextNode(entry.text));
      ul.appendChild(li);
    });
    el.appendChild(ul);
  }

  function renderReflectHistory() {
    var el = document.getElementById("reflect-history");
    el.innerHTML = "";
    if (!state.currentReflections || !state.currentReflections.length) {
      el.innerHTML = '<p style="margin:0;color:var(--text-faint);font-size:0.85rem">No saved reflections yet.</p>';
      return;
    }
    state.currentReflections.forEach(function (r) {
      var item = document.createElement("div");
      item.className = "reflect-history-item";
      item.innerHTML =
        '<div class="reflect-history-q">' + escapeHtml(r.question) + '</div>' +
        '<div class="reflect-history-a">' + escapeHtml(r.answer) + '</div>' +
        '<div class="reflect-history-at">' + formatDate(r.at) + '</div>';
      item.addEventListener("click", function () { item.classList.toggle("expanded"); });
      el.appendChild(item);
    });
  }

  // Grow textareas to fit content so the modal scrolls as one page,
  // not as a stack of independently-scrolling boxes.
  function autoSize(el) {
    if (!el) return;
    el.style.height = "auto";
    el.style.height = (el.scrollHeight + 2) + "px";
  }
  function autoSizeTextareas() {
    var ids = ["f-notes", "f-dossier", "reflect-question"];
    ids.forEach(function (id) { autoSize(document.getElementById(id)); });
  }

  function setSaveIndicator(status) {
    var el = document.getElementById("save-indicator");
    if (!el) return;
    var labels = {
      saved: "saved",
      saving: "saving…",
      dirty: "unsaved changes",
      draft: "new — click save to create",
      error: "save error",
    };
    el.className = "save-indicator mono " + (status || "");
    el.textContent = labels[status] || "";
  }

  function markDirty() {
    state.dirty = true;
    if (state.editingId === "new") {
      setSaveIndicator("draft");
      return;
    }
    setSaveIndicator("dirty");
    if (state.autoSaveTimer) clearTimeout(state.autoSaveTimer);
    state.autoSaveTimer = setTimeout(function () {
      saveModal({ close: false, silent: true });
    }, AUTOSAVE_DEBOUNCE_MS);
  }

  function clearDirty() {
    state.dirty = false;
    if (state.autoSaveTimer) { clearTimeout(state.autoSaveTimer); state.autoSaveTimer = null; }
  }

  function closeModalSafely() {
    var modal = document.getElementById("project-modal");
    if (state.dirty && state.editingId !== "new" && document.getElementById("f-title").value.trim()) {
      saveModal({ close: true, silent: true });
    } else {
      clearDirty();
      modal.close();
    }
  }

  function saveModal(opts) {
    opts = opts || {};
    var doClose = opts.close !== false;
    var silent = !!opts.silent;
    var title = document.getElementById("f-title").value.trim();
    if (!title) {
      if (silent) return; // skip silent autosave when title is missing
      toast("Title required", true);
      document.getElementById("f-title").focus();
      return;
    }
    var tags = document.getElementById("f-tags").value.split(",").map(function (t) { return t.trim(); }).filter(Boolean);
    var stack = document.getElementById("f-stack").value.split(",").map(function (t) { return t.trim(); }).filter(Boolean);

    var input = {
      title: title,
      area: document.getElementById("f-area").value,
      status: document.getElementById("f-status").value,
      pinned: document.getElementById("f-pinned").checked,
      nextAction: document.getElementById("f-next").value,
      notes: document.getElementById("f-notes").value,
      dossier: document.getElementById("f-dossier").value,
      primaryPath: document.getElementById("f-primary-path").value,
      liveUrl: document.getElementById("f-live-url").value,
      thumbnail: document.getElementById("f-thumbnail").value,
      stack: stack,
      tags: tags,
      links: collectLinks(),
      docPaths: collectPaths(),
      related: collectRelated(),
    };

    setSaveIndicator("saving");
    try {
      if (state.editingId === "new") {
        input.id = uid();
        input.createdAt = nowIso();
        var newP = normalizeProject(input);
        persistCreate(newP);
        state.editingId = newP.id;
      } else {
        var existing = state.projects.find(function (x) { return x.id === state.editingId; });
        if (!existing) return;
        input.id = existing.id;
        input.createdAt = existing.createdAt;
        var merged = normalizeProject(Object.assign({}, existing, input));
        persistUpdate(merged);
      }
      clearDirty();
      setSaveIndicator("saved");
      render();
      if (!silent) toast("Saved");
      if (doClose) document.getElementById("project-modal").close();
    } catch (e) {
      setSaveIndicator("error");
      if (!silent) toast("Save failed: " + (e && e.message ? e.message : "unknown"), true);
    }
  }

  function deleteCurrent() {
    if (state.editingId === "new") { document.getElementById("project-modal").close(); return; }
    if (!confirm("Delete this project? This cannot be undone.")) return;
    persistDelete(state.editingId);
    render();
    toast("Deleted");
    document.getElementById("project-modal").close();
  }

  function appendQuickLog() {
    if (state.editingId === "new") { toast("Save the project first", true); return; }
    var text = document.getElementById("quick-log-input").value.trim();
    if (!text) return;
    var entry = persistLog(state.editingId, text);
    if (entry) {
      state.currentLog.unshift(entry);
      document.getElementById("quick-log-input").value = "";
      renderLog();
      render();
      toast("Logged");
    }
  }

  function copyToClipboard(text) {
    if (!text) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { toast("Copied"); },
        function () { toast("Copy failed", true); }
      );
    } else {
      // fallback
      var ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand("copy"); toast("Copied"); }
      catch (e) { toast("Copy failed", true); }
      document.body.removeChild(ta);
    }
  }

  // ============================================================
  // Reflect
  // ============================================================

  function setReflectStatus(text, kind) {
    var statusEl = document.getElementById("reflect-status");
    statusEl.className = "reflect-status mono" + (kind ? " " + kind : "");
    statusEl.textContent = text || "";
  }

  function askReflect(question) {
    if (state.reflectBusy) return;
    if (state.editingId === "new") {
      setReflectStatus("Save the project first, then ask.", "error");
      return;
    }
    if (!state.online) {
      setReflectStatus("Reflect needs cloud mode — deploy the Worker first. See atlas/DEPLOY.md.", "error");
      return;
    }
    var q = String(question || document.getElementById("reflect-question").value || "").trim();
    if (!q) { setReflectStatus("Type a question or pick a preset.", "error"); return; }

    var p = state.projects.find(function (x) { return x.id === state.editingId; });
    if (!p) return;

    state.reflectBusy = true;
    var statusEl = document.getElementById("reflect-status");
    var answerEl = document.getElementById("reflect-answer");
    statusEl.innerHTML = '<span class="spinner"></span> Thinking…';
    statusEl.className = "reflect-status mono working";
    answerEl.hidden = true;
    document.getElementById("btn-reflect").disabled = true;

    var payload = {
      project: p,
      question: q,
      recentLog: (state.currentLog || []).slice(0, 10),
    };

    apiFetch("/reflect", { method: "POST", body: JSON.stringify(payload) }).then(
      function (data) {
        var answer = data.answer || "(no answer)";
        answerEl.textContent = answer;
        answerEl.hidden = false;
        statusEl.textContent = "";
        statusEl.className = "reflect-status mono";
        // Save locally so history shows it right away
        var entry = { id: uid("ref"), at: nowIso(), question: q, answer: answer };
        state.currentReflections.unshift(entry);
        renderReflectHistory();
      },
      function (e) {
        statusEl.textContent = "Error: " + (e.message || "unknown");
        statusEl.className = "reflect-status mono error";
      }
    ).then(function () {
      state.reflectBusy = false;
      document.getElementById("btn-reflect").disabled = false;
    });
  }

  // ============================================================
  // Import / Export
  // ============================================================

  function exportJson() {
    var blob = new Blob(
      [JSON.stringify({ version: 1, projects: state.projects }, null, 2)],
      { type: "application/json" }
    );
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "atlas-backup-" + nowIso().slice(0, 10) + ".json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Download started");
  }

  // Accept { projects: [...] }, a bare array, or a single project object.
  function importPayloadToList(data) {
    if (!data) return null;
    if (Array.isArray(data)) return data;
    if (Array.isArray(data.projects)) return data.projects;
    if (data.id || data.title) return [data];
    return null;
  }

  // Find groups of likely-duplicate projects (case-insensitive title match).
  function findDuplicateGroups(projects) {
    var by = {};
    (projects || []).forEach(function (p) {
      var key = (p.title || "").trim().toLowerCase();
      if (!key) return;
      (by[key] = by[key] || []).push(p);
    });
    var out = [];
    Object.keys(by).forEach(function (k) {
      if (by[k].length > 1) out.push({ key: k, items: by[k] });
    });
    return out;
  }

  // Pick the "richest" record in a group as the survivor.
  function pickWinner(items) {
    return items.slice().sort(function (a, b) {
      var aThumb = a.thumbnail ? 1 : 0, bThumb = b.thumbnail ? 1 : 0;
      if (aThumb !== bThumb) return bThumb - aThumb;
      var aLen = ((a.dossier || "") + (a.notes || "")).length;
      var bLen = ((b.dossier || "") + (b.notes || "")).length;
      if (aLen !== bLen) return bLen - aLen;
      var aLinks = (a.links || []).length, bLinks = (b.links || []).length;
      if (aLinks !== bLinks) return bLinks - aLinks;
      return (b.updatedAt || "").localeCompare(a.updatedAt || "");
    })[0];
  }

  // Merge loser's data into winner without losing anything informative.
  function combineProjects(winner, loser) {
    var out = Object.assign({}, winner);
    ["notes", "dossier", "nextAction", "liveUrl", "primaryPath", "thumbnail"].forEach(function (k) {
      var w = winner[k] || "", l = loser[k] || "";
      if (l && l.length > w.length) out[k] = l;
    });
    ["stack", "tags", "docPaths", "related"].forEach(function (k) {
      var seen = {}, merged = [];
      (winner[k] || []).concat(loser[k] || []).forEach(function (v) {
        var key = String(v).trim().toLowerCase();
        if (!key || seen[key]) return;
        seen[key] = true;
        merged.push(v);
      });
      out[k] = merged;
    });
    var seen = {}, links = [];
    (winner.links || []).concat(loser.links || []).forEach(function (link) {
      if (!link || (!link.url && !link.label)) return;
      var key = (link.url || link.label).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      links.push(link);
    });
    out.links = links;
    out.pinned = !!(winner.pinned || loser.pinned);
    return out;
  }

  // Auto-merge every duplicate group: keep the richest record, fold in the rest, delete losers.
  function autoMergeDuplicates() {
    var groups = findDuplicateGroups(state.projects);
    if (groups.length === 0) { toast("No duplicates"); return; }
    var totalLosers = 0;
    groups.forEach(function (g) {
      var winner = pickWinner(g.items);
      g.items.forEach(function (item) {
        if (item.id === winner.id) return;
        winner = combineProjects(winner, item);
      });
      // Apply merged winner to local state + server.
      var idx = state.projects.findIndex(function (p) { return p.id === winner.id; });
      if (idx >= 0) state.projects[idx] = winner;
      persistUpdate(winner);
      // Drop losers.
      g.items.forEach(function (item) {
        if (item.id === winner.id) return;
        state.projects = state.projects.filter(function (p) { return p.id !== item.id; });
        persistDelete(item.id);
        totalLosers++;
      });
    });
    saveToStorage();
    render();
    toast("Combined " + totalLosers + " duplicate" + (totalLosers === 1 ? "" : "s"));
  }

  // Upsert by id: update if id matches an existing project, otherwise create.
  function mergeImported(data) {
    var list = importPayloadToList(data);
    if (!list) { toast("Invalid file", true); return; }
    var byId = {};
    var byTitle = {};
    state.projects.forEach(function (p, i) {
      byId[p.id] = i;
      var t = (p.title || "").trim().toLowerCase();
      if (t && !(t in byTitle)) byTitle[t] = i;
    });

    var updated = 0, created = 0, mergedByTitle = 0;
    list.forEach(function (raw) {
      var idx = raw && raw.id ? byId[raw.id] : undefined;
      // Title-match fallback: if id doesn't exist locally but a project with
      // the same title does, fold the imported record into that one instead
      // of creating a duplicate.
      if (idx === undefined) {
        var t = ((raw && raw.title) || "").trim().toLowerCase();
        if (t && t in byTitle) {
          idx = byTitle[t];
          mergedByTitle++;
        }
      }
      if (idx !== undefined) {
        var existing = state.projects[idx];
        var merged = normalizeProject(Object.assign({}, existing, raw, {
          id: existing.id,
          createdAt: existing.createdAt,
        }));
        state.projects[idx] = merged;
        if (state.online) {
          apiFetch("/projects/" + encodeURIComponent(merged.id), {
            method: "PUT", body: JSON.stringify(merged),
          }).catch(function () {});
        }
        updated++;
      } else {
        var n = normalizeProject(raw || {});
        if (!n.id) n.id = uid();
        while (byId[n.id] !== undefined) { n.id = uid(); }
        byId[n.id] = state.projects.length;
        var nt = (n.title || "").trim().toLowerCase();
        if (nt && !(nt in byTitle)) byTitle[nt] = state.projects.length;
        state.projects.push(n);
        if (state.online) {
          apiFetch("/projects", { method: "POST", body: JSON.stringify(n) }).catch(function () {});
        }
        created++;
      }
    });
    saveToStorage();
    render();
    var parts = [];
    if (updated) parts.push("updated " + updated);
    if (created) parts.push("created " + created);
    if (mergedByTitle) parts.push(mergedByTitle + " by title");
    toast("Import: " + (parts.join(", ") || "no changes"));
  }

  function replaceAll(data) {
    var list = importPayloadToList(data);
    if (!list) { toast("Invalid file", true); return; }
    state.projects = list.map(normalizeProject);
    saveToStorage();
    render();
    toast("Replaced with imported data");
  }

  // ============================================================
  // Wiring
  // ============================================================

  function wire() {
    // Top toolbar
    document.getElementById("btn-new").addEventListener("click", openNewModal);
    document.getElementById("btn-export").addEventListener("click", exportJson);
    document.getElementById("btn-import").addEventListener("click", function () {
      document.getElementById("import-file").click();
    });
    document.getElementById("import-file").addEventListener("change", function (e) {
      var f = e.target.files && e.target.files[0];
      e.target.value = "";
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(reader.result);
          var merge = confirm("OK = upsert (update by id, create if new).\nCancel = replace all projects with file.");
          if (merge) mergeImported(data);
          else replaceAll(data);
        } catch (err) { toast("Invalid JSON", true); }
      };
      reader.readAsText(f);
    });

    // Image upload to Base64
    window.handleThumbUpload = function(e) {
      var f = e.target.files && e.target.files[0];
      if (!f) return;
      var reader = new FileReader();
      reader.onload = function(evt) {
        var img = new Image();
        img.onload = function() {
          var canvas = document.createElement("canvas");
          var ctx = canvas.getContext("2d");
          var size = 150;
          canvas.width = size;
          canvas.height = size;
          var minDim = Math.min(img.width, img.height);
          var sx = (img.width - minDim) / 2;
          var sy = (img.height - minDim) / 2;
          ctx.drawImage(img, sx, sy, minDim, minDim, 0, 0, size, size);
          var dataUrl = canvas.toDataURL("image/jpeg", 0.6);
          document.getElementById("f-thumbnail").value = dataUrl;
        };
        img.src = evt.target.result;
      };
      reader.readAsDataURL(f);
    };

    var searchEl = document.getElementById("search");
    var agentStrip = document.getElementById("agent-strip");
    var agentLoader = document.getElementById("agent-loader");
    var agentMsg = document.getElementById("agent-msg");
    var agentActions = document.getElementById("agent-actions");
    var agentConfirmBtn = document.getElementById("btn-agent-confirm");
    var agentPendingMutations = null;

    searchEl.addEventListener("input", function (e) {
      // If starts with ?, it's for the agent, don't local filter yet.
      if (e.target.value.trim().startsWith("?")) return;
      state.search = e.target.value;
      render();
    });

    searchEl.addEventListener("keydown", function (e) {
      if (e.key === "Enter") {
        var val = searchEl.value.trim();
        if (!val) return;
        if (val.startsWith("?")) val = val.substring(1).trim();
        if (!val) return;
        
        agentStrip.hidden = false;
        agentLoader.hidden = false;
        agentMsg.textContent = "";
        agentActions.hidden = true;
        agentPendingMutations = null;
        agentConfirmBtn.disabled = false;
        agentConfirmBtn.textContent = "Apply changes";

        apiFetch("/agent", {
          method: "POST",
          body: JSON.stringify({ query: val })
        }).then(function(res) {
          agentLoader.hidden = true;
          agentMsg.innerHTML = "<strong>Atlas:</strong> " + escapeHtml(res.message || "Done.");
          
          if (res.view_patch) {
            if (res.view_patch.layout) state.view = res.view_patch.layout;
            if (res.view_patch.area) state.filterArea = res.view_patch.area;
            if (res.view_patch.filter !== undefined) {
              state.search = res.view_patch.filter || "";
              searchEl.value = state.search;
            }
            
            document.querySelectorAll(".view-tabs button").forEach(function (b) {
              b.setAttribute("aria-pressed", b.getAttribute("data-view") === state.view ? "true" : "false");
            });
            document.querySelectorAll(".area-tabs button").forEach(function (b) {
              b.setAttribute("aria-pressed", b.getAttribute("data-area") === state.filterArea ? "true" : "false");
            });
            render();
          }

          if (res.mutations && res.mutations.length > 0) {
            agentPendingMutations = res.mutations;
            agentActions.hidden = false;
          }
        }).catch(function(err) {
          agentLoader.hidden = true;
          agentMsg.innerHTML = '<span style="color:var(--danger)">Error: ' + escapeHtml(err.message) + '</span>';
        });
      }
    });

    document.getElementById("btn-agent-close").addEventListener("click", function() {
      agentStrip.hidden = true;
      searchEl.value = "";
      state.search = "";
      render();
    });

    agentConfirmBtn.addEventListener("click", function() {
      if (!agentPendingMutations) return;
      agentConfirmBtn.disabled = true;
      agentConfirmBtn.textContent = "Applying...";
      
      var chain = Promise.resolve();
      agentPendingMutations.forEach(function(m) {
        chain = chain.then(function() {
          if (m.type === "create_project") {
            return apiFetch("/projects", { method: "POST", body: JSON.stringify(m.payload) });
          } else if (m.type === "update_project") {
            return apiFetch("/projects/" + m.payload.id, { method: "PUT", body: JSON.stringify(m.payload) });
          }
        });
      });
      
      chain.then(function() {
        agentConfirmBtn.textContent = "Done!";
        setTimeout(function() { agentStrip.hidden = true; }, 1500);
        searchEl.value = "";
        state.search = "";
        return tryOnlineList().then(function(list) {
          state.projects = list;
          // PATCH: was saveLocal(), corrected to saveToStorage()
          saveToStorage();
          render();
        });
      }).catch(function(err) {
        agentConfirmBtn.textContent = "Failed";
        agentMsg.innerHTML = '<span style="color:var(--danger)">Error: ' + escapeHtml(err.message) + '</span>';
      });
    });

    // Area filter
    document.querySelectorAll(".area-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.filterArea = btn.getAttribute("data-area") || "all";
        document.querySelectorAll(".area-tabs button").forEach(function (b) {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        render();
      });
    });

    // View toggle
    document.querySelectorAll(".view-tabs button").forEach(function (btn) {
      btn.addEventListener("click", function () {
        state.view = btn.getAttribute("data-view") || "cards";
        document.querySelectorAll(".view-tabs button").forEach(function (b) {
          b.setAttribute("aria-pressed", b === btn ? "true" : "false");
        });
        render();
      });
    });

    // Modal
    document.getElementById("btn-close-modal").addEventListener("click", closeModalSafely);
    document.getElementById("btn-save-modal").addEventListener("click", function () { saveModal({ close: true }); });
    document.getElementById("btn-delete-modal").addEventListener("click", deleteCurrent);
    document.getElementById("btn-quick-log").addEventListener("click", appendQuickLog);
    document.getElementById("quick-log-input").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); appendQuickLog(); }
    });

    // Dirty-tracking: any field change in the modal flags as dirty
    // and (for existing projects) schedules a debounced auto-save.
    var modalEl = document.getElementById("project-modal");
    var EXCLUDE_IDS = { "quick-log-input": 1, "reflect-question": 1, "search": 1 };
    var dirtyHandler = function (e) {
      var t = e.target;
      if (!t || EXCLUDE_IDS[t.id]) return;
      if (t.matches("input, textarea, select")) markDirty();
    };
    modalEl.addEventListener("input", function (e) {
      dirtyHandler(e);
      if (e.target && e.target.tagName === "TEXTAREA") autoSize(e.target);
    });
    modalEl.addEventListener("change", dirtyHandler);
    // Adding/removing list-editor rows is a click; treat as dirty.
    ["paths-editor", "links-editor", "related-editor"].forEach(function (id) {
      var el = document.getElementById(id);
      if (!el) return;
      el.addEventListener("click", function (e) {
        if (e.target.closest("button")) markDirty();
      });
    });
    // Click on the dialog's backdrop closes (and saves if dirty).
    modalEl.addEventListener("click", function (e) {
      if (e.target === modalEl) closeModalSafely();
    });

    // Dossier tabs
    document.querySelectorAll(".dossier-tabs button").forEach(function (b) {
      b.addEventListener("click", function () { switchTab(b.getAttribute("data-tab")); });
    });

    // Copy primary path
    document.getElementById("btn-copy-primary").addEventListener("click", function () {
      copyToClipboard(document.getElementById("f-primary-path").value.trim());
    });

    // Reflect
    document.getElementById("btn-reflect").addEventListener("click", function () { askReflect(); });
    document.querySelectorAll(".reflect-preset").forEach(function (b) {
      b.addEventListener("click", function () {
        var q = b.getAttribute("data-q") || "";
        document.getElementById("reflect-question").value = q;
        askReflect(q);
      });
    });

    document.getElementById("project-modal").addEventListener("cancel", function (e) {
      e.preventDefault();
      closeModalSafely();
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    wire();
    init();
  });
})();
