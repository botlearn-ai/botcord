import { HUB_BASE_URL } from "./config";
import { supabase } from "./supabase";
import type {
  Attachment,
  DashboardOverview,
  FileUploadResult,
  HumanInfo,
  OwnerChatRoom,
  RoomMessagesResponse,
  RoomSendResponse,
  UserAgent,
} from "./types";

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function errorMessage(res: Response): Promise<string> {
  try {
    const body = await res.json();
    // FastAPI uses {detail}; app/routers/auth.py uses {error, message}.
    if (typeof body.detail === "string") return body.detail;
    if (typeof body.message === "string") return body.message;
    if (typeof body.error === "string") return body.error;
    return JSON.stringify(body.detail ?? body);
  } catch {
    return res.statusText;
  }
}

// Mirrors frontend/src/lib/api.ts: call the Hub directly with the Supabase
// access token and no X-Active-Agent header, i.e. act as the Human.
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const { data } = await supabase.auth.getSession();
  const headers = new Headers(init.headers);
  if (data.session) {
    headers.set("Authorization", `Bearer ${data.session.access_token}`);
  }
  if (typeof init.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  const res = await fetch(new URL(path, HUB_BASE_URL).toString(), { ...init, headers });
  if (!res.ok) {
    throw new ApiError(res.status, await errorMessage(res));
  }
  return (await res.json()) as T;
}

export function resolveFileUrl(url: string): string {
  return url.startsWith("/") ? new URL(url, HUB_BASE_URL).toString() : url;
}

export const api = {
  signup(email: string, password: string) {
    // No Origin header from native, so the Hub falls back to the web
    // /auth/callback for the confirmation link; the user then signs in here.
    return request<{ ok?: boolean }>("/api/auth/signup", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
  },
  getHumanMe() {
    return request<HumanInfo>("/api/humans/me");
  },
  getMyAgents() {
    return request<{ agents: UserAgent[] }>("/api/users/me/agents");
  },
  getOverview() {
    return request<DashboardOverview>("/api/dashboard/overview");
  },
  getRoomMessages(roomId: string, opts: { before?: string; limit?: number } = {}) {
    const params = new URLSearchParams({ limit: String(opts.limit ?? 50) });
    if (opts.before) params.set("before", opts.before);
    return request<RoomMessagesResponse>(`/api/dashboard/rooms/${roomId}/messages?${params}`);
  },
  sendRoomMessage(roomId: string, text: string, attachments?: Attachment[]) {
    return request<RoomSendResponse>(`/api/dashboard/rooms/${roomId}/send`, {
      method: "POST",
      body: JSON.stringify(attachments?.length ? { text, attachments } : { text }),
    });
  },
  markRoomRead(roomId: string) {
    return request<unknown>(`/api/dashboard/rooms/${roomId}/read`, { method: "POST" });
  },
  getOwnerChatRoom(agentId: string) {
    return request<OwnerChatRoom>(`/api/dashboard/chat/room?agent_id=${encodeURIComponent(agentId)}`);
  },
  sendOwnerChatMessage(agentId: string, text: string, attachments?: Attachment[]) {
    return request<RoomSendResponse>("/api/dashboard/chat/send", {
      method: "POST",
      body: JSON.stringify(
        attachments?.length ? { text, agent_id: agentId, attachments } : { text, agent_id: agentId },
      ),
    });
  },
  // Native passes an {uri, name, type} descriptor, which React Native's
  // FormData accepts in place of a Blob; web passes the picked File.
  uploadFile(file: Blob | { uri: string; name: string; type: string }, agentId?: string) {
    const form = new FormData();
    form.append("file", file as Blob);
    const query = agentId ? `?agent_id=${encodeURIComponent(agentId)}` : "";
    return request<FileUploadResult>(`/api/dashboard/upload${query}`, { method: "POST", body: form });
  },
  registerPushToken(token: string, platform: string) {
    return request<{ ok: boolean }>("/api/users/me/push-tokens", {
      method: "POST",
      body: JSON.stringify({ token, platform }),
    });
  },
  deletePushToken(token: string) {
    return request<{ ok: boolean }>(`/api/users/me/push-tokens?token=${encodeURIComponent(token)}`, {
      method: "DELETE",
    });
  },
};
