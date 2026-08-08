-- PostgreSQL dialect guard for the shared authoritative schema.
CREATE OR REPLACE FUNCTION reject_artifact_version_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'artifact_versions are append-only after publication';
END;
$$;

DROP TRIGGER IF EXISTS artifact_versions_append_only_update ON artifact_versions;
CREATE TRIGGER artifact_versions_append_only_update
BEFORE UPDATE OR DELETE ON artifact_versions
FOR EACH ROW
EXECUTE FUNCTION reject_artifact_version_mutation();
