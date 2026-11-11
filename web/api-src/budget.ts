import { endUser } from "./otari.ts";

/** Per-user AI budget for the current browser (end user of the Otari service key). */
export default async function handler(req: any, res: any) {
  res.setHeader("Cache-Control", "no-store");
  const uid = String(req.query?.uid ?? "");
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(uid)) { res.status(400).json({ error: "bad uid" }); return; }
  try { res.status(200).json(await endUser(`tp:${uid}`)); } catch (e) { res.status(502).json({ error: (e as Error).message }); }
}
