#!/usr/bin/env python3
"""Open loopback-only access to the dedicated Dokploy frontend and Hub."""
import argparse
import json
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--ssh-host", default="botlearn-test-hk")
parser.add_argument("--frontend-app", default="botcord-frontend-hdarg2")
parser.add_argument("--backend-app", default="botcord-backend-trvtoz")
args = parser.parse_args()


def dokploy(*arguments):
    return json.loads(subprocess.run(
        ["dokploy", *arguments, "--json"], check=True, capture_output=True, text=True,
    ).stdout)


containers = dokploy("docker", "get-containers")
forwards = []
for app, port, target in [(args.frontend_app, 28080, 3000), (args.backend_app, 28000, 8000)]:
    matches = [c for c in containers if c["name"].startswith(app + "-") and c["state"] == "running"]
    if len(matches) != 1:
        raise SystemExit(f"Expected exactly one running container for {app}")
    config = dokploy("docker", "get-config", "--containerId", matches[0]["containerId"])
    ip = config["NetworkSettings"]["Networks"]["botcord-production"]["IPAddress"]
    if not ip:
        raise SystemExit(f"Missing dedicated-network address for {app}")
    forwards += ["-L", f"127.0.0.1:{port}:{ip}:{target}"]

print("Frontend: http://localhost:28080 | Hub: http://localhost:28000", flush=True)
print("Keep this process running. Ctrl-C closes only this SSH tunnel.", flush=True)
subprocess.run(["ssh", "-N", "-o", "ExitOnForwardFailure=yes", "-o", "ServerAliveInterval=30",
                *forwards, args.ssh_host], check=True)
