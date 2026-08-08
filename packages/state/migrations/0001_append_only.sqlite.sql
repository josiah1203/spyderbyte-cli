-- SQLite dialect guard for the shared authoritative schema.
DROP TRIGGER IF EXISTS artifact_versions_append_only_update;
CREATE TRIGGER artifact_versions_append_only_update
BEFORE UPDATE ON artifact_versions
BEGIN
  SELECT RAISE(ABORT, 'artifact_versions are append-only after publication');
END;

DROP TRIGGER IF EXISTS artifact_versions_append_only_delete;
CREATE TRIGGER artifact_versions_append_only_delete
BEFORE DELETE ON artifact_versions
BEGIN
  SELECT RAISE(ABORT, 'artifact_versions are append-only after publication');
END;
