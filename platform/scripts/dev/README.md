# Development scripts

Local development composition and helper scripts belong here.

`create-development-license.mjs` creates a real Ed25519-signed Spyderbyte development
entitlement, its public verification key, and a private signing key. Keep the private key outside
the repository; production signing keys must never be derived from this fixture.
