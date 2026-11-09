import contextlib
import io
import importlib.util
import json
import pathlib
import subprocess
import sys
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra/eks/deploy_frontend.py"
sys.path.insert(0, str(SCRIPT.parent))
SPEC = importlib.util.spec_from_file_location("deploy_frontend", SCRIPT)
deploy_frontend = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
sys.modules[SPEC.name] = deploy_frontend
SPEC.loader.exec_module(deploy_frontend)
DEVOPS_SHA = "f" * 40


def manifest_objects(image: str):
    def metadata(name):
        return {"name": name, "namespace": "prod"}
    return [
        {"kind": "ConfigMap", "metadata": metadata("botcord-frontend-config"), "data": {
            "NEXT_PUBLIC_APP_URL": "https://www.botcord.chat",
            "NEXT_PUBLIC_HUB_BASE_URL": "https://api.botcord.chat",
            "NEXT_PUBLIC_SUPABASE_URL": "https://prod.supabase.co",
            "NEXT_PUBLIC_SUPABASE_ANON_KEY": "public-key-not-placeholder",
            "NEXT_PUBLIC_BETA_GATE_ENABLED": "false",
            "SHOW_MESSAGE_STATUS": "false",
        }},
        {"kind": "Deployment", "metadata": metadata("botcord-frontend"),
         "spec": {"template": {"spec": {"containers": [
             {"name": "botcord-frontend", "image": image}
         ]}}}},
        {"kind": "Service", "metadata": metadata("botcord-frontend")},
        {"kind": "Ingress", "metadata": metadata("botcord-frontend-ingress")},
    ]


class TestFrontendEksController(unittest.TestCase):
    def setUp(self):
        self.digest = "sha256:" + "a" * 64
        self.image = f"{deploy_frontend.IMAGE_PREFIX}@{self.digest}"

    def test_manifest_accepts_only_exact_resources_and_digest(self):
        self.assertEqual(deploy_frontend.validate_objects(manifest_objects(self.image)),
                         (self.image, self.digest))
        extra = manifest_objects(self.image) + [
            {"kind": "Secret", "metadata": {"name": "x", "namespace": "prod"}}
        ]
        with self.assertRaises(deploy_frontend.DeploymentError):
            deploy_frontend.validate_objects(extra)
        with self.assertRaises(deploy_frontend.DeploymentError):
            deploy_frontend.validate_objects(
                manifest_objects(deploy_frontend.IMAGE_PREFIX + ":prod"))

    def test_candidate_must_have_requested_source_tag(self):
        sha = "b" * 40
        response = {"imageDetails": [{"imageTags": [f"prod-{sha}-123-1"]}]}
        inspection = {"Os": "linux", "Architecture": "arm64", "Config": {
            "Labels": {"org.opencontainers.image.revision": sha}
        }}
        with mock.patch.object(
            deploy_frontend, "run",
            side_effect=[json.dumps(response), "pulled", json.dumps(inspection)],
        ):
            deploy_frontend.verify_candidate(sha, self.digest)
        response["imageDetails"][0]["imageTags"] = ["prod-" + "c" * 40 + "-123-1"]
        with mock.patch.object(deploy_frontend, "run", return_value=json.dumps(response)):
            with self.assertRaises(deploy_frontend.DeploymentError):
                deploy_frontend.verify_candidate(sha, self.digest)

    def test_candidate_rejects_wrong_platform_or_revision(self):
        sha = "b" * 40
        response = {"imageDetails": [{"imageTags": [f"prod-{sha}-123-1"]}]}
        inspection = {"Os": "linux", "Architecture": "amd64", "Config": {
            "Labels": {"org.opencontainers.image.revision": sha}
        }}
        with mock.patch.object(
            deploy_frontend, "run",
            side_effect=[json.dumps(response), "pulled", json.dumps(inspection)],
        ):
            with self.assertRaises(deploy_frontend.DeploymentError):
                deploy_frontend.verify_candidate(sha, self.digest)

    def test_manifest_rejects_placeholder_runtime_configuration(self):
        objects = manifest_objects(self.image)
        config = next(obj for obj in objects if obj["kind"] == "ConfigMap")
        config["data"]["NEXT_PUBLIC_SUPABASE_ANON_KEY"] = "__FILL_ME__"
        with self.assertRaises(deploy_frontend.DeploymentError):
            deploy_frontend.validate_objects(objects)

    def test_runtime_secret_preflight_never_reads_or_logs_value(self):
        with mock.patch.object(deploy_frontend, "run", return_value="present") as run:
            deploy_frontend.verify_runtime_secret()
        args = run.call_args.args
        self.assertIn('go-template={{if index .data "SUPABASE_DB_URL"}}present{{end}}', args)
        self.assertNotIn("json", args)

    def test_deploy_validates_gates_before_apply(self):
        sha = "d" * 40
        calls = []

        def record_run(*args, **kwargs):
            calls.append(args[3])
            if args[3] == "apply":
                snapshot = pathlib.Path(args[-1])
                self.assertNotEqual(snapshot, deploy_frontend.MANIFEST)
                self.assertEqual(snapshot.read_bytes(), b"reviewed")
                self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
            return ""

        with (
            mock.patch.object(
                deploy_frontend,
                "verify_devops_checkout",
                side_effect=lambda: calls.append("checkout") or DEVOPS_SHA,
            ),
            mock.patch.object(deploy_frontend, "verify_identity", side_effect=lambda: calls.append("identity")),
            mock.patch.object(deploy_frontend, "verify_runtime_secret", side_effect=lambda: calls.append("secret")),
            mock.patch.object(
                deploy_frontend,
                "capture_reviewed_inputs",
                return_value=(b"reviewed", b"reviewed checker\n"),
            ),
            mock.patch.object(deploy_frontend, "render_and_validate_manifest", return_value=(self.image, self.digest)),
            mock.patch.object(deploy_frontend, "verify_candidate", side_effect=lambda *_: calls.append("candidate")),
            mock.patch.object(
                deploy_frontend,
                "verify_frozen_devops_head",
                side_effect=lambda *_: calls.append("frozen"),
            ),
            mock.patch.object(deploy_frontend, "MANIFEST", mock.Mock(read_bytes=mock.Mock(return_value=b"reviewed"))),
            mock.patch.object(deploy_frontend, "run", side_effect=record_run),
            mock.patch.object(deploy_frontend, "verify_rollout", return_value="new-alb.example.com"),
            mock.patch.object(deploy_frontend, "verify_https", side_effect=lambda *_: calls.append("https")),
            mock.patch.object(
                deploy_frontend,
                "verify_public",
                side_effect=lambda *_: calls.append("public"),
            ),
        ):
            deploy_frontend.deploy(sha)
        self.assertEqual(
            calls,
            [
                "checkout", "identity", "secret", "candidate", "frozen", "frozen",
                "apply", "https", "public",
            ],
        )

    def test_preflight_is_read_only_and_returns_exact_reviewed_image(self):
        sha = "d" * 40
        with (
            mock.patch.object(deploy_frontend, "verify_devops_checkout", return_value=DEVOPS_SHA),
            mock.patch.object(deploy_frontend, "verify_identity"),
            mock.patch.object(deploy_frontend, "verify_runtime_secret"),
            mock.patch.object(
                deploy_frontend,
                "capture_reviewed_inputs",
                return_value=(b"reviewed", b"reviewed checker\n"),
            ),
            mock.patch.object(
                deploy_frontend,
                "render_and_validate_manifest",
                return_value=(self.image, self.digest),
            ),
            mock.patch.object(deploy_frontend, "verify_candidate"),
            mock.patch.object(deploy_frontend, "verify_frozen_devops_head"),
            mock.patch.object(
                deploy_frontend,
                "MANIFEST",
                mock.Mock(read_bytes=mock.Mock(return_value=b"reviewed")),
            ),
            mock.patch.object(deploy_frontend, "run") as run,
        ):
            result = deploy_frontend.preflight(sha, self.image)
        self.assertEqual(result.image, self.image)
        self.assertEqual(result.digest, self.digest)
        self.assertEqual(result.manifest, b"reviewed")
        self.assertEqual(result.public_verifier, b"reviewed checker\n")
        self.assertEqual(result.devops_sha, DEVOPS_SHA)
        run.assert_not_called()

    def test_private_snapshot_is_exact_and_removed(self):
        contents = b"apiVersion: v1\nkind: ConfigMap\n"
        with deploy_frontend.private_snapshot(contents, suffix=".yaml") as snapshot:
            self.assertTrue(snapshot.is_file())
            self.assertEqual(snapshot.read_bytes(), contents)
            self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
            captured = snapshot
        self.assertFalse(captured.exists())

    def test_preflight_rejects_a_different_reviewed_candidate(self):
        sha = "d" * 40
        expected = f"{deploy_frontend.IMAGE_PREFIX}@sha256:" + "e" * 64
        with (
            mock.patch.object(deploy_frontend, "verify_devops_checkout", return_value=DEVOPS_SHA),
            mock.patch.object(deploy_frontend, "verify_identity"),
            mock.patch.object(deploy_frontend, "verify_runtime_secret"),
            mock.patch.object(
                deploy_frontend,
                "capture_reviewed_inputs",
                return_value=(b"reviewed", b"reviewed checker\n"),
            ),
            mock.patch.object(
                deploy_frontend,
                "render_and_validate_manifest",
                return_value=(self.image, self.digest),
            ),
            mock.patch.object(deploy_frontend, "verify_candidate") as candidate,
            mock.patch.object(deploy_frontend, "verify_frozen_devops_head"),
            mock.patch.object(
                deploy_frontend,
                "MANIFEST",
                mock.Mock(read_bytes=mock.Mock(return_value=b"reviewed")),
            ),
            self.assertRaisesRegex(deploy_frontend.DeploymentError, "expected release candidate"),
        ):
            deploy_frontend.preflight(sha, expected)
        candidate.assert_not_called()

    def test_capture_refuses_worktree_bytes_that_differ_from_reviewed_git_objects(self):
        with (
            mock.patch.object(
                deploy_frontend,
                "read_reviewed_file",
                side_effect=[b"reviewed manifest", b"reviewed checker"],
            ),
            mock.patch.object(
                deploy_frontend,
                "MANIFEST",
                mock.Mock(read_bytes=mock.Mock(return_value=b"raced worktree manifest")),
            ),
            mock.patch.object(
                deploy_frontend,
                "PUBLIC_VERIFIER",
                mock.Mock(read_bytes=mock.Mock(return_value=b"reviewed checker")),
            ),
            self.assertRaisesRegex(deploy_frontend.DeploymentError, "differs from its Git object"),
        ):
            deploy_frontend.capture_reviewed_inputs(DEVOPS_SHA)

    def test_capture_refuses_checker_bytes_that_differ_from_reviewed_git_object(self):
        with (
            mock.patch.object(
                deploy_frontend,
                "read_reviewed_file",
                side_effect=[b"reviewed manifest", b"reviewed checker"],
            ),
            mock.patch.object(
                deploy_frontend,
                "MANIFEST",
                mock.Mock(read_bytes=mock.Mock(return_value=b"reviewed manifest")),
            ),
            mock.patch.object(
                deploy_frontend,
                "PUBLIC_VERIFIER",
                mock.Mock(read_bytes=mock.Mock(return_value=b"raced checker")),
            ),
            self.assertRaisesRegex(deploy_frontend.DeploymentError, "differs from its Git object"),
        ):
            deploy_frontend.capture_reviewed_inputs(DEVOPS_SHA)

    def test_frozen_devops_head_must_match_before_apply(self):
        with (
            mock.patch.object(
                deploy_frontend,
                "run",
                return_value="e" * 40,
            ),
            self.assertRaisesRegex(deploy_frontend.DeploymentError, "changed after reviewed preflight"),
        ):
            deploy_frontend.verify_frozen_devops_head(DEVOPS_SHA)

    def test_preflight_only_cli_prints_machine_readable_exact_image(self):
        sha = "d" * 40
        output = io.StringIO()
        candidate = deploy_frontend.ReviewedCandidate(
            image=self.image,
            digest=self.digest,
            manifest=b"reviewed",
            public_verifier=b"reviewed checker\n",
            devops_sha=DEVOPS_SHA,
        )
        with (
            mock.patch.object(
                sys,
                "argv",
                [
                    str(SCRIPT),
                    "--source-sha", sha,
                    "--expected-image", self.image,
                    "--preflight-only",
                ],
            ),
            mock.patch.object(deploy_frontend, "preflight", return_value=candidate) as preflight,
            mock.patch.object(deploy_frontend, "deploy") as deploy,
            contextlib.redirect_stdout(output),
        ):
            deploy_frontend.main()
        preflight.assert_called_once_with(sha, self.image)
        deploy.assert_not_called()
        self.assertEqual(
            output.getvalue().splitlines(),
            [f"image={self.image}", f"digest={self.digest}"],
        )

    def test_deploy_cli_passes_the_expected_image_gate(self):
        sha = "d" * 40
        with (
            mock.patch.object(
                sys,
                "argv",
                [str(SCRIPT), "--source-sha", sha, "--expected-image", self.image],
            ),
            mock.patch.object(deploy_frontend, "preflight") as preflight,
            mock.patch.object(deploy_frontend, "deploy") as deploy,
        ):
            deploy_frontend.main()
        preflight.assert_not_called()
        deploy.assert_called_once_with(sha, self.image)

    def test_invalid_source_sha_stops_before_external_call(self):
        with mock.patch.object(deploy_frontend, "verify_devops_checkout") as checkout:
            with self.assertRaises(deploy_frontend.DeploymentError):
                deploy_frontend.deploy("main")
        checkout.assert_not_called()

    def test_malformed_expected_image_stops_before_external_call(self):
        with mock.patch.object(deploy_frontend, "verify_devops_checkout") as checkout:
            with self.assertRaisesRegex(deploy_frontend.DeploymentError, "full production ECR"):
                deploy_frontend.preflight("d" * 40, "example.invalid/frontend:latest")
        checkout.assert_not_called()

    def test_https_verification_bypasses_proxy_and_preserves_sni(self):
        response = json.dumps({"status": "ok", "service": "botcord-web"})
        with mock.patch.object(deploy_frontend, "run", return_value=response) as run:
            deploy_frontend.verify_https("new-alb.example.com")
        args = run.call_args.args
        self.assertIn("--noproxy", args)
        self.assertEqual(args[args.index("--noproxy") + 1], "*")
        self.assertIn(
            "www.botcord.chat:443:new-alb.example.com:443",
            args,
        )

    def test_https_verification_can_succeed_after_twelve_transient_failures(self):
        response = json.dumps({"status": "ok", "service": "botcord-web"})
        transient = subprocess.CalledProcessError(22, ["curl"])
        with (
            mock.patch.object(
                deploy_frontend, "run",
                side_effect=[transient] * 15 + [response],
            ) as run,
            mock.patch.object(deploy_frontend.time, "sleep") as sleep,
        ):
            deploy_frontend.verify_https("new-alb.example.com")
        self.assertEqual(run.call_count, 16)
        self.assertEqual(sleep.call_count, 15)
        sleep.assert_called_with(deploy_frontend.HTTPS_HEALTH_RETRY_SECONDS)

    def test_https_verification_fails_after_bounded_five_minute_budget(self):
        transient = subprocess.CalledProcessError(22, ["curl"])
        with (
            mock.patch.object(deploy_frontend, "run", side_effect=transient) as run,
            mock.patch.object(deploy_frontend.time, "sleep") as sleep,
            self.assertRaisesRegex(deploy_frontend.DeploymentError, "after 5 minutes"),
        ):
            deploy_frontend.verify_https("new-alb.example.com")
        self.assertEqual(run.call_count, deploy_frontend.HTTPS_HEALTH_ATTEMPTS)
        self.assertEqual(sleep.call_count, deploy_frontend.HTTPS_HEALTH_ATTEMPTS - 1)
        self.assertGreaterEqual(
            sleep.call_count * deploy_frontend.HTTPS_HEALTH_RETRY_SECONDS,
            300,
        )

    def test_public_verification_uses_reviewed_devops_checker(self):
        snapshots = []

        def record_run(*args, **kwargs):
            snapshot = pathlib.Path(args[1])
            self.assertNotEqual(snapshot, deploy_frontend.PUBLIC_VERIFIER)
            self.assertEqual(snapshot.read_bytes(), b"reviewed checker\n")
            self.assertEqual(snapshot.stat().st_mode & 0o777, 0o600)
            snapshots.append(snapshot)
            return ""

        with (
            mock.patch.object(
                deploy_frontend,
                "verify_frozen_devops_head",
            ) as frozen,
            mock.patch.object(
                deploy_frontend,
                "PUBLIC_VERIFIER",
                mock.Mock(
                    read_bytes=mock.Mock(return_value=b"reviewed checker\n"),
                ),
            ),
            mock.patch.object(deploy_frontend, "run", side_effect=record_run) as run,
        ):
            deploy_frontend.verify_public(DEVOPS_SHA, b"reviewed checker\n")
        frozen.assert_called_once_with(DEVOPS_SHA)
        run.assert_called_once()
        self.assertEqual(len(snapshots), 1)
        self.assertFalse(snapshots[0].exists())

    def test_public_verification_refuses_checker_drift_before_execution(self):
        with (
            mock.patch.object(
                deploy_frontend,
                "verify_frozen_devops_head",
            ),
            mock.patch.object(
                deploy_frontend,
                "PUBLIC_VERIFIER",
                mock.Mock(
                    read_bytes=mock.Mock(return_value=b"changed checker\n"),
                ),
            ),
            mock.patch.object(deploy_frontend, "run") as run,
            self.assertRaisesRegex(deploy_frontend.DeploymentError, "changed during validation"),
        ):
            deploy_frontend.verify_public(DEVOPS_SHA, b"reviewed checker\n")
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
