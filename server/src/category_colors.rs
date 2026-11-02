//! Automatic subcategory colours. The user picks a colour for a top-level
//! category only; a subcategory with `color_auto = 1` takes a shade of its
//! parent — same family, a little lighter, the hue nudged per sibling so
//! siblings stay distinguishable. A colour set by hand (`color_auto = 0`) is
//! kept, and its own auto children follow it. `recolor` recomputes the whole
//! forest; it runs after every change to the tree and at startup.
//! The same formula lives in `src/lib/colors.ts` (`autoChildColor`) for the
//! preview in the category dialog.

use std::collections::HashMap;

use rusqlite::{params, Connection};

/// Hue offsets for the 1st, 2nd, … sibling (cycled).
const HUE_STEPS: [i32; 7] = [0, 12, -12, 24, -24, 36, -36];

fn clamp(v: f64, lo: f64, hi: f64) -> f64 {
    v.max(lo).min(hi)
}

/// `#rrggbb` → (h 0..360, s 0..100, l 0..100), rounded like the TS helper.
fn hex_to_hsl(hex: &str) -> Option<(i32, i32, i32)> {
    let m = hex.trim().trim_start_matches('#');
    if m.len() < 6 {
        return None;
    }
    let channel = |i: usize| u8::from_str_radix(m.get(i..i + 2)?, 16).ok().map(|v| v as f64 / 255.0);
    let (r, g, b) = (channel(0)?, channel(2)?, channel(4)?);
    let max = r.max(g).max(b);
    let min = r.min(g).min(b);
    let delta = max - min;
    let l = (max + min) / 2.0;
    let (mut h, mut s) = (0.0, 0.0);
    if delta != 0.0 {
        s = if l > 0.5 { delta / (2.0 - max - min) } else { delta / (max + min) };
        h = if max == r {
            ((g - b) / delta + if g < b { 6.0 } else { 0.0 }) * 60.0
        } else if max == g {
            ((b - r) / delta + 2.0) * 60.0
        } else {
            ((r - g) / delta + 4.0) * 60.0
        };
    }
    Some((h.round() as i32, (s * 100.0).round() as i32, (l * 100.0).round() as i32))
}

fn hsl_to_hex(h: i32, s: f64, l: f64) -> String {
    let s = clamp(s, 0.0, 100.0) / 100.0;
    let l = clamp(l, 0.0, 100.0) / 100.0;
    let c = (1.0 - (2.0 * l - 1.0).abs()) * s;
    let hh = (((h % 360) + 360) % 360) as f64 / 60.0;
    let x = c * (1.0 - ((hh % 2.0) - 1.0).abs());
    let (r, g, b) = match hh {
        v if v < 1.0 => (c, x, 0.0),
        v if v < 2.0 => (x, c, 0.0),
        v if v < 3.0 => (0.0, c, x),
        v if v < 4.0 => (0.0, x, c),
        v if v < 5.0 => (x, 0.0, c),
        _ => (c, 0.0, x),
    };
    let m = l - c / 2.0;
    let to = |v: f64| ((v + m) * 255.0).round() as u8;
    format!("#{:02x}{:02x}{:02x}", to(r), to(g), to(b))
}

/// Colour of the `index`-th child (siblings ordered by id) of `parent`.
pub(crate) fn auto_child_color(parent: &str, index: usize) -> String {
    let Some((h, s, l)) = hex_to_hsl(parent) else { return parent.to_string() };
    let hue = h + HUE_STEPS[index % HUE_STEPS.len()];
    // Past the hue steps, alternate the lightness so siblings still differ.
    let round = (index / HUE_STEPS.len()) % 2;
    let light = clamp(l as f64 + 8.0 - 6.0 * round as f64, 25.0, 88.0);
    let sat = clamp(s as f64 - 5.0, 25.0, 85.0);
    hsl_to_hex(hue, sat, light)
}

/// Recompute the colour of every automatic subcategory, top-down.
pub(crate) fn recolor(conn: &Connection) -> rusqlite::Result<()> {
    let rows: Vec<(i64, Option<i64>, String, bool)> = {
        let mut stmt = conn.prepare("SELECT id, parent_id, color, color_auto FROM categories ORDER BY id")?;
        let rows = stmt.query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)))?;
        rows.collect::<rusqlite::Result<_>>()?
    };
    let mut children: HashMap<Option<i64>, Vec<(i64, String, bool)>> = HashMap::new();
    for (id, parent, color, auto) in rows {
        children.entry(parent).or_default().push((id, color, auto));
    }
    let mut queue: Vec<(i64, String)> =
        children.get(&None).into_iter().flatten().map(|(id, color, _)| (*id, color.clone())).collect();
    // Bounded by the row count: a corrupted cycle is never reached from a root.
    while let Some((parent, parent_color)) = queue.pop() {
        for (index, (id, color, auto)) in children.get(&Some(parent)).into_iter().flatten().enumerate() {
            let effective = if *auto {
                let derived = auto_child_color(&parent_color, index);
                if derived != *color {
                    conn.execute("UPDATE categories SET color = ?1 WHERE id = ?2", params![derived, id])?;
                }
                derived
            } else {
                color.clone()
            };
            queue.push((*id, effective));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn conversions_round_trip_and_siblings_differ() {
        assert_eq!(hex_to_hsl("#e05757"), Some((0, 69, 61)));
        let first = auto_child_color("#e05757", 0);
        let second = auto_child_color("#e05757", 1);
        let eighth = auto_child_color("#e05757", 7);
        assert_ne!(first, second);
        assert_ne!(first, eighth);
        // Lighter than the parent, same family.
        let (h, _, l) = hex_to_hsl(&first).unwrap();
        assert!(h <= 2 || h >= 358);
        assert!(l > 61);
    }
}
