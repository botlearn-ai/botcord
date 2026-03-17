#!/usr/bin/env python3
"""Demo: full M2 Registry operation flow.

Exercises all 9 Registry APIs against a live Hub:
  1. Register agent (Alice)
  2. Verify key (challenge-response)
  3. Register endpoint
  4. Query key
  5. Resolve agent
  6. Discover agents
  7. Add second key (rotation)
  8. Verify second key
  9. Revoke first key
  10. Token refresh
  11. Register another agent (Bob) and discover both

Usage:
    python demo_registry.py [HUB_URL]
"""

import base64
import sys

import httpx
from nacl.signing import SigningKey

HUB = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000"
SEP = "-" * 60


def make_keypair():
    sk = SigningKey.generate()
    pub_b64 = base64.b64encode(bytes(sk.verify_key)).decode()
    return sk, f"ed25519:{pub_b64}"


def sign_challenge(sk: SigningKey, challenge_b64: str) -> str:
    challenge_bytes = base64.b64decode(challenge_b64)
    return base64.b64encode(sk.sign(challenge_bytes).signature).decode()


def register_and_verify(client: httpx.Client, sk: SigningKey, pubkey_str: str, name: str):
    """Register + verify in one shot. Returns (agent_id, key_id, token)."""
    # Register
    resp = client.post(
        f"{HUB}/registry/agents",
        json={"display_name": name, "pubkey": pubkey_str},
    )
    resp.raise_for_status()
    data = resp.json()
    agent_id, key_id, challenge = data["agent_id"], data["key_id"], data["challenge"]
    print(f"  agent_id : {agent_id}")
    print(f"  key_id   : {key_id}")

    # Verify
    sig = sign_challenge(sk, challenge)
    resp = client.post(
        f"{HUB}/registry/agents/{agent_id}/verify",
        json={"key_id": key_id, "challenge": challenge, "sig": sig},
    )
    resp.raise_for_status()
    token = resp.json()["agent_token"]
    print(f"  token    : {token[:40]}...")
    return agent_id, key_id, token


def main():
    client = httpx.Client(timeout=10)

    # ======================================================================
    # Step 1 & 2: Register Alice + verify
    # ======================================================================
    print(SEP)
    print("Step 1-2: Register Alice and verify key")
    print(SEP)
    alice_sk, alice_pubkey = make_keypair()
    alice_id, alice_key1, alice_token = register_and_verify(
        client, alice_sk, alice_pubkey, "Alice"
    )
    print()

    auth = {"Authorization": f"Bearer {alice_token}"}

    # ======================================================================
    # Step 3: Register endpoint
    # ======================================================================
    print(SEP)
    print("Step 3: Register Alice's endpoint")
    print(SEP)
    resp = client.post(
        f"{HUB}/registry/agents/{alice_id}/endpoints",
        json={"url": "https://alice.example.com/hooks"},
        headers=auth,
    )
    resp.raise_for_status()
    ep = resp.json()
    print(f"  endpoint_id : {ep['endpoint_id']}")
    print(f"  url         : {ep['url']}")
    print(f"  state       : {ep['state']}")
    print(f"  status      : {resp.status_code} (created)")

    # Update endpoint
    resp = client.post(
        f"{HUB}/registry/agents/{alice_id}/endpoints",
        json={"url": "https://alice-v2.example.com/hooks"},
        headers=auth,
    )
    resp.raise_for_status()
    ep2 = resp.json()
    print(f"  updated url : {ep2['url']}")
    print(f"  same ep_id  : {ep2['endpoint_id'] == ep['endpoint_id']}")
    print(f"  status      : {resp.status_code} (updated)")
    print()

    # ======================================================================
    # Step 4: Query key
    # ======================================================================
    print(SEP)
    print("Step 4: Query Alice's public key")
    print(SEP)
    resp = client.get(f"{HUB}/registry/agents/{alice_id}/keys/{alice_key1}")
    resp.raise_for_status()
    key_info = resp.json()
    print(f"  key_id  : {key_info['key_id']}")
    print(f"  pubkey  : {key_info['pubkey'][:30]}...")
    print(f"  state   : {key_info['state']}")
    print()

    # ======================================================================
    # Step 5: Resolve agent
    # ======================================================================
    print(SEP)
    print("Step 5: Resolve Alice")
    print(SEP)
    resp = client.get(f"{HUB}/registry/resolve/{alice_id}")
    resp.raise_for_status()
    resolved = resp.json()
    print(f"  agent_id     : {resolved['agent_id']}")
    print(f"  display_name : {resolved['display_name']}")
    print(f"  has_endpoint : {resolved['has_endpoint']}")
    print()

    # ======================================================================
    # Step 6: Discover agents (just Alice so far)
    # ======================================================================
    print(SEP)
    print("Step 6: Discover agents by name")
    print(SEP)
    resp = client.get(f"{HUB}/registry/agents", params={"name": "Alice"})
    resp.raise_for_status()
    found = resp.json()
    print(f"  search 'Alice' : {len(found['agents'])} result(s)")

    resp = client.get(f"{HUB}/registry/agents", params={"name": "nobody"})
    resp.raise_for_status()
    print(f"  search 'nobody': {len(resp.json()['agents'])} result(s)")
    print()

    # ======================================================================
    # Step 7 & 8: Key rotation — add second key and verify it
    # ======================================================================
    print(SEP)
    print("Step 7-8: Key rotation — add and verify a second key")
    print(SEP)
    alice_sk2, alice_pubkey2 = make_keypair()

    resp = client.post(
        f"{HUB}/registry/agents/{alice_id}/keys",
        json={"pubkey": alice_pubkey2},
        headers=auth,
    )
    resp.raise_for_status()
    new_key_data = resp.json()
    alice_key2 = new_key_data["key_id"]
    challenge2 = new_key_data["challenge"]
    print(f"  new key_id  : {alice_key2}")

    # Check it's pending
    resp = client.get(f"{HUB}/registry/agents/{alice_id}/keys/{alice_key2}")
    print(f"  state before: {resp.json()['state']}")

    # Verify it
    sig2 = sign_challenge(alice_sk2, challenge2)
    resp = client.post(
        f"{HUB}/registry/agents/{alice_id}/verify",
        json={"key_id": alice_key2, "challenge": challenge2, "sig": sig2},
    )
    resp.raise_for_status()
    print(f"  verified OK — new token issued")

    # Check it's active now
    resp = client.get(f"{HUB}/registry/agents/{alice_id}/keys/{alice_key2}")
    print(f"  state after : {resp.json()['state']}")
    print()

    # ======================================================================
    # Step 9: Revoke first key
    # ======================================================================
    print(SEP)
    print("Step 9: Revoke Alice's first key")
    print(SEP)
    resp = client.delete(
        f"{HUB}/registry/agents/{alice_id}/keys/{alice_key1}",
        headers=auth,
    )
    resp.raise_for_status()
    revoked = resp.json()
    print(f"  key_id : {revoked['key_id']}")
    print(f"  state  : {revoked['state']}")

    # Confirm: can't revoke the last remaining active key
    resp = client.delete(
        f"{HUB}/registry/agents/{alice_id}/keys/{alice_key2}",
        headers=auth,
    )
    print(f"  revoke last key: {resp.status_code} — {resp.json()['detail']}")
    print()

    # ======================================================================
    # Step 10: Token refresh using the new key
    # ======================================================================
    print(SEP)
    print("Step 10: Token refresh with second key")
    print(SEP)
    nonce = base64.b64encode(b"demo-nonce-unique-value-1234567").decode()
    nonce_sig = base64.b64encode(
        alice_sk2.sign(base64.b64decode(nonce)).signature
    ).decode()

    resp = client.post(
        f"{HUB}/registry/agents/{alice_id}/token/refresh",
        json={"key_id": alice_key2, "nonce": nonce, "sig": nonce_sig},
    )
    resp.raise_for_status()
    new_token = resp.json()
    print(f"  new token    : {new_token['agent_token'][:40]}...")
    print(f"  expires_at   : {new_token['expires_at']}")
    print()

    # ======================================================================
    # Step 11: Register Bob and discover both
    # ======================================================================
    print(SEP)
    print("Step 11: Register Bob, then list all agents")
    print(SEP)
    bob_sk, bob_pubkey = make_keypair()
    bob_id, bob_key, bob_token = register_and_verify(
        client, bob_sk, bob_pubkey, "Bob"
    )

    # Register Bob's endpoint
    resp = client.post(
        f"{HUB}/registry/agents/{bob_id}/endpoints",
        json={"url": "https://bob.example.com/hooks"},
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    resp.raise_for_status()
    print(f"  Bob endpoint : {resp.json()['url']}")

    # List all agents (no name filter)
    resp = client.get(f"{HUB}/registry/agents")
    resp.raise_for_status()
    all_agents = resp.json()["agents"]
    print(f"\n  All registered agents ({len(all_agents)}):")
    for a in all_agents:
        print(f"    - {a['agent_id']} ({a['display_name']})")
    print()

    # ======================================================================
    # Security check: cross-agent access denied
    # ======================================================================
    print(SEP)
    print("Step 12: Security — cross-agent access denied")
    print(SEP)
    # Alice tries to register endpoint for Bob → 403
    resp = client.post(
        f"{HUB}/registry/agents/{bob_id}/endpoints",
        json={"url": "https://evil.com/hijack"},
        headers=auth,  # Alice's token
    )
    print(f"  Alice → Bob endpoint: {resp.status_code} ({resp.json()['detail']})")

    # Alice tries to revoke Bob's key → 403
    resp = client.delete(
        f"{HUB}/registry/agents/{bob_id}/keys/{bob_key}",
        headers=auth,
    )
    print(f"  Alice → Bob revoke  : {resp.status_code} ({resp.json()['detail']})")

    # SSRF blocked
    resp = client.post(
        f"{HUB}/registry/agents/{bob_id}/endpoints",
        json={"url": "http://169.254.169.254/latest/meta-data"},
        headers={"Authorization": f"Bearer {bob_token}"},
    )
    print(f"  SSRF metadata       : {resp.status_code} ({resp.json()['detail']})")
    print()

    print(SEP)
    print("All M2 Registry operations completed successfully!")
    print(SEP)

    client.close()


if __name__ == "__main__":
    main()
