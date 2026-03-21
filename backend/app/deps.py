"""Common dependencies for /api routes.

Re-exports RequestContext and auth dependencies for convenience.
"""

from app.auth import RequestContext, require_active_agent, require_user

__all__ = ["RequestContext", "require_active_agent", "require_user"]
