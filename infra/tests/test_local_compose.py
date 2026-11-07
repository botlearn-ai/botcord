"""Contracts for the isolated, source-built local Compose stack."""
import json
import os
from pathlib import Path
import subprocess
import unittest


ROOT = Path(__file__).resolve().parents[2]
COMPOSE = ROOT / "infra/compose/docker-compose-debug.yml"
LOCAL_SCRIPT = ROOT / "infra/compose/local.sh"
VALUES = {
    "POSTGRES_PASSWORD": "test-postgres-password",
    "NEXT_PUBLIC_SUPABASE_URL": "http://localhost:18001",
    "NEXT_PUBLIC_SUPABASE_ANON_KEY": "test-public-key",
    "SUPABASE_INTERNAL_URL": "http://supabase-test:8000",
    "BIND_PROOF_SECRET": "test-binding-secret",
    "REDIS_PASSWORD": "test-redis-password",
    "JWT_SECRET": "test-jwt-secret",
    "INTERNAL_API_SECRET": "test-internal-secret",
    "CLOUD_GATEWAY_INGRESS_SECRET": "test-ingress-secret",
    "BOTCORD_HUB_CONTROL_PRIVATE_KEY": "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
}


class LocalComposeContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = os.environ.copy()
        for key in (
            "CLOUD_AGENT_FEATURE_ENABLED",
            "BOTLEARN_INTEGRATION_ENABLED",
            "EXPO_PUSH_ENABLED",
        ):
            env.pop(key, None)
        env.update(VALUES)
        result = subprocess.run(
            ["docker", "compose", "--env-file", "/dev/null", "-f", str(COMPOSE),
             "config", "--format", "json"],
            cwd=ROOT,
            env=env,
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            raise AssertionError(result.stderr)
        cls.config = json.loads(result.stdout)

    def test_data_services_are_private_and_persistent(self):
        for name in ("postgres", "redis"):
            with self.subTest(service=name):
                service = self.config["services"][name]
                self.assertNotIn("ports", service)
                self.assertIn("healthcheck", service)
                self.assertTrue(service["volumes"])

    def test_only_loopback_development_endpoints_are_published(self):
        backend = self.config["services"]["botcord-backend"]
        ingress = self.config["services"]["botcord-gateway-ingress"]
        self.assertEqual(backend["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual(backend["ports"][0]["published"], "18000")
        self.assertEqual(ingress["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual(ingress["ports"][0]["published"], "19100")
        self.assertNotIn("9101", json.dumps(ingress.get("ports", [])))

    def test_services_build_from_checkout_and_gate_on_health(self):
        backend = self.config["services"]["botcord-backend"]
        ingress = self.config["services"]["botcord-gateway-ingress"]
        self.assertEqual(Path(backend["build"]["context"]), ROOT / "backend")
        self.assertEqual(Path(ingress["build"]["context"]), ROOT)
        self.assertEqual(backend["depends_on"]["postgres"]["condition"], "service_healthy")
        self.assertEqual(backend["depends_on"]["redis"]["condition"], "service_healthy")
        self.assertEqual(ingress["depends_on"]["botcord-backend"]["condition"], "service_healthy")

    def test_frontend_builds_without_private_build_arguments(self):
        service = self.config["services"]["botcord-frontend"]
        self.assertEqual(Path(service["build"]["context"]), ROOT / "frontend")
        self.assertEqual(service["ports"][0]["published"], "18080")
        self.assertEqual(service["ports"][0]["host_ip"], "127.0.0.1")
        self.assertEqual(service["environment"]["HUB_INTERNAL_URL"], "http://botcord-backend:8000")
        self.assertEqual(service["depends_on"]["botcord-backend"]["condition"], "service_healthy")
        self.assertTrue(all(k.startswith("NEXT_PUBLIC_") for k in service["build"]["args"]))
        self.assertNotIn("SUPABASE_DB_URL", service["build"]["args"])

    def test_external_integrations_default_off(self):
        environment = self.config["services"]["botcord-backend"]["environment"]
        for key in (
            "CLOUD_AGENT_FEATURE_ENABLED",
            "BOTLEARN_INTEGRATION_ENABLED",
            "EXPO_PUSH_ENABLED",
            "ENDPOINT_PROBE_ENABLED",
        ):
            with self.subTest(key=key):
                self.assertEqual(environment[key], "false")
        for key in ("STRIPE_SECRET_KEY", "STRIPE_WEBHOOK_SECRET", "RESEND_API_KEY", "SENTRY_DSN"):
            with self.subTest(key=key):
                self.assertEqual(environment[key], "")

    def test_local_script_never_renders_secret_values(self):
        script = LOCAL_SCRIPT.read_text()
        self.assertIn("compose config --quiet", script)
        self.assertIn('compose config --format json | python3', script)
        self.assertNotIn('echo "$(compose config', script)
        self.assertIn('chmod 600 "$ENV_FILE"', script)


if __name__ == "__main__":
    unittest.main()
