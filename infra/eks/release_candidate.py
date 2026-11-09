#!/usr/bin/env python3
"""Candidate marker and read-only reviewed-manifest wait; never changes a cluster."""
from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import time
from pathlib import Path
from urllib.request import Request, urlopen

REGION = "us-east-1"
ACCOUNT = "928112001319"
REPOSITORY = "botlearn-ai/botcord-frontend"
PREFIX = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/{REPOSITORY}"
ROOT = Path("/www/devops")
MANIFEST = Path("eks/us-aibrary/prod/botcord-frontend/k8s.yaml")
DIGEST = re.compile(r"sha256:[0-9a-f]{64}")


def run(*args: str, cwd: Path | None = None) -> str:
    return subprocess.check_output(args, text=True, cwd=cwd, stderr=subprocess.PIPE, timeout=120).strip()


def tag_for(sha: str, run_id: str, restore: bool = False) -> str:
    if not re.fullmatch(r"[0-9a-f]{40}", sha) or not run_id.isdigit():
        raise ValueError("candidate requires an exact source SHA and numeric run ID")
    return f"{'rollback' if restore else 'release'}-{sha}-{run_id}"


def ecr(*args: str) -> dict:
    return json.loads(run("aws", "ecr", *args, "--region", REGION, "--output", "json"))


def lookup(tag: str) -> str:
    result = ecr("batch-get-image", "--repository-name", REPOSITORY, "--image-ids", f"imageTag={tag}")
    failures = result.get("failures", [])
    if len(failures) == 1 and failures[0].get("failureCode") == "ImageNotFound" and not result.get("images"):
        return ""
    images = result.get("images", [])
    if failures or len(images) != 1:
        raise ValueError("cannot resolve candidate marker safely")
    digest = images[0]["imageId"]["imageDigest"]
    if not DIGEST.fullmatch(digest):
        raise ValueError("invalid candidate digest")
    return digest


def validate(sha: str, digest: str, run_id: str, restore: bool = False) -> str:
    if not DIGEST.fullmatch(digest):
        raise ValueError("invalid candidate digest")
    image = PREFIX + "@" + digest
    run("docker", "pull", image)
    detail = json.loads(run("docker", "image", "inspect", image, "--format", "{{json .}}"))
    labels = detail.get("Config", {}).get("Labels") or {}
    if (detail.get("Os") != "linux" or detail.get("Architecture") != "arm64"
            or labels.get("org.opencontainers.image.revision") != sha):
        raise ValueError("candidate platform or source provenance mismatch")
    if restore:
        details = ecr("describe-images", "--repository-name", REPOSITORY,
                      "--image-ids", f"imageDigest={digest}").get("imageDetails", [])
        pattern = re.compile(rf"^prod-{sha}-([0-9]+)-[0-9]+$")
        original_runs = {match.group(1) for item in details for tag in item.get("imageTags", [])
                         if (match := pattern.fullmatch(tag))}
        if not original_runs:
            raise ValueError("rollback requires original source-addressed production candidate tag")
        if labels.get("org.opencontainers.image.source", "https://github.com/botlearn-ai/botcord") != "https://github.com/botlearn-ai/botcord":
            raise ValueError("rollback image source label mismatch")
        if labels.get("com.botcord.release.run-id") and labels["com.botcord.release.run-id"] not in original_runs:
            raise ValueError("rollback build run label mismatch")
    elif (labels.get("org.opencontainers.image.source") != "https://github.com/botlearn-ai/botcord"
          or labels.get("com.botcord.release.run-id") != run_id):
        raise ValueError("candidate source or release run provenance mismatch")
    return image


def publish(sha: str, tag: str, digest: str) -> str:
    image = validate(sha, digest, tag.rsplit("-", 1)[1], tag.startswith("rollback-"))
    existing = lookup(tag)
    if existing:
        if existing != digest:
            raise ValueError("refusing to overwrite a release candidate marker")
        return image
    result = ecr("batch-get-image", "--repository-name", REPOSITORY, "--image-ids", f"imageDigest={digest}")
    images = result.get("images", [])
    if result.get("failures") or len(images) != 1:
        raise ValueError("candidate manifest unavailable")
    ecr("put-image", "--repository-name", REPOSITORY, "--image-tag", tag,
        "--image-manifest", images[0]["imageManifest"])
    if lookup(tag) != digest:
        raise ValueError("candidate marker changed during publication")
    return image


def restore_image(sha: str, explicit_image: str, mode: str) -> str:
    if explicit_image:
        if not re.fullmatch(re.escape(PREFIX) + r"@sha256:[0-9a-f]{64}", explicit_image):
            raise ValueError("frontend_image must be a full fixed-registry digest")
        image = explicit_image
    elif mode == "redeploy":
        images = re.findall(r"^\s*image:\s*(\S+)\s*$", (ROOT / MANIFEST).read_text(), re.MULTILINE)
        if len(images) != 1 or not synchronized(images[0]):
            raise ValueError("redeploy requires the current clean synchronized image")
        image = images[0]
    else:
        details = ecr("describe-images", "--repository-name", REPOSITORY).get("imageDetails", [])
        pattern = re.compile(rf"^prod-{sha}-[0-9]+-[0-9]+$")
        digests = {item["imageDigest"] for item in details
                   if any(pattern.fullmatch(tag) for tag in item.get("imageTags", []))}
        if len(digests) != 1:
            raise ValueError("rollback source has zero/multiple candidates; supply exact frontend_image")
        image = PREFIX + "@" + digests.pop()
    return validate(sha, image.split("@", 1)[1], "", restore=True)


def synchronized(image: str) -> bool:
    # Only fetch remote metadata; checkout changes are exclusively Sync to DevOps' job.
    run("git", "fetch", "origin", "main", "--quiet", cwd=ROOT)
    if run("git", "rev-parse", "HEAD", cwd=ROOT) != run("git", "rev-parse", "origin/main", cwd=ROOT):
        return False
    run("git", "ls-files", "--error-unmatch", "--", str(MANIFEST), cwd=ROOT)
    if run("git", "status", "--porcelain", "--untracked-files=no", "--", str(MANIFEST), cwd=ROOT):
        raise ValueError("tracked frontend manifest drift; refusing to wait past it")
    images = re.findall(r"^\s*image:\s*(\S+)\s*$", (ROOT / MANIFEST).read_text(), re.MULTILINE)
    return images == [image]


def wait_review(sha: str, tag: str, image: str, timeout: int = 7200) -> None:
    if not re.fullmatch(re.escape(PREFIX) + r"@sha256:[0-9a-f]{64}", image):
        raise ValueError("invalid expected production image")
    digest = image.split("@", 1)[1]
    deadline = time.monotonic() + timeout
    print(f"Waiting for reviewed DevOps PR + Sync: {tag} -> {digest}", flush=True)
    print("Review: https://github.com/readai-team/aibrary-devops/pulls", flush=True)
    while True:
        if lookup(tag) != digest:
            raise ValueError("candidate marker drift detected; start a new release")
        if synchronized(image):
            validate(sha, digest, tag.rsplit("-", 1)[1], tag.startswith("rollback-"))
            print("Exact reviewed candidate is synchronized; preflight may proceed", flush=True)
            return
        if time.monotonic() >= deadline:
            raise TimeoutError("review/sync timed out; merge the exact PR then rerun failed jobs")
        time.sleep(30)


def verify_ci(sha: str, timeout: int = 1200) -> None:
    deadline = time.monotonic() + timeout
    url = ("https://api.github.com/repos/botlearn-ai/botcord/actions/workflows/ci.yml/runs"
           f"?head_sha={sha}&per_page=100")
    while True:
        request = Request(url, headers={"Authorization": "Bearer " + os.environ["GH_TOKEN"],
                                       "Accept": "application/vnd.github+json"})
        with urlopen(request, timeout=30) as response:
            runs = json.load(response)["workflow_runs"]
        runs = [item for item in runs if item.get("head_sha") == sha
                and item.get("head_repository", {}).get("full_name") == "botlearn-ai/botcord"]
        if runs:
            latest = max(runs, key=lambda item: item["id"])
            if latest["status"] == "completed":
                if latest["conclusion"] != "success":
                    raise ValueError("source CI did not succeed: " + latest["html_url"])
                print("Source CI passed: " + latest["html_url"])
                return
        if time.monotonic() >= deadline:
            raise TimeoutError("no successful source CI within 20 minutes")
        time.sleep(30)


def output(**values: str) -> None:
    with open(os.environ["GITHUB_OUTPUT"], "a") as handle:
        for key, value in values.items():
            handle.write(f"{key}={value}\n")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["resolve", "publish", "wait", "ci"])
    parser.add_argument("--source-sha", required=True)
    parser.add_argument("--run-id", default=os.environ.get("GITHUB_RUN_ID", ""))
    parser.add_argument("--digest", default="")
    parser.add_argument("--image", default="")
    parser.add_argument("--mode", choices=["normal", "hotfix", "rollback", "redeploy"], default="normal")
    parser.add_argument("--candidate-tag", default="")
    args = parser.parse_args()
    restore = args.mode in {"rollback", "redeploy"}
    tag = tag_for(args.source_sha, args.run_id, restore)
    if args.candidate_tag:
        if args.candidate_tag not in {tag_for(args.source_sha, args.run_id), tag_for(args.source_sha, args.run_id, True)}:
            raise ValueError("candidate tag is outside this frozen source/run")
        tag = args.candidate_tag
        restore = tag.startswith("rollback-")
    if args.command == "ci":
        verify_ci(args.source_sha)
        return
    if json.loads(run("aws", "sts", "get-caller-identity", "--output", "json"))["Account"] != ACCOUNT:
        raise ValueError("wrong AWS account")
    if args.command == "resolve":
        digest = lookup(tag)
        if digest:
            image = validate(args.source_sha, digest, args.run_id, restore)
        elif restore:
            image = restore_image(args.source_sha, args.image, args.mode)
            publish(args.source_sha, tag, image.split("@", 1)[1])
        else:
            if args.image:
                raise ValueError("frontend_image is only accepted for redeploy/rollback")
            image = ""
        output(image=image, candidate_tag=tag)
    elif args.command == "publish":
        output(image=publish(args.source_sha, tag, args.digest), candidate_tag=tag)
    else:
        wait_review(args.source_sha, tag, args.image)


if __name__ == "__main__":
    main()
