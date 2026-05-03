const JSON_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type, Authorization",
};

const ATLAS_PREFIX = "/atlas";
const API_PREFIX = "/atlas/api";

// Daily ceiling for combined input + output tokens across /reflect and /agent.
// At Haiku 4.5 pricing (~$1/MTok in, $5/MTok out) this caps you at roughly $1-2/day worst case.
const DAILY_TOKEN_CAP = 500000;
const CLAUDE_MODEL = "claude-haiku-4-5-20251001";

function json(data, status = 200, extra = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...JSON_HEADERS, ...extra },
  });
}

function err(message, status = 400) {
  return json({ error: message }, status);
}

function uid(prefix = "p") {
  return prefix + "-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 9);
}

function nowIso() {
  return new Date().toISOString();
}

function parseJsonField(v, fallback) {
  if (v == null) return fallback;
  if (typeof v !== "string") return v;
  try {
    return JSON.parse(v);
  } catch {
    return fallback;
  }
}

function normalizeAreas(a) {
  return ["work", "freelance", "personal"].includes(a) ? a : "personal";
}

function normalizeStatus(s) {
  return ["idea", "active", "paused", "done", "archived"].includes(s) ? s : "active";
}

function toArr(x) {
  if (Array.isArray(x)) return x;
  if (x == null || x === "") return [];
  return [x];
}

function projectFromRow(row) {
  return {
    id: row.id,
    title: row.title,
    area: row.area,
    status: row.status,
    pinned: !!row.pinned,
    nextAction: row.next_action || "",
    notes: row.notes || "",
    dossier: row.dossier || "",
    primaryPath: row.primary_path || "",
    liveUrl: row.live_url || "",
    thumbnail: row.thumbnail || "",
    stack: parseJsonField(row.stack, []),
    tags: parseJsonField(row.tags, []),
    links: parseJsonField(row.links, []),
    docPaths: parseJsonField(row.doc_paths, []),
    related: parseJsonField(row.related, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeInput(p) {
  const now = nowIso();
  return {
    id: p.id || uid(),
    title: String(p.title || "Untitled").slice(0, 200).trim(),
    area: normalizeAreas(p.area),
    status: normalizeStatus(p.status),
    pinned: p.pinned ? 1 : 0,
    next_action: String(p.nextAction || "").slice(0, 500),
    notes: String(p.notes || "").slice(0, 20000),
    dossier: String(p.dossier || "").slice(0, 20000),
    primary_path: String(p.primaryPath || "").slice(0, 500),
    live_url: String(p.liveUrl || "").slice(0, 500),
    thumbnail: String(p.thumbnail || "").slice(0, 500),
    stack: JSON.stringify(toArr(p.stack).map(String).slice(0, 30)),
    tags: JSON.stringify(toArr(p.tags).map(String).slice(0, 30)),
    links: JSON.stringify(
      toArr(p.links)
        .filter((l) => l && (l.url || l.label))
        .slice(0, 30)
        .map((l) => ({
          label: String(l.label || l.url || "").slice(0, 200),
          url: String(l.url || "").slice(0, 500),
        }))
    ),
    doc_paths: JSON.stringify(toArr(p.docPaths).map(String).slice(0, 30)),
    related: JSON.stringify(toArr(p.related).map(String).slice(0, 30)),
    created_at: p.createdAt || now,
    updated_at: now,
  };
}

async function listProjects(env) {
  try {
    const res = await env.DB.prepare(
      "SELECT * FROM projects ORDER BY pinned DESC, updated_at DESC"
    ).all();
    return json({ projects: (res.results || []).map(projectFromRow) });
  } catch (e) {
    if (e.message && e.message.includes("no such table")) {
      return json({
        projects: [],
        _warning:
          "Database tables not initialized. Run: npx wrangler d1 execute tb-atlas --remote --file=./schema.sql",
      });
    }
    throw e;
  }
}

async function getProject(env, id) {
  try {
    const pRow = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
    if (!pRow) return err("Not found", 404);
    const logs = await env.DB.prepare(
      "SELECT id, at, text FROM log_entries WHERE project_id = ? ORDER BY at DESC LIMIT 200"
    )
      .bind(id)
      .all();
    const refs = await env.DB.prepare(
      "SELECT id, at, question, answer FROM reflections WHERE project_id = ? ORDER BY at DESC LIMIT 50"
    )
      .bind(id)
      .all();
    return json({
      project: projectFromRow(pRow),
      log: logs.results || [],
      reflections: refs.results || [],
    });
  } catch (e) {
    if (e.message && e.message.includes("no such table")) {
      return err("Database tables not initialized", 500);
    }
    throw e;
  }
}

async function createProject(env, body) {
  const n = normalizeInput(body);
  await env.DB.prepare(
    `INSERT INTO projects
     (id, title, area, status, pinned, next_action, notes, dossier, primary_path, live_url, thumbnail, stack, tags, links, doc_paths, related, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  )
    .bind(
      n.id,
      n.title,
      n.area,
      n.status,
      n.pinned,
      n.next_action,
      n.notes,
      n.dossier,
      n.primary_path,
      n.live_url,
      n.thumbnail,
      n.stack,
      n.tags,
      n.links,
      n.doc_paths,
      n.related,
      n.created_at,
      n.updated_at
    )
    .run();
  await env.DB.prepare(
    "INSERT INTO log_entries (id, project_id, at, text) VALUES (?, ?, ?, ?)"
  )
    .bind(uid("log"), n.id, n.updated_at, "Project created.")
    .run();
  return getProject(env, n.id);
}

async function updateProject(env, id, body) {
  const existing = await env.DB.prepare("SELECT * FROM projects WHERE id = ?").bind(id).first();
  if (!existing) return err("Not found", 404);
  const merged = { ...projectFromRow(existing), ...body, id, createdAt: existing.created_at };
  const n = normalizeInput(merged);
  await env.DB.prepare(
    `UPDATE projects SET
       title = ?, area = ?, status = ?, pinned = ?, next_action = ?, notes = ?,
       dossier = ?, primary_path = ?, live_url = ?, thumbnail = ?, stack = ?, tags = ?, links = ?,
       doc_paths = ?, related = ?, updated_at = ?
     WHERE id = ?`
  )
    .bind(
      n.title,
      n.area,
      n.status,
      n.pinned,
      n.next_action,
      n.notes,
      n.dossier,
      n.primary_path,
      n.live_url,
      n.thumbnail,
      n.stack,
      n.tags,
      n.links,
      n.doc_paths,
      n.related,
      n.updated_at,
      id
    )
    .run();
  return getProject(env, id);
}

async function deleteProject(env, id) {
  const existing = await env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(id).first();
  if (!existing) return err("Not found", 404);
  await env.DB.prepare("DELETE FROM log_entries WHERE project_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM reflections WHERE project_id = ?").bind(id).run();
  await env.DB.prepare("DELETE FROM projects WHERE id = ?").bind(id).run();
  return json({ ok: true });
}

async function appendLog(env, id, body) {
  const text = String(body.text || "").trim();
  if (!text) return err("Empty log entry");
  const existing = await env.DB.prepare("SELECT id FROM projects WHERE id = ?").bind(id).first();
  if (!existing) return err("Not found", 404);
  const at = nowIso();
  await env.DB.prepare(
    "INSERT INTO log_entries (id, project_id, at, text) VALUES (?, ?, ?, ?)"
  )
    .bind(uid("log"), id, at, text.slice(0, 2000))
    .run();
  await env.DB.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").bind(at, id).run();
  return json({ ok: true, at });
}

const REFLECT_SYSTEM_PROMPT = `You are Todd Boswell's thinking partner. Todd is a senior designer/developer in Omaha who runs a workspace full of personal projects, client work, and experiments. He's asked you to help him think about one specific project.

VOICE:
- Plainspoken, Midwest, direct. No marketing language. No hype.
- NO em dashes, ever. Use periods or commas instead.
- No corporate fluff. No "I'd be happy to help." Skip the preamble.
- Match Todd's own style: short declarative sentences, dry.

APPROACH:
- Be a real thinking partner, not a cheerleader. If the project looks like it should be archived, say so.
- Challenge Todd's assumptions when you see a better path. He explicitly wants this.
- Show tradeoffs, don't just pick a side.
- Ground everything in the actual project data he gives you. Don't invent details.
- If info is missing to answer well, say what's missing.

FORMAT:
- Keep it tight. 3-5 short paragraphs max unless the question genuinely needs more.
- Use bullets sparingly, only when listing options or steps.
- End with ONE concrete next action Todd could take today.`;

// Resilient against the table not existing yet (e.g. before the migration runs).
async function getUsageToday(env) {
  try {
    const today = nowIso().slice(0, 10);
    const row = await env.DB.prepare(
      "SELECT COALESCE(SUM(input_tokens + output_tokens), 0) AS total FROM usage_log WHERE at LIKE ?"
    ).bind(today + "%").first();
    return Number((row && row.total) || 0);
  } catch (e) {
    if (e && e.message && e.message.includes("no such table")) return 0;
    console.warn("usage lookup failed:", e && e.message);
    return 0;
  }
}

async function logUsage(env, endpoint, model, usage) {
  try {
    const inT = (usage && (usage.input_tokens || usage.prompt_tokens)) || 0;
    const outT = (usage && (usage.output_tokens || usage.completion_tokens)) || 0;
    await env.DB.prepare(
      "INSERT INTO usage_log (id, at, endpoint, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?, ?)"
    ).bind(uid("usg"), nowIso(), endpoint, model || "", inT, outT).run();
  } catch (e) {
    if (!(e && e.message && e.message.includes("no such table"))) {
      console.warn("usage log failed:", e && e.message);
    }
  }
}

// Haiku 4.5 list pricing as of late 2025: $1 / MTok input, $5 / MTok output.
const PRICE_INPUT_PER_TOKEN = 1 / 1_000_000;
const PRICE_OUTPUT_PER_TOKEN = 5 / 1_000_000;

function estimateCostUsd(inT, outT) {
  return inT * PRICE_INPUT_PER_TOKEN + outT * PRICE_OUTPUT_PER_TOKEN;
}

async function getUsageReport(env) {
  const today = nowIso().slice(0, 10);
  const sevenDaysAgo = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
  const empty = {
    today: { date: today, input_tokens: 0, output_tokens: 0, total_tokens: 0, requests: 0, estimated_cost_usd: 0 },
    cap: DAILY_TOKEN_CAP,
    model: CLAUDE_MODEL,
    pricing: { input_per_mtok: 1, output_per_mtok: 5, currency: "USD" },
    by_endpoint_today: [],
    week: [],
  };
  try {
    const todayRowP = env.DB.prepare(
      "SELECT COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COUNT(*) AS requests FROM usage_log WHERE at LIKE ?"
    ).bind(today + "%").first();
    const byEndpointP = env.DB.prepare(
      "SELECT endpoint, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COUNT(*) AS requests FROM usage_log WHERE at LIKE ? GROUP BY endpoint"
    ).bind(today + "%").all();
    const weekP = env.DB.prepare(
      "SELECT substr(at,1,10) AS day, COALESCE(SUM(input_tokens),0) AS input_tokens, COALESCE(SUM(output_tokens),0) AS output_tokens, COUNT(*) AS requests FROM usage_log WHERE substr(at,1,10) >= ? GROUP BY day ORDER BY day"
    ).bind(sevenDaysAgo).all();
    const [todayRow, byEndpoint, week] = await Promise.all([todayRowP, byEndpointP, weekP]);
    const inT = Number(todayRow?.input_tokens || 0);
    const outT = Number(todayRow?.output_tokens || 0);
    return json({
      today: {
        date: today,
        input_tokens: inT,
        output_tokens: outT,
        total_tokens: inT + outT,
        requests: Number(todayRow?.requests || 0),
        estimated_cost_usd: estimateCostUsd(inT, outT),
      },
      cap: DAILY_TOKEN_CAP,
      model: CLAUDE_MODEL,
      pricing: { input_per_mtok: 1, output_per_mtok: 5, currency: "USD" },
      by_endpoint_today: (byEndpoint?.results || []).map((r) => ({
        endpoint: r.endpoint,
        input_tokens: Number(r.input_tokens || 0),
        output_tokens: Number(r.output_tokens || 0),
        requests: Number(r.requests || 0),
        estimated_cost_usd: estimateCostUsd(Number(r.input_tokens || 0), Number(r.output_tokens || 0)),
      })),
      week: (week?.results || []).map((r) => ({
        date: r.day,
        input_tokens: Number(r.input_tokens || 0),
        output_tokens: Number(r.output_tokens || 0),
        total_tokens: Number(r.input_tokens || 0) + Number(r.output_tokens || 0),
        requests: Number(r.requests || 0),
        estimated_cost_usd: estimateCostUsd(Number(r.input_tokens || 0), Number(r.output_tokens || 0)),
      })),
    });
  } catch (e) {
    if (e && e.message && e.message.includes("no such table")) {
      return json(empty);
    }
    return err("Usage lookup failed: " + (e && e.message), 500);
  }
}

async function checkSpendCap(env, endpoint) {
  const today = await getUsageToday(env);
  if (today >= DAILY_TOKEN_CAP) {
    return err(
      "Daily token cap reached for " + endpoint + ": " + today + " / " + DAILY_TOKEN_CAP +
      " tokens. Resets at midnight UTC.",
      429
    );
  }
  return null;
}

async function reflect(env, body) {
  if (!env.ANTHROPIC_API_KEY) return err("ANTHROPIC_API_KEY not set", 503);
  const project = body.project;
  const question = String(body.question || "").trim();
  if (!project || !question) return err("Missing project or question");

  const capError = await checkSpendCap(env, "reflect");
  if (capError) return capError;

  let fetchedUrlText = null;
  if (project.liveUrl) {
    try {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 2500);
      const res = await fetch(project.liveUrl, { signal: abort.signal });
      if (res.ok) {
        const text = await res.text();
        const stripped = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
        fetchedUrlText = stripped.slice(0, 3000) + (stripped.length > 3000 ? "..." : "");
      }
    } catch (e) {
      console.warn("Failed to fetch live URL:", e);
    }
  }

  const context = [
    `PROJECT: ${project.title}`,
    `AREA: ${project.area} · STATUS: ${project.status}${project.pinned ? " · pinned" : ""}`,
    project.stack?.length ? `STACK: ${project.stack.join(", ")}` : null,
    project.tags?.length ? `TAGS: ${project.tags.join(", ")}` : null,
    project.primaryPath ? `PRIMARY PATH: ${project.primaryPath}` : null,
    project.liveUrl ? `LIVE URL: ${project.liveUrl}` : null,
    fetchedUrlText ? `\nAUTO-FETCHED LIVE URL CONTENT:\n${fetchedUrlText}` : null,
    project.docPaths?.length
      ? `DOC PATHS:\n${project.docPaths.map((p) => "  " + p).join("\n")}`
      : null,
    project.nextAction
      ? `CURRENT NEXT ACTION: ${project.nextAction}`
      : "CURRENT NEXT ACTION: (none set)",
    project.notes ? `\nNOTES:\n${project.notes}` : null,
    project.dossier ? `\nHOW IT WAS BUILT:\n${project.dossier}` : null,
    body.recentLog?.length
      ? `\nRECENT LOG:\n${body.recentLog
          .slice(0, 10)
          .map((l) => "  " + l.at.slice(0, 10) + "  " + l.text)
          .join("\n")}`
      : null,
  ]
    .filter(Boolean)
    .join("\n");

  const userMessage = `Here's the project context:\n\n${context}\n\n---\n\nTODD'S QUESTION: ${question}`;

  const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4000,
      system: REFLECT_SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMessage }],
    }),
  });

  const data = await apiResponse.json();
  if (!apiResponse.ok) {
    console.error("Claude API error:", JSON.stringify(data));
    return err(data?.error?.message || "Claude API error", 502);
  }
  await logUsage(env, "reflect", CLAUDE_MODEL, data.usage);
  const answer = (data.content || [])
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();

  if (project.id && answer) {
    try {
      await env.DB.prepare(
        "INSERT INTO reflections (id, project_id, at, question, answer) VALUES (?, ?, ?, ?, ?)"
      )
        .bind(uid("ref"), project.id, nowIso(), question.slice(0, 500), answer.slice(0, 20000))
        .run();
    } catch (e) {
      console.error("Reflection save error:", e);
    }
  }
  return json({ answer });
}

const AGENT_SYSTEM_PROMPT = `You are Atlas, the intelligent agent managing Todd's projects.
You have tools to list projects, get project details, propose project mutations, and manipulate the user's UI view.
When the user asks a question, if you need data, use list_projects or get_project.
When you want to change the UI to better show the user the data, use set_view.
When the user asks to create or update a project, use create_project or update_project.
Be concise and direct. Return a set_view call whenever it would be helpful to change the layout, grouping, sorting, or filtering to match the user's request.`;

const AGENT_TOOLS = [
  {
    name: "list_projects",
    description: "Returns a list of all projects, optionally filtered by area or status.",
    input_schema: {
      type: "object",
      properties: {
        area: { type: "string", enum: ["work", "freelance", "personal"] },
        status: { type: "string", enum: ["idea", "active", "paused", "done", "archived"] },
      },
    },
  },
  {
    name: "get_project",
    description: "Fetches the full details of a single project by its ID.",
    input_schema: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
    },
  },
  {
    name: "create_project",
    description: "Propose creating a new project.",
    input_schema: {
      type: "object",
      properties: {
        title: { type: "string" },
        area: { type: "string", enum: ["work", "freelance", "personal"] },
        status: { type: "string", enum: ["idea", "active", "paused", "done", "archived"] },
        nextAction: { type: "string" },
        notes: { type: "string" },
      },
      required: ["title"],
    },
  },
  {
    name: "update_project",
    description: "Propose updating an existing project. Provide only fields to change.",
    input_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        title: { type: "string" },
        area: { type: "string", enum: ["work", "freelance", "personal"] },
        status: { type: "string", enum: ["idea", "active", "paused", "done", "archived"] },
        nextAction: { type: "string" },
        notes: { type: "string" },
        pinned: { type: "boolean" },
        stack: { type: "array", items: { type: "string" } },
      },
      required: ["id"],
    },
  },
  {
    name: "set_view",
    description: "Updates the frontend UI to display information how the user asked.",
    input_schema: {
      type: "object",
      properties: {
        layout: { type: "string", enum: ["cards", "forecast", "tech", "timeline"] },
        group_by: { type: "string", enum: ["status", "area", "tag", "stack"] },
        sort: {
          type: "string",
          enum: ["updated_desc", "updated_asc", "created_desc", "created_asc", "title_asc"],
        },
        filter: { type: "string" },
        highlight: { type: "string" },
      },
    },
  },
];

async function runAgent(env, body) {
  if (!env.ANTHROPIC_API_KEY) return err("ANTHROPIC_API_KEY not set", 503);
  const query = String(body.query || "").trim();
  if (!query) return err("Missing query");

  const capError = await checkSpendCap(env, "agent");
  if (capError) return capError;

  const messages = [{ role: "user", content: query }];

  for (let i = 0; i < 3; i++) {
    const apiResponse = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: CLAUDE_MODEL,
        max_tokens: 1000,
        system: AGENT_SYSTEM_PROMPT,
        tools: AGENT_TOOLS,
        messages,
      }),
    });
    const data = await apiResponse.json();
    if (!apiResponse.ok) return err(data?.error?.message || "Claude API error", 502);
    await logUsage(env, "agent", CLAUDE_MODEL, data.usage);
    messages.push({ role: "assistant", content: data.content });

    let viewPatch = null;
    const mutations = [];
    let textResponse = "";
    let requiresAnotherTurn = false;
    const toolResults = [];

    for (const block of data.content) {
      if (block.type === "text") {
        textResponse += block.text + "\n";
      } else if (block.type === "tool_use") {
        const toolName = block.name;
        const input = block.input;
        if (toolName === "list_projects") {
          const res = await env.DB.prepare(
            "SELECT * FROM projects ORDER BY updated_at DESC"
          ).all();
          let list = (res.results || []).map(projectFromRow);
          if (input.area) list = list.filter((p) => p.area === input.area);
          if (input.status) list = list.filter((p) => p.status === input.status);
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: JSON.stringify(list),
          });
          requiresAnotherTurn = true;
        } else if (toolName === "get_project") {
          const pRow = await env.DB.prepare("SELECT * FROM projects WHERE id = ?")
            .bind(input.id)
            .first();
          toolResults.push({
            type: "tool_result",
            tool_use_id: block.id,
            content: pRow ? JSON.stringify(projectFromRow(pRow)) : "Not found",
          });
          requiresAnotherTurn = true;
        } else if (toolName === "set_view") {
          viewPatch = input;
        } else if (toolName === "create_project" || toolName === "update_project") {
          mutations.push({ type: toolName, payload: input });
        }
      }
    }
    if (requiresAnotherTurn && toolResults.length > 0) {
      messages.push({ role: "user", content: toolResults });
      continue;
    }
    return json({
      message: textResponse.trim(),
      view_patch: viewPatch,
      mutations: mutations.length > 0 ? mutations : undefined,
    });
  }
  return err("Agent loop exceeded limit");
}

async function handleApi(request, env, url) {
  const path = url.pathname;
  const method = request.method;

  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
      },
    });
  }

  if (path === API_PREFIX + "/projects") {
    if (method === "GET") return listProjects(env);
    if (method === "POST") return createProject(env, await safeJson(request));
    return err("Method not allowed", 405);
  }
  const pMatch = path.match(/^\/atlas\/api\/projects\/([^/]+)$/);
  if (pMatch) {
    const id = decodeURIComponent(pMatch[1]);
    if (method === "GET") return getProject(env, id);
    if (method === "PUT") return updateProject(env, id, await safeJson(request));
    if (method === "DELETE") return deleteProject(env, id);
    return err("Method not allowed", 405);
  }
  const logMatch = path.match(/^\/atlas\/api\/projects\/([^/]+)\/log$/);
  if (logMatch) {
    const id = decodeURIComponent(logMatch[1]);
    if (method === "POST") return appendLog(env, id, await safeJson(request));
    return err("Method not allowed", 405);
  }
  if (path === API_PREFIX + "/reflect") {
    if (method === "POST") return reflect(env, await safeJson(request));
    return err("Method not allowed", 405);
  }
  if (path === API_PREFIX + "/agent") {
    if (method === "POST") return runAgent(env, await safeJson(request));
    return err("Method not allowed", 405);
  }
  if (path === API_PREFIX + "/usage") {
    if (method === "GET") return getUsageReport(env);
    return err("Method not allowed", 405);
  }
  return err("Not found", 404);
}

async function safeJson(request) {
  try {
    const txt = await request.text();
    if (!txt) return {};
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

async function serveStatic(request, env, url) {
  if (!env.ASSETS) {
    return new Response(
      "Static assets binding (env.ASSETS) is missing. Confirm wrangler.toml has [assets] with binding = \"ASSETS\" and redeploy.",
      { status: 500, headers: { "Content-Type": "text/plain; charset=utf-8" } }
    );
  }
  if (url.pathname === ATLAS_PREFIX || url.pathname === ATLAS_PREFIX + "/") {
    const indexUrl = new URL(ATLAS_PREFIX + "/index.html", url.origin);
    return env.ASSETS.fetch(new Request(indexUrl.toString(), request));
  }
  return env.ASSETS.fetch(request);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;
    if (path.startsWith(API_PREFIX)) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        console.error("API error:", e);
        return err("Server error: " + (e && e.message ? e.message : "unknown"), 500);
      }
    }
    if (path === ATLAS_PREFIX || path.startsWith(ATLAS_PREFIX + "/")) {
      return serveStatic(request, env, url);
    }
    return new Response("Not found", { status: 404 });
  },
};
