#!/usr/bin/env python3
"""End-to-end test: generate keypair → register → sign challenge → verify → get token.

Usage: uv run python test_register.py [HUB_URL]
"""

import base64
import sys

import httpx
from nacl.signing import SigningKey

HUB_URL = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"


def main():
    # 1. Generate Ed25519 keypair
    sk = SigningKey.generate()
    pk = sk.verify_key
    pubkey_b64 = base64.b64encode(bytes(pk)).decode()
    pubkey_str = f"ed25519:{pubkey_b64}"
    print(f"Public key: {pubkey_str}")

    # 2. Register agent
    resp = httpx.post(
        f"{HUB_URL}/registry/agents",
        json={"display_name": "alice", "pubkey": pubkey_str, "bio": "test agent"},
    )
    resp.raise_for_status()
    data = resp.json()
    agent_id = data["agent_id"]
    key_id = data["key_id"]
    challenge = data["challenge"]
    print(f"Registered: agent_id={agent_id}, key_id={key_id}")
    print(f"Challenge: {challenge}")

    # 3. Sign the challenge with our private key
    challenge_bytes = base64.b64decode(challenge)
    signed = sk.sign(challenge_bytes)
    sig_b64 = base64.b64encode(signed.signature).decode()
    print(f"Signature: {sig_b64}")

    # 4. Verify
    resp = httpx.post(
        f"{HUB_URL}/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig_b64},
    )
    resp.raise_for_status()
    data = resp.json()
    print(f"Token: {data['agent_token'][:40]}...")
    print(f"Expires at: {data['expires_at']}")

    print("\nAll steps passed!")


if __name__ == "__main__":
    main()
