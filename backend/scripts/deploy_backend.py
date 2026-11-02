"""US backend delivery using reviewed configuration and a fixed migration gate.

Run only on the existing US deploy runner. No arbitrary SQL, resource name or
command inputs. Candidate images are pinned by digest before touching runtime.
"""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import re
import signal
import subprocess
import sys
import tempfile
import time

CONTEXT = "arn:aws:eks:us-east-1:928112001319:cluster/aibrary"
REPO = "928112001319.dkr.ecr.us-east-1.amazonaws.com/botlearn-ai/botcord-backend"
DEVOPS = Path("/www/devops")
SERVICE = "botcord-backend"
GATE = Path(__file__).with_name("conversation_release_gate.py").resolve()
VALIDATOR = GATE.parents[1] / "hub/services/conversation_capture.py"
ENV_CODE = "import os,json; print(json.dumps({k:os.environ[k] for k in ('DATABASE_URL','DATABASE_SCHEMA','JWT_SECRET','BOTCORD_HUB_CONTROL_PRIVATE_KEY') if k in os.environ}))"


def run(*args, input=None, timeout=180):
    result = subprocess.run(args, input=input, capture_output=True, text=True, timeout=timeout)
    if result.returncode:
        for line in result.stderr.splitlines():
            if line.startswith("Conversation release gate failed:"):
                print(line, file=sys.stderr, flush=True)
        # stdout/stderr can include runtime values: never echo them in Actions.
        raise RuntimeError(f"Command failed ({result.returncode}): {' '.join(args[:3])}")
    return result.stdout.strip()


def kube(*args):
    return run("kubectl", "--context", CONTEXT, "-n", "prod", *args, timeout=360)


def check_checkout(paths):
    head = run("git", "-C", str(DEVOPS), "rev-parse", "HEAD")
    remote = run("git", "-C", str(DEVOPS), "ls-remote", "origin", "refs/heads/main").split()[0]
    if head != remote:
        raise RuntimeError("DevOps checkout has not synchronized current main")
    if run("git", "-C", str(DEVOPS), "status", "--porcelain", "--untracked-files=no", "--", *paths):
        raise RuntimeError("Target DevOps configuration has tracked local drift")
    print(f"Reviewed DevOps configuration: {head}", flush=True)


class Runtime:
    def __init__(self, environment):
        self.environment = environment
        self.tag = f"{REPO}:{environment}"
        self.replicas = 1
        if environment == "preview":
            self.compose = DEVOPS / "deployments/test/botcord-backend/docker-compose.yaml"
            configured = Path(os.environ["DEPLOY_ROOT"]) / SERVICE / "docker-compose.yaml"
            if configured.resolve() != self.compose:
                raise RuntimeError("DEPLOY_ROOT does not identify reviewed US preview configuration")
            check_checkout(["deployments/test/botcord-backend"])
            ids = self.dc("ps", "-q", SERVICE).splitlines()
            if len(ids) != 1:
                raise RuntimeError("Expected exactly one running preview Hub")
            data = json.loads(run("docker", "inspect", ids[0]))[0]
            if data["Config"]["Image"] != self.tag or not data["State"]["Running"]:
                raise RuntimeError("Unexpected preview image or stopped runtime")
            self.old_image = data["Image"]
            self.env = json.loads(run("docker", "exec", ids[0], "/app/.venv/bin/python", "-c", ENV_CODE))
        else:
            check_checkout(["eks/us-aibrary/prod/botcord-backend/k8s.yaml"])
            deployment = json.loads(kube("get", "deployment", SERVICE, "-o", "json"))
            containers = deployment["spec"]["template"]["spec"]["containers"]
            if len(containers) != 1 or containers[0]["name"] != SERVICE or containers[0]["image"] != self.tag:
                raise RuntimeError("Unexpected production deployment image contract")
            self.replicas = deployment["spec"]["replicas"]
            hpa = json.loads(kube("get", "hpa", "botcord-backend-hpa", "-o", "json"))["spec"]
            if hpa["scaleTargetRef"]["name"] != SERVICE or hpa.get("minReplicas", 1) < 1:
                raise RuntimeError("HPA cannot enter zero-replica maintenance mode")
            pods = json.loads(kube("get", "pods", "-l", "app=botcord-backend", "-o", "json"))["items"]
            if len(pods) != self.replicas or not pods:
                raise RuntimeError("Production must be stable before release")
            digests = set()
            for pod in pods:
                statuses = pod["status"].get("containerStatuses", [])
                if pod["metadata"].get("deletionTimestamp") or len(statuses) != 1 or not statuses[0]["ready"]:
                    raise RuntimeError("Production has an unready or terminating Hub")
                digests.add(statuses[0]["imageID"].removeprefix("docker-pullable://"))
            if len(digests) != 1:
                raise RuntimeError("Production runs multiple image revisions")
            self.old_image = digests.pop()
            validate_image(self.old_image)
            pod_name = pods[0]["metadata"]["name"]
            self.env = json.loads(kube("exec", pod_name, "-c", SERVICE, "--",
                                       "/app/.venv/bin/python", "-c", ENV_CODE))
        if not self.env.get("DATABASE_URL") or not self.env.get("BOTCORD_HUB_CONTROL_PRIVATE_KEY"):
            raise RuntimeError("Runtime is missing required database or signing configuration")
        # Keep an immutable old image locally before the maintenance window.
        if environment == "prod":
            run("docker", "pull", self.old_image, timeout=600)
        print(f"Runtime baseline: {environment}, image {self.old_image}, replicas {self.replicas}", flush=True)

    def dc(self, *args):
        return run("docker", "compose", "-f", str(self.compose), *args, timeout=360)

    def stop(self):
        if self.environment == "preview":
            self.dc("stop", "--timeout", "60", SERVICE)
            if self.dc("ps", "--status", "running", "-q", SERVICE):
                raise RuntimeError("Preview Hub did not stop")
        else:
            kube("scale", f"deployment/{SERVICE}", "--replicas=0")
            kube("wait", "--for=delete", "pod", "-l", "app=botcord-backend", "--timeout=180s")
        print("Old Hub and projection worker stopped", flush=True)

    def start(self):
        if self.environment == "preview":
            self.dc("pull", SERVICE)
            self.dc("up", "-d", "--no-deps", "--no-build", SERVICE)
        else:
            kube("rollout", "restart", f"deployment/{SERVICE}")
            kube("scale", f"deployment/{SERVICE}", f"--replicas={self.replicas}")
            kube("rollout", "status", f"deployment/{SERVICE}", "--timeout=300s")

    def verify(self, image):
        expected_id = run("docker", "image", "inspect", image, "--format", "{{.Id}}")
        for _ in range(45):
            try:
                if self.environment == "preview":
                    container = self.dc("ps", "-q", SERVICE)
                    actual_id = run("docker", "inspect", container, "--format", "{{.Image}}")
                    if actual_id != expected_id:
                        raise RuntimeError("Preview image differs from candidate")
                    run("docker", "exec", container, "/app/.venv/bin/python", "-c",
                        "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3)")
                else:
                    pods = json.loads(kube("get", "pods", "-l", "app=botcord-backend", "-o", "json"))["items"]
                    if len(pods) != self.replicas:
                        raise RuntimeError("Unexpected production replica count")
                    for pod in pods:
                        status = pod["status"]["containerStatuses"][0]
                        if not status["ready"] or status["imageID"].removeprefix("docker-pullable://") != image:
                            raise RuntimeError("Production readiness/image mismatch")
                        kube("exec", pod["metadata"]["name"], "-c", SERVICE, "--", "/app/.venv/bin/python", "-c",
                             "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8000/health',timeout=3)")
                print(f"Verified healthy {self.environment} runtime: {image}", flush=True)
                return
            except (RuntimeError, KeyError, IndexError):
                time.sleep(2)
        raise RuntimeError("New runtime failed image/readiness/HTTP verification")


def validate_image(image):
    if not re.fullmatch(re.escape(REPO) + r"@sha256:[0-9a-f]{64}", image):
        raise RuntimeError("Candidate must be an immutable image in the fixed US backend repository")


def promote(image, tag):
    run("docker", "tag", image, tag)
    run("docker", "push", tag, timeout=600)


def gate(image, mode, runtime, state):
    container = f"{state.name}-{mode}"
    try:
        output = run("docker", "run", "--name", container, "--rm", "--network", "host", "-i",
                     "--mount", f"type=bind,src={state},dst=/release-state",
                     "--mount", f"type=bind,src={GATE},dst=/release-gate.py,readonly",
                     "--mount", f"type=bind,src={VALIDATOR},dst=/release-capture-validator.py,readonly",
                     image, "/app/.venv/bin/python", "/release-gate.py", mode,
                     input=json.dumps(runtime.env), timeout=1800)
    except BaseException:
        # Killing the Docker client alone does not stop a migration container.
        subprocess.run(["docker", "rm", "-f", container], capture_output=True, timeout=30)
        raise
    if output:
        print(output, flush=True)
    return json.loads(output) if output else {}


def deploy(runtime, image, state):
    result = gate(image, "preflight", runtime, state)
    maintenance = result["needs_migration"]
    if maintenance:
        gate(runtime.old_image, "validate", runtime, state)
    changed = False
    snapshot_saved = False
    try:
        if maintenance:
            changed = True
            runtime.stop()
            gate(image, "snapshot", runtime, state)
            snapshot_saved = True
            gate(image, "apply", runtime, state)
        changed = True
        promote(image, runtime.tag)
        runtime.start()
        runtime.verify(image)
    except BaseException:
        if changed:
            print("Release failed; restoring previous capture and immutable image", flush=True)
            runtime.stop()
            if snapshot_saved:
                gate(image, "restore", runtime, state)
                gate(runtime.old_image, "backfill-old", runtime, state)
            promote(runtime.old_image, runtime.tag)
            runtime.start()
            runtime.verify(runtime.old_image)
            print("Previous runtime restored; release remains failed", flush=True)
        raise


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--environment", choices=("preview", "prod"), required=True)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    validate_image(args.image)
    run("docker", "pull", args.image, timeout=600)
    runtime = Runtime(args.environment)
    # Preserve recovery DDL on the runner if recovery itself fails. No secrets.
    state = Path(tempfile.mkdtemp(prefix="botcord-release-", dir=os.environ.get("RUNNER_TEMP")))
    print(f"Recovery state: {state}", flush=True)
    deploy(runtime, args.image, state)


if __name__ == "__main__":
    def cancelled(signum, frame):
        raise RuntimeError("Release interrupted; attempting bounded recovery")
    signal.signal(signal.SIGTERM, cancelled)
    try:
        main()
    except Exception as exc:
        print(f"Backend deployment failed: {type(exc).__name__}: {exc}", file=sys.stderr)
        sys.exit(1)
