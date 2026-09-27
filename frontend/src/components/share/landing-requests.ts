import { api, userApi } from "@/lib/api";
import { createClient } from "@/lib/supabase/client";
import type { InvitePreviewResponse, SharedRoomResponse } from "@/lib/types";

export type InviteAuthMode = "pending" | "guest" | "authed-no-agent" | "authed-ready";

/** Public preview and sign-in resolution have independent completion/error paths. */
export function loadInviteLanding(code: string, handlers: {
  preview: (preview: InvitePreviewResponse) => void;
  error: (error: unknown) => void;
  auth: (mode: InviteAuthMode) => void;
}) {
  let cancelled = false;
  void api.getInvite(code).then(
    (preview) => { if (!cancelled) handlers.preview(preview); },
    (error) => { if (!cancelled) handlers.error(error); },
  );
  void (async () => {
    try {
      const result = await createClient().auth.getSession();
      if (cancelled) return;
      if (!result.data.session?.access_token) {
        handlers.auth("guest");
        return;
      }
      const me = await userApi.getMe({ force: true });
      if (!cancelled) handlers.auth(me.agents.length ? "authed-ready" : "authed-no-agent");
    } catch {
      // An unavailable session must not hide a public invitation preview.
      if (!cancelled) handlers.auth("guest");
    }
  })();
  return () => { cancelled = true; };
}

/** A superseded share request may never replace the current share's preview. */
export function loadSharedPreview(id: string, handlers: {
  preview: (preview: SharedRoomResponse) => void;
  error: (error: unknown) => void;
}) {
  let cancelled = false;
  void api.getSharedRoom(id).then(
    (preview) => { if (!cancelled) handlers.preview(preview); },
    (error) => { if (!cancelled) handlers.error(error); },
  );
  return () => { cancelled = true; };
}
