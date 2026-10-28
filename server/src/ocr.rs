//! Local text recognition for stored documents — nothing leaves the machine.
//!
//! PaddleOCR PP-OCRv5 models on ONNX Runtime (via `oar-ocr`), chosen over
//! Tesseract after a side-by-side test on the user's slips (notes found on
//! 59/60 vs 34/60; Tesseract kept losing light-grey labels such as "Note").
//!
//! Pipeline per image:
//! 1. text detection once → fragment boxes;
//! 2. the Latin+digits ("ch") and the Cyrillic (East Slavic) recognisers read
//!    every fragment — the Latin one is sometimes *confidently* wrong on
//!    Russian ("Usdt Ha 3apnnaty"), so Cyrillic cannot be gated on its score;
//! 3. the Thai recogniser reads only fragments the Latin one is unsure about
//!    (< [`GATE`]); the result is chosen by script: real Cyrillic letters →
//!    Cyrillic model, except "amount + currency code" lines (codes are Latin;
//!    the Cyrillic model reads "THB" as "тHB"), then Thai letters → Thai
//!    model, otherwise Latin;
//! 4. junk fragments (icons, logos) below [`MIN_SCORE`] are dropped;
//! 5. fragments are laid out as text: grouped into lines by vertical overlap,
//!    left to right, with a wide horizontal gap marked as `" | "` (a column
//!    break, e.g. between a label and its value).
//!
//! Models live in `FINANCES_OCR_MODELS` (default `/app/ocr-models` in the
//! image; `scripts/fetch-ocr-models.sh` downloads them); the character
//! dictionaries are in `FINANCES_OCR_DICTS` (default: `server/ocr/` in a
//! checkout, `/app/ocr-dicts` in the image). They load once, on first use.
//! QR codes are decoded in-process with `rqrr`.

use std::path::PathBuf;
use std::sync::OnceLock;

use image::{GrayImage, RgbImage};
use oar_ocr::predictors::{TextDetectionPredictor, TextRecognitionPredictor};

/// Below this Latin-recogniser score a fragment is also read by the Cyrillic
/// and Thai recognisers.
const GATE: f32 = 0.95;
/// Fragments whose best score is below this are dropped as junk.
const MIN_SCORE: f32 = 0.5;

pub struct Recognised {
    /// Layout-aware text (lines; `" | "` marks a column gap).
    pub text: String,
    /// Raw payload of the first QR code found, if any.
    pub qr: Option<String>,
}

/// One recognised text fragment in image coordinates.
#[derive(Debug, Clone, PartialEq)]
pub struct Fragment {
    pub x0: f32,
    pub y0: f32,
    pub x1: f32,
    pub y1: f32,
    pub text: String,
}

struct Engine {
    det: TextDetectionPredictor,
    latin: TextRecognitionPredictor,
    cyrillic: TextRecognitionPredictor,
    thai: TextRecognitionPredictor,
}

fn env_dir(var: &str, defaults: &[&str]) -> PathBuf {
    if let Ok(v) = std::env::var(var) {
        return PathBuf::from(v);
    }
    defaults
        .iter()
        .map(PathBuf::from)
        .find(|p| p.is_dir())
        .unwrap_or_else(|| PathBuf::from(defaults[0]))
}

fn load_engine() -> Result<Engine, String> {
    let models = env_dir("FINANCES_OCR_MODELS", &["/app/ocr-models", "ocr-models", "../ocr-models"]);
    let dicts = env_dir("FINANCES_OCR_DICTS", &["/app/ocr-dicts", "ocr", "server/ocr"]);
    let model = |name: &str| {
        let p = models.join(name);
        if p.is_file() {
            Ok(p)
        } else {
            Err(format!("ocr.unavailable: model {} not found", p.display()))
        }
    };
    let rec = |model_name: &str, dict: &str| -> Result<TextRecognitionPredictor, String> {
        TextRecognitionPredictor::builder()
            .score_threshold(0.0)
            .dict_path(dicts.join(dict))
            .build(model(model_name)?.as_path())
            .map_err(|e| format!("ocr.unavailable: {model_name}: {e}"))
    };
    Ok(Engine {
        det: TextDetectionPredictor::builder()
            .build(model("ch_PP-OCRv5_det_mobile.onnx")?.as_path())
            .map_err(|e| format!("ocr.unavailable: detection model: {e}"))?,
        latin: rec("ch_PP-OCRv5_rec_mobile.onnx", "ppocrv5_ch_dict.txt")?,
        cyrillic: rec("eslav_PP-OCRv5_rec_mobile.onnx", "ppocrv5_eslav_dict.txt")?,
        thai: rec("th_PP-OCRv5_rec_mobile.onnx", "ppocrv5_th_dict.txt")?,
    })
}

fn engine() -> Result<&'static Engine, String> {
    static ENGINE: OnceLock<Result<Engine, String>> = OnceLock::new();
    ENGINE.get_or_init(load_engine).as_ref().map_err(Clone::clone)
}

/// QR payload of an image document (used by both recognisers).
pub fn qr_from_image(bytes: &[u8]) -> Option<String> {
    image::load_from_memory(bytes).ok().and_then(|img| decode_qr(&img.to_luma8()))
}

pub fn recognise(bytes: &[u8], mime: &str) -> Result<Recognised, String> {
    if !mime.starts_with("image/") {
        return Err("ocr.unsupported_type".into());
    }
    let img = image::load_from_memory(bytes).map_err(|e| format!("ocr.bad_image: {e}"))?;
    let qr = decode_qr(&img.to_luma8());
    let fragments = read_fragments(engine()?, img.to_rgb8())?;
    Ok(Recognised { text: layout_text(&fragments), qr })
}

fn read_fragments(engine: &Engine, img: RgbImage) -> Result<Vec<Fragment>, String> {
    let (w, h) = img.dimensions();
    let detections = engine
        .det
        .predict(vec![img.clone()])
        .map_err(|e| format!("ocr.failed: detection: {e}"))?
        .detections
        .into_iter()
        .next()
        .unwrap_or_default();

    // Axis-aligned crops: slips are screenshots, text is never rotated.
    let mut boxes = Vec::new();
    let mut crops = Vec::new();
    for d in &detections {
        let xs = d.bbox.points.iter().map(|p| p.x);
        let ys = d.bbox.points.iter().map(|p| p.y);
        let x0 = xs.clone().fold(f32::INFINITY, f32::min).max(0.0);
        let x1 = xs.fold(f32::NEG_INFINITY, f32::max).min(w as f32);
        let y0 = ys.clone().fold(f32::INFINITY, f32::min).max(0.0);
        let y1 = ys.fold(f32::NEG_INFINITY, f32::max).min(h as f32);
        if x1 - x0 < 2.0 || y1 - y0 < 2.0 {
            continue;
        }
        let crop = image::imageops::crop_imm(&img, x0 as u32, y0 as u32, (x1 - x0) as u32, (y1 - y0) as u32);
        crops.push(crop.to_image());
        boxes.push((x0, y0, x1, y1));
    }
    if crops.is_empty() {
        return Ok(Vec::new());
    }

    let latin = engine
        .latin
        .predict(crops.clone())
        .map_err(|e| format!("ocr.failed: recognition: {e}"))?;
    let cyr = engine
        .cyrillic
        .predict(crops.clone())
        .map_err(|e| format!("ocr.failed: recognition: {e}"))?;
    let unsure: Vec<usize> = (0..crops.len())
        .filter(|&i| latin.scores[i] < GATE && !has_real_cyrillic(&cyr.texts[i]))
        .collect();
    let thai = if unsure.is_empty() {
        None
    } else {
        let subset: Vec<RgbImage> = unsure.iter().map(|&i| crops[i].clone()).collect();
        Some(engine.thai.predict(subset).map_err(|e| format!("ocr.failed: {e}"))?)
    };

    let mut fragments = Vec::new();
    for (i, &(x0, y0, x1, y1)) in boxes.iter().enumerate() {
        let mut text = latin.texts[i].clone();
        let mut best = latin.scores[i].max(cyr.scores[i]);
        if has_real_cyrillic(&cyr.texts[i]) && !is_amount_with_code(&latin.texts[i]) {
            text = cyr.texts[i].clone();
        } else if let (Some(thai), Some(k)) = (&thai, unsure.iter().position(|&u| u == i)) {
            best = best.max(thai.scores[k]);
            if has_thai(&thai.texts[k]) {
                text = thai.texts[k].clone();
            }
        }
        if best >= MIN_SCORE && !text.trim().is_empty() {
            fragments.push(Fragment { x0, y0, x1, y1, text: text.trim().to_string() });
        }
    }
    Ok(fragments)
}

/// "15,000.00 THB", "240,000.00THB" — an amount followed by a three-letter
/// currency code (ISO 4217 codes are always Latin).
fn is_amount_with_code(text: &str) -> bool {
    static RE: OnceLock<regex::Regex> = OnceLock::new();
    RE.get_or_init(|| regex::Regex::new(r"^\s*[\d][\d.,\s]*\s*[A-Za-z]{3}\s*$").expect("valid regex"))
        .is_match(text)
}

/// Cyrillic letters that have no Latin look-alike — real Russian text rather
/// than Latin read by the Cyrillic model ("НЕАТ" for "HEAT"). Lowercase
/// "т" counts as real, so "тHB" would pass — such amount lines are kept on
/// the Latin model by the [`GATE`] instead.
fn has_real_cyrillic(text: &str) -> bool {
    const LOOKALIKES: &str = "АВЕКМНОРСТХаеорсухк";
    text.chars()
        .any(|c| matches!(c, 'А'..='я' | 'Ё' | 'ё') && !LOOKALIKES.contains(c))
}

fn has_thai(text: &str) -> bool {
    text.chars().any(|c| ('\u{0E00}'..='\u{0E7F}').contains(&c))
}

/// Lay fragments out as text: lines by vertical overlap, left to right, a
/// gap wider than ~1.6 line heights marked as `" | "`.
pub fn layout_text(fragments: &[Fragment]) -> String {
    let mut sorted: Vec<&Fragment> = fragments.iter().collect();
    sorted.sort_by(|a, b| ((a.y0 + a.y1) / 2.0).total_cmp(&((b.y0 + b.y1) / 2.0)));
    let mut lines: Vec<Vec<&Fragment>> = Vec::new();
    for f in sorted {
        // Same line when the fragment overlaps the line's band by at least
        // half of the smaller height — loose enough for baseline jitter,
        // strict enough not to merge adjacent lines.
        let line = lines.iter_mut().find(|line| {
            let top = line.iter().map(|g| g.y0).fold(f32::INFINITY, f32::min);
            let bottom = line.iter().map(|g| g.y1).fold(f32::NEG_INFINITY, f32::max);
            let overlap = f.y1.min(bottom) - f.y0.max(top);
            overlap >= 0.5 * (f.y1 - f.y0).min(bottom - top)
        });
        match line {
            Some(line) => line.push(f),
            None => lines.push(vec![f]),
        }
    }
    lines.sort_by(|a, b| {
        let ta = a.iter().map(|g| g.y0).fold(f32::INFINITY, f32::min);
        let tb = b.iter().map(|g| g.y0).fold(f32::INFINITY, f32::min);
        ta.total_cmp(&tb)
    });
    let mut out = Vec::new();
    for mut line in lines {
        line.sort_by(|a, b| a.x0.total_cmp(&b.x0));
        let mut heights: Vec<f32> = line.iter().map(|g| g.y1 - g.y0).collect();
        heights.sort_by(f32::total_cmp);
        let height = heights[heights.len() / 2];
        let mut text = line[0].text.clone();
        for pair in line.windows(2) {
            let gap = pair[1].x0 - pair[0].x1;
            text.push_str(if gap > 1.6 * height { " | " } else { " " });
            text.push_str(&pair[1].text);
        }
        out.push(text);
    }
    out.join("\n")
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
        assert!(recognise(b"%PDF-1.4", "application/pdf").is_err());
    }

    fn frag(x0: f32, y0: f32, x1: f32, y1: f32, text: &str) -> Fragment {
        Fragment { x0, y0, x1, y1, text: text.to_string() }
    }

    #[test]
    fn layout_groups_lines_and_marks_column_gaps() {
        // A Bangkok Bank-like block: label column on the left, values on the
        // right; one fragment split by a small gap stays on one line.
        let text = layout_text(&[
            frag(300.0, 100.0, 520.0, 130.0, "0.00 THB"),
            frag(80.0, 102.0, 140.0, 128.0, "Fee"),
            frag(80.0, 160.0, 150.0, 186.0, "Note"),
            frag(300.0, 158.0, 470.0, 188.0, "Страховка для"),
            frag(478.0, 158.0, 560.0, 188.0, "Натальи"),
            frag(80.0, 230.0, 380.0, 256.0, "Bank reference no."),
            // Tall boxes of adjacent lines touching slightly stay separate.
            frag(80.0, 250.0, 200.0, 280.0, "391380"),
        ]);
        assert_eq!(
            text,
            "Fee | 0.00 THB\nNote | Страховка для Натальи\nBank reference no.\n391380"
        );
    }

    #[test]
    fn script_choice() {
        assert!(has_real_cyrillic("латте Насте"));
        assert!(!has_real_cyrillic("НЕАТ СОСО"), "only look-alikes: Latin read as Cyrillic");
        assert!(!has_real_cyrillic("THB 0.00"));
        assert!(is_amount_with_code("15,000.00 THB"));
        assert!(is_amount_with_code("240,000.00THB"));
        assert!(!is_amount_with_code("Usdt Ha 3apnnaty"));
        assert!(has_thai("ร้านถุงเงิน"));
        assert!(!has_thai("SCB SHOP"));
    }
}
