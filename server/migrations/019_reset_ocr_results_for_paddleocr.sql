-- Recognition switched from Tesseract to PaddleOCR (much better on the
-- user's slips). Drop the old OCR results so documents are recognised again:
-- keep only the time taken from the file name, clear the OCR text and set
-- the status back to 'pending'. Links to transactions are kept.
UPDATE attachments
SET extraction = CASE
        WHEN json_extract(extraction, '$.occurredAt.source') = 'filename'
        THEN json_object('occurredAt', json_extract(extraction, '$.occurredAt'))
        ELSE NULL
    END,
    ocr_text = NULL,
    extract_status = 'pending'
WHERE extract_status <> 'pending' OR ocr_text IS NOT NULL;
