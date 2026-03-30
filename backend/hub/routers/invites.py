"""
[INPUT]: 依赖 hub.auth 的 agent JWT 上下文与 invite_ops 共享逻辑完成邀请兑换
[OUTPUT]: 对外提供 /hub/invites Hub 级路由，让 Plugin/CLI/HTTP 通过 agent token 兑换邀请
[POS]: hub 层邀请端点，与 app/routers/invites.py（BFF 层）共享核心逻辑
[PROTOCOL]: 变更时更新此头部，然后检查 README.md
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from hub.auth import get_current_claimed_agent
from hub.database import get_db
from hub.invite_ops import preview_invite, redeem_invite_for_agent

router = APIRouter(prefix="/hub/invites", tags=["hub-invites"])


@router.get("/{code}")
async def get_invite(
    code: str,
    db: AsyncSession = Depends(get_db),
):
    return await preview_invite(code, db)


@router.post("/{code}/redeem")
async def redeem_invite(
    code: str,
    current_agent: str = Depends(get_current_claimed_agent),
    db: AsyncSession = Depends(get_db),
):
    return await redeem_invite_for_agent(code, current_agent, db)
