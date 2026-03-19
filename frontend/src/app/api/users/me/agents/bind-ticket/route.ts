import { NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth";
import { issueBindTicket } from "@/lib/bind-ticket";

/**
 * [INPUT]: 依赖 requireAuth 获取用户身份，依赖 issueBindTicket 生成一次性绑定票据
 * [OUTPUT]: 对外提供 POST /api/users/me/agents/bind-ticket 返回 nonce + bind_ticket + expires_at
 * [POS]: 用户 agent 绑定流程的前置票据颁发器，限制 bind_proof 的时效与用户归属
 * [PROTOCOL]: 变更时更新此头部，然后检查 README.md
 */

export async function POST() {
  const { user, error } = await requireAuth();
  if (error) {
    return NextResponse.json({ error: error.message }, { status: error.status });
  }

  try {
    const issued = issueBindTicket(user.id, 300);
    return NextResponse.json({
      bind_ticket: issued.bindTicket,
      nonce: issued.nonce,
      expires_at: issued.expiresAt,
    });
  } catch (err: any) {
    return NextResponse.json(
      { error: err?.message || "Failed to issue bind ticket" },
      { status: 500 },
    );
  }
}
