# Spyderbyte license

This package validates the Spyderbyte `SignedEntitlementV1` payload. Entitlements are signed
with Ed25519 over canonical JSON and are checked at startup/status reads and before licensed,
effectful commands. The package never exposes a private key or the raw signature through
`LicenseStatus`.

Production composition supplies public keys and an entitlement file through the desktop host or
local daemon. Offline validation is intentionally time-bounded by `expiresAt`; an online refresh or
revocation service is a later hosted capability.
