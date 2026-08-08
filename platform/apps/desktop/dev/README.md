# Spyderbyte development license

These files are for the unsigned x86 developer build only. The public verification key is
embedded into developer builds; import `development-entitlement.json` through the app’s License
panel. It expires on 2027-08-04 and is not a production entitlement.

The matching private signing key is intentionally not stored in the repository. Generate a new
development set with:

```sh
pnpm dev:license
```

The generator writes the private key to the user application-support directory with mode `0600`.
Never use this development key for a production release.
