"""Fail-closed contracts for reusing an existing Supabase project."""

import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import unittest


ROOT = Path(__file__).resolve().parents[2]
VALIDATOR = ROOT / "infra/compose/validate_shared_environment.py"
SPEC = importlib.util.spec_from_file_location("validate_shared_environment", VALIDATOR)
assert SPEC and SPEC.loader
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


def shared_config():
    return {
        "services": {
            "botcord-backend": {
                "environment": {
                    "DATABASE_URL": "postgresql+asyncpg://postgres:secret@db.example.test:5432/postgres",
                    "DATABASE_SCHEMA": "public",
                    "SUPABASE_URL": "https://project.example.test",
                    "SUPABASE_JWT_JWKS_URL": "https://project.example.test/auth/v1/.well-known/jwks.json",
                    "SUPABASE_JWT_SECRET": "",
                    "SUPABASE_SERVICE_ROLE_KEY": "private-service-role",
                    "SUPABASE_STORAGE_BUCKET": "botcord-files",
                    "FILE_STORAGE_BACKEND": "supabase",
                    "BOTCORD_SCHEMA_AUTO_CREATE": "false",
                    "BOTCORD_BACKGROUND_TASKS_ENABLED": "false",
                }
            },
            "botcord-frontend": {
                "environment": {
                    "SUPABASE_INTERNAL_URL": "https://project.example.test/",
                    "SUPABASE_DB_URL": "postgresql://postgres:secret@db.example.test/postgres",
                },
                "build": {
                    "args": {
                        "NEXT_PUBLIC_SUPABASE_URL": "https://project.example.test",
                        "NEXT_PUBLIC_SUPABASE_ANON_KEY": "public-anon-key",
                    }
                },
            },
        }
    }


class SharedEnvironmentValidation(unittest.TestCase):
    def test_valid_shared_configuration_passes(self):
        MODULE.validate(shared_config(), "up")

    def test_pure_local_core_configuration_passes(self):
        config = shared_config()
        backend = config["services"]["botcord-backend"]["environment"]
        backend.update({
            "DATABASE_URL": "postgresql+asyncpg://botcord:secret@postgres:5432/botcord",
            "SUPABASE_URL": "",
            "SUPABASE_JWT_JWKS_URL": "",
            "SUPABASE_SERVICE_ROLE_KEY": "",
        })
        MODULE.validate(config, "core-up")

    def test_external_core_database_requires_shared_safety_contract(self):
        config = shared_config()
        config["services"]["botcord-backend"]["environment"]["BOTCORD_SCHEMA_AUTO_CREATE"] = "true"
        with self.assertRaisesRegex(ValueError, "BOTCORD_SCHEMA_AUTO_CREATE"):
            MODULE.validate(config, "core-up")

    def test_shared_core_validation_does_not_require_frontend_configuration(self):
        config = shared_config()
        del config["services"]["botcord-frontend"]
        MODULE.validate(config, "core-up")

    def test_database_targets_must_match(self):
        config = shared_config()
        config["services"]["botcord-frontend"]["environment"]["SUPABASE_DB_URL"] = (
            "postgresql://postgres:secret@other.example.test/postgres"
        )
        with self.assertRaisesRegex(ValueError, "same database"):
            MODULE.validate(config, "up")

    def test_supabase_urls_must_match(self):
        config = shared_config()
        config["services"]["botcord-frontend"]["environment"]["SUPABASE_INTERNAL_URL"] = (
            "https://other.example.test"
        )
        with self.assertRaisesRegex(ValueError, "URLs must match"):
            MODULE.validate(config, "up")

    def test_required_auth_storage_and_ownership_fields_fail_closed(self):
        cases = (
            ("backend", "SUPABASE_JWT_JWKS_URL", "JWT"),
            ("backend", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_SERVICE_ROLE_KEY"),
            ("backend", "SUPABASE_STORAGE_BUCKET", "SUPABASE_STORAGE_BUCKET"),
            ("backend", "BOTCORD_BACKGROUND_TASKS_ENABLED", "BOTCORD_BACKGROUND_TASKS_ENABLED"),
            ("frontend", "SUPABASE_DB_URL", "SUPABASE_DB_URL"),
        )
        for service, field, message in cases:
            with self.subTest(field=field):
                config = shared_config()
                config["services"][f"botcord-{service}"]["environment"][field] = ""
                with self.assertRaisesRegex(ValueError, message):
                    MODULE.validate(config, "up")

    def test_public_auth_build_values_are_required(self):
        for field in ("NEXT_PUBLIC_SUPABASE_URL", "NEXT_PUBLIC_SUPABASE_ANON_KEY"):
            with self.subTest(field=field):
                config = shared_config()
                config["services"]["botcord-frontend"]["build"]["args"][field] = ""
                with self.assertRaisesRegex(ValueError, field):
                    MODULE.validate(config, "up")

    def test_cli_errors_name_fields_without_printing_secrets(self):
        config = shared_config()
        config["services"]["botcord-backend"]["environment"]["BOTCORD_SCHEMA_AUTO_CREATE"] = "true"
        result = subprocess.run(
            [sys.executable, str(VALIDATOR), "--mode", "up"],
            input=json.dumps(config),
            capture_output=True,
            text=True,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("BOTCORD_SCHEMA_AUTO_CREATE", result.stderr)
        self.assertNotIn("private-service-role", result.stderr)
        self.assertNotIn("public-anon-key", result.stderr)


if __name__ == "__main__":
    unittest.main()
