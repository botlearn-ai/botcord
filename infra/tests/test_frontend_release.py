import importlib.util
import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest import mock

ROOT = Path(__file__).resolve().parents[2]


def module(name):
    spec = importlib.util.spec_from_file_location(name, ROOT / f"infra/eks/{name}.py")
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


candidate = module("release_candidate")
prepare = module("prepare_release")
SHA = "a" * 40
OTHER_SHA = "b" * 40
DIGEST = "sha256:" + "c" * 64
IMAGE = candidate.PREFIX + "@" + DIGEST
TAG = f"release-{SHA}-123"


class CandidateTests(unittest.TestCase):
    def test_tag_requires_fixed_source_and_numeric_run(self):
        self.assertEqual(candidate.tag_for(SHA, "123"), TAG)
        for sha, run in (("main", "123"), (SHA, "1;touch /tmp/x")):
            with self.assertRaises(ValueError):
                candidate.tag_for(sha, run)

    @mock.patch.object(candidate, "ecr")
    def test_only_not_found_allows_new_build(self, ecr):
        ecr.return_value = {"images": [], "failures": [{"failureCode": "ImageNotFound"}]}
        self.assertEqual(candidate.lookup(TAG), "")
        for result in ({}, {"failures": [{"failureCode": "AccessDenied"}]},
                       {"images": [{"imageId": {"imageDigest": "latest"}}]}):
            ecr.return_value = result
            with self.assertRaises(ValueError):
                candidate.lookup(TAG)

    @mock.patch.object(candidate, "run")
    def test_reuse_checks_source_platform_and_run_provenance(self, run):
        labels = {"org.opencontainers.image.revision": SHA,
                  "org.opencontainers.image.source": "https://github.com/botlearn-ai/botcord",
                  "com.botcord.release.run-id": "123"}
        detail = {"Os": "linux", "Architecture": "arm64", "Config": {"Labels": labels}}
        run.return_value = json.dumps(detail)
        self.assertEqual(candidate.validate(SHA, DIGEST, "123"), IMAGE)
        for key in labels:
            modified = json.loads(json.dumps(detail))
            modified["Config"]["Labels"][key] = "wrong"
            run.return_value = json.dumps(modified)
            with self.assertRaises(ValueError):
                candidate.validate(SHA, DIGEST, "123")
        detail["Architecture"] = "amd64"
        run.return_value = json.dumps(detail)
        with self.assertRaises(ValueError):
            candidate.validate(SHA, DIGEST, "123")

    @mock.patch.object(candidate, "ecr")
    @mock.patch.object(candidate, "lookup", return_value="sha256:" + "d" * 64)
    @mock.patch.object(candidate, "validate", return_value=IMAGE)
    def test_never_overwrites_existing_marker(self, validate, lookup, ecr):
        with self.assertRaises(ValueError):
            candidate.publish(SHA, TAG, DIGEST)
        ecr.assert_not_called()
        lookup.return_value = DIGEST
        self.assertEqual(candidate.publish(SHA, TAG, DIGEST), IMAGE)
        ecr.assert_not_called()

    @mock.patch.object(candidate, "validate")
    @mock.patch.object(candidate, "synchronized", return_value=True)
    @mock.patch.object(candidate, "lookup", return_value=DIGEST)
    def test_wait_requires_exact_marker_and_manifest(self, lookup, synced, validate):
        candidate.wait_review(SHA, TAG, IMAGE, timeout=0)
        synced.assert_called_once_with(IMAGE)
        validate.assert_called_once_with(SHA, DIGEST, "123", False)
        lookup.return_value = "sha256:" + "d" * 64
        with self.assertRaises(ValueError):
            candidate.wait_review(SHA, TAG, IMAGE, timeout=0)

    @mock.patch.object(candidate, "validate")
    @mock.patch.object(candidate, "synchronized", return_value=False)
    @mock.patch.object(candidate, "lookup", return_value=DIGEST)
    def test_wait_timeout_never_deploys(self, lookup, synced, validate):
        with self.assertRaises(TimeoutError):
            candidate.wait_review(SHA, TAG, IMAGE, timeout=0)
        validate.assert_not_called()

    def test_wait_checks_synced_checkout_and_never_mutates_it(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            path = root / candidate.MANIFEST
            path.parent.mkdir(parents=True)
            path.write_text(f"      image: {IMAGE}\n")
            with mock.patch.object(candidate, "ROOT", root), mock.patch.object(candidate, "run") as run:
                run.side_effect = ["", SHA, SHA, str(candidate.MANIFEST), ""]
                self.assertTrue(candidate.synchronized(IMAGE))
                self.assertFalse(any("pull" in call.args or "reset" in call.args
                                     or "checkout" in call.args for call in run.call_args_list))
                run.side_effect = ["", SHA, OTHER_SHA]
                self.assertFalse(candidate.synchronized(IMAGE))
                run.side_effect = ["", SHA, SHA, str(candidate.MANIFEST), " M manifest"]
                with self.assertRaises(ValueError):
                    candidate.synchronized(IMAGE)

    @mock.patch.object(candidate, "ecr")
    @mock.patch.object(candidate, "validate", return_value=IMAGE)
    def test_rollback_uses_exact_artifact_and_refuses_ambiguity(self, validate, ecr):
        ecr.return_value = {"imageDetails": [{"imageDigest": DIGEST, "imageTags": [f"prod-{SHA}-120-1"]}]}
        self.assertEqual(candidate.restore_image(SHA, "", "rollback"), IMAGE)
        validate.assert_called_with(SHA, DIGEST, "", restore=True)
        ecr.return_value["imageDetails"].append({"imageDigest": "sha256:" + "d" * 64,
                                                "imageTags": [f"prod-{SHA}-121-1"]})
        with self.assertRaises(ValueError):
            candidate.restore_image(SHA, "", "rollback")
        with self.assertRaises(ValueError):
            candidate.restore_image(SHA, candidate.PREFIX + ":latest", "rollback")
        self.assertEqual(candidate.restore_image(SHA, IMAGE, "rollback"), IMAGE)
        self.assertEqual(candidate.tag_for(SHA, "123", True), f"rollback-{SHA}-123")

    @mock.patch.object(candidate, "run")
    @mock.patch.object(candidate, "ecr")
    def test_legacy_rollback_requires_original_production_tag_and_source(self, ecr, run):
        detail = {"Os": "linux", "Architecture": "arm64", "Config": {"Labels": {
            "org.opencontainers.image.revision": SHA}}}
        run.return_value = json.dumps(detail)
        ecr.return_value = {"imageDetails": [{"imageTags": [f"prod-{SHA}-120-1"]}]}
        self.assertEqual(candidate.validate(SHA, DIGEST, "123", True), IMAGE)
        ecr.return_value = {"imageDetails": [{"imageTags": [f"prod-{OTHER_SHA}-120-1"]}]}
        with self.assertRaises(ValueError):
            candidate.validate(SHA, DIGEST, "123", True)
        detail["Config"]["Labels"]["org.opencontainers.image.revision"] = OTHER_SHA
        run.return_value = json.dumps(detail)
        with self.assertRaises(ValueError):
            candidate.validate(SHA, DIGEST, "123", True)

    @mock.patch.object(candidate, "synchronized", return_value=True)
    @mock.patch.object(candidate, "validate", side_effect=ValueError("source mismatch"))
    def test_redeploy_current_image_must_match_frozen_source(self, validate, synced):
        with tempfile.TemporaryDirectory() as tmp, mock.patch.object(candidate, "ROOT", Path(tmp)):
            path = Path(tmp) / candidate.MANIFEST
            path.parent.mkdir(parents=True)
            path.write_text(f"image: {IMAGE}\n")
            with self.assertRaisesRegex(ValueError, "source mismatch"):
                candidate.restore_image(SHA, "", "redeploy")


    @mock.patch.object(candidate, "urlopen")
    def test_ci_failure_blocks_release(self, urlopen):
        from io import StringIO
        def response(conclusion):
            return StringIO(json.dumps({"workflow_runs": [{"id": 1, "head_sha": SHA,
                "head_repository": {"full_name": "botlearn-ai/botcord"},
                "status": "completed", "conclusion": conclusion, "html_url": "https://github.com/run"}]}))
        with mock.patch.dict(os.environ, {"GH_TOKEN": "test-not-a-secret"}):
            urlopen.return_value = response("failure")
            with self.assertRaises(ValueError):
                candidate.verify_ci(SHA, timeout=0)
            urlopen.return_value = response("success")
            candidate.verify_ci(SHA, timeout=0)


class SourceSnapshotTests(unittest.TestCase):
    def test_main_uses_event_sha_not_fetched_head_and_rerun_reuses_snapshot(self):
        with tempfile.TemporaryDirectory() as tmp:
            snapshot = Path(tmp) / "request.json"
            with mock.patch.object(prepare, "git", return_value="") as git:
                record = prepare.prepare("main", SHA, "123", snapshot, False)
            self.assertEqual(record["source_sha"], SHA)
            self.assertNotIn(mock.call("rev-parse", "FETCH_HEAD"), git.call_args_list)
            self.assertFalse(any(call.args[0] == "push" for call in git.call_args_list))
            with mock.patch.object(prepare, "git") as git:
                self.assertEqual(prepare.prepare("main", SHA, "123", snapshot, True), record)
                git.assert_not_called()
            for branch, workflow_sha, run_id in (("hotfix/x", SHA, "123"),
                                                 ("main", OTHER_SHA, "123"),
                                                 ("main", SHA, "124")):
                with self.assertRaises(ValueError):
                    prepare.prepare(branch, workflow_sha, run_id, snapshot, True)

    def test_archive_only_after_ci_is_idempotent_and_no_overwrite(self):
        record = {"archive_branch": "release/2026-11-09", "source_sha": SHA}
        with mock.patch.object(prepare, "git", return_value="") as git:
            prepare.archive_release(record)
            git.assert_called_with("push", "origin", SHA + ":refs/heads/release/2026-11-09")
        with mock.patch.object(prepare, "git", return_value=OTHER_SHA + "\trefs/heads/release/2026-11-09"):
            with self.assertRaises(ValueError):
                prepare.archive_release(record)

    def test_missing_retry_snapshot_is_not_recreated(self):
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "missing.json"
            with mock.patch.object(prepare, "git") as git:
                with self.assertRaises(FileNotFoundError):
                    prepare.prepare("main", SHA, "123", path, True)
                git.assert_not_called()

    def test_hotfix_resolves_once_and_freezes(self):
        with tempfile.TemporaryDirectory() as tmp:
            def git(*args):
                return OTHER_SHA if args == ("rev-parse", "FETCH_HEAD") else ""
            path = Path(tmp) / "request.json"
            with mock.patch.object(prepare, "git", side_effect=git):
                record = prepare.prepare("hotfix/fix", SHA, "123", path, False)
            self.assertEqual(record["source_sha"], OTHER_SHA)
            self.assertEqual(record["publish_mode"], "hotfix")


class ReleaseWorkflowTests(unittest.TestCase):
    def test_all_production_writes_depend_on_common_preflight(self):
        text = (ROOT / ".github/workflows/release.yml").read_text()
        for name in ("migrate-prod", "deploy-backend-prod", "deploy-frontend-prod", "deploy-gateway-ingress-prod"):
            section = text.split(f"  {name}:\n", 1)[1].split("\n  #", 1)[0]
            self.assertIn("release-preflight", section.split("    steps:", 1)[0])
        self.assertIn("group: botcord-production-release", text)
        prepare_job = text.split("  prepare:\n", 1)[1].split("  frontend-candidate:", 1)[0]
        self.assertIn("runs-on: ubuntu-latest", prepare_job)
        self.assertNotIn("runs-on: self-hosted", prepare_job)
        self.assertIn("request_review: true", text)
        self.assertNotIn("needs.frontend-candidate.outputs.image", text)
        self.assertIn("preflight_only: true", text)
        self.assertEqual(text.count("needs.frontend-candidate.outputs.digest) }}"), 2)
        self.assertIn("actions/download-artifact@v4", text)
        self.assertIn("actions/upload-artifact@v4", text)
        self.assertIn("release_candidate.py ci", text)
        self.assertNotIn('SOURCE_BRANCH="${{ inputs.', text)

    def test_workflow_changes_trigger_contracts(self):
        for name in ("ci.yml", "infra-check.yml"):
            content = (ROOT / ".github/workflows" / name).read_text()
            self.assertIn(".github/workflows/**", content)
            self.assertIn("bash infra/eks/check_workflows.sh", content)

    def test_all_workflows_get_schema_checks_and_release_lane_shell_lint(self):
        script = (ROOT / "infra/eks/check_workflows.sh").read_text()
        self.assertIn('"$binary" -shellcheck=', script)
        self.assertIn("sha256sum --check", script)
        self.assertIn(".github/workflows/release.yml", script)

    def test_build_reuse_does_not_deploy_and_controls_are_trusted(self):
        text = (ROOT / ".github/workflows/deploy-frontend.yml").read_text()
        self.assertIn("inputs.build_only != true", text)
        self.assertIn("release_candidate.py resolve", text)
        self.assertIn("release_candidate.py publish", text)
        self.assertIn("release_candidate.py wait", text)
        self.assertIn('args+=(--expected-image "$EXPECTED_IMAGE")', text)
        self.assertIn('args+=(--preflight-only)', text)
        self.assertGreaterEqual(text.count("ref: ${{ github.workflow_sha }}"), 2)
        self.assertIn("com.botcord.release.run-id=${{ github.run_id }}", text)
        self.assertNotIn("git pull", text)
        self.assertNotIn("git reset", text)
        self.assertNotIn("VERCEL_TOKEN", text)


if __name__ == "__main__":
    unittest.main()
