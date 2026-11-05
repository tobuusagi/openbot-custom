# Plan 011 Noise library spike

This is a private, isolated feasibility package. It tests the public
`@chainsafe/libp2p-noise@17.0.0` XX API with generated identities. It does not use product keys,
account grants, OAuth, user data, a gateway, or application SDKs. The memory transport is test
scaffolding. The browser run uses a local browser bundle.

The package source and exact dependency pins are tracked here. It is outside the root
`scripts/**/*.ts` TypeScript project. Its runner writes results to the ignored
`.openbot-build/011-noise-spike/evidence/` directory.

## Reproduce

Use Node.js 24, Bun 1.4.2, and Chromium. From this directory, install only this package's frozen
lockfile, then run the runtimes in order:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run typecheck
npm run evidence:start
npm run spike:node
npm run spike:bun
npm run bundle:browser
npm run spike:chromium
npm run evidence
```

Keep the existing proxy and TLS settings for registry access. The lockfile pins every dependency
and records its archive integrity. The install does not change the root `package.json`, root lock,
or Bun catalog.

`npm run bundle:browser` writes ignored `browser-bundle.js` and `browser-bundle.json` files here.
The metadata binds the bundle SHA-256 to the active run, source, and lockfile. Chromium checks this
metadata and the bundle bytes before launch, then runs with `chromiumSandbox: true`. If the default
tool sandbox blocks Chromium startup, run only `npm run spike:chromium` with a narrow execution
escalation. Do not pass `--no-sandbox` or add production routes, credentials, or services.

Each reproduction starts a new evidence run after install. The runners save their reports under
that run ID and record source and lockfile SHA-256 digests, current dependency pins, timestamps,
runtime versions, the Noise archive integrity, package license metadata, and untested platform gaps.
The combiner accepts only complete reports from the active run whose fingerprints and pins match
the current package. It also checks that Chromium used the bundle whose SHA-256 is recorded for
that run. It rejects missing, stale, mixed, blocked, or failed reports and writes the combined
`report.json` at the evidence root and inside the run directory. Keys are generated in memory,
never printed or written.

## Limits

This harness checks a local library boundary only. It does not test a WebSocket or WSS transport,
framing, fragmentation, routing, reconnect, relay behavior, product grants, persistent identity,
pairing, key rotation, authorization leases, product frames, application receipts, or OS operations.
A pass does not approve product WSS or key management.

Only Linux x64 Node, Bun, and Chromium are exercised here. Physical Electron macOS ARM64, Electron
Windows ARM64, and Android WebView remain untested. This package does not claim portability to those
targets or release readiness.
