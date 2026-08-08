# Bundled Meltano runtime

Release packaging copies the signed executable configured by `SPYDERBYTE_MELTANO_BIN` into this
directory and writes `runtime-manifest.json`. The executable and manifest are intentionally ignored
by Git because they are platform-specific release inputs.
