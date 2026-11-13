// server.js - Mock "Optus Network Inventory" MCP server (with request logging)
const http = require("http");

const PORT = process.env.PORT || 3000;
const API_KEY = (process.env.API_KEY || "change-me").trim();

const ASSETS = [
  {
    asset_id: "OPT-NET-SYDMEL-04",
    name: "OPT-NET-SYDMEL-04",
    type: "SD-WAN Link",
    customer: "Meridian Logistics Group",
    endpoint_a: "Sydney (Meridian HQ)",
    endpoint_b: "Melbourne (Meridian DC)",
    status: "Degraded",
    bandwidth_mbps: 500,
    service_id: "SVC-MLG-SDWAN-0042",
    last_updated: "2024-11-02T03:15:00Z",
    source_system: "Optus Network Inventory (external, non-ServiceNow)",
    aliases_seen_elsewhere: []
  }
];

const TOOLS = [
  {
    name: "lookup_network_asset",
    description:
      "Look up a network asset in the external Optus Network Inventory by asset ID, link name, customer, or site pair. Read-only. Returns the inventory record so the caller can compare it against other systems. Does not modify anything.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Asset ID, link name, customer name, or site pair (e.g. 'Sydney Melbourne')" }
      },
      required: ["query"]
    },
    annotations: { readOnlyHint: true, destructiveHint: false }
  }
];

function findAssets(q) {
  const n = (q || "").toLowerCase().replace(/[^a-z0-9]/g, " ");
  const terms = n.split(/\s+/).filter(Boolean);
  return ASSETS.filter(a => {
    const hay = JSON.stringify(a).toLowerCase().replace(/[^a-z0-9]/g, " ");
    return terms.some(t => t.length > 2 && hay.includes(t)) || (n.includes("syd") && n.includes("mel"));
  });
}

function handle(msg) {
  const { id, method, params } = msg;
  const ok = result => ({ jsonrpc: "2.0", id, result });
  const err = (code, message) => ({ jsonrpc: "2.0", id, error: { code, message } });

  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion || "2025-03-26",
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: "optus-network-inventory-mock", version: "1.0.0" }
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools: TOOLS });
    case "prompts/list":
      return ok({ prompts: [] });
    case "resources/list":
      return ok({ resources: [] });
    case "tools/call": {
      if (params?.name !== "lookup_network_asset") return err(-32602, "Unknown tool");
      const matches = findAssets(params.arguments?.query);
      const payload = matches.length
        ? { found: true, count: matches.length, assets: matches,
            note: "Read-only lookup. Any merge or reconciliation must be proposed to a human, not committed." }
        : { found: false, count: 0, assets: [] };
      return ok({ content: [{ type: "text", text: JSON.stringify(payload, null, 2) }], isError: false });
    }
    default:
      return err(-32601, `Method not found: ${method}`);
  }
}

function getKey(req) {
  const h = req.headers;
  const bearer = (h.authorization || "").replace(/^Bearer\s+/i, "");
  return String(h["x-api-key"] || h["api-key"] || h["apikey"] || bearer || "").trim();
}

http.createServer((req, res) => {
  const path = (req.url || "").split("?")[0].replace(/\/+$/, "");
  const log = (status, extra) =>
    console.log(`${new Date().toISOString()} ${req.method} ${req.url} -> ${status}${extra ? " | " + extra : ""}`);

  if (path === "/health") { res.writeHead(200); res.end("ok"); return log(200); }
  if (path !== "/mcp" && path !== "") { res.writeHead(404); res.end(); return log(404); }

  const key = getKey(req);
  if (key !== API_KEY) {
    res.writeHead(401); res.end("Unauthorized");
    return log(401, `header names: ${Object.keys(req.headers).join(",")} | key length received ${key.length}, expected ${API_KEY.length}`);
  }
  if (req.method !== "POST") {
    res.writeHead(405, { Allow: "POST" }); res.end();
    return log(405, `accept=${req.headers.accept || ""}`);
  }

  let body = "";
  req.on("data", c => (body += c));
  req.on("end", () => {
    let msg;
    try { msg = JSON.parse(body); } catch { res.writeHead(400); res.end(); return log(400, "bad JSON"); }

    const msgs = Array.isArray(msg) ? msg : [msg];
    const names = msgs.map(m => m.method + (m.method === "initialize" ? `(v${m.params && m.params.protocolVersion})` : "")).join(",");
    const replies = msgs.filter(m => m.id !== undefined).map(handle);

    if (replies.length === 0) { res.writeHead(202); res.end(); return log(202, `rpc=${names}`); }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(Array.isArray(msg) ? replies : replies[0]));
    log(200, `rpc=${names}`);
  });
}).listen(PORT, () => console.log(`MCP mock listening on ${PORT}`));
