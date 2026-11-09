#!/usr/bin/env python3
"""One-time, create-only migration of frontend configuration from Vercel.

Never writes private values to disk/logs. Public build inputs are the only artifact.
"""
import argparse
import json
import os
import re
from pathlib import Path
import subprocess
import urllib.error
import urllib.parse
import urllib.request

CONTEXT = "arn:aws:eks:us-east-1:928112001319:cluster/aibrary"
SECRET = "botcord-frontend-runtime"
PUBLIC_KEYS = (
    "NEXT_PUBLIC_APP_URL", "NEXT_PUBLIC_HUB_BASE_URL",
    "NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "NEXT_PUBLIC_BETA_GATE_ENABLED", "NEXT_PUBLIC_GA_ID", "SHOW_MESSAGE_STATUS",
)


def select_environment(payload):
    if payload.get("pagination", {}).get("next"):
        raise ValueError("Paginated environment export requires a complete snapshot")
    if not isinstance(payload.get("envs"), list):
        raise ValueError("Unexpected Vercel environment response")
    values = {}
    allowed = set(PUBLIC_KEYS) | {"SUPABASE_DB_URL", "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "NEXT_PUBLIC_SHOW_MESSAGE_STATUS"}
    for entry in payload.get("envs", []):
        if "production" not in entry.get("target", []) or entry.get("gitBranch"):
            continue
        key = entry.get("key")
        if key not in allowed:
            continue
        if key in values:
            raise ValueError(f"Ambiguous production variable: {key}")
        if entry.get("visibility") == "secret" or ("visibility" not in entry and entry.get("type") in ("sensitive", "secret")):
            raise ValueError(f"Vercel cannot export {key}; provision through the environment secret channel")
        value = entry.get("value")
        if not isinstance(value, str) or (not value.strip() and key != "NEXT_PUBLIC_GA_ID"):
            raise ValueError(f"Missing exportable value: {key}")
        if any(marker in value.lower() for marker in ("encrypted-placeholder", "redacted", "__fill_me__", "<secret>", "********")):
            raise ValueError(f"Non-exported placeholder: {key}")
        values[key] = value
    if not values.get("NEXT_PUBLIC_SUPABASE_ANON_KEY"):
        values["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = values.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_DEFAULT_KEY", "")
    if not values.get("SHOW_MESSAGE_STATUS"):
        values["SHOW_MESSAGE_STATUS"] = values.get("NEXT_PUBLIC_SHOW_MESSAGE_STATUS", "")
    values.setdefault("NEXT_PUBLIC_GA_ID", "")
    for key in (*PUBLIC_KEYS[:4], "SUPABASE_DB_URL", "SHOW_MESSAGE_STATUS", "NEXT_PUBLIC_BETA_GATE_ENABLED"):
        if not values.get(key):
            raise ValueError(f"Missing production variable: {key}")
    for key, expected in (("NEXT_PUBLIC_APP_URL", "https://www.botcord.chat"),
                          ("NEXT_PUBLIC_HUB_BASE_URL", "https://api.botcord.chat")):
        if values[key].rstrip("/") != expected:
            raise ValueError(f"Unexpected production origin: {key}; hostname={urllib.parse.urlparse(values[key]).hostname}; surrounding_whitespace={values[key] != values[key].strip()}")
    if urllib.parse.urlparse(values["NEXT_PUBLIC_SUPABASE_URL"]).scheme != "https":
        raise ValueError("Production Supabase URL must use HTTPS")
    if not re.fullmatch(r"(?:sb_publishable_[A-Za-z0-9_-]{20,}|eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)", values["NEXT_PUBLIC_SUPABASE_ANON_KEY"]):
        raise ValueError("Production Supabase public key is not an exported key")
    for key in ("SHOW_MESSAGE_STATUS", "NEXT_PUBLIC_BETA_GATE_ENABLED"):
        if values[key] not in ("true", "false"):
            raise ValueError(f"Invalid production boolean: {key}")
    database = urllib.parse.urlparse(values["SUPABASE_DB_URL"])
    if database.scheme not in ("postgres", "postgresql") or not all((database.hostname, database.username, database.password, database.path.strip("/"))):
        raise ValueError("Production database value is not an exported PostgreSQL URI")
    return {key: values[key] for key in PUBLIC_KEYS}, values["SUPABASE_DB_URL"]


def fetch_environment():
    project = os.environ["VERCEL_PROJECT_ID"]
    team = os.environ["VERCEL_ORG_ID"]
    query = urllib.parse.urlencode({"teamId": team, "decrypt": "true"})
    request = urllib.request.Request(
        f"https://api.vercel.com/v10/projects/{urllib.parse.quote(project, safe='')}/env?{query}",
        headers={"Authorization": f"Bearer {os.environ['VERCEL_TOKEN']}"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            return json.load(response)
    except (urllib.error.URLError, json.JSONDecodeError) as error:
        # API error bodies may contain credentials; deliberately do not log them.
        raise RuntimeError("Vercel production configuration export failed") from None


def create_runtime_secret(database_url):
    command = ["kubectl", "--context", CONTEXT, "-n", "prod"]
    existing = subprocess.run(command + ["get", "secret", SECRET, "--ignore-not-found", "-o", "name"],
                              capture_output=True, text=True, timeout=30)
    if existing.returncode:
        raise RuntimeError("Cannot inspect frontend secret metadata")
    if existing.stdout.strip():
        raise RuntimeError("Frontend runtime Secret already exists; refusing to overwrite")
    payload = {"apiVersion": "v1", "kind": "Secret", "metadata": {
        "name": SECRET, "namespace": "prod", "labels": {"app.kubernetes.io/name": "botcord-frontend"}},
        "type": "Opaque", "stringData": {"SUPABASE_DB_URL": database_url}}
    result = subprocess.run(command + ["create", "-f", "-"], input=json.dumps(payload),
                            capture_output=True, text=True, timeout=30)
    if result.returncode:
        raise RuntimeError("Creating dedicated frontend runtime Secret failed")
    print("Created dedicated frontend runtime Secret (values withheld)")


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--create-secret", action="store_true")
    parser.add_argument("--public-output", type=Path, required=True)
    args = parser.parse_args()
    public, database_url = select_environment(fetch_environment())
    if args.create_secret:
        create_runtime_secret(database_url)
    args.public_output.parent.mkdir(parents=True, exist_ok=True)
    args.public_output.write_text(json.dumps(public, indent=2) + "\n")
    print("Exported public build configuration; private values were not written to disk")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, RuntimeError, KeyError, subprocess.TimeoutExpired) as error:
        # Only our explicit validation messages are safe; never stringify a subprocess.
        if isinstance(error, (ValueError, RuntimeError)):
            print(str(error))
        else:
            print("Production configuration preparation failed")
        raise SystemExit(1) from None
