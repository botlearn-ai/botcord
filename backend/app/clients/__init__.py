"""HTTP clients the Hub uses to call sibling services.

Currently exposes the cloud gateway ingress client (Phase 2 of the cloud
gateway ingress remediation plan). Each module here owns one outbound
contract and is the only place that knows that contract's URL shape, auth,
and error vocabulary — route handlers stay free of HTTP plumbing.
"""
