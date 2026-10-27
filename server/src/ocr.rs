//! Local text recognition for stored documents — nothing leaves the machine.
//!
//! The image is converted to greyscale and upscaled before OCR: that
//! neutralises textured / holiday slip backgrounds (hard thresholding was
//! tried on real slips and damages thin memo glyphs). ×1.5 reads most slips;
//! the caller retries at ×2 when the big bold amount was missed — on real
//! K PLUS slips that recovered every such case. Text comes from the
//! `tesseract` CLI (installed in the Docker image; `FINANCES_TESSERACT`
//! overrides the binary, `FINANCES_OCR_LANGS` the languages, default
//! `eng+rus+tha`), fed through stdin so no temp files are written. QR codes
//! are decoded in-process with `rqrr`.

use std::io::{Cursor, Write};
use std::process::{Command, Stdio};

use image::imageops::FilterType;
use image::{GrayImage, ImageFormat};

const DEFAULT_LANGS: &str = "eng+rus+tha";

pub struct Recognised {
    pub text: String,
    /// Raw payload of the first QR code found, if any.
    pub qr: Option<String>,
}

/// `scale_pct` — upscale factor in percent (150 = ×1.5).
pub fn recognise(bytes: &[u8], mime: &str, scale_pct: u32) -> Result<Recognised, String> {
    if !mime.starts_with("image/") {
        return Err("ocr.unsupported_type".into());
    }
    let gray = image::load_from_memory(bytes)
        .map_err(|e| format!("ocr.bad_image: {e}"))?
        .to_luma8();
    let qr = decode_qr(&gray);
    let (w, h) = gray.dimensions();
    let upscaled = image::imageops::resize(
        &gray,
        w * scale_pct / 100,
        h * scale_pct / 100,
        FilterType::Triangle,
    );
    let mut png = Vec::new();
    upscaled
        .write_to(&mut Cursor::new(&mut png), ImageFormat::Png)
        .map_err(|e| format!("ocr.encode: {e}"))?;
    let text = run_tesseract(&png)?;
    Ok(Recognised { text, qr })
}

fn decode_qr(gray: &GrayImage) -> Option<String> {
    let mut prepared = rqrr::PreparedImage::prepare_from_greyscale(
        gray.width() as usize,
        gray.height() as usize,
        |x, y| gray.get_pixel(x as u32, y as u32)[0],
    );
    prepared
        .detect_grids()
        .into_iter()
        .find_map(|grid| grid.decode().ok().map(|(_, content)| content))
}

fn run_tesseract(png: &[u8]) -> Result<String, String> {
    let binary = std::env::var("FINANCES_TESSERACT").unwrap_or_else(|_| "tesseract".into());
    let langs = std::env::var("FINANCES_OCR_LANGS").unwrap_or_else(|_| DEFAULT_LANGS.into());
    let mut child = Command::new(&binary)
        .args(["stdin", "stdout", "-l", &langs, "--psm", "4"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("ocr.unavailable: {binary}: {e}"))?;
    child
        .stdin
        .take()
        .expect("piped stdin")
        .write_all(png)
        .map_err(|e| format!("ocr.failed: {e}"))?;
    let out = child.wait_with_output().map_err(|e| format!("ocr.failed: {e}"))?;
    if !out.status.success() {
        return Err(format!(
            "ocr.failed: {}",
            String::from_utf8_lossy(&out.stderr).trim()
        ));
    }
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

/// Thai slip-verification QR (Bank of Thailand "mini QR"): TLV where tag 00
/// holds `{00: "000001", 01: <sending bank code>, 02: <transaction ref>}` and
/// tag 51 is the country. Returns `(bank code, reference)`.
pub fn parse_slip_verify_qr(payload: &str) -> Option<(String, String)> {
    fn tlv(s: &str) -> Vec<(&str, &str)> {
        let mut out = Vec::new();
        let mut i = 0;
        while i + 4 <= s.len() {
            let tag = &s[i..i + 2];
            let Ok(len) = s[i + 2..i + 4].parse::<usize>() else { break };
            if i + 4 + len > s.len() {
                break;
            }
            out.push((tag, &s[i + 4..i + 4 + len]));
            i += 4 + len;
        }
        out
    }
    let payload = payload.lines().next()?.trim();
    if !payload.is_ascii() {
        return None;
    }
    let top = tlv(payload);
    let inner = tlv(top.iter().find(|(t, _)| *t == "00")?.1);
    let get = |tag| inner.iter().find(|(t, _)| *t == tag).map(|(_, v)| v.to_string());
    if get("00")? != "000001" {
        return None;
    }
    Some((get("01")?, get("02")?))
}

/// Bank of Thailand bank codes → display names (sending bank on slip QRs).
pub fn thai_bank_name(code: &str) -> Option<&'static str> {
    Some(match code {
        "002" => "Bangkok Bank",
        "004" => "Kasikorn Bank",
        "006" => "Krungthai Bank",
        "011" => "TMBThanachart (ttb)",
        "014" => "Siam Commercial Bank",
        "022" => "CIMB Thai",
        "024" => "UOB Thailand",
        "025" => "Krungsri",
        "030" => "Government Savings Bank",
        "033" => "GH Bank",
        "034" => "BAAC",
        "069" => "Kiatnakin Phatra",
        "073" => "LH Bank",
        _ => return None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn slip_verify_qr_payload() {
        // From a real K PLUS slip.
        let qr = "0041000600000101030040220016299114702DPM055345102TH9104E58C";
        assert_eq!(
            parse_slip_verify_qr(qr),
            Some(("004".to_string(), "016299114702DPM05534".to_string()))
        );
        assert_eq!(thai_bank_name("004"), Some("Kasikorn Bank"));
        // A PromptPay "pay me" QR is not a slip.
        assert_eq!(parse_slip_verify_qr("00020101021129370016A000000677010111"), None);
    }

    #[test]
    fn non_images_are_rejected() {
        assert!(recognise(b"%PDF-1.4", "application/pdf", 150).is_err());
    }
}
