import importlib.util
import json
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

SPEC = importlib.util.spec_from_file_location("prepare_production", Path(__file__).parents[1] / "eks/prepare_production.py")
prepare = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(prepare)


def fixture():
    values = {
        "NEXT_PUBLIC_APP_URL": "https://www.botcord.chat",
        "NEXT_PUBLIC_HUB_BASE_URL": "https://api.botcord.chat",
        "NEXT_PUBLIC_SUPABASE_URL": "https://production.example.test",
        "NEXT_PUBLIC_SUPABASE_ANON_KEY": "sb_publishable_TestPublicKey0123456789012345",
        "NEXT_PUBLIC_BETA_GATE_ENABLED": "false",
        "SHOW_MESSAGE_STATUS": "false",
        "SUPABASE_DB_URL": "postgres://test:private-value@db.example.test/app",
    }
    return {"envs": [{"key": key, "value": value, "target": ["production"], "type": "encrypted"} for key, value in values.items()]}


class PreparationTests(unittest.TestCase):
    def test_public_artifact_never_contains_private_values(self):
        public, database = prepare.select_environment(fixture())
        self.assertEqual(set(public), set(prepare.PUBLIC_KEYS))
        self.assertNotIn("private-value", json.dumps(public))
        self.assertIn("private-value", database)
        self.assertEqual(public["SHOW_MESSAGE_STATUS"], "false")
        self.assertEqual(public["NEXT_PUBLIC_BETA_GATE_ENABLED"], "false")

    def test_preview_values_are_not_used(self):
        data = fixture()
        data["envs"].append({"key": "NEXT_PUBLIC_APP_URL", "value": "https://preview.test", "target": ["preview"]})
        public, _ = prepare.select_environment(data)
        self.assertEqual(public["NEXT_PUBLIC_APP_URL"], "https://www.botcord.chat")

    def test_secret_or_missing_exports_fail_closed(self):
        for change in ({"visibility": "secret"}, {"type": "sensitive"}, {"value": None}, {"value": "encrypted-placeholder"}):
            with self.subTest(change=change):
                data = fixture()
                data["envs"][-1].update(change)
                with self.assertRaises(ValueError):
                    prepare.select_environment(data)

    def test_public_and_uri_shaped_placeholders_fail(self):
        for key, value in (("NEXT_PUBLIC_SUPABASE_ANON_KEY", "encrypted-placeholder"),
                           ("SUPABASE_DB_URL", "postgres://user:__FILL_ME__@db.example.test/app")):
            data = fixture()
            next(entry for entry in data["envs"] if entry["key"] == key)["value"] = value
            with self.assertRaises(ValueError):
                prepare.select_environment(data)

    def test_missing_behavior_flags_fail_instead_of_changing_defaults(self):
        for key in ("SHOW_MESSAGE_STATUS", "NEXT_PUBLIC_BETA_GATE_ENABLED"):
            data = fixture()
            data["envs"] = [entry for entry in data["envs"] if entry["key"] != key]
            with self.assertRaises(ValueError):
                prepare.select_environment(data)

    def test_incomplete_snapshot_fails(self):
        for data in ({"envs": [], "pagination": {"next": "page2"}}, {"key": "single-variable"}):
            with self.assertRaises(ValueError):
                prepare.select_environment(data)

    def test_duplicate_and_wrong_origin_fail(self):
        data = fixture()
        data["envs"].append(data["envs"][0])
        with self.assertRaises(ValueError):
            prepare.select_environment(data)
        data = fixture()
        data["envs"][0]["value"] = "https://www.test.botcord.chat"
        with self.assertRaises(ValueError):
            prepare.select_environment(data)

    @patch.object(prepare.subprocess, "run")
    def test_existing_secret_is_not_overwritten(self, run):
        run.return_value = subprocess.CompletedProcess([], 0, "secret/botcord-frontend-runtime\n", "")
        with self.assertRaisesRegex(RuntimeError, "refusing to overwrite"):
            prepare.create_runtime_secret("postgres://private-value")
        self.assertEqual(run.call_count, 1)

    @patch.object(prepare.subprocess, "run")
    def test_get_failure_does_not_create(self, run):
        run.return_value = subprocess.CompletedProcess([], 1, "", "forbidden")
        with self.assertRaises(RuntimeError):
            prepare.create_runtime_secret("postgres://private-value")
        self.assertEqual(run.call_count, 1)

    @patch.object(prepare.subprocess, "run")
    def test_secret_only_sent_over_stdin_to_fixed_scope(self, run):
        run.side_effect = [subprocess.CompletedProcess([], 0, "", ""), subprocess.CompletedProcess([], 0, "created", "")]
        prepare.create_runtime_secret("postgres://private-value")
        command = run.call_args.args[0]
        self.assertEqual(command, ["kubectl", "--context", prepare.CONTEXT, "-n", "prod", "create", "-f", "-"])
        self.assertNotIn("private-value", str(command))
        payload = json.loads(run.call_args.kwargs["input"])
        self.assertEqual(payload["metadata"]["name"], prepare.SECRET)
        self.assertEqual(payload["stringData"], {"SUPABASE_DB_URL": "postgres://private-value"})


if __name__ == "__main__":
    unittest.main()
