#!/usr/bin/env python3
"""Fail-closed deployment controller for the reviewed BotCord frontend manifest."""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import subprocess
import time
from pathlib import Path
from typing import Any


AWS_ACCOUNT = "928112001319"
AWS_REGION = "us-east-1"
KUBE_CONTEXT = "arn:aws:eks:us-east-1:928112001319:cluster/aibrary"
NAMESPACE = "prod"
SERVICE = "botcord-frontend"
DEVOPS_ROOT = Path("/www/devops")
MANIFEST = DEVOPS_ROOT / "eks/us-aibrary/prod/botcord-frontend/k8s.yaml"
IMAGE_PREFIX = f"{AWS_ACCOUNT}.dkr.ecr.{AWS_REGION}.amazonaws.com/botlearn-ai/{SERVICE}"
IMAGE_RE = re.compile(rf"^{re.escape(IMAGE_PREFIX)}@(sha256:[0-9a-f]{{64}})$")
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
ALLOWED_OBJECTS = {
    ("ConfigMap", f"{SERVICE}-config"),
    ("Deployment", SERVICE),
    ("Service", SERVICE),
    ("Ingress", f"{SERVICE}-ingress"),
}


class DeploymentError(RuntimeError):
    pass


def run(*args: str, cwd: Path | None = None) -> str:
    completed = subprocess.run(
        args, cwd=cwd, check=True, text=True,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    return completed.stdout.strip()


def parse_json_documents(value: str) -> list[dict[str, Any]]:
    decoder = json.JSONDecoder()
    offset = 0
    documents: list[dict[str, Any]] = []
    while offset < len(value):
        while offset < len(value) and value[offset].isspace():
            offset += 1
        if offset == len(value):
            break
        document, offset = decoder.raw_decode(value, offset)
        if document.get("kind") == "List":
            documents.extend(document.get("items", []))
        else:
            documents.append(document)
    return documents


def validate_objects(objects: list[dict[str, Any]]) -> tuple[str, str]:
    identities = {
        (obj.get("kind"), obj.get("metadata", {}).get("name")) for obj in objects
    }
    if identities != ALLOWED_OBJECTS or len(objects) != len(ALLOWED_OBJECTS):
        raise DeploymentError(f"unexpected manifest objects: {sorted(identities)}")
    for obj in objects:
        if obj.get("metadata", {}).get("namespace") != NAMESPACE:
            raise DeploymentError("every reviewed object must target namespace prod")

    deployment = next(obj for obj in objects if obj["kind"] == "Deployment")
    containers = deployment["spec"]["template"]["spec"].get("containers", [])
    if len(containers) != 1 or containers[0].get("name") != SERVICE:
        raise DeploymentError("frontend Deployment must have exactly one canonical container")
    image = containers[0].get("image", "")
    match = IMAGE_RE.fullmatch(image)
    if not match:
        raise DeploymentError("frontend image must be the fixed production ECR digest")
    return image, match.group(1)


def verify_devops_checkout() -> None:
    if not MANIFEST.is_file():
        raise DeploymentError(f"reviewed manifest missing: {MANIFEST}")
    run("git", "fetch", "origin", "main", "--quiet", cwd=DEVOPS_ROOT)
    if run("git", "rev-parse", "HEAD", cwd=DEVOPS_ROOT) != run(
        "git", "rev-parse", "origin/main", cwd=DEVOPS_ROOT
    ):
        raise DeploymentError("/www/devops is not synchronized to origin/main")
    relative = str(MANIFEST.relative_to(DEVOPS_ROOT))
    run("git", "ls-files", "--error-unmatch", "--", relative, cwd=DEVOPS_ROOT)
    if run(
        "git", "status", "--porcelain", "--untracked-files=no", "--", relative,
        cwd=DEVOPS_ROOT,
    ):
        raise DeploymentError("reviewed frontend manifest has local tracked drift")


def render_and_validate_manifest() -> tuple[str, str]:
    rendered = run(
        "kubectl", "--context", KUBE_CONTEXT, "create", "--dry-run=client",
        "-o", "json", "-f", str(MANIFEST),
    )
    return validate_objects(parse_json_documents(rendered))


def verify_identity() -> None:
    account = json.loads(
        run("aws", "sts", "get-caller-identity", "--output", "json")
    )["Account"]
    if account != AWS_ACCOUNT:
        raise DeploymentError(f"unexpected AWS account: {account}")
    context = run("kubectl", "config", "get-contexts", KUBE_CONTEXT, "-o", "name")
    if context != KUBE_CONTEXT:
        raise DeploymentError(f"US production Kubernetes context is unavailable: {context}")


def verify_candidate(source_sha: str, digest: str) -> None:
    result = json.loads(
        run(
            "aws", "ecr", "describe-images", "--region", AWS_REGION,
            "--repository-name", f"botlearn-ai/{SERVICE}",
            "--image-ids", f"imageDigest={digest}", "--output", "json",
        )
    )
    details = result.get("imageDetails", [])
    expected_prefix = f"prod-{source_sha}-"
    if len(details) != 1 or not any(
        tag.startswith(expected_prefix) for tag in details[0].get("imageTags", [])
    ):
        raise DeploymentError(
            "reviewed digest is not a production candidate for the requested source commit"
        )


def verify_rollout(digest: str) -> str:
    run(
        "kubectl", "--context", KUBE_CONTEXT, "-n", NAMESPACE,
        "rollout", "status", f"deployment/{SERVICE}", "--timeout=600s",
    )
    deployment = json.loads(
        run(
            "kubectl", "--context", KUBE_CONTEXT, "-n", NAMESPACE,
            "get", "deployment", SERVICE, "-o", "json",
        )
    )
    desired = deployment.get("spec", {}).get("replicas", 1)
    available = deployment.get("status", {}).get("availableReplicas", 0)
    if not isinstance(desired, int) or desired < 1 or available < desired:
        raise DeploymentError("frontend Deployment does not have all desired replicas available")

    pods = json.loads(
        run(
            "kubectl", "--context", KUBE_CONTEXT, "-n", NAMESPACE,
            "get", "pods", "-l", f"app={SERVICE}", "-o", "json",
        )
    ).get("items", [])
    pods = [pod for pod in pods if not pod.get("metadata", {}).get("deletionTimestamp")]
    if len(pods) < desired:
        raise DeploymentError("frontend rollout has fewer active Pods than desired replicas")
    expected_id = f"docker-pullable://{IMAGE_PREFIX}@{digest}"
    for pod in pods:
        statuses = pod.get("status", {}).get("containerStatuses", [])
        if len(statuses) != 1 or not statuses[0].get("ready"):
            raise DeploymentError("frontend Pod is not Ready")
        # Runtimes may report either docker-pullable:// or containerd://.
        if not statuses[0].get("imageID", "").endswith(f"{IMAGE_PREFIX}@{digest}"):
            raise DeploymentError(
                f"frontend Pod is not on the reviewed image digest (expected {expected_id})"
            )

    for _ in range(30):
        ingress = json.loads(
            run(
                "kubectl", "--context", KUBE_CONTEXT, "-n", NAMESPACE,
                "get", "ingress", f"{SERVICE}-ingress", "-o", "json",
            )
        )
        entries = ingress.get("status", {}).get("loadBalancer", {}).get("ingress", [])
        hostnames = [entry.get("hostname") for entry in entries if entry.get("hostname")]
        if len(hostnames) == 1:
            return hostnames[0]
        time.sleep(10)
    raise DeploymentError("frontend Ingress did not expose one ALB hostname within 5 minutes")


def verify_https(alb_hostname: str) -> None:
    for _ in range(12):
        try:
            body = run(
                "curl", "--fail", "--silent", "--show-error",
                "--connect-timeout", "10", "--max-time", "20",
                "--connect-to", f"www.botcord.chat:443:{alb_hostname}:443",
                "https://www.botcord.chat/api/health",
            )
            payload = json.loads(body)
            if payload.get("status") == "ok" and payload.get("service") == "botcord-web":
                return
        except (subprocess.CalledProcessError, json.JSONDecodeError):
            pass
        time.sleep(10)
    raise DeploymentError("frontend HTTPS health failed through the new ALB")


def deploy(source_sha: str) -> None:
    if not SHA_RE.fullmatch(source_sha):
        raise DeploymentError("deployment requires an exact 40-character source commit")
    verify_devops_checkout()
    verify_identity()
    reviewed_hash = hashlib.sha256(MANIFEST.read_bytes()).hexdigest()
    image, digest = render_and_validate_manifest()
    verify_candidate(source_sha, digest)
    if hashlib.sha256(MANIFEST.read_bytes()).hexdigest() != reviewed_hash:
        raise DeploymentError("reviewed frontend manifest changed during validation")
    print(f"Deploying reviewed image {image}")
    run("kubectl", "--context", KUBE_CONTEXT, "apply", "-f", str(MANIFEST))
    alb_hostname = verify_rollout(digest)
    verify_https(alb_hostname)
    print(f"Verified {image} at https://www.botcord.chat through {alb_hostname}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--source-sha", required=True)
    args = parser.parse_args()
    try:
        deploy(args.source_sha)
    except (DeploymentError, subprocess.CalledProcessError) as exc:
        raise SystemExit(f"deployment refused: {exc}") from exc


if __name__ == "__main__":
    main()
