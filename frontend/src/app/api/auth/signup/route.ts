/**
 * [INPUT]: JSON { email, password, redirectTo? }
 * [OUTPUT]: POST /api/auth/signup - compatibility proxy to Hub /api/auth/signup
 * [POS]: thin migration shim; signup email generation lives in backend/app/routers/auth.py
 * [PROTOCOL]: no Supabase service-role or Resend logic belongs in this route
 */

import { proxyPublicHub } from "../../_lib/proxy-hub";

export async function POST(req: Request) {
  return proxyPublicHub("/api/auth/signup", req, { method: "POST" });
}
