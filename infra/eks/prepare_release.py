#!/usr/bin/env python3
"""Freeze release source/version once per Actions run, including rerun-all."""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
from pathlib import Path


def git(*args: str) -> str:
    return subprocess.check_output(["git", *args], text=True).strip()


def prepare(source: str, workflow_sha: str, run_id: str, snapshot: Path, retry: bool) -> dict[str, str]:
    if not re.fullmatch(r"[0-9a-f]{40}", workflow_sha) or not run_id.isdigit():
        raise ValueError("invalid immutable workflow/run identity")
    if retry:
        record = json.loads(snapshot.read_text())
        if (record.get("run_id") != run_id or record.get("source_branch") != source
                or record.get("workflow_sha") != workflow_sha
                or not re.fullmatch(r"[0-9a-f]{40}", record.get("source_sha", ""))):
            raise ValueError("release snapshot does not match this run; start a new release")
        return record
    git("check-ref-format", "refs/heads/" + source)
    if source == "main":
        mode = "normal"
    elif source.startswith("hotfix/"):
        mode = "hotfix"
    elif source == "release/latest":
        mode = "redeploy"
    elif source.startswith("release/"):
        mode = "rollback"
    else:
        raise ValueError("source must be main, hotfix/* or release/*")
    # main is the event's immutable commit, not whichever main exists after queueing.
    git("fetch", "origin", source, "--quiet")
    sha = workflow_sha if source == "main" else git("rev-parse", "FETCH_HEAD")
    git("cat-file", "-e", sha + "^{commit}")
    now = datetime.datetime.now(datetime.timezone.utc)
    archive = ""
    if mode in {"normal", "hotfix"}:
        base = "release/" + now.strftime("%Y-%m-%d")
        archive, seq = base, 2
        while git("ls-remote", "--heads", "origin", "refs/heads/" + archive):
            archive, seq = f"{base}-{seq}", seq + 1
    git("fetch", "--tags", "--quiet")
    base = f"v{now.year}.{now.month}.{now.day}"
    tags = git("tag", "-l", base, base + "-*").splitlines()
    versions = [1 if tag == base else int(tag[len(base) + 1:])
                for tag in tags if tag == base or re.fullmatch(re.escape(base) + r"-\d+", tag)]
    version = base if not versions else f"{base}-{max(versions) + 1}"
    record = dict(run_id=run_id, workflow_sha=workflow_sha, source_branch=source,
                  source_sha=sha, publish_mode=mode, archive_branch=archive,
                  deploy_branch="release/latest", version=version)
    snapshot.parent.mkdir(parents=True, exist_ok=True)
    snapshot.write_text(json.dumps(record, indent=2) + "\n")
    return record


def archive_release(record: dict[str, str]) -> None:
    branch = record["archive_branch"]
    if not branch:
        return
    existing = git("ls-remote", "--heads", "origin", "refs/heads/" + branch)
    if existing:
        if existing.split()[0] != record["source_sha"]:
            raise ValueError("archive identity changed; refusing overwrite")
        return
    git("push", "origin", f"{record['source_sha']}:refs/heads/{branch}")


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--archive", action="store_true")
    args = parser.parse_args()
    record = prepare(os.environ["SOURCE_BRANCH"], os.environ["GITHUB_SHA"],
                     os.environ["GITHUB_RUN_ID"], Path(os.environ["RELEASE_SNAPSHOT"]),
                     args.archive or os.environ["GITHUB_RUN_ATTEMPT"] != "1")
    if args.archive:
        archive_release(record)
        return
    with open(os.environ["GITHUB_OUTPUT"], "a") as output:
        for key, value in record.items():
            output.write(f"{key}={value}\n")
    print(f"Frozen release {record['version']}: {record['source_sha']} ({record['publish_mode']})")


if __name__ == "__main__":
    main()
