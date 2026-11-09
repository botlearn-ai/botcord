"""Unit tests for the fail-closed Dokploy test deployment orchestration."""

from __future__ import annotations

import importlib.util
import io as text_io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest
import urllib.parse
import urllib.error
from contextlib import redirect_stderr
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
MODULE_PATH = ROOT / "infra/dokploy/deploy.py"
SPEC = importlib.util.spec_from_file_location("botcord_dokploy_deploy", MODULE_PATH)
assert SPEC and SPEC.loader
deploy_module = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = deploy_module
SPEC.loader.exec_module(deploy_module)


SHA = "a" * 40
DIGEST = "registry.example.test/botcord@sha256:" + "b" * 64


def resource(name):
    return next(item for item in deploy_module.RESOURCES if item.name == name)


def github_value(resource, **overrides):
    value = {
        "composeId": resource.compose_id,
        "appName": resource.app_name,
        "environmentId": deploy_module.ENVIRONMENT_ID,
        "environment": {"projectId": deploy_module.PROJECT_ID},
        "composeType": "docker-compose",
        "sourceType": "github",
        "owner": deploy_module.OWNER,
        "repository": deploy_module.REPOSITORY,
        "githubId": deploy_module.GITHUB_ID,
        "composePath": resource.compose_path,
        "autoDeploy": False,
    }
    value.update(overrides)
    return value


def native_value(database, **overrides):
    value = {
        f"{database.kind}Id": database.service_id,
        "appName": database.app_name,
        "environmentId": deploy_module.ENVIRONMENT_ID,
        "environment": {"projectId": deploy_module.PROJECT_ID},
        "externalPort": None,
        "detachDokployNetwork": True,
        "networkIds": [deploy_module.DATABASE_NETWORK_ID],
        "replicas": 1,
        "placementSwarm": {
            "Constraints": [deploy_module.DATABASE_NODE_CONSTRAINT],
        },
        "dockerImage": database.docker_image,
        "mounts": [{
            "type": "volume",
            "volumeName": database.volume_source,
            "mountPath": database.volume_target,
        }],
    }
    value.update(overrides)
    return value


class FakeGitHubIO:
    def __init__(self, values):
        self.values = iter(values)
        self.calls = []

    def gh(self, args):
        self.calls.append(args)
        value = next(self.values)
        if isinstance(value, Exception):
            raise value
        return value


class FakeDeploymentIO:
    def __init__(self, records):
        self.records = iter(records)

    def cli(self, args):
        return next(self.records)

    def sleep(self, _seconds):
        pass


class FakeRuntimeIO:
    def __init__(self, containers):
        self.containers = containers
        self.calls = []

    def cli(self, args):
        self.calls.append(args)
        return self.containers

    def sleep(self, _seconds):
        pass


class FakeResponse:
    def __init__(self, value):
        self.body = json.dumps({"result": {"data": {"json": value}}}).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        return self.body


class FakeJsonResponse(FakeResponse):
    def __init__(self, value):
        self.body = json.dumps(value).encode()


class DokployDeployTests(unittest.TestCase):
    def test_only_application_compose_resources_are_deployed(self):
        self.assertEqual(
            [resource.name for resource in deploy_module.RESOURCES],
            ["backend", "gateway", "frontend"],
        )

    def test_identity_mismatch_is_rejected(self):
        target = resource("backend")
        for field, bad in (
            ("appName", "wrong"),
            ("environmentId", "wrong"),
            ("sourceType", "raw"),
            ("githubId", "wrong"),
            ("composePath", "wrong.yml"),
            ("autoDeploy", True),
        ):
            with self.subTest(field=field):
                value = github_value(target, **{field: bad})
                with self.assertRaises(deploy_module.DeploymentError):
                    deploy_module.validate_identity(target, value, False)

        wrong_project = github_value(target)
        wrong_project["environment"] = {"projectId": "wrong"}
        with self.assertRaises(deploy_module.DeploymentError):
            deploy_module.validate_identity(target, wrong_project, False)

    def test_raw_source_requires_explicit_adoption(self):
        target = resource("backend")
        raw = github_value(target, sourceType="raw")
        with self.assertRaises(deploy_module.DeploymentError):
            deploy_module.validate_identity(target, raw, False)
        deploy_module.validate_identity(target, raw, True)

    def test_native_database_identity_is_fail_closed(self):
        for database in deploy_module.NATIVE_DATABASES:
            deploy_module.validate_native_database_identity(
                database, native_value(database)
            )
            bad_values = (
                {f"{database.kind}Id": "wrong"},
                {"appName": "wrong"},
                {"environmentId": "wrong"},
                {"environment": {"projectId": "wrong"}},
                {"externalPort": 6379},
                {"detachDokployNetwork": False},
                {"networkIds": []},
                {"networkIds": [{"networkId": deploy_module.DATABASE_NETWORK_ID}]},
                {"networkIds": [deploy_module.DATABASE_NETWORK_ID, "extra-network"]},
                {"replicas": 2},
                {"replicas": True},
                {"placementSwarm": {"Constraints": []}},
                {"placementSwarm": {
                    "Constraints": [
                        deploy_module.DATABASE_NODE_CONSTRAINT,
                        "node.role==worker",
                    ],
                }},
                {"dockerImage": "postgres:16-alpine"},
                {"mounts": []},
                {"mounts": [{
                    "type": "volume",
                    "source": database.volume_source,
                    "target": database.volume_target,
                }]},
                {"mounts": [{
                    "type": "bind",
                    "volumeName": database.volume_source,
                    "mountPath": database.volume_target,
                }]},
                {"mounts": [{
                    "type": "volume",
                    "volumeName": "wrong-volume",
                    "mountPath": database.volume_target,
                }]},
                {"mounts": [{
                    "type": "volume",
                    "volumeName": database.volume_source,
                    "mountPath": "/wrong-target",
                }]},
                {"mounts": [
                    {
                        "type": "volume",
                        "volumeName": database.volume_source,
                        "mountPath": database.volume_target,
                    },
                    {
                        "type": "volume",
                        "volumeName": "extra",
                        "mountPath": "/extra",
                    },
                ]},
            )
            for override in bad_values:
                with self.subTest(database=database.name, override=override):
                    with self.assertRaises(deploy_module.DeploymentError):
                        deploy_module.validate_native_database_identity(
                            database, native_value(database, **override)
                        )

    def test_native_database_runtime_requires_one_exact_healthy_task(self):
        database = deploy_module.NATIVE_DATABASES[0]
        healthy = {
            "name": f"{database.app_name}.1.task123",
            "state": "running",
            "status": "Up 1 minute (healthy)",
        }
        fake = FakeRuntimeIO([healthy])
        deploy_module.verify_native_database_runtime(fake, database)
        self.assertEqual(
            fake.calls,
            [[
                "docker", "get-containers-by-app-name-match",
                "--appName", database.app_name,
            ]],
        )
        deploy_module.verify_native_database_runtime(
            FakeRuntimeIO([
                {**healthy, "state": "exited", "status": "Exited (0)"},
                healthy,
                {**healthy, "name": f"{database.app_name}-old.1.task123"},
            ]),
            database,
        )
        for containers in (
            [],
            [healthy, healthy],
            [{**healthy, "name": f"prefix-{database.app_name}.1.task123"}],
            [{**healthy, "state": "exited"}],
            [{**healthy, "status": "Up 1 minute (unhealthy)"}],
        ):
            with self.subTest(containers=containers):
                with self.assertRaises(deploy_module.DeploymentError):
                    deploy_module.verify_native_database_runtime(
                        FakeRuntimeIO(containers), database
                    )

    def test_native_database_reads_use_only_get_endpoints(self):
        io = deploy_module.IO()
        requests = []

        def open_request(request):
            requests.append(request)
            return FakeResponse({"redisId": "example"})

        env = {
            "DOKPLOY_URL": "https://console.botlearn.ai",
            "DOKPLOY_AUTH_TOKEN": "test-token",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            with mock.patch.object(io, "_open", side_effect=open_request):
                io.cli(["redis", "one", "--redisId", "example"])
                io.cli(["postgres", "one", "--postgresId", "example"])
                io.cli([
                    "docker", "get-containers-by-app-name-match",
                    "--appName", "botcord-postgres-native-5pmi4g",
                ])
        self.assertEqual(
            [request.get_method() for request in requests], ["GET", "GET", "GET"]
        )
        self.assertEqual(
            [urllib.parse.urlparse(request.full_url).path for request in requests],
            [
                "/api/trpc/redis.one",
                "/api/trpc/postgres.one",
                "/api/trpc/docker.getContainersByAppNameMatch",
            ],
        )
        query = urllib.parse.parse_qs(urllib.parse.urlparse(requests[-1].full_url).query)
        self.assertEqual(
            json.loads(query["input"][0]),
            {"json": {"appName": "botcord-postgres-native-5pmi4g"}},
        )

    def test_native_preflight_failure_prevents_all_mutations(self):
        class NativeFailureIO:
            def __init__(self):
                self.calls = []

            def cli(self, args):
                self.calls.append(args)
                if args[:2] == ["postgres", "one"]:
                    return native_value(
                        deploy_module.NATIVE_DATABASES[0], externalPort=5432
                    )
                raise AssertionError(f"unexpected call after native failure: {args}")

        fake = NativeFailureIO()
        env = {
            "DOKPLOY_URL": "https://console.botlearn.ai",
            "DOKPLOY_AUTH_TOKEN": "test-token",
            "GH_TOKEN": "test-github-token",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            with mock.patch.object(
                deploy_module, "ensure_ref", side_effect=AssertionError("must not mutate")
            ) as ensure_ref:
                with self.assertRaisesRegex(
                    deploy_module.DeploymentError, "identity mismatch"
                ):
                    deploy_module.deploy(
                        SHA,
                        {"backend": DIGEST, "frontend": DIGEST, "gateway": DIGEST},
                        io=fake,
                    )
        ensure_ref.assert_not_called()
        self.assertEqual(
            fake.calls,
            [[
                "postgres", "one", "--postgresId",
                deploy_module.NATIVE_DATABASES[0].service_id,
            ]],
        )

    def test_merge_env_preserves_secrets_and_replaces_only_image(self):
        current = (
            "DATABASE_URL='postgresql://user:private@example.test/db'\n"
            "BOTCORD_BACKEND_IMAGE=old.example/image@sha256:" + "c" * 64 + "\n"
            "JWT_SECRET='very-private-value'\n"
        )
        merged = deploy_module.merge_env(current, "BOTCORD_BACKEND_IMAGE", DIGEST)
        self.assertIn("DATABASE_URL='postgresql://user:private@example.test/db'", merged)
        self.assertIn("JWT_SECRET='very-private-value'", merged)
        self.assertEqual(merged.count("BOTCORD_BACKEND_IMAGE="), 1)
        self.assertIn(f"BOTCORD_BACKEND_IMAGE={DIGEST}", merged)

    def test_cli_failure_never_includes_command_output(self):
        secret = "private-runtime-secret"
        completed = subprocess.CompletedProcess(
            ["dokploy"], 1, stdout=f'env="{secret}"', stderr=f"failed {secret}"
        )
        with mock.patch.object(subprocess, "run", return_value=completed):
            with self.assertRaises(deploy_module.DeploymentError) as caught:
                deploy_module.IO().cli(
                    ["compose", "deploy", "--composeId", "example"]
                )
        self.assertNotIn(secret, str(caught.exception))

    def test_cli_timeout_never_includes_env_argument(self):
        secret = "private-env-on-process-command"
        timeout = subprocess.TimeoutExpired(
            ["dokploy", "compose", "update", "--env", secret], 60
        )
        with mock.patch.object(subprocess, "run", side_effect=timeout):
            with self.assertRaises(deploy_module.DeploymentError) as caught:
                deploy_module.IO().cli(
                    ["compose", "deploy", "--description", secret]
                )
        self.assertNotIn(secret, str(caught.exception))

    def test_trpc_get_uses_required_json_envelope(self):
        io = deploy_module.IO()
        requests = []

        def open_request(request):
            requests.append(request)
            return FakeResponse({"composeId": "example"})

        env = {
            "DOKPLOY_URL": "https://console.botlearn.ai",
            "DOKPLOY_AUTH_TOKEN": "test-token",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            with mock.patch.object(io, "_open", side_effect=open_request):
                result = io.cli(["compose", "one", "--composeId", "example"])
        self.assertEqual(result, {"composeId": "example"})
        request = requests[0]
        query = urllib.parse.parse_qs(urllib.parse.urlparse(request.full_url).query)
        self.assertEqual(
            json.loads(query["input"][0]), {"json": {"composeId": "example"}}
        )
        self.assertEqual(request.get_method(), "GET")
        self.assertNotIn("test-token", request.full_url)

    def test_trpc_update_sends_typed_false_without_env_in_url(self):
        io = deploy_module.IO()
        requests = []

        def open_request(request):
            requests.append(request)
            return FakeResponse({"ok": True})

        secret_env = "JWT_SECRET=private-runtime-value"
        args = [
            "compose", "update",
            "--composeId", "example",
            "--sourceType", "github",
            "--composeType", "docker-compose",
            "--owner", "botlearn-ai",
            "--repository", "botcord",
            "--githubId", "provider",
            "--branch", "dokploy-test-" + SHA,
            "--composePath", "infra/dokploy/example.yml",
            "--env", secret_env,
            "--createEnvFile", "--no-autoDeploy",
        ]
        env = {
            "DOKPLOY_URL": "https://console.botlearn.ai",
            "DOKPLOY_AUTH_TOKEN": "test-token",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            with mock.patch.object(io, "_open", side_effect=open_request):
                io.cli(args)
        request = requests[0]
        body = json.loads(request.data)
        self.assertEqual(request.get_method(), "POST")
        self.assertFalse(body["json"]["autoDeploy"])
        self.assertTrue(body["json"]["createEnvFile"])
        self.assertEqual(body["json"]["env"], secret_env)
        self.assertNotIn(secret_env, request.full_url)

    def test_github_get_ref_uses_rest_without_token_in_url(self):
        io = deploy_module.IO()
        requests = []

        def open_request(request):
            requests.append(request)
            return FakeJsonResponse({"object": {"type": "commit", "sha": SHA}})

        endpoint = f"repos/botlearn-ai/botcord/git/ref/tags/dokploy-test-{SHA}"
        with mock.patch.dict(os.environ, {"GH_TOKEN": "private-github-token"}):
            with mock.patch.object(io, "_open", side_effect=open_request):
                result = io.gh(["api", endpoint])
        self.assertEqual(result["object"]["sha"], SHA)
        request = requests[0]
        self.assertEqual(request.get_method(), "GET")
        self.assertEqual(
            request.full_url,
            f"https://api.github.com/{endpoint}",
        )
        self.assertNotIn("private-github-token", request.full_url)
        self.assertEqual(request.get_header("Authorization"), "Bearer private-github-token")

    def test_github_create_ref_uses_typed_rest_body(self):
        io = deploy_module.IO()
        requests = []

        def open_request(request):
            requests.append(request)
            return FakeJsonResponse({"object": {"type": "commit", "sha": SHA}})

        args = [
            "api", "repos/botlearn-ai/botcord/git/refs",
            "--method", "POST",
            "-f", f"ref=refs/tags/dokploy-test-{SHA}",
            "-f", f"sha={SHA}",
        ]
        with mock.patch.dict(os.environ, {"GH_TOKEN": "private-github-token"}):
            with mock.patch.object(io, "_open", side_effect=open_request):
                io.gh(args)
        request = requests[0]
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(
            json.loads(request.data),
            {"ref": f"refs/tags/dokploy-test-{SHA}", "sha": SHA},
        )
        self.assertNotIn("private-github-token", request.full_url)

    def test_github_http_status_maps_without_leaking_token(self):
        io = deploy_module.IO()
        endpoint = f"repos/botlearn-ai/botcord/git/ref/tags/dokploy-test-{SHA}"
        for code, expected in (
            (404, deploy_module.GitHubRefNotFound),
            (422, deploy_module.GitHubRefAlreadyExists),
        ):
            with self.subTest(code=code):
                error = urllib.error.HTTPError(
                    f"https://api.github.com/{endpoint}", code, "error", {}, None
                )
                with mock.patch.dict(os.environ, {"GH_TOKEN": "private-github-token"}):
                    with mock.patch.object(io, "_open", side_effect=error):
                        with self.assertRaises(expected) as caught:
                            io.gh(["api", endpoint])
                self.assertNotIn("private-github-token", str(caught.exception))

    def test_existing_immutable_tag_is_verified(self):
        value = {"object": {"type": "commit", "sha": SHA}}
        fake = FakeGitHubIO([value])
        ref = deploy_module.ensure_ref(fake, SHA)
        self.assertEqual(ref, f"dokploy-test-{SHA}")
        self.assertEqual(len(fake.calls), 1)

    def test_missing_tag_is_created_and_verified(self):
        created = {"object": {"type": "commit", "sha": SHA}}
        fake = FakeGitHubIO([deploy_module.GitHubRefNotFound("missing"), created])
        self.assertEqual(deploy_module.ensure_ref(fake, SHA), f"dokploy-test-{SHA}")
        self.assertIn("--method", fake.calls[1])
        self.assertIn(f"sha={SHA}", fake.calls[1])

    def test_existing_tag_pointing_elsewhere_is_never_rewritten(self):
        value = {"object": {"type": "commit", "sha": "d" * 40}}
        fake = FakeGitHubIO([value])
        with self.assertRaisesRegex(
            deploy_module.DeploymentError, "unexpected commit"
        ):
            deploy_module.ensure_ref(fake, SHA)
        self.assertEqual(len(fake.calls), 1)

    def test_ambiguous_new_deployments_are_rejected(self):
        target = resource("backend")
        records = [[
            {"deploymentId": "new-1", "status": "running"},
            {"deploymentId": "new-2", "status": "running"},
        ]]
        with self.assertRaisesRegex(deploy_module.DeploymentError, "ambiguous"):
            deploy_module._wait_deployment(
                FakeDeploymentIO(records), target, {"old"}, 10
            )

    def test_errored_deployment_stops_the_gate(self):
        target = resource("gateway")
        records = [[{"deploymentId": "new", "status": "error"}]]
        with self.assertRaisesRegex(deploy_module.DeploymentError, "failed"):
            deploy_module._wait_deployment(
                FakeDeploymentIO(records), target, {"old"}, 10
            )

    def test_returned_deployment_id_wins_over_parallel_new_record(self):
        target = resource("gateway")
        records = [[
            {"deploymentId": "parallel", "status": "done"},
            {"deploymentId": "ours", "status": "done"},
        ]]
        result = deploy_module._wait_deployment(
            FakeDeploymentIO(records),
            target,
            {"old"},
            10,
            deployment_id="ours",
        )
        self.assertEqual(result, "ours")

    def test_runtime_health_uses_only_scoped_service_read(self):
        target = resource("frontend")
        fake = FakeRuntimeIO([
            {
                "containerId": "not-inspected-with-global-docker-permission",
                "name": f"{target.app_name}-botcord-frontend-1",
                "state": "running",
                "status": "Up 1 minute (healthy)",
            }
        ])
        deploy_module.verify_runtime(fake, target, timeout_seconds=1)
        self.assertEqual(len(fake.calls), 1)
        self.assertEqual(fake.calls[0][:2], ["docker", "get-containers-by-app-name-match"])
        self.assertNotIn("get-config", fake.calls[0])

    def test_main_reports_sanitized_non_atomic_boundary(self):
        secret = "never-print-this-secret"
        stderr = text_io.StringIO()
        error = deploy_module.DeploymentError("safe failure")
        argv = [
            "--sha", SHA,
            "--backend-image", DIGEST,
            "--frontend-image", DIGEST,
            "--gateway-image", DIGEST,
        ]
        with mock.patch.object(deploy_module, "deploy", side_effect=error):
            with redirect_stderr(stderr):
                status = deploy_module.main(argv)
        output = stderr.getvalue()
        self.assertEqual(status, 1)
        self.assertNotIn(secret, output)
        self.assertIn("non-atomic", output)
        self.assertIn("No data or volumes were deleted", output)

    def test_wrong_target_url_fails_before_any_dokploy_call(self):
        class NoCalls:
            def cli(self, _args):
                self.fail("should not be called")

        with mock.patch.dict(os.environ, {"DOKPLOY_URL": "https://wrong.example"}):
            with self.assertRaisesRegex(deploy_module.DeploymentError, "URL mismatch"):
                deploy_module.deploy(
                    SHA,
                    {"backend": DIGEST, "frontend": DIGEST, "gateway": DIGEST},
                    io=NoCalls(),
                )

    def test_all_image_digests_fail_before_provider_read(self):
        class NoCalls:
            called = False

            def cli(self, _args):
                self.called = True
                raise AssertionError("Provider must not be read")

        fake = NoCalls()
        env = {
            "DOKPLOY_URL": "https://console.botlearn.ai",
            "DOKPLOY_AUTH_TOKEN": "test-token",
            "GH_TOKEN": "test-github-token",
        }
        with mock.patch.dict(os.environ, env, clear=False):
            with self.assertRaisesRegex(
                deploy_module.DeploymentError, "immutable image digest"
            ):
                deploy_module.deploy(
                    SHA,
                    {
                        "backend": DIGEST,
                        "frontend": "not-a-digest",
                        "gateway": DIGEST,
                    },
                    io=fake,
                )
        self.assertFalse(fake.called)


if __name__ == "__main__":
    unittest.main()
