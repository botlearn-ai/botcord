# Production frontend delivery

`botcord-frontend` production uses the US `aibrary` EKS cluster. Delivery is
split so application CI cannot bypass reviewed DevOps configuration:

1. Manually run **Deploy Frontend Production** with `build_only=true`. It builds
   Linux ARM64 and pushes `prod-<source-sha>-<run>-<attempt>`. This does not mutate
   Kubernetes or DNS.
2. Review that exact digest in
   `aibrary-devops/eks/us-aibrary/prod/botcord-frontend/k8s.yaml`, merge the PR,
   and wait until `/www/devops` is clean and synchronized.
3. Release the same source SHA. The controller rejects mutable images, source
   mismatches, unexpected resources, the wrong AWS/EKS target, or DevOps drift.

After rollout it proves every Pod is Ready on the reviewed digest and checks
`https://www.botcord.chat/api/health` through the new ALB with real TLS SNI. It
does not change Route 53. Vercel remains the rollback source during cutover.

Required Production environment variables are `BOTCORD_PROD_APP_URL`,
`BOTCORD_PROD_HUB_BASE_URL`, `BOTCORD_PROD_SUPABASE_URL`, and
`BOTCORD_PROD_SUPABASE_ANON_KEY`, `BOTCORD_PROD_BETA_GATE_ENABLED`, and
`BOTCORD_PROD_SHOW_MESSAGE_STATUS`. The two behavior flags must be the literal
`true` or `false` so migration cannot silently change production behavior.
`BOTCORD_PROD_GA_ID` is optional. Database credentials remain in the dedicated
Kubernetes runtime Secret; they are never image build arguments.

## First migration from Vercel

Before building, run **Prepare Frontend Production Configuration** from reviewed
`main` with `create_secret=true`. It uses the existing Vercel credentials to
read the current production variables and creates only
`prod/botcord-frontend-runtime` with `SUPABASE_DB_URL`; an existing Secret is
never overwritten. Non-exportable Vercel secrets, missing behavior flags,
placeholder values and incomplete responses stop preparation. Use the existing
environment secret channel if Vercel cannot export a required value.

Download the `botcord-production-public` artifact (one-day retention), then map
its public values to the `BOTCORD_PROD_*` variables above. Map
`SHOW_MESSAGE_STATUS` to `BOTCORD_PROD_SHOW_MESSAGE_STATUS`; map the other
`NEXT_PUBLIC_*` keys by replacing that prefix with `BOTCORD_PROD_`. Preserve the
same public values in the reviewed ConfigMap. Private credentials are never
uploaded, printed or written into the repository.

For this migration GoDaddy is authoritative DNS. Only change `www` CNAME after
new-ALB TLS, HTML/assets, Hub/Supabase/database connectivity and callback checks
pass. Keep the existing apex Vercel redirect and the prior `www` CNAME for
rollback; never pin changing ALB IPs into apex A records. `/api/health` proves
process liveness only, not those dependencies or an authenticated user journey.
