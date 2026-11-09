# Production frontend delivery

Production is `www.botcord.chat` → CloudFront → dedicated ALB → US `aibrary`
EKS, namespace `prod`. Backend and database remain separate delivery units.

## Normal Release (single entry, reviewed configuration)

Run **Release** from `main`, choose `source_branch` and `targets` as before.
`frontend` changes only the frontend; `both`/`all` include backend and gateway.
Database migration stays optional and defaults to false.

1. Freeze source SHA, release version and archive in a run-scoped artifact.
   For `main`, the event commit is used even if main advances in the queue.
   Require successful CI for that exact source before preparing production.
2. Build the ARM64 ECR candidate with source/run provenance. Production images
   are digest-pinned; a stable `release-<sha>-<run>` discovery tag is published.
3. DevOps **BotCord Frontend Release PR** discovers release markers on its
   schedule and opens an image-only PR. Review and merge that PR. This is the
   only deliberate human approval step; neither workflow approves or merges it.
4. Release waits up to two hours for the exact digest in the clean, synchronized
   `/www/devops` checkout. **Sync to DevOps**, not the application, updates it.
   Wrong identity, image/source/platform, runtime configuration or drift fails
   the preflight. No backend/gateway rollout or optional DB migration starts
   before the common release preflight succeeds.
5. Deploy the same reviewed digest, verify all Pods Ready/imageIDs, ALB TLS
   health, then normal public CloudFront HTML/static assets, static cache hits,
   dynamic cache misses and the missing-code auth callback redirect.
6. Promote `release/latest` and publish the GitHub Release only after all
   selected deployments pass. Multi-service rollout is not runtime-atomic;
   failures do not silently revert other services or database changes.

The two-hour wait can be resumed with **Re-run failed jobs** after the PR and
Sync complete. **Re-run all jobs** restores the original source/version artifact
and reuses the candidate; it never resolves a moving branch or overwrites the
candidate tag. Snapshots expire after 30 days; start a new Release if absent.
ECR currently permits mutable tags, so the captured digest is authoritative;
marker drift or an existing marker with conflicting provenance stops release.

The DevOps workflow has a manual `candidate_tag` input for immediate discovery
or a historical candidate. It requires no new cross-repository credentials:
DevOps uses its existing repository-scoped App; BotCord only reads the synced
checkout. GitHub cron delivery can be delayed; it is not a five-minute SLA.

## Manual preparation and rollback

**Deploy Frontend Production** with `build_only=true` still builds an isolated
`prod-<sha>-<run>-<attempt>` candidate without requesting a PR or deploying.
After a separately reviewed digest PR and Sync, `build_only=false` accepts a
source branch or exact SHA and verifies its provenance before deployment.

`release/latest` redeploys the current reviewed digest only when it matches the
frozen source; `release/*` rollback resolves a unique prior source-addressed ECR
digest. Neither mode rebuilds with today's configuration. If several historical
candidates exist, supply `frontend_image` as the full immutable ECR digest. A
`rollback-<sha>-<run>` marker requests review of that exact historical artifact.
Legacy images still need the original production tag, exact source revision and
Linux ARM64 platform. For a manual application rollback, review/pin the previous
immutable EKS digest and redeploy its exact source. For an edge rollback, restore the GoDaddy `www` CNAME
to `k8s-prod-botcordf-f9ac4ffdde-618604690.us-east-1.elb.amazonaws.com`. Existing
Vercel deployments remain a second-level fallback; Git auto-deploy is disabled
by `frontend/vercel.json`, while deliberate CLI emergency deployments remain
possible. No workflow deletes the Vercel project or edits DNS.

GoDaddy now owns the apex 301 to `https://www.botcord.chat`; it is not a Vercel
redirect. Its deep-link/query preservation limitations are independent of this
pipeline. Canonical links should use `www`. A retained Vercel deployment and
its domain/TLS bindings must be verified before any future DNS rollback.

## Configuration and one-time migration

Use the dedicated `FrontendProduction` environment restricted to `main`.
Required public build variables: `BOTCORD_PROD_APP_URL`,
`BOTCORD_PROD_HUB_BASE_URL`, `BOTCORD_PROD_SUPABASE_URL`,
`BOTCORD_PROD_SUPABASE_ANON_KEY`, `BOTCORD_PROD_BETA_GATE_ENABLED`,
`BOTCORD_PROD_SHOW_MESSAGE_STATUS`; `BOTCORD_PROD_GA_ID` is optional.
Both flags must be literal `true`/`false`. Values must match the reviewed
ConfigMap; runtime environment cannot repair a previously built browser bundle.
Database credentials remain in `prod/botcord-frontend-runtime`, never build args.

**Prepare Frontend Production Configuration** is a one-time migration tool,
not part of normal release. It reads existing Vercel production configuration;
`create_secret=true` creates the dedicated Secret only when absent and never
overwrites one. Its public artifact is retained for one day; private values
are not logged or uploaded. Do not rerun it as ordinary production setup.

Automated checks are anonymous/read-only. They do not replace real login,
OAuth completion, payment or database business validation.
