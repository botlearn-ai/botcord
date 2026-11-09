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
        {"kind": "ConfigMap", "metadata": metadata("botcord-frontend-config")},
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
        with mock.patch.object(deploy_frontend, "run", return_value=json.dumps(response)):
            deploy_frontend.verify_candidate(sha, self.digest)
        response["imageDetails"][0]["imageTags"] = ["prod-" + "c" * 40 + "-123-1"]
        with mock.patch.object(deploy_frontend, "run", return_value=json.dumps(response)):
            with self.assertRaises(deploy_frontend.DeploymentError):
                deploy_frontend.verify_candidate(sha, self.digest)

    def test_deploy_validates_gates_before_apply(self):
        sha = "d" * 40
        calls = []
        with (
            mock.patch.object(deploy_frontend, "verify_devops_checkout", side_effect=lambda: calls.append("checkout")),
            mock.patch.object(deploy_frontend, "verify_identity", side_effect=lambda: calls.append("identity")),
            mock.patch.object(deploy_frontend, "render_and_validate_manifest", return_value=(self.image, self.digest)),
            mock.patch.object(deploy_frontend, "verify_candidate", side_effect=lambda *_: calls.append("candidate")),
            mock.patch.object(deploy_frontend, "MANIFEST", mock.Mock(read_bytes=mock.Mock(return_value=b"reviewed"))),
            mock.patch.object(deploy_frontend, "run", side_effect=lambda *args, **kwargs: calls.append(args[3]) or ""),
            mock.patch.object(deploy_frontend, "verify_rollout", return_value="new-alb.example.com"),
            mock.patch.object(deploy_frontend, "verify_https", side_effect=lambda *_: calls.append("https")),
        ):
            deploy_frontend.deploy(sha)
        self.assertEqual(calls, ["checkout", "identity", "candidate", "apply", "https"])

    def test_invalid_source_sha_stops_before_external_call(self):
        with mock.patch.object(deploy_frontend, "verify_devops_checkout") as checkout:
            with self.assertRaises(deploy_frontend.DeploymentError):
                deploy_frontend.deploy("main")
        checkout.assert_not_called()


if __name__ == "__main__":
    unittest.main()
