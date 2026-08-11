# Hub control signing-key rotation

Daemon control frames are signed by the Hub with Ed25519. Daemons accept a
comma- or newline-separated trust ring from
`BOTCORD_HUB_CONTROL_PUBLIC_KEYS`. `BOTCORD_HUB_CONTROL_PUBLIC_KEY` remains a
supported single-key fallback, and an embedded development public key is used
only when neither variable supplies a key. Never put a private key in either
public-key variable.

Use this order for a compatible rotation:

1. Generate the new key through the approved secret-management path. Do not
   print or persist private key material in logs, manifests, or ConfigMaps.
2. Set daemon consumers to `BOTCORD_HUB_CONTROL_PUBLIC_KEYS=old,new`, then
   release the compatible daemon and update the full local and cloud fleet.
3. Confirm both old- and new-signed test frames are accepted. Existing E2B
   sandboxes retain their launch environment, so inventory and restart or
   replace them before changing the signer.
4. Inject the new private key into the Hub from a Kubernetes Secret and roll
   out the Hub. Monitor control acknowledgements and `bad_signature` errors.
5. After the rollback window, remove the old public key from every consumer.

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
