#!/usr/bin/env python3
"""Deploy the BotCord test stack from a commit-pinned Dokploy GitHub source."""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from dataclasses import dataclass
from typing import Any


ENVIRONMENT_ID = "5he_zWMNfE-ED_oN47Nc5"
PROJECT_ID = "5UIS5-vklz4ac_SW1TgtP"
GITHUB_ID = "FB6EqcETvaxkY0D239q0I"
OWNER = "botlearn-ai"
REPOSITORY = "botcord"
SHA_RE = re.compile(r"^[0-9a-f]{40}$")
IMAGE_RE = re.compile(r"^\S+@sha256:[0-9a-f]{64}$")
DATABASE_NETWORK_ID = "4Kbb8OeuSSOv1tvzmzHyG"
DATABASE_NODE_CONSTRAINT = "node.id==pcc2py85mdnziaxjn322plfx8"


@dataclass(frozen=True)
class Resource:
    name: str
    compose_id: str
    app_name: str
    compose_path: str
    services: tuple[str, ...]
    image_key: str | None = None


@dataclass(frozen=True)
class NativeDatabase:
    name: str
    kind: str
    service_id: str
    app_name: str
    docker_image: str
    volume_source: str
    volume_target: str


RESOURCES = (
    Resource(
        "backend",
        "Ug07R-0ic81Rm8uHA1SE6",
        "botcord-backend-trvtoz",
        "infra/dokploy/botcord-backend.yml",
        ("botcord-backend",),
        "BOTCORD_BACKEND_IMAGE",
    ),
    Resource(
        "gateway",
        "4cHGyGZLYTEe7dTxtaFIe",
        "botcord-gateway-ingress-eymfyp",
        "infra/dokploy/botcord-gateway-ingress.yml",
        ("botcord-gateway-ingress",),
        "BOTCORD_GATEWAY_INGRESS_IMAGE",
    ),
    Resource(
        "frontend",
        "amZUZW2R40fAmNop14Zbc",
        "botcord-frontend-hdarg2",
        "infra/dokploy/botcord-frontend.yml",
        ("botcord-frontend",),
        "BOTCORD_FRONTEND_IMAGE",
    ),
)

NATIVE_DATABASES = (
    NativeDatabase(
        "postgres",
        "postgres",
        "y4SAYkwmTWF-uYkB1Yn5s",
        "botcord-postgres-native-5pmi4g",
        "postgres:16-alpine@sha256:0cefaabd882e42bcb2a2f3dc56d3ce4770560ba62fd7f197f1a2e008fd5731ab",
        "botcord-data-rhhgnk_botcord_postgres_data",
        "/var/lib/postgresql/data",
    ),
    NativeDatabase(
        "redis",
        "redis",
        "dM0yCFytwg_FAw0nXsEZ6",
        "botcord-redis-native-ogq8mr",
        "redis:7-alpine@sha256:6ba19c50b56777f5c11c58eff8ddb69d0d5f27ba131cffb63f180ccfd43c66af",
        "botcord-data-rhhgnk_botcord_redis_data",
        "/data",
    ),
)


class DeploymentError(RuntimeError):
    """A sanitized deployment failure safe to write to CI logs."""


class GitHubRefNotFound(DeploymentError):
    pass


class GitHubRefAlreadyExists(DeploymentError):
    pass


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, fp, code, message, headers, new_url):
        return None


def compose_ref(sha: str) -> str:
    if not SHA_RE.fullmatch(sha):
        raise DeploymentError("A full lowercase source commit is required")
    return f"dokploy-test-{sha}"


def merge_env(current: str, key: str | None, image: str | None) -> str:
    if key is None:
        return current
    if image is None or not IMAGE_RE.fullmatch(image):
        raise DeploymentError(f"{key} requires an immutable image digest")
    pattern = re.compile(rf"^\s*(?:export\s+)?{re.escape(key)}\s*=")
    lines = [line for line in current.splitlines() if not pattern.match(line)]
    lines.append(f"{key}={image}")
    return "\n".join(lines) + ("\n" if current.endswith("\n") else "")


class IO:
    """External operations. Responses are parsed in memory and never logged."""

    def _open(self, request: urllib.request.Request):
        return urllib.request.build_opener(_NoRedirect()).open(request, timeout=60)

    def _trpc(self, procedure: str, payload: dict[str, Any], *, method: str) -> Any:
        base_url = os.environ.get("DOKPLOY_URL", "").rstrip("/")
        token = os.environ.get("DOKPLOY_AUTH_TOKEN", "")
        if base_url != "https://console.botlearn.ai" or not token:
            raise DeploymentError("HTTPS Dokploy credentials are required")
        url = f"{base_url}/api/trpc/{procedure}"
        body = None
        if method == "GET":
            query = urllib.parse.urlencode(
                {"input": json.dumps({"json": payload}, separators=(",", ":"))}
            )
            url = f"{url}?{query}"
        else:
            body = json.dumps({"json": payload}, separators=(",", ":")).encode()
        request = urllib.request.Request(
            url,
            data=body,
            method=method,
            headers={"x-api-key": token, "Content-Type": "application/json"},
        )
        try:
            with self._open(request) as response:
                raw = response.read()
        except (OSError, TimeoutError, urllib.error.URLError) as exc:
            raise DeploymentError(f"Dokploy request failed: {procedure}") from exc
        try:
            result = json.loads(raw)
            value = result["result"]["data"]["json"]
        except (json.JSONDecodeError, KeyError, TypeError) as exc:
            raise DeploymentError(f"Invalid Dokploy response: {procedure}") from exc
        return value

    @staticmethod
    def _pairs(args: list[str], allowed: set[str]) -> dict[str, str]:
        if len(args) % 2:
            raise DeploymentError("Unsupported Dokploy command shape")
        result: dict[str, str] = {}
        for index in range(0, len(args), 2):
            flag, value = args[index : index + 2]
            if flag not in allowed or flag in result or not isinstance(value, str):
                raise DeploymentError("Unsupported Dokploy command shape")
            result[flag] = value
        if set(result) != allowed:
            raise DeploymentError("Unsupported Dokploy command shape")
        return result

    def _update(self, args: list[str]) -> Any:
        if args[-2:] != ["--createEnvFile", "--no-autoDeploy"]:
            raise DeploymentError("Unsupported Dokploy update shape")
        values = self._pairs(
            args[:-2],
            {
                "--composeId",
                "--sourceType",
                "--composeType",
                "--owner",
                "--repository",
                "--githubId",
                "--branch",
                "--composePath",
                "--env",
            },
        )
        payload = {flag.removeprefix("--"): value for flag, value in values.items()}
        payload.update({"createEnvFile": True, "autoDeploy": False})
        return self._trpc("compose.update", payload, method="POST")

    def cli(self, args: list[str]) -> Any:
        for kind in ("postgres", "redis"):
            if args[:2] == [kind, "one"]:
                id_flag = f"--{kind}Id"
                values = self._pairs(args[2:], {id_flag})
                return self._trpc(
                    f"{kind}.one", {f"{kind}Id": values[id_flag]}, method="GET"
                )
        if args[:2] == ["compose", "one"]:
            values = self._pairs(args[2:], {"--composeId"})
            return self._trpc(
                "compose.one", {"composeId": values["--composeId"]}, method="GET"
            )
        if args[:2] == ["deployment", "all-by-compose"]:
            values = self._pairs(args[2:], {"--composeId"})
            return self._trpc(
                "deployment.allByCompose",
                {"composeId": values["--composeId"]},
                method="GET",
            )
        if args[:2] == ["docker", "get-containers-by-app-name-match"]:
            allowed = (
                {"--appName"}
                if len(args) == 4
                else {"--appType", "--appName"}
            )
            values = self._pairs(args[2:], allowed)
            payload = {"appName": values["--appName"]}
            if "--appType" in values:
                payload["appType"] = values["--appType"]
            return self._trpc(
                "docker.getContainersByAppNameMatch",
                payload,
                method="GET",
            )
        if args[:2] == ["compose", "update"]:
            return self._update(args[2:])
        command = ["dokploy", *args, "--json"]
        try:
            result = subprocess.run(command, capture_output=True, text=True, timeout=60)
        except (OSError, subprocess.TimeoutExpired) as exc:
            raise DeploymentError("Dokploy operation could not complete") from exc
        if result.returncode != 0:
            operation = " ".join(args[:2])
            raise DeploymentError(f"Dokploy operation failed: {operation}")
        try:
            return json.loads(result.stdout)
        except json.JSONDecodeError as exc:
            raise DeploymentError("Dokploy returned invalid JSON") from exc

    def gh(self, args: list[str]) -> Any:
        token = os.environ.get("GH_TOKEN", "")
        if not token:
            raise DeploymentError("GitHub credentials are required")
        tag_prefix = f"repos/{OWNER}/{REPOSITORY}/git/ref/tags/dokploy-test-"
        create_endpoint = f"repos/{OWNER}/{REPOSITORY}/git/refs"
        method = "GET"
        body = None
        if (
            len(args) == 2
            and args[0] == "api"
            and args[1].startswith(tag_prefix)
            and SHA_RE.fullmatch(args[1][len(tag_prefix) :])
        ):
            endpoint = args[1]
        elif (
            len(args) == 8
            and args[:2] == ["api", create_endpoint]
            and args[2:4] == ["--method", "POST"]
            and args[4] == "-f"
            and args[6] == "-f"
        ):
            endpoint = create_endpoint
            ref_value = args[5].removeprefix("ref=refs/tags/dokploy-test-")
            sha_value = args[7].removeprefix("sha=")
            if (
                not args[5].startswith("ref=refs/tags/dokploy-test-")
                or not args[7].startswith("sha=")
                or not SHA_RE.fullmatch(ref_value)
                or sha_value != ref_value
            ):
                raise DeploymentError("Unsupported GitHub request shape")
            method = "POST"
            body = json.dumps(
                {
                    "ref": f"refs/tags/dokploy-test-{ref_value}",
                    "sha": sha_value,
                },
                separators=(",", ":"),
            ).encode()
        else:
            raise DeploymentError("Unsupported GitHub request shape")
        request = urllib.request.Request(
            f"https://api.github.com/{endpoint}",
            data=body,
            method=method,
            headers={
                "Authorization": f"Bearer {token}",
                "Accept": "application/vnd.github+json",
                "Content-Type": "application/json",
                "X-GitHub-Api-Version": "2022-11-28",
            },
        )
        try:
            with self._open(request) as response:
                raw = response.read()
        except urllib.error.HTTPError as exc:
            if exc.code == 404:
                raise GitHubRefNotFound("GitHub Compose ref was not found") from None
            if exc.code == 422:
                raise GitHubRefAlreadyExists("GitHub Compose ref already exists") from None
            raise DeploymentError("GitHub Compose ref operation failed") from None
        except (OSError, TimeoutError, urllib.error.URLError) as exc:
            raise DeploymentError("GitHub Compose ref operation could not complete") from exc
        try:
            return json.loads(raw)
        except json.JSONDecodeError as exc:
            raise DeploymentError("GitHub returned invalid JSON") from exc

    def sleep(self, seconds: float) -> None:
        time.sleep(seconds)

    def http_status(self, url: str) -> int:
        request = urllib.request.Request(url, headers={"User-Agent": "botcord-deploy/1"})
        try:
            with urllib.request.urlopen(request, timeout=20) as response:
                return response.status
        except urllib.error.HTTPError as exc:
            return exc.code
        except (urllib.error.URLError, TimeoutError) as exc:
            raise DeploymentError("Public HTTPS health check failed") from exc


def _verify_tag(value: Any, sha: str) -> None:
    if not isinstance(value, dict):
        raise DeploymentError("GitHub Compose ref could not be verified")
    target = value.get("object") or {}
    if target.get("type") != "commit" or target.get("sha") != sha:
        raise DeploymentError("GitHub Compose ref points to an unexpected commit")


def ensure_ref(io: IO, sha: str) -> str:
    ref = compose_ref(sha)
    endpoint = f"repos/{OWNER}/{REPOSITORY}/git/ref/tags/{ref}"
    try:
        _verify_tag(io.gh(["api", endpoint]), sha)
        return ref
    except GitHubRefNotFound:
        pass

    try:
        created = io.gh(
            [
                "api",
                f"repos/{OWNER}/{REPOSITORY}/git/refs",
                "--method",
                "POST",
                "-f",
                f"ref=refs/tags/{ref}",
                "-f",
                f"sha={sha}",
            ]
        )
        _verify_tag(created, sha)
    except GitHubRefAlreadyExists:
        _verify_tag(io.gh(["api", endpoint]), sha)
    return ref


def validate_identity(resource: Resource, value: Any, adopt_provider: bool) -> None:
    if not isinstance(value, dict):
        raise DeploymentError(f"{resource.name}: invalid Dokploy resource")
    environment = value.get("environment") or {}
    if (
        value.get("composeId") != resource.compose_id
        or value.get("appName") != resource.app_name
        or value.get("environmentId") != ENVIRONMENT_ID
        or environment.get("projectId") != PROJECT_ID
        or value.get("composeType") != "docker-compose"
    ):
        raise DeploymentError(f"{resource.name}: Dokploy target identity mismatch")

    if value.get("sourceType") == "raw" and adopt_provider:
        return
    if (
        value.get("sourceType") != "github"
        or value.get("owner") != OWNER
        or value.get("repository") != REPOSITORY
        or value.get("githubId") != GITHUB_ID
        or value.get("composePath") != resource.compose_path
        or value.get("autoDeploy") is not False
    ):
        raise DeploymentError(f"{resource.name}: GitHub Provider identity mismatch")


def validate_native_database_identity(
    database: NativeDatabase, value: Any
) -> None:
    if not isinstance(value, dict):
        raise DeploymentError(f"{database.name}: invalid native database")
    environment = value.get("environment") or {}
    placement = value.get("placementSwarm") or {}
    mounts = value.get("mounts")
    mount = mounts[0] if isinstance(mounts, list) and len(mounts) == 1 else {}
    if (
        value.get(f"{database.kind}Id") != database.service_id
        or value.get("appName") != database.app_name
        or value.get("environmentId") != ENVIRONMENT_ID
        or environment.get("projectId") != PROJECT_ID
        or value.get("externalPort") is not None
        or value.get("detachDokployNetwork") is not True
        or value.get("networkIds") != [DATABASE_NETWORK_ID]
        or type(value.get("replicas")) is not int
        or value.get("replicas") != 1
        or not isinstance(placement, dict)
        or placement.get("Constraints") != [DATABASE_NODE_CONSTRAINT]
        or value.get("dockerImage") != database.docker_image
        or not isinstance(mount, dict)
        or mount.get("type") != "volume"
        or mount.get("volumeName") != database.volume_source
        or mount.get("mountPath") != database.volume_target
    ):
        raise DeploymentError(f"{database.name}: native database identity mismatch")


def verify_native_database_runtime(io: IO, database: NativeDatabase) -> None:
    containers = io.cli(
        [
            "docker",
            "get-containers-by-app-name-match",
            "--appName",
            database.app_name,
        ]
    )
    if not isinstance(containers, list) or any(
        not isinstance(item, dict) for item in containers
    ):
        raise DeploymentError(f"{database.name}: native database runtime mismatch")
    expected_name = re.compile(rf"^{re.escape(database.app_name)}\.1\.[a-z0-9]+$")
    matching = [
        item
        for item in containers
        if isinstance(item.get("name"), str)
        and expected_name.fullmatch(item["name"])
        and item.get("state") not in {"dead", "exited"}
    ]
    if len(matching) != 1:
        raise DeploymentError(f"{database.name}: native database runtime mismatch")
    container = matching[0]
    status = container.get("status") or ""
    if (
        container.get("state") != "running"
        or not isinstance(status, str)
        or "(healthy)" not in status
        or "unhealthy" in status
    ):
        raise DeploymentError(f"{database.name}: native database container unhealthy")


def verify_native_databases(io: IO) -> None:
    for database in NATIVE_DATABASES:
        value = io.cli(
            [database.kind, "one", f"--{database.kind}Id", database.service_id]
        )
        validate_native_database_identity(database, value)
        verify_native_database_runtime(io, database)


def _deployment_ids(io: IO, resource: Resource) -> set[str]:
    records = io.cli(
        ["deployment", "all-by-compose", "--composeId", resource.compose_id]
    )
    if not isinstance(records, list):
        raise DeploymentError(f"{resource.name}: invalid deployment history")
    return {
        item["deploymentId"]
        for item in records
        if isinstance(item, dict) and isinstance(item.get("deploymentId"), str)
    }


def _wait_deployment(
    io: IO,
    resource: Resource,
    seen: set[str],
    timeout_seconds: float,
    deployment_id: str | None = None,
) -> str:
    deadline = time.monotonic() + timeout_seconds
    while time.monotonic() < deadline:
        records = io.cli(
            ["deployment", "all-by-compose", "--composeId", resource.compose_id]
        )
        if not isinstance(records, list):
            raise DeploymentError(f"{resource.name}: invalid deployment history")
        created = [
            item
            for item in records
            if isinstance(item, dict) and item.get("deploymentId") not in seen
        ]
        if deployment_id is None:
            if len(created) > 1:
                raise DeploymentError(f"{resource.name}: ambiguous deployment records")
            if created:
                deployment_id = created[0].get("deploymentId")
                if not isinstance(deployment_id, str):
                    raise DeploymentError(f"{resource.name}: invalid deployment record")
        current = next(
            (item for item in records if item.get("deploymentId") == deployment_id), None
        )
        if current and current.get("status") == "error":
            raise DeploymentError(f"{resource.name}: Dokploy deployment failed")
        if current and current.get("status") == "done":
            return deployment_id
        io.sleep(5)
    raise DeploymentError(f"{resource.name}: Dokploy deployment timed out")


def verify_runtime(
    io: IO,
    resource: Resource,
    timeout_seconds: float = 240,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    expected_names = {f"{resource.app_name}-{service}-1" for service in resource.services}
    while time.monotonic() < deadline:
        containers = io.cli(
            [
                "docker",
                "get-containers-by-app-name-match",
                "--appType",
                "docker-compose",
                "--appName",
                resource.app_name,
            ]
        )
        if not isinstance(containers, list) or any(
            not isinstance(item, dict) for item in containers
        ):
            raise DeploymentError(f"{resource.name}: invalid container response")
        names = [item.get("name") for item in containers]
        if len(names) != len(set(names)):
            raise DeploymentError(f"{resource.name}: duplicate runtime containers")
        if any(name not in expected_names for name in names):
            raise DeploymentError(f"{resource.name}: unexpected runtime container")
        if set(names) != expected_names:
            io.sleep(5)
            continue
        for container in containers:
            state = container.get("state")
            status = container.get("status") or ""
            if state in {"dead", "exited", "restarting"} or "unhealthy" in status:
                raise DeploymentError(f"{resource.name}: container unhealthy")
        if all(
            item.get("state") == "running" and "(healthy)" in (item.get("status") or "")
            for item in containers
        ):
            return
        io.sleep(5)
    raise DeploymentError(f"{resource.name}: runtime health timed out")


def verify_public_https(io: IO) -> None:
    for url in (
        "https://api.test.botcord.chat/health",
        "https://www.test.botcord.chat/api/health",
    ):
        if io.http_status(url) != 200:
            raise DeploymentError("Public HTTPS health check failed")


def deploy(
    sha: str,
    images: dict[str, str],
    *,
    adopt_provider: bool = False,
    io: IO | None = None,
    deployment_timeout: float = 600,
) -> None:
    io = io or IO()
    if os.environ.get("DOKPLOY_URL", "").rstrip("/") != "https://console.botlearn.ai":
        raise DeploymentError("Dokploy target URL mismatch")
    if not os.environ.get("DOKPLOY_AUTH_TOKEN") or not os.environ.get("GH_TOKEN"):
        raise DeploymentError("Dokploy and GitHub credentials are required")
    # Validate all artifacts before reading or mutating a Provider resource.
    for resource in RESOURCES:
        if resource.image_key is not None:
            merge_env("", resource.image_key, images.get(resource.name))
    # Native databases are provisioned independently. CI must only verify their
    # exact private identities and healthy tasks; it never mutates or deploys them.
    verify_native_databases(io)
    branch = compose_ref(sha)
    previous: dict[str, Any] = {}

    # Validate every target before the first mutation. Raw is accepted only for
    # the explicit one-time Provider adoption run.
    for resource in RESOURCES:
        value = io.cli(["compose", "one", "--composeId", resource.compose_id])
        validate_identity(resource, value, adopt_provider)
        previous[resource.name] = value
    ensure_ref(io, sha)

    for resource in RESOURCES:
        before = previous[resource.name]
        env = merge_env(
            before.get("env") or "", resource.image_key, images.get(resource.name)
        )
        args = [
            "compose",
            "update",
            "--composeId",
            resource.compose_id,
            "--sourceType",
            "github",
            "--composeType",
            "docker-compose",
            "--owner",
            OWNER,
            "--repository",
            REPOSITORY,
            "--githubId",
            GITHUB_ID,
            "--branch",
            branch,
            "--composePath",
            resource.compose_path,
            "--env",
            env,
            "--createEnvFile",
            "--no-autoDeploy",
        ]
        io.cli(args)
        current = io.cli(["compose", "one", "--composeId", resource.compose_id])
        validate_identity(resource, current, False)
        if (
            current.get("branch") != branch
            or current.get("env") != env
            or current.get("createEnvFile") is not True
        ):
            raise DeploymentError(f"{resource.name}: Dokploy update readback mismatch")

        seen = _deployment_ids(io, resource)
        title = f"BotCord test {resource.name} {sha} {uuid.uuid4()}"
        deployment_response = io.cli(
            [
                "compose",
                "deploy",
                "--composeId",
                resource.compose_id,
                "--title",
                title,
            ]
        )
        deployment_id = (
            deployment_response.get("deploymentId")
            if isinstance(deployment_response, dict)
            and isinstance(deployment_response.get("deploymentId"), str)
            else None
        )
        deployment_id = _wait_deployment(
            io,
            resource,
            seen,
            deployment_timeout,
            deployment_id=deployment_id,
        )
        verify_runtime(io, resource)
        print(
            f"{resource.name}: deployment {deployment_id} and scoped container health verified"
        )

    verify_public_https(io)
    print("BotCord test: public HTTPS health verified")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--sha", required=True)
    parser.add_argument("--backend-image", required=True)
    parser.add_argument("--frontend-image", required=True)
    parser.add_argument("--gateway-image", required=True)
    parser.add_argument("--adopt-provider", action="store_true")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    try:
        deploy(
            args.sha,
            {
                "backend": args.backend_image,
                "frontend": args.frontend_image,
                "gateway": args.gateway_image,
            },
            adopt_provider=args.adopt_provider,
        )
    except DeploymentError as exc:
        print(f"BotCord test deployment failed: {exc}", file=sys.stderr)
        print(
            "Deployment is non-atomic; inspect the failed stage and restore the prior "
            "GitHub ref/image before redeploying. No data or volumes were deleted.",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
