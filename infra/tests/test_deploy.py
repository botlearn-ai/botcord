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


class DokployDeployTests(unittest.TestCase):
    def test_identity_mismatch_is_rejected(self):
        resource = deploy_module.RESOURCES[0]
        for field, bad in (
            ("appName", "wrong"),
            ("environmentId", "wrong"),
            ("sourceType", "raw"),
            ("githubId", "wrong"),
            ("composePath", "wrong.yml"),
            ("autoDeploy", True),
        ):
            with self.subTest(field=field):
                value = github_value(resource, **{field: bad})
                with self.assertRaises(deploy_module.DeploymentError):
                    deploy_module.validate_identity(resource, value, False)

        wrong_project = github_value(resource)
        wrong_project["environment"] = {"projectId": "wrong"}
        with self.assertRaises(deploy_module.DeploymentError):
            deploy_module.validate_identity(resource, wrong_project, False)

    def test_raw_source_requires_explicit_adoption(self):
        resource = deploy_module.RESOURCES[0]
        raw = github_value(resource, sourceType="raw")
        with self.assertRaises(deploy_module.DeploymentError):
            deploy_module.validate_identity(resource, raw, False)
        deploy_module.validate_identity(resource, raw, True)

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
        resource = deploy_module.RESOURCES[0]
        records = [[
            {"deploymentId": "new-1", "status": "running"},
            {"deploymentId": "new-2", "status": "running"},
        ]]
        with self.assertRaisesRegex(deploy_module.DeploymentError, "ambiguous"):
            deploy_module._wait_deployment(
                FakeDeploymentIO(records), resource, {"old"}, 10
            )

    def test_errored_deployment_stops_the_gate(self):
        resource = deploy_module.RESOURCES[1]
        records = [[{"deploymentId": "new", "status": "error"}]]
        with self.assertRaisesRegex(deploy_module.DeploymentError, "failed"):
            deploy_module._wait_deployment(
                FakeDeploymentIO(records), resource, {"old"}, 10
            )

    def test_returned_deployment_id_wins_over_parallel_new_record(self):
        resource = deploy_module.RESOURCES[1]
        records = [[
            {"deploymentId": "parallel", "status": "done"},
            {"deploymentId": "ours", "status": "done"},
        ]]
        result = deploy_module._wait_deployment(
            FakeDeploymentIO(records),
            resource,
            {"old"},
            10,
            deployment_id="ours",
        )
        self.assertEqual(result, "ours")

    def test_runtime_health_uses_only_scoped_service_read(self):
        resource = deploy_module.RESOURCES[3]
        fake = FakeRuntimeIO([
            {
                "containerId": "not-inspected-with-global-docker-permission",
                "name": f"{resource.app_name}-botcord-frontend-1",
                "state": "running",
                "status": "Up 1 minute (healthy)",
            }
        ])
        deploy_module.verify_runtime(fake, resource, timeout_seconds=1)
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
