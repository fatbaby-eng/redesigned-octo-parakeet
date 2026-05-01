const API = "/atlas/api";

const state = {
  projects: [],
  selectedId: null,
  selected: null,
  filter: { area: "", status: "", q: "" },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function fmtDate(iso) {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const now = new Date();
  const diffMs = now - d;
  const day = 86400000;
  if (diffMs < day) {
    const h = Math.max(1, Math.round(diffMs / 3600000));
    return h + "h ago";
  }
  if (diffMs < 7 * day) return Math.round(diffMs / day) + "d ago";
  return d.toISOString().slice(0, 10);
}

function applyFilter(list) {
  const { area, status, q } = state.filter;
  const ql = q.trim().toLowerCase();
  return list.filter((p) => {
    if (area && p.area !== area) return false;
    if (status && p.status !== status) return false;
    if (!ql) return true;
    const hay = [
      p.title,
      ...(p.tags || []),
      ...(p.stack || []),
      p.notes,
      p.dossier,
    ]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return hay.includes(ql);
  });
}

function renderList() {
  const list = $("#project-list");
  list.innerHTML = "";
  const tpl = $("#project-card-tpl");
  const filtered = applyFilter(state.projects);
  if (filtered.length === 0) {
    const li = document.createElement("li");
    li.className = "project-card";
    li.innerHTML = `<div style="padding:16px;color:var(--muted)">No projects match.</div>`;
    list.appendChild(li);
    return;
  }
  for (const p of filtered) {
    const node = tpl.content.firstElementChild.cloneNode(true);
    if (p.id === state.selectedId) node.classList.add("active");
    $(".card-title", node).textContent = p.title;
    const pin = $(".pin", node);
    pin.textContent = "★";
    if (!p.pinned) pin.classList.add("hidden");
    $(".badge.area", node).textContent = p.area;
    $(".badge.status", node).textContent = p.status;
    $(".updated", node).textContent = fmtDate(p.updatedAt);
    const tags = $(".tags", node);
    for (const t of (p.tags || []).slice(0, 4)) {
      const chip = document.createElement("span");
      chip.className = "tag-chip";
      chip.textContent = t;
      tags.appendChild(chip);
    }
    $(".card-button", node).addEventListener("click", () => selectProject(p.id));
    list.appendChild(node);
  }
}

function renderDetail() {
  const root = $("#detail");
  root.innerHTML = "";
  if (!state.selected) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.innerHTML = `<h2>Select a project</h2><p>Pick one from the list, or create a new one.</p>`;
    root.appendChild(empty);
    return;
  }
  const tpl = $("#detail-tpl");
  const node = tpl.content.firstElementChild.cloneNode(true);
  const p = state.selected.project;

  for (const f of node.querySelectorAll("[data-field]")) {
    const k = f.dataset.field;
    let v = p[k];
    if (Array.isArray(v)) v = v.join(", ");
    f.value = v ?? "";
  }

  const btnPin = $(".btn-pin", node);
  if (p.pinned) btnPin.classList.add("pinned");
  btnPin.addEventListener("click", async () => {
    await save({ pinned: !p.pinned });
  });

  $(".btn-delete", node).addEventListener("click", async () => {
    if (!confirm(`Delete "${p.title}"? This cannot be undone.`)) return;
    await api("/projects/" + encodeURIComponent(p.id), { method: "DELETE" });
    state.selectedId = null;
    state.selected = null;
    await loadProjects();
    renderList();
    renderDetail();
  });

  $(".btn-save", node).addEventListener("click", async () => {
    const patch = {};
    for (const f of node.querySelectorAll("[data-field]")) {
      const k = f.dataset.field;
      let v = f.value;
      if (k === "stack" || k === "tags") {
        v = v.split(",").map((s) => s.trim()).filter(Boolean);
      }
      patch[k] = v;
    }
    await save(patch, $(".save-status", node));
  });

  const logList = $(".log-list", node);
  for (const e of state.selected.log) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="at">${fmtDate(e.at)}</span><span class="text"></span>`;
    li.querySelector(".text").textContent = e.text;
    logList.appendChild(li);
  }

  $(".btn-log", node).addEventListener("click", async () => {
    const input = $(".log-text", node);
    const text = input.value.trim();
    if (!text) return;
    await api("/projects/" + encodeURIComponent(p.id) + "/log", {
      method: "POST",
      body: JSON.stringify({ text }),
    });
    input.value = "";
    await selectProject(p.id);
  });

  const reflectAnswer = $(".reflect-answer", node);
  $(".btn-reflect", node).addEventListener("click", async () => {
    const q = $(".reflect-question", node).value.trim();
    if (!q) return;
    reflectAnswer.classList.add("loading");
    reflectAnswer.textContent = "Thinking...";
    try {
      const r = await api("/reflect", {
        method: "POST",
        body: JSON.stringify({
          project: p,
          question: q,
          recentLog: state.selected.log.slice(0, 10),
        }),
      });
      reflectAnswer.classList.remove("loading");
      reflectAnswer.textContent = r.answer || "(no answer)";
      await selectProject(p.id);
    } catch (e) {
      reflectAnswer.classList.remove("loading");
      reflectAnswer.textContent = "Error: " + e.message;
    }
  });

  const reflectHist = $(".reflect-history", node);
  for (const r of state.selected.reflections) {
    const li = document.createElement("li");
    const q = document.createElement("div");
    q.className = "q";
    q.textContent = r.question;
    const a = document.createElement("div");
    a.className = "a";
    a.textContent = r.answer;
    const at = document.createElement("span");
    at.className = "at";
    at.textContent = fmtDate(r.at);
    li.append(at, q, a);
    reflectHist.appendChild(li);
  }

  root.appendChild(node);
}

async function save(patch, statusEl) {
  if (!state.selectedId) return;
  if (statusEl) {
    statusEl.classList.remove("success", "error");
    statusEl.textContent = "Saving...";
  }
  try {
    const r = await api("/projects/" + encodeURIComponent(state.selectedId), {
      method: "PUT",
      body: JSON.stringify(patch),
    });
    state.selected = r;
    const idx = state.projects.findIndex((x) => x.id === r.project.id);
    if (idx >= 0) state.projects[idx] = r.project;
    if (statusEl) {
      statusEl.textContent = "Saved";
      statusEl.classList.add("success");
    }
    renderList();
    renderDetail();
  } catch (e) {
    if (statusEl) {
      statusEl.textContent = "Error: " + e.message;
      statusEl.classList.add("error");
    } else {
      alert("Error: " + e.message);
    }
  }
}

async function loadProjects() {
  const r = await api("/projects");
  state.projects = r.projects || [];
}

async function selectProject(id) {
  state.selectedId = id;
  try {
    state.selected = await api("/projects/" + encodeURIComponent(id));
  } catch (e) {
    state.selected = null;
    alert("Error: " + e.message);
  }
  renderList();
  renderDetail();
}

async function createNew() {
  const title = prompt("New project title:");
  if (!title) return;
  const r = await api("/projects", {
    method: "POST",
    body: JSON.stringify({ title, area: "personal", status: "active" }),
  });
  await loadProjects();
  await selectProject(r.project.id);
}

function wireFilters() {
  $("#filter-area").addEventListener("change", (e) => {
    state.filter.area = e.target.value;
    renderList();
  });
  $("#filter-status").addEventListener("change", (e) => {
    state.filter.status = e.target.value;
    renderList();
  });
  $("#filter-search").addEventListener("input", (e) => {
    state.filter.q = e.target.value;
    renderList();
  });
  $("#btn-new").addEventListener("click", createNew);
}

async function init() {
  wireFilters();
  try {
    await loadProjects();
    renderList();
    renderDetail();
  } catch (e) {
    $("#project-list").innerHTML = `<li style="padding:16px;color:var(--danger)">Failed to load projects: ${e.message}</li>`;
  }
}

init();
