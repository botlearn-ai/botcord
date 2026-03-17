"""Async Python client for the BotCord Hub.

Usage::

    async with BotcordClient("http://localhost:8000") as client:
        await client.register("alice")
        await client.register_endpoint("http://localhost:8001/hooks")
        resp = await client.send("ag_receiver", {"text": "hello"})
"""

from __future__ import annotations

import base64
import hashlib
import time
import uuid

import httpx
import jcs
from nacl.signing import SigningKey


class BotcordClient:
    """Wraps all BotCord Hub APIs with automatic key management and signing."""

    def __init__(self, hub_url: str = "http://localhost:8000") -> None:
        self.hub_url = hub_url.rstrip("/")
        self._http: httpx.AsyncClient | None = None

        # Set after register()
        self.agent_id: str | None = None
        self.key_id: str | None = None
        self.token: str | None = None

        # Ed25519 keypair (raw bytes)
        self._signing_key: SigningKey | None = None
        self._private_key_b64: str | None = None
        self._public_key_b64: str | None = None

    # ------------------------------------------------------------------
    # Context manager
    # ------------------------------------------------------------------

    async def __aenter__(self) -> BotcordClient:
        self._http = httpx.AsyncClient()
        return self

    async def __aexit__(self, *exc) -> None:
        if self._http:
            await self._http.aclose()
            self._http = None

    @property
    def http(self) -> httpx.AsyncClient:
        if self._http is None:
            raise RuntimeError("Use 'async with BotcordClient() as client:' or call open()/close()")
        return self._http

    async def open(self) -> None:
        if self._http is None:
            self._http = httpx.AsyncClient()

    async def close(self) -> None:
        if self._http:
            await self._http.aclose()
            self._http = None

    # ------------------------------------------------------------------
    # Key management helpers
    # ------------------------------------------------------------------

    def _generate_keypair(self) -> None:
        self._signing_key = SigningKey.generate()
        self._private_key_b64 = base64.b64encode(bytes(self._signing_key)).decode()
        self._public_key_b64 = base64.b64encode(
            bytes(self._signing_key.verify_key)
        ).decode()

    def _sign_bytes(self, data: bytes) -> str:
        """Sign raw bytes and return base64-encoded signature."""
        assert self._signing_key is not None
        signed = self._signing_key.sign(data)
        return base64.b64encode(signed.signature).decode()

    # ------------------------------------------------------------------
    # Envelope helpers
    # ------------------------------------------------------------------

    @staticmethod
    def _compute_payload_hash(payload: dict) -> str:
        canonical = jcs.canonicalize(payload)
        digest = hashlib.sha256(canonical).hexdigest()
        return f"sha256:{digest}"

    def _build_signing_input(self, env: dict) -> bytes:
        parts = [
            env["v"],
            env["msg_id"],
            str(env["ts"]),
            env["from"],
            env["to"],
            str(env["type"]),
            env.get("reply_to") or "",
            str(env["ttl_sec"]),
            env["payload_hash"],
        ]
        return "\n".join(parts).encode()

    def build_envelope(
        self,
        *,
        to: str,
        payload: dict,
        msg_type: str = "message",
        reply_to: str | None = None,
        ttl_sec: int = 3600,
    ) -> dict:
        """Build and sign a complete MessageEnvelope dict."""
        assert self.agent_id and self.key_id and self._signing_key

        env = {
            "v": "a2a/0.1",
            "msg_id": str(uuid.uuid4()),
            "ts": int(time.time()),
            "from": self.agent_id,
            "to": to,
            "type": msg_type,
            "reply_to": reply_to,
            "ttl_sec": ttl_sec,
            "payload": payload,
            "payload_hash": self._compute_payload_hash(payload),
        }

        signing_input = self._build_signing_input(env)
        sig_b64 = self._sign_bytes(signing_input)
        env["sig"] = {
            "alg": "ed25519",
            "key_id": self.key_id,
            "value": sig_b64,
        }
        return env

    def _auth_headers(self) -> dict[str, str]:
        assert self.token, "Not authenticated -- call register() or refresh_token() first"
        return {"Authorization": f"Bearer {self.token}"}

    # ------------------------------------------------------------------
    # Registry APIs
    # ------------------------------------------------------------------

    async def register(self, display_name: str) -> dict:
        """Generate keypair, register agent, verify challenge, obtain JWT.

        Sets self.agent_id, self.key_id, self.token.
        Returns the verify response.
        """
        self._generate_keypair()
        pubkey_str = f"ed25519:{self._public_key_b64}"

        # 1. Register
        resp = await self.http.post(
            f"{self.hub_url}/registry/agents",
            json={"display_name": display_name, "pubkey": pubkey_str},
        )
        resp.raise_for_status()
        reg = resp.json()
        self.agent_id = reg["agent_id"]
        self.key_id = reg["key_id"]
        challenge = reg["challenge"]

        # 2. Verify (sign the challenge bytes)
        challenge_bytes = base64.b64decode(challenge)
        sig = self._sign_bytes(challenge_bytes)

        resp = await self.http.post(
            f"{self.hub_url}/registry/agents/{self.agent_id}/verify",
            json={"key_id": self.key_id, "challenge": challenge, "sig": sig},
        )
        resp.raise_for_status()
        verify = resp.json()
        self.token = verify["agent_token"]
        return verify

    async def register_endpoint(self, url: str) -> dict:
        """Register (or update) the agent's inbox endpoint URL."""
        resp = await self.http.post(
            f"{self.hub_url}/registry/agents/{self.agent_id}/endpoints",
            json={"url": url},
            headers=self._auth_headers(),
        )
        resp.raise_for_status()
        return resp.json()

    async def resolve(self, agent_id: str) -> dict:
        """Resolve agent info + active endpoints."""
        resp = await self.http.get(
            f"{self.hub_url}/registry/resolve/{agent_id}",
        )
        resp.raise_for_status()
        return resp.json()

    async def discover(self, name: str | None = None) -> list[dict]:
        """Discover agents, optionally filtered by name. Returns list of agent summaries."""
        params = {}
        if name:
            params["name"] = name
        resp = await self.http.get(
            f"{self.hub_url}/registry/agents",
            params=params,
        )
        resp.raise_for_status()
        return resp.json()["agents"]

    async def get_key(self, agent_id: str, key_id: str) -> dict:
        """Get public key info."""
        resp = await self.http.get(
            f"{self.hub_url}/registry/agents/{agent_id}/keys/{key_id}",
        )
        resp.raise_for_status()
        return resp.json()

    async def refresh_token(self) -> dict:
        """Refresh JWT via nonce signature. Updates self.token."""
        assert self.agent_id and self.key_id and self._signing_key

        import os
        nonce = base64.b64encode(os.urandom(32)).decode()
        nonce_bytes = base64.b64decode(nonce)
        sig = self._sign_bytes(nonce_bytes)

        resp = await self.http.post(
            f"{self.hub_url}/registry/agents/{self.agent_id}/token/refresh",
            json={"key_id": self.key_id, "nonce": nonce, "sig": sig},
        )
        resp.raise_for_status()
        data = resp.json()
        self.token = data["agent_token"]
        return data

    # ------------------------------------------------------------------
    # Hub APIs
    # ------------------------------------------------------------------

    async def send(
        self,
        to: str,
        payload: dict,
    ) -> dict:
        """Build, sign, and send a message envelope. Returns SendResponse."""
        envelope = self.build_envelope(to=to, payload=payload)
        resp = await self.http.post(
            f"{self.hub_url}/hub/send",
            json=envelope,
            headers=self._auth_headers(),
        )
        resp.raise_for_status()
        return resp.json()

    async def send_receipt(
        self,
        to: str,
        msg_type: str,
        reply_to: str,
        payload: dict | None = None,
    ) -> dict:
        """Send an ack/result/error receipt. Returns ReceiptResponse."""
        envelope = self.build_envelope(
            to=to,
            payload=payload or {},
            msg_type=msg_type,
            reply_to=reply_to,
        )
        resp = await self.http.post(
            f"{self.hub_url}/hub/receipt",
            json=envelope,
        )
        resp.raise_for_status()
        return resp.json()

    async def get_status(self, msg_id: str) -> dict:
        """Query message delivery status."""
        resp = await self.http.get(
            f"{self.hub_url}/hub/status/{msg_id}",
            headers=self._auth_headers(),
        )
        resp.raise_for_status()
        return resp.json()

    async def poll_inbox(self, *, limit: int = 10, timeout: int = 30, ack: bool = True) -> dict:
        """Poll for queued messages. Supports long-polling via *timeout*."""
        resp = await self.http.get(
            f"{self.hub_url}/hub/inbox",
            params={"limit": limit, "timeout": timeout, "ack": str(ack).lower()},
            headers=self._auth_headers(),
            timeout=timeout + 5,
        )
        resp.raise_for_status()
        return resp.json()
