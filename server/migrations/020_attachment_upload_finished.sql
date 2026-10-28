-- Documents are recognised in the background right after upload and linked
-- to transactions once their whole upload is recognised. An upload is "done"
-- when the frontend has sent its last file (`finish_attachment_upload`);
-- uploads that existed before this migration are complete by definition.
ALTER TABLE attachment_uploads ADD COLUMN finished_at TEXT;
UPDATE attachment_uploads SET finished_at = uploaded_at;
