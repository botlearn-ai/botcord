import importlib.util
import json
import pathlib
import unittest
from unittest import mock


ROOT = pathlib.Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "infra/eks/deploy_frontend.py"
SPEC = importlib.util.spec_from_file_location("deploy_frontend", SCRIPT)
deploy_frontend = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(deploy_frontend)


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
        with (
            mock.patch.object(deploy_frontend, "verify_devops_checkout", side_effect=lambda: calls.append("checkout")),
            mock.patch.object(deploy_frontend, "verify_identity", side_effect=lambda: calls.append("identity")),
            mock.patch.object(deploy_frontend, "verify_runtime_secret", side_effect=lambda: calls.append("secret")),
            mock.patch.object(deploy_frontend, "render_and_validate_manifest", return_value=(self.image, self.digest)),
            mock.patch.object(deploy_frontend, "verify_candidate", side_effect=lambda *_: calls.append("candidate")),
            mock.patch.object(deploy_frontend, "MANIFEST", mock.Mock(read_bytes=mock.Mock(return_value=b"reviewed"))),
            mock.patch.object(deploy_frontend, "run", side_effect=lambda *args, **kwargs: calls.append(args[3]) or ""),
            mock.patch.object(deploy_frontend, "verify_rollout", return_value="new-alb.example.com"),
            mock.patch.object(deploy_frontend, "verify_https", side_effect=lambda *_: calls.append("https")),
        ):
            deploy_frontend.deploy(sha)
        self.assertEqual(calls, ["checkout", "identity", "secret", "candidate", "apply", "https"])

    def test_invalid_source_sha_stops_before_external_call(self):
        with mock.patch.object(deploy_frontend, "verify_devops_checkout") as checkout:
            with self.assertRaises(deploy_frontend.DeploymentError):
                deploy_frontend.deploy("main")
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


if __name__ == "__main__":
    unittest.main()
