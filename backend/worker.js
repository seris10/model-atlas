/* Public scientific resources and stateless MCP. Live views require an unlisted read capability;
   updates require a separate write capability, kept only in the publishing browser's memory. */
const CACHE = new Map();
const MAX_LIVE_VIEWS = 200, MAX_CREATES_PER_HOUR = 10;
const PROTOCOLS = ["2025-03-26", "2025-06-18", "2025-11-25"];
const READ_HEADERS = { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*", "X-Content-Type-Options": "nosniff" };
const json = (value, status = 200, extra = {}) => new Response(JSON.stringify(value), { status, headers: { ...READ_HEADERS, ...extra } });
class ApiError extends Error { constructor(message, status = 400) { super(message); this.status = status; } }
function number(value, fallback, low, high, integer = false) {
  const n = value === undefined || value === null ? fallback : Number(value);
  if (!Number.isFinite(n) || n < low || n > high || (integer && !Number.isInteger(n))) throw new ApiError(`Expected ${integer ? "integer" : "number"} in [${low}, ${high}]`);
  return n;
}
async function asset(env, request, path, parse = true) {
  if (parse && CACHE.has(path)) return CACHE.get(path);
  const response = await env.ASSETS.fetch(new Request(new URL(path, request.url)));
  if (!response.ok) throw new ApiError("Published resource unavailable", 404);
  const value = parse ? await response.json() : await response.text();
  if (parse) CACHE.set(path, value);
  return value;
}
const manifest = (env, req) => asset(env, req, "/manifest.json");
async function source(env, req, args) {
  const m = await manifest(env, req), file = m.files.find(f => f.path === args.path);
  if (!file) throw new ApiError("Unknown published source path", 404);
  const text = await asset(env, req, file.url, false), lines = text.split("\n");
  const start = number(args.start, 1, 1, Math.max(1, lines.length), true);
  const limit = number(args.limit, 120, 1, 250, true);
  const excerpt = lines.slice(start - 1, start - 1 + limit).join("\n");
  const offset = number(args.offset, 0, 0, Math.max(0, excerpt.length), true), maxChars = number(args.max_chars, 16000, 1, 40000, true);
  return { ...file, start, end: Math.min(lines.length, start + limit - 1), total_lines: lines.length,
    content: excerpt.slice(offset, offset + maxChars), offset, next_offset: offset + maxChars < excerpt.length ? offset + maxChars : null,
    next_start: start + limit <= lines.length ? start + limit : null };
}
async function experiment(env, req, a) {
  if (a.scene === "thermal") {
    const d = await asset(env, req, "/data/thermal.json"), c = d.curves.find(c => c.id === (a.curve || "chlorella_tpc:49"));
    if (!c) throw new ApiError("Unknown thermal curve");
    const model = a.model || "sharpeschoolhigh_1981", fit = c.models[model];
    if (!fit) throw new ApiError("Unknown thermal model");
    const t = number(a.temperature, 30, 11, 54), amplitude = number(a.amplitude, 0, 0, 8);
    if (t - amplitude < 11 || t + amplitude > 54) throw new ApiError("Cycle must remain within the 11–54 °C display domain");
    const band = a => a.some(x => x === null) && (t < fit.domain[0] || t > fit.domain[1]) ? null : AtlasModel.interpolate(d.temperatures, a, t);
    return { scene: a.scene, curve: c.id, model, temperature_c: t, predicted_rate: AtlasModel.thermalRate(fit, t),
      unit: d.unit, ci95: [band(fit.lo), band(fit.hi)], observed_domain_c: fit.domain, extrapolated: t < fit.domain[0] || t > fit.domain[1],
      optimum: fit.optimum, observations: c.observations, cycle: AtlasModel.cycleAverage(fit, t, amplitude), source: d.source_url,
      limitation: "Conditional fitted response; tested interval coverage 87–91%. Cycle averaging assumes instantaneous response, with no acclimation or damage dynamics." };
  }
  if (a.scene === "neural") {
    const d = await asset(env, req, "/data/neural.json");
    const firing = number(a.firing, 4, 0, 12), release = number(a.release, .25, 0, 1), recovery = number(a.recovery, .8, .1, 2);
    const available = a.depletion === true ? AtlasModel.resourceState(firing, release, recovery,
      number(a.initial, 1, 0, 1), a.elapsed === undefined ? null : number(a.elapsed, 0, 0, 3600)) : 1;
    return { scene: a.scene, ...AtlasModel.budget(d, firing, release * available,
      number(a.overlap, 1.24, 1, 4), a.housekeeping !== false), effective_release: release * available,
      resources: a.depletion === true ? { available, recovery_s: recovery, steady: AtlasModel.resourceState(firing, release, recovery),
        note: "Optional one-pool mean-field depletion coupled to source per-event ATP costs; not a measured ATP time series." } : null,
      unit: "µmol ATP / g / min", source: d.source_url };
  }
  if (a.scene === "membrane") {
    const m = await manifest(env, req);
    const key = a.trace || m.traces[0].id, entry = m.traces.find(t => t.id === key);
    if (!entry) throw new ApiError("Unknown trace; choose an id from catalog.traces");
    const d = await asset(env, req, entry.url), t = number(a.time, d.on, 0, d.duration);
    const stride = number(a.stride, 5, 1, 100, true);
    return { scene: a.scene, trace: key, time_s: t, voltage_mv: AtlasModel.interpolate(d.t, d.v, t),
      dvdt_mv_per_ms: AtlasModel.interpolate(d.t, d.dvdt, t), current: (d.pulses || [[d.on,d.off]]).some(([a,b])=>t>=a&&t<b) ? d.amplitude_pa : 0,
      current_unit: d.isHH ? "µA/cm²" : "pA", spike_times_s: d.spikes, spike_count: d.spike_count, duration_s: d.duration,
      kinetic_factor: d.kinetic_factor, protocol: d.protocol, pulses_s: d.pulses,
      samples: a.samples === true ? d.t.filter((_, i) => i % stride === 0).map((t, k) => ({ t_s: t, v_mv: d.v[k * stride],
        dvdt_mv_per_ms: d.dvdt[k * stride], gates: d.gates?.[k * stride], ina: d.ina?.[k * stride], ik: d.ik?.[k * stride] })) : undefined,
      provenance: entry, note: "HH server traces are independently checked published reference runs. Arbitrary HH controls run in the browser and are visible through Share view." };
  }
  throw new ApiError("scene must be thermal, membrane, or neural");
}
async function behavior(env, req, scene) {
  const d = await asset(env, req, "/behavior.json");
  if (scene && !Object.hasOwn(d.scenes, scene)) throw new ApiError("Unknown scene");
  return scene ? { ...d.common, scene, ...d.scenes[scene] } : d;
}
async function readView(env, id) {
  if (!/^[0-9a-f-]{36}$/.test(id || "")) throw new ApiError("Invalid view id");
  if (!env.ATLAS_SESSIONS) throw new ApiError("View storage unavailable", 503);
  const row = await env.ATLAS_SESSIONS.prepare("SELECT expires,updated,payload FROM atlas_views WHERE id=? AND expires>?").bind(id, Date.now()).first();
  if (!row) throw new ApiError("View stopped or expired", 404);
  const payload = JSON.parse(row.payload), age = Date.now() - row.updated;
  return { id, updated_at: new Date(row.updated).toISOString(), expires_at: new Date(row.expires).toISOString(), age_ms: age,
    fresh: age < 15000, provenance: "Snapshot published by the sharing browser; browser-supplied data, not a server measurement.", ...payload };
}
async function hash(value) { return Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))), x => x.toString(16).padStart(2, "0")).join(""); }
async function body(request, limit = 250000) {
  if (!request.headers.get("content-type")?.startsWith("application/json")) throw new ApiError("Use application/json", 415);
  if (Number(request.headers.get("content-length")) > limit) throw new ApiError("Request too large", 413);
  const reader = request.body?.getReader(); if (!reader) throw new ApiError("Missing JSON body");
  let chunks = [], length = 0;
  while (true) { const part = await reader.read(); if (part.done) break; length += part.value.length;
    if (length > limit) { await reader.cancel(); throw new ApiError("Request too large", 413); } chunks.push(part.value); }
  const bytes = new Uint8Array(length); let offset = 0; for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  let value; try { value = JSON.parse(new TextDecoder().decode(bytes)); } catch { throw new ApiError("Invalid JSON"); }
  if (!value || Array.isArray(value) || typeof value !== "object") throw new ApiError("Expected JSON object");
  return value;
}
function snapshotPayload(d) {
  if (!d.state || !["thermal", "membrane", "neural"].includes(d.state.scene)) throw new ApiError("Missing scientific state");
  if (!Array.isArray(d.timeline) || d.timeline.length > 30) throw new ApiError("Invalid animation samples");
  if (d.image && (!/^data:image\/webp;base64,[A-Za-z0-9+/=]+$/.test(d.image) || d.image.length > 150000)) throw new ApiError("Invalid WebP frame");
  const payload = { state: d.state, result: d.result, readouts: d.readouts, viewport: d.viewport,
    captured_at: d.captured_at, timeline: d.timeline, image: d.image, version: d.version };
  const encoded = JSON.stringify(payload); if (encoded.length > 240000) throw new ApiError("Snapshot too large", 413);
  return encoded;
}
async function views(env, req, path) {
  if (!env.ATLAS_SESSIONS) throw new ApiError("View storage unavailable", 503);
  const bits = path.split("/").filter(Boolean), id = bits[2];
  if (req.method === "GET" && id) {
    const value = await readView(env, id);
    if (bits[3] === "frame") {
      if (!value.image) throw new ApiError("No frame has been published", 404);
      const bytes = Uint8Array.from(atob(value.image.split(",")[1]), c => c.charCodeAt(0));
      return new Response(bytes, { headers: { "Content-Type": "image/webp", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Access-Control-Allow-Origin": "*" } });
    }
    delete value.image; return json({ ...value, frame_url: `/api/views/${id}/frame` });
  }
  // Publishing is same-origin and is never available as an MCP write tool.
  if (req.headers.get("Origin") !== new URL(req.url).origin) throw new ApiError("Publishing requires the atlas origin", 403);
  if (req.method === "POST" && !id) {
    const payload = snapshotPayload(await body(req)), now = Date.now();
    const readId = crypto.randomUUID(), token = crypto.randomUUID() + crypto.randomUUID();
    // Origin can be forged by non-browser clients, so creation is capped per client and in total.
    const client = await hash(req.headers.get("CF-Connecting-IP") || "unknown"), window = Math.floor(now / 3600000);
    await env.ATLAS_SESSIONS.batch([
      env.ATLAS_SESSIONS.prepare("DELETE FROM atlas_views WHERE expires<?").bind(now),
      env.ATLAS_SESSIONS.prepare("DELETE FROM atlas_view_quota WHERE window<?").bind(window)
    ]);
    const live = await env.ATLAS_SESSIONS.prepare("SELECT COUNT(*) AS n FROM atlas_views").first();
    if (live.n >= MAX_LIVE_VIEWS) throw new ApiError("Too many shared views are active; try again later", 503);
    const used = await env.ATLAS_SESSIONS.prepare("INSERT INTO atlas_view_quota(client,window,n) VALUES(?,?,1) ON CONFLICT(client,window) DO UPDATE SET n=n+1 RETURNING n").bind(client, window).first();
    if (used.n > MAX_CREATES_PER_HOUR) throw new ApiError("Share view creation limit reached; try again in an hour", 429);
    await env.ATLAS_SESSIONS.prepare("INSERT INTO atlas_views VALUES(?,?,?,?,?)").bind(readId, await hash(token), now + 3600000, now, payload).run();
    return json({ id: readId, write_token: token, expires_at: new Date(now + 3600000).toISOString(),
      url: new URL(`/api/views/${readId}`, req.url).href }, 201, { "Access-Control-Allow-Origin": new URL(req.url).origin });
  }
  if (id && ["PUT", "DELETE"].includes(req.method)) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new ApiError("Invalid view id");
    const token = req.headers.get("Authorization")?.replace(/^Bearer /, "");
    if (!token || token.length > 100) throw new ApiError("Writer capability required", 401);
    const auth = await hash(token), now = Date.now();
    const row = await env.ATLAS_SESSIONS.prepare("SELECT updated FROM atlas_views WHERE id=? AND write_hash=? AND expires>?").bind(id, auth, now).first();
    if (!row) throw new ApiError("Writer capability refused or view expired", 403);
    if (req.method === "DELETE") {
      await env.ATLAS_SESSIONS.prepare("DELETE FROM atlas_views WHERE id=? AND write_hash=?").bind(id, auth).run(); return json({ stopped: true });
    }
    if (now - row.updated < 1000) throw new ApiError("Publish at most once per second", 429);
    const payload = snapshotPayload(await body(req));
    await env.ATLAS_SESSIONS.prepare("UPDATE atlas_views SET updated=?,payload=? WHERE id=? AND write_hash=?").bind(now, payload, id, auth).run();
    return json({ updated_at: new Date(now).toISOString() });
  }
  throw new ApiError("Method not allowed", 405);
}
const objectSchema = properties => ({ type: "object", properties, additionalProperties: false });
const str = { type: "string" }, num = { type: "number" }, bool = { type: "boolean" };
const TOOLS = [
  ["atlas_catalog", "List source files, stylesheets, recordings, citations, numerical models and their URLs.", {}],
  ["atlas_source", "Read published Python, JavaScript, CSS, HTML or reports with line numbers and SHA256. Use catalog paths; offset/max_chars page long lines.", { path: str, start: num, limit: num, offset: num, max_chars: num }],
  ["atlas_experiment", "Evaluate exported Python thermal/ATP models or inspect a recorded/published HH trace. Units and provenance are explicit.",
    { scene: { enum: ["thermal", "neural", "membrane"] }, curve: str, model: str, temperature: num, amplitude: num,
      firing: num, release: num, overlap: num, housekeeping: bool, depletion: bool, recovery: num, initial: num, elapsed: num,
      trace: str, time: num, samples: bool, stride: num }],
  ["atlas_behavior", "Inspect animation mappings, interaction gestures, controls, colors, audio mappings and equations.", { scene: str }],
  ["atlas_view", "Inspect an unlisted live Share view link: browser state, results, recent animation samples and optional rendered image. Freshness is reported.", { id: str, include_frame: bool }],
  ["search", "Search the atlas's scientific source-file catalog, scene metadata and citations.", { query: str }],
  ["fetch", "Fetch a scientific resource by catalog file path or scene name; returns source text and canonical URL.", { id: str }]
].map(([name, description, properties]) => ({ name, description, inputSchema: { ...objectSchema(properties), required: name === "atlas_source" ? ["path"] : name === "atlas_experiment" ? ["scene"] : name === "atlas_view" || name === "fetch" ? ["id"] : name === "search" ? ["query"] : [] },
  annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } }));
async function callTool(env, req, name, a) {
  const tool = TOOLS.find(t => t.name === name); if (!tool) throw new ApiError("Unknown tool");
  if (!a || Array.isArray(a) || typeof a !== "object") throw new ApiError("Expected tool arguments object");
  for (const k of Object.keys(a)) if (!(k in tool.inputSchema.properties)) throw new ApiError(`Unknown argument: ${k}`);
  for (const k of tool.inputSchema.required) if (!(k in a)) throw new ApiError(`Missing argument: ${k}`);
  for (const [k, v] of Object.entries(a)) {
    const spec = tool.inputSchema.properties[k];
    if (spec.type && typeof v !== spec.type) throw new ApiError(`Invalid type for ${k}`);
    if (spec.enum && !spec.enum.includes(v)) throw new ApiError(`Invalid value for ${k}`);
  }
  const origin = new URL(req.url).origin;
  if (name === "atlas_catalog") return manifest(env, req);
  if (name === "atlas_source") return source(env, req, a);
  if (name === "atlas_experiment") return experiment(env, req, a);
  if (name === "atlas_behavior") return behavior(env, req, a.scene);
  if (name === "atlas_view") { const v = await readView(env, a.id); if (!a.include_frame) delete v.image; return v; }
  if (name === "search") {
    if (typeof a.query !== "string" || a.query.length > 160) throw new ApiError("query must be text, at most 160 characters");
    const m = await manifest(env, req), words = a.query.toLowerCase().split(/\s+/).filter(Boolean);
    return { results: m.files.filter(f => words.every(w => `${f.path} ${f.kind}`.toLowerCase().includes(w))).slice(0, 30)
      .map(f => ({ id: f.path, title: f.path, url: origin + f.url })), scenes: m.scenes, citations: m.citations };
  }
  if (["thermal", "membrane", "neural"].includes(a.id)) return { id: a.id, url: `${origin}/#${a.id}`, title: a.id, text: JSON.stringify(await behavior(env, req, a.id)) };
  const s = await source(env, req, { path: a.id, limit: 250 }); return { id: a.id, url: origin + s.url, title: a.id, text: s.content, next_start: s.next_start };
}
async function mcp(env, req) {
  const origin = req.headers.get("Origin");
  if (origin && ![new URL(req.url).origin, "https://chatgpt.com", "https://chat.openai.com"].includes(origin)) throw new ApiError("Origin refused", 403);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: { ...READ_HEADERS,
    "Access-Control-Allow-Methods": "POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version" } });
  if (req.method !== "POST") return json({ error: "Use Streamable HTTP POST" }, 405, { Allow: "POST" });
  const protocol = req.headers.get("MCP-Protocol-Version"); if (protocol && !PROTOCOLS.includes(protocol)) throw new ApiError("Unsupported MCP version");
  const q = await body(req, 30000);
  if (q.jsonrpc !== "2.0" || typeof q.method !== "string") return json({ jsonrpc: "2.0", id: q.id ?? null, error: { code: -32600, message: "Invalid request" } }, 400);
  if (q.id === undefined) return new Response(null, { status: 202 });
  let result;
  try {
    if (q.method === "initialize") result = { protocolVersion: PROTOCOLS.includes(q.params?.protocolVersion) ? q.params.protocolVersion : "2025-06-18",
      capabilities: { tools: {}, resources: {} }, serverInfo: { name: "relay70-atlas", version: "1.0.0" },
      instructions: "Inspect atlas_catalog first. atlas_source reads the exact published code and styles. atlas_behavior explains animation and audio mappings. atlas_experiment evaluates scientific models. atlas_view reads a Share view capability with a freshness timestamp. Views are browser-supplied snapshots; absence of a view cannot reveal any open tab. All MCP tools are read-only. Scientific sources and limitations travel with results." };
    else if (q.method === "ping") result = {};
    else if (q.method === "tools/list") result = { tools: TOOLS };
    else if (q.method === "tools/call") {
      try { const value = await callTool(env, req, q.params?.name, q.params?.arguments || {});
        const content = []; if (value.image) { const data = value.image.split(",")[1]; delete value.image; content.push({ type: "image", mimeType: "image/webp", data }); }
        content.unshift({ type: "text", text: JSON.stringify(value) }); result = { content, structuredContent: value, isError: false };
      } catch (e) { result = { content: [{ type: "text", text: e.message }], isError: true }; }
    } else if (q.method === "resources/list") { const m = await manifest(env, req); result = { resources: [
      { uri: "atlas://catalog", name: "Atlas catalog", mimeType: "application/json" },
      { uri: "atlas://behavior", name: "Animated behavior and interaction semantics", mimeType: "application/json" },
      ...m.files.map(f => ({ uri: `atlas://source/${f.path}`, name: f.path, mimeType: "text/plain" }))] }; }
    else if (q.method === "resources/read") {
      const uri = q.params?.uri; let value;
      if (uri === "atlas://catalog") value = JSON.stringify(await manifest(env, req));
      else if (uri === "atlas://behavior") value = JSON.stringify(await behavior(env, req));
      else if (uri?.startsWith("atlas://source/")) { const path = uri.slice(15), m = await manifest(env, req), f = m.files.find(f => f.path === path);
        if (!f) throw new ApiError("Unknown resource"); value = await asset(env, req, f.url, false); }
      else throw new ApiError("Unknown resource");
      result = { contents: [{ uri, mimeType: "text/plain", text: value }] };
    } else return json({ jsonrpc: "2.0", id: q.id, error: { code: -32601, message: "Method not found" } });
  } catch (e) { return json({ jsonrpc: "2.0", id: q.id, error: { code: -32602, message: e.message } }); }
  return json({ jsonrpc: "2.0", id: q.id, result });
}
export default {
  async fetch(request, env) {
    const url = new URL(request.url), path = url.pathname;
    try {
      if (request.method === "OPTIONS" && path.startsWith("/api/")) return new Response(null, { status: 204, headers: { ...READ_HEADERS,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS", "Access-Control-Allow-Headers": "Content-Type, MCP-Protocol-Version", "Access-Control-Max-Age": "600" } });
      if (path === "/mcp") return await mcp(env, request);
      if (path.startsWith("/api/views")) return await views(env, request, path);
      if (path.startsWith("/api/")) {
        if (path === "/api/experiment" && request.method === "POST") return json(await experiment(env, request, await body(request, 10000)));
        if (request.method !== "GET") throw new ApiError("Method not allowed", 405);
        if (path === "/api/health") return json({ ok: true, version: (await manifest(env, request)).version, view_storage: Boolean(env.ATLAS_SESSIONS) });
        if (path === "/api/catalog") return json(await manifest(env, request));
        if (path === "/api/source") return json(await source(env, request, Object.fromEntries(url.searchParams)));
        if (path === "/api/behavior") return json(await behavior(env, request, url.searchParams.get("scene")));
        if (path === "/api/experiment") {
          const args = Object.fromEntries(url.searchParams);
          for (const key of ["housekeeping", "depletion", "samples"]) if (key in args) {
            if (!["true", "false"].includes(args[key])) throw new ApiError(`Invalid boolean ${key}`);
            args[key] = args[key] === "true";
          }
          return json(await experiment(env, request, args));
        }
        throw new ApiError("Unknown API route", 404);
      }
      const response = await env.ASSETS.fetch(request); return response;
    } catch (e) { if (!(e instanceof ApiError)) console.error("Atlas backend failure:", e.message);
      return json({ error: e instanceof ApiError ? e.message : "Service unavailable" }, e.status || 500); }
  }
};
