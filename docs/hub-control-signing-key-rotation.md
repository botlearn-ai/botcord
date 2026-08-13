# Hub control signing-key rotation

Daemon control frames are signed by the Hub with Ed25519. Daemons accept a
comma- or newline-separated trust ring from
`BOTCORD_HUB_CONTROL_PUBLIC_KEYS`. `BOTCORD_HUB_CONTROL_PUBLIC_KEY` remains a
supported single-key fallback, and an embedded development public key is used
only when neither variable supplies a key. Never put a private key in either
public-key variable.

## Release and fleet prerequisites

The key-ring code must be published before any production signer change. This
repository releases JavaScript packages through Changesets: merge a changeset,
run the `Release Packages` workflow to create and merge its version PR, then run
the workflow again to publish. The version PR is expected to bump both
`@botcord/protocol-core` and `@botcord/daemon`; the daemon's `workspace:^`
dependency is converted to the matching published protocol-core range by the
publish flow. Do not use a backend release as evidence of a daemon release.

Before approving the Version Packages PR, inspect its complete package and
changeset list. The repository may contain unrelated pending changesets that
the workflow will bundle into the same release. Either approve and attest the
entire bundled release (including every unrelated change), or isolate the
key-ring changes into a release branch/workflow that contains no unapproved
changesets. The key-ring changeset alone is not evidence that the resulting
artifacts are keyring-only.

Record the package workflow run, immutable source commit, package names and
versions, and npm tarball integrity values. Before rollout, install the exact
daemon version in a clean environment (never `@latest`) and confirm its
installed dependency tree contains the released protocol-core version. Also
exercise one frame signed by each overlap key against that installed artifact.
Only after those checks pass may `CLOUD_DAEMON_NPM_SPEC` be pinned to the exact
attested daemon version for newly created E2B sandboxes.

Inventory cloud and local daemons by agent, daemon version, last-seen time, and
whether their configured trust ring contains both overlap keys. Treat a missing
version or missing trust evidence as incompatible. The signer-switch gate is:

- every cloud sandbox created before the exact package pin and overlap ring
  took effect has been replaced/recreated; restart is acceptable only when
  launch-time evidence already proves that exact pin and ring were present;
- every local daemon seen during the agreed activity window (at least 24 hours,
  extended to cover known intermittent agents) reports the attested version and
  overlap ring; and
- every remaining old or unknown daemon is explicitly disabled, disconnected,
  or routed away from control frames, with an owner and recovery plan recorded.

Counts alone are not sufficient. Save the agent-level inventory before and
after migration, and require zero traffic-eligible incompatible/unknown entries
before switching the signer. If local daemons cannot be upgraded or isolated,
keep the old signer active; do not accept loss of control as a migration step.

The released daemon reports `hubControlTrustKeyFingerprints` in each
`runtime_snapshot`/`list_runtimes` result. Each value is
`sha256:<64 lowercase hex characters>` computed from one configured public-key
string; raw keys are never sent or stored. Apply
`backend/migrations/001_add_daemon_trust_key_fingerprints.sql` and deploy the
compatible Hub before collecting the gate inventory. Query
`GET /daemon/instances` (and explicitly refresh online instances first) and
compare each instance's `hub_control_trust_key_fingerprints` with fingerprints
computed offline from the approved old and new public keys. Require both exact
fingerprints, the attested daemon version, and a fresh `runtimes_probed_at` for
every traffic-eligible instance. Both the list and per-instance refresh
responses include `agent_bindings`, containing each bound `agent_id`, its
status, and `traffic_eligible`. That flag is true only for an active,
non-deleted agent. Export those bindings for the required before/after
agent-level inventory, and disable or isolate every incompatible binding that
is still eligible. A null/empty field, malformed fingerprint,
stale probe, or extra unapproved key is incompatible and must be upgraded or
isolated. Store only the fingerprints and comparison result in rollout records.

## Rotation procedure

Use this order for a compatible rotation:

1. Generate the new key through the approved secret-management path. Do not
   print or persist private key material in logs, manifests, or ConfigMaps.
2. Configure consumers with
   `BOTCORD_HUB_CONTROL_PUBLIC_KEYS=old,new`. Publish and attest the compatible
   packages as described above, pin cloud creation to the exact daemon version,
   and update the fleet.
3. Replace/recreate every E2B sandbox launched before the exact package pin and
   overlap ring took effect. An E2B sandbox retains its launch environment, so
   restart does not acquire either setting. Restart is sufficient only for a
   sandbox whose recorded launch-time evidence already proves both settings.
   Confirm the pinned artifact, overlap ring, and acceptance of both old- and
   new-signed test frames on the replacement fleet.
4. Enforce the zero-incompatible fleet gate above. Keep incompatible local
   agents disconnected from control delivery until upgraded and re-attested.
5. With production approval, inject the new private key into the Hub from a
   Kubernetes Secret and roll out the Hub. Record source SHA and resulting image
   digest, and monitor control acknowledgements and `bad_signature` errors.
6. During the rollback window, keep both public keys deployed. If errors rise,
   restore the old signer while the old key is still trusted, isolate newly
   incompatible agents, and verify acknowledgements recover. A backend rollback
   does not restore E2B launch-time environment; sandbox replacement is a
   separate rollback action.
7. After the rollback window and a fresh zero-incompatible inventory, remove
   the old public key, replace/restart E2B sandboxes again, and verify that only
   the new key remains trusted. Retire old private material through the approved
   secret-management process.

The Hub includes its currently active signing public key in the ring passed to
new E2B daemons. Additional future/previous keys are configured on the Hub via
`BOTCORD_HUB_CONTROL_PUBLIC_KEYS`. A per-runtime plural override extends that
provider ring: its keys are merged and deduplicated after the provider keys, so
it cannot remove the active signer. A legacy singular override is folded into
the same plural ring as an additional trusted key; the singular variable sent
to the runtime remains the provider's active signing public key for old daemon
releases.

This key ring adds multi-key verification, not key identifiers or dual
signatures. Rolling back the Hub signer still requires the corresponding old
public key to remain in every daemon's trust ring.
