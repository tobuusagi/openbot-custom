Add a separate Feitu client package identity and native ARM64 target configuration for macOS and
Windows. The package has a dedicated main entry and a verifier for its architecture and resource
boundary. The runtime remains an explicit fail-closed scaffold: it has no account transport,
renderer, device capabilities, or update feed, and is not ready for distribution.

The package verifier rejects ASAR links and unsafe member paths while preserving standard integrity
metadata. It also checks the macOS resource allowlist and follows only links that resolve inside the
application bundle when it scans native files.
