import { handleRpc } from "./mcpServer.ts";

export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET" || req.method === "DELETE") { res.setHeader("Allow", "POST"); res.status(405).json({ error: "Stateless MCP server: POST JSON-RPC only." }); return; }
  if (req.method !== "POST") { res.status(405).end(); return; }
  const token = process.env.MCP_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) { res.status(401).json({ error: "unauthorized" }); return; }
  let body: any;
  try { body = typeof req.body === "string" ? JSON.parse(req.body) : req.body; } catch { res.status(400).json({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } }); return; }
  const msgs = Array.isArray(body) ? body : [body];
  const out = (await Promise.all(msgs.map(handleRpc))).filter((x) => x !== null);
  if (!out.length) { res.status(202).end(); return; }
  res.setHeader("Content-Type", "application/json");
  res.status(200).send(JSON.stringify(Array.isArray(body) ? out : out[0]));
}
