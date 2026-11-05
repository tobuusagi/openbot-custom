# Self-hosted account HTTP

Add the five desktop bearer account routes to the local SQLite gateway. Readiness stays unavailable
until the explicit schema, ES256 ticket keys, and SMTP delivery are ready. The loopback development
code mode supports local sign-in checks without SMTP. Self-hosted SMTP uses verified implicit TLS
without the Worker relay. Logout uses the shared session revocation operation so its trigger ends
matching remote sessions and writes the durable event outbox.
