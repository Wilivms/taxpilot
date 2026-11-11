import { PROFILES, validate } from "./guardService.ts";

/** Otari guardrails service: POST /api/guard/validate, GET /api/guard/profiles (see vercel.json rewrites). */
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  const op = String(req.query?.op ?? "");
  if (req.method === "GET") { res.status(200).json(op === "profiles" || !op ? PROFILES : { error: "unknown" }); return; }
  if (req.method !== "POST") { res.status(405).end(); return; }
  const token = process.env.GUARD_TOKEN;
  if (token && req.headers.authorization !== `Bearer ${token}`) { res.status(401).json({ error: "unauthorized" }); return; }
  const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : req.body ?? {};
  const profile = String(b.profile ?? "");
  const v = validate(profile, String(b.input_text ?? ""));
  if (!v) { res.status(404).json({ error: `unknown profile ${profile}` }); return; }
  res.status(200).json({ profile, result: v });
}
