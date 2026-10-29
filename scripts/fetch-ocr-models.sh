#!/usr/bin/env bash
# Download the PaddleOCR PP-OCRv5 ONNX models used for document recognition
# into a directory (default: ./ocr-models), verifying SHA-256. Used by the
# Dockerfile and for local dev runs (point FINANCES_OCR_MODELS at the dir).
# The matching character dictionaries are committed in server/ocr/.
set -euo pipefail

DEST="${1:-ocr-models}"
BASE="https://www.modelscope.cn/models/RapidAI/RapidOCR/resolve/v3.10.0/onnx/PP-OCRv5"
mkdir -p "$DEST"

# sha256sum on Linux, shasum on macOS (desktop CI build).
sha256_ok() {
  local file="$1" sha="$2"
  if command -v sha256sum > /dev/null; then
    echo "$sha  $file" | sha256sum -c --status - 2>/dev/null
  else
    echo "$sha  $file" | shasum -a 256 -c --status - 2>/dev/null
  fi
}

fetch() {
  local path="$1" sha="$2" file
  file="$DEST/$(basename "$path")"
  if [ -f "$file" ] && sha256_ok "$file" "$sha"; then
    return
  fi
  curl -fsSL --retry 3 -o "$file.part" "$BASE/$path"
  if ! sha256_ok "$file.part" "$sha"; then
    echo "[fetch-ocr-models] checksum mismatch for $path" >&2
    exit 1
  fi
  mv "$file.part" "$file"
}

# Text detection.
fetch det/ch_PP-OCRv5_det_mobile.onnx 4d97c44a20d30a81aad087d6a396b08f786c4635742afc391f6621f5c6ae78ae
# Recognition: Latin + digits (the "ch" model), Cyrillic (East Slavic), Thai.
fetch rec/ch_PP-OCRv5_rec_mobile.onnx 5825fc7ebf84ae7a412be049820b4d86d77620f204a041697b0494669b1742c5
fetch rec/eslav_PP-OCRv5_rec_mobile.onnx 08705d6721849b1347d26187f15a5e362c431963a2a62bfff4feac578c489aab
fetch rec/th_PP-OCRv5_rec_mobile.onnx de541dd83161c241ff426f7ecfd602a0ba77d686cf3ab9a6c255ea82fd08006e

echo "[fetch-ocr-models] models in $DEST"
