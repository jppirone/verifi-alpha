// Caller authentication for the registry functions. Same model as every other staff/internal endpoint in this project
// (see list-resume-extraction-failures): the service-role key as bearer (exact, constant-time compare) OR a live staff
// session token in the body, resolved against staff_sessions (hashed, unrevoked, unexpired) and staff_users. Identity is
// never taken from the request. Anything else is one undifferentiated 401.

export type RegistryCaller = { kind: "service" } | { kind: "staff"; id: string; email: string; name: string; role: string };

async function sha256Hex(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function authenticateRegistryCaller(req: Request, body: Record<string, unknown>, url: string, serviceKey: string): Promise<RegistryCaller | null> {
  const h = req.headers.get("authorization") || "";
  const t = h.toLowerCase().startsWith("bearer ") ? h.slice(7).trim() : "";
  if (t && serviceKey && safeEqual(t, serviceKey)) return { kind: "service" };
  const tok = typeof body?.staff_session_token === "string" ? body.staff_session_token : "";
  if (tok.length < 20 || tok.length > 200) return null;
  const rest = { apikey: serviceKey, Authorization: `Bearer ${serviceKey}` };
  const sRes = await fetch(`${url}/rest/v1/staff_sessions?token_hash=eq.${await sha256Hex(tok)}&select=staff_user_id,expires_at,revoked_at`, { headers: rest });
  const sess = sRes.ok ? (await sRes.json())[0] : null;
  if (!sess || sess.revoked_at || new Date(sess.expires_at).getTime() <= Date.now()) return null;
  const uRes = await fetch(`${url}/rest/v1/staff_users?id=eq.${sess.staff_user_id}&select=id,email,name,role`, { headers: rest });
  const u = uRes.ok ? (await uRes.json())[0] : null;
  return u ? { kind: "staff", id: u.id, email: u.email, name: u.name, role: u.role } : null;
}
export const isRegistryAdmin = (c: RegistryCaller) => c.kind === "service" || (c.kind === "staff" && c.role === "admin");
