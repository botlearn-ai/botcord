import json
import os
import pathlib
import subprocess
import unittest


ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"


def workflow(name: str) -> str:
    return (WORKFLOWS / name).read_text()


class TestDokployWorkflowContracts(unittest.TestCase):
    def test_vercel_is_retained_for_rollback_but_production_workflow_uses_eks(self):
        config = json.loads((ROOT / "frontend" / "vercel.json").read_text())
        self.assertEqual(config["framework"], "nextjs")
        self.assertEqual(config["installCommand"], "pnpm install --ignore-workspace")
        self.assertEqual(config["git"], {"deploymentEnabled": False})
        self.assertNotIn("ignoreCommand", config)

        production_workflow = workflow("deploy-frontend.yml")
        self.assertNotIn("vercel build --prod", production_workflow)
        self.assertNotIn("vercel deploy --prebuilt --prod", production_workflow)
        self.assertIn("platforms: linux/arm64", production_workflow)
        self.assertIn("infra/eks/deploy_frontend.py", production_workflow)
        self.assertIn("ref: ${{ github.workflow_sha }}", production_workflow)
        self.assertIn("inputs.build_only != true", production_workflow)

    def test_pull_requests_validate_but_only_main_push_deploys(self):
        content = workflow("ci.yml")

        self.assertIn("pull_request:\n    types: [opened, synchronize, reopened]", content)
        self.assertIn("pull-requests: read", content)
        self.assertIn("github.event_name == 'push'", content)
        self.assertIn("github.ref == 'refs/heads/main'", content)
        self.assertIn("uses: ./.github/workflows/deploy-dokploy-test.yml", content)
        self.assertIn("NODE_OPTIONS: --no-experimental-webstorage", content)
        self.assertEqual(
            content.count("dest: ${{ runner.temp }}/setup-pnpm-${{ github.job }}"),
            3,
        )
        self.assertNotIn("cache: 'pnpm'", content)
        self.assertNotIn("cache-dependency-path:", content)
        self.assertIn("python3 -m unittest discover -s infra/tests -v", content)
        self.assertIn("needs.infra-ci.result == 'success'", content)
        self.assertIn("if: always() && needs.changes.result == 'success'", content)
        self.assertIn('>> "$GITHUB_PATH"', content)
        self.assertNotIn("uses: ./.github/workflows/deploy-backend.yml", content)
        self.assertNotIn("uses: ./.github/workflows/deploy-frontend.yml", content)
        self.assertNotIn("uses: ./.github/workflows/deploy-gateway-ingress.yml", content)

    def test_test_deploy_is_commit_addressed_arm64_and_fail_closed(self):
        content = workflow("deploy-dokploy-test.yml")

        for required in (
            "workflow_call:",
            "workflow_dispatch:",
            "group: botcord-dokploy-test",
            "contents: write",
            "test -n \"$REQUESTED_REF\"",
            "[[ \"$SOURCE_SHA\" =~ ^[0-9a-f]{40}$ ]]",
            "test-$SOURCE_SHA-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}",
            "platforms: linux/arm64",
            "file: backend/Dockerfile",
            "file: frontend/Dockerfile",
            "file: packages/gateway-ingress/Dockerfile",
            "BOTCORD_TEST_SUPABASE_URL",
            "BOTCORD_TEST_SUPABASE_ANON_KEY",
            "@dokploy/cli@0.30.6",
            "python3 .deployment-control/infra/dokploy/deploy.py",
            '--sha "$SOURCE_SHA"',
            '--backend-image "$BACKEND_IMAGE"',
            '--frontend-image "$FRONTEND_IMAGE"',
            '--gateway-image "$GATEWAY_IMAGE"',
        ):
            self.assertIn(required, content)

        self.assertEqual(content.count("platforms: linux/arm64"), 3)
        self.assertIn("ref: ${{ github.workflow_sha }}", content)
        self.assertIn("path: .deployment-control", content)
        self.assertIn("sparse-checkout: infra/dokploy/deploy.py", content)
        self.assertIn("sparse-checkout-cone-mode: false", content)
        control_checkout = content[
            content.index("Checkout trusted deployment control") :
            content.index("Set up Node.js")
        ]
        self.assertIn("persist-credentials: false", control_checkout)
        self.assertNotIn("ref: ${{ inputs.ref", control_checkout)
        self.assertNotIn("python3 infra/dokploy/deploy.py", content)
        self.assertIn("botcord-backend@$BACKEND_DIGEST", content)
        self.assertIn("botcord-frontend@$FRONTEND_DIGEST", content)
        self.assertIn("botcord-gateway-ingress@$GATEWAY_DIGEST", content)
        self.assertNotIn("secrets.PREVIEW_DATABASE_URL", content)

    def test_manual_pr_deploy_targets_the_complete_dokploy_environment(self):
        content = workflow("deploy-pr-backend-preview.yml")

        self.assertIn("Deploy Complete Dokploy Test Environment", content)
        self.assertIn("pr.head.repo.full_name !== repoFullName", content)
        self.assertIn("ref: ${{ needs.prepare.outputs.head_sha }}", content)
        self.assertIn("uses: ./.github/workflows/deploy-dokploy-test.yml", content)
        self.assertIn("https://www.test.botcord.chat", content)
        self.assertIn("https://api.test.botcord.chat", content)
        self.assertIn("HEAD_REF: ${{ steps.pr.outputs.head_ref }}", content)
        self.assertIn("echo \"| Branch | \\`$HEAD_REF\\` |\"", content)
        self.assertNotIn(
            'echo "| Branch | \\`${{ steps.pr.outputs.head_ref }}\\` |"',
            content,
        )
        self.assertNotIn('echo "| Notes | ${{ inputs.notes', content)
        self.assertIn("permissions:\n  contents: read\n  pull-requests: read", content)
        self.assertIn(
            "backend-tests:\n    name: Backend Tests",
            content,
        )
        backend_tests = content[
            content.index("  backend-tests:") : content.index("  deploy-test:")
        ]
        self.assertIn("persist-credentials: false", backend_tests)
        self.assertIn("ref: ${{ needs.prepare.outputs.head_sha }}", backend_tests)
        self.assertNotIn("contents: write", backend_tests)

        deploy_test = content[
            content.index("  deploy-test:") : content.index("  pr-comment:")
        ]
        self.assertIn("contents: write", deploy_test)

        pr_comment = content[
            content.index("  pr-comment:") : content.index("  notify:")
        ]
        self.assertIn("pull-requests: write", pr_comment)

        notify = content[content.index("  notify:") :]
        self.assertIn("contents: read", notify)
        self.assertIn("persist-credentials: false", notify)
        self.assertIn("ref: ${{ github.workflow_sha }}", notify)
        self.assertNotIn("ref: ${{ needs.prepare.outputs.head_sha }}", notify)
        self.assertNotIn("contents: write", notify)
        self.assertNotIn("run_migrations", content)
        self.assertNotIn("PREVIEW_DATABASE_URL", content)
        self.assertNotIn("api.preview.botcord.chat", content)

    def test_legacy_reusable_workflows_are_production_only(self):
        for name in (
            "deploy-backend.yml",
            "deploy-frontend.yml",
            "deploy-gateway-ingress.yml",
        ):
            content = workflow(name)
            self.assertIn("only prod is supported", content)
            self.assertIn("if: inputs.env_name != 'prod'", content)
            self.assertIn("production-only", content)
            self.assertLess(
                content.index("Reject legacy non-production deployment"),
                content.index("uses: actions/checkout@v6"),
            )

        self.assertNotIn("restart-preview:", workflow("deploy-gateway-ingress.yml"))
        frontend = workflow("deploy-frontend.yml")
        self.assertIn("BOTCORD_PROD_APP_URL", frontend)
        self.assertEqual(frontend.count('test "$GITHUB_REF" = "refs/heads/main"'), 2)
        self.assertIn("Login to ECR for provenance verification", frontend)
        self.assertIn('[[ "$BETA_GATE_ENABLED" =~ ^(true|false)$ ]]', frontend)
        self.assertIn('[[ "$SHOW_MESSAGE_STATUS" =~ ^(true|false)$ ]]', frontend)
        self.assertNotIn("BOTCORD_PROD_BETA_GATE_ENABLED ||", frontend)
        self.assertNotIn("BOTCORD_PROD_SHOW_MESSAGE_STATUS ||", frontend)
        self.assertIn("prod-$SOURCE_SHA-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}", frontend)
        self.assertNotIn("VERCEL_TOKEN", frontend)

        release = workflow("release.yml")
        self.assertIn("uses: ./.github/workflows/deploy-backend.yml", release)
        self.assertIn("uses: ./.github/workflows/deploy-frontend.yml", release)
        self.assertIn("uses: ./.github/workflows/deploy-gateway-ingress.yml", release)
        self.assertGreaterEqual(release.count("env_name: prod"), 3)


if __name__ == "__main__":
    unittest.main()
