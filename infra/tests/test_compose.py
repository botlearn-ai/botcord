"""Infrastructure contracts, evaluated by Compose itself (no extra dependencies)."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
DOKPLOY = ROOT / "infra/dokploy"
VALUES = {
    "BOTCORD_NETWORK": "botcord-test",
    "BOTCORD_DATABASE_NETWORK": "botcord-databases-test",
    "BOTCORD_BACKEND_IMAGE": "example.invalid/botcord-backend:sha-test",
    "BOTCORD_GATEWAY_INGRESS_IMAGE": "example.invalid/botcord-gateway-ingress:sha-test",
    "ENVIRONMENT_TAG": "prod",
    "BOTCORD_FRONTEND_IMAGE": "example.invalid/botcord-frontend:sha-test",
    "SUPABASE_INTERNAL_URL": "http://supabase-test:8000",
    "SUPABASE_DB_URL": "postgresql://botcord:test@postgres:5432/botcord",
    "BIND_PROOF_SECRET": "test-binding-secret",
    "DATABASE_URL": "postgresql+asyncpg://botcord:test@postgres:5432/botcord",
    "SUPABASE_URL": "https://project.example.test",
    "SUPABASE_JWT_JWKS_URL": "https://project.example.test/auth/v1/.well-known/jwks.json",
    "SUPABASE_SERVICE_ROLE_KEY": "test-service-role",
    "SUPABASE_STORAGE_BUCKET": "botcord-files",
    "BOTCORD_REDIS_URL": "redis://redis:6379/0",
    "JWT_SECRET": "test-jwt",
    "INTERNAL_API_SECRET": "test-internal",
    "BOTCORD_HUB_CONTROL_PRIVATE_KEY": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
    "CLOUD_GATEWAY_INGRESS_SECRET": "test-ingress",
}


class ComposeContracts(unittest.TestCase):
    def test_active_remote_manifests_only_contain_applications(self):
        self.assertEqual(
            sorted(path.name for path in DOKPLOY.glob("*.yml")),
            [
                "botcord-backend.yml",
                "botcord-frontend.yml",
                "botcord-gateway-ingress.yml",
            ],
        )

    def render(self, filename, missing=None):
        # Use a temporary copy so real local/Dokploy .env secrets cannot leak.
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / filename
            shutil.copy(DOKPLOY / filename, target)
            (Path(directory) / ".env").write_text("OPTIONAL_FLAG=preserved\n")
            env = {k: v for k, v in os.environ.items() if k not in VALUES}
            env.update({k: v for k, v in VALUES.items() if k != missing})
            result = subprocess.run(
                ["docker", "compose", "--project-name", "botcord-contract", "--env-file",
                 str(Path(directory) / ".env"), "-f", str(target), "config", "--format", "json"],
                env=env, capture_output=True, text=True,
            )
            if missing:
                self.assertNotEqual(result.returncode, 0)
                self.assertIn(missing, result.stderr)
                return
            self.assertEqual(result.returncode, 0, result.stderr)
            return json.loads(result.stdout)

    def test_remote_services_have_healthchecks_and_no_host_ports_or_builds(self):
        for filename in ("botcord-backend.yml", "botcord-gateway-ingress.yml", "botcord-frontend.yml"):
            with self.subTest(filename=filename):
                config = self.render(filename)
                for service in config["services"].values():
                    self.assertNotIn("ports", service)
                    self.assertNotIn("build", service)
                    self.assertIn("healthcheck", service)
                    self.assertEqual(service["restart"], "unless-stopped")
                self.assertTrue(config["networks"]["botcord"]["external"])
                self.assertEqual(config["networks"]["botcord"]["name"], "botcord-test")

    def test_backend_environment_and_upload_persistence(self):
        service = self.render("botcord-backend.yml")["services"]["botcord-backend"]
        self.assertEqual(service["environment"]["OPTIONAL_FLAG"], "preserved")
        self.assertIn("--no-sync", service["command"])
        self.assertEqual(service["environment"]["CLOUD_GATEWAY_INGRESS_BASE_URL"],
                         "http://botcord-gateway-ingress:9101")
        self.assertEqual(service["environment"]["BOTCORD_SCHEMA_AUTO_CREATE"], "false")
        self.assertEqual(service["environment"]["BOTCORD_BACKGROUND_TASKS_ENABLED"], "false")
        self.assertEqual(service["environment"]["DATABASE_SCHEMA"], "public")
        self.assertEqual(service["environment"]["FILE_STORAGE_BACKEND"], "supabase")
        self.assertIn("/data/uploads", [v["target"] for v in service["volumes"]])
        self.assertEqual(set(service["networks"]), {"botcord", "databases"})
        config = self.render("botcord-backend.yml")
        self.assertTrue(config["networks"]["databases"]["external"])
        self.assertEqual(
            config["networks"]["databases"]["name"], "botcord-databases-test"
        )

    def test_ingress_secret_volume_and_private_setup_contract(self):
        service = self.render("botcord-gateway-ingress.yml")["services"]["botcord-gateway-ingress"]
        self.assertEqual(service["environment"]["BOTCORD_INGRESS_SECRET"], VALUES["CLOUD_GATEWAY_INGRESS_SECRET"])
        self.assertEqual(service["environment"]["BOTCORD_INGRESS_SETUP_HOST"], "0.0.0.0")
        self.assertEqual({v["target"] for v in service["volumes"]}, {"/data", "/secrets"})
        self.assertEqual(set(service["networks"]), {"botcord"})
        self.assertIn("/healthz", " ".join(service["healthcheck"]["test"]))

    def test_frontend_uses_internal_server_urls_and_scoped_secrets(self):
        service = self.render("botcord-frontend.yml")["services"]["botcord-frontend"]
        self.assertEqual(service["environment"]["HUB_INTERNAL_URL"], "http://botcord-backend:8000")
        self.assertEqual(set(service["networks"]), {"botcord"})
        self.assertNotIn("SUPABASE_SERVICE_ROLE_KEY", service["environment"])
        self.assertNotIn("JWT_SECRET", service["environment"])
        self.assertIn("/api/health", " ".join(service["healthcheck"]["test"]))

    def test_missing_required_environment_fails_closed(self):
        for key in ("DATABASE_URL", "SUPABASE_URL", "SUPABASE_JWT_JWKS_URL",
                    "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_STORAGE_BUCKET",
                    "JWT_SECRET", "BOTCORD_REDIS_URL", "BOTCORD_HUB_CONTROL_PRIVATE_KEY",
                    "INTERNAL_API_SECRET", "CLOUD_GATEWAY_INGRESS_SECRET", "BOTCORD_BACKEND_IMAGE",
                    "BOTCORD_NETWORK", "BOTCORD_DATABASE_NETWORK"):
            with self.subTest(key=key):
                self.render("botcord-backend.yml", missing=key)
        self.render("botcord-gateway-ingress.yml", missing="CLOUD_GATEWAY_INGRESS_SECRET")
        self.render("botcord-frontend.yml", missing="SUPABASE_INTERNAL_URL")
        self.render("botcord-backend.yml", missing="ENVIRONMENT_TAG")


if __name__ == "__main__":
    unittest.main()
