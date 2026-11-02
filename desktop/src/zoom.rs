//! Page zoom of the whole app window, behaving like Chrome's: the same keys,
//! steps and View menu items, on the native webview zoom, because the webview
//! has no zoom hotkeys of its own. The chosen level survives a restart.

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use tauri::ipc::CapabilityBuilder;
use tauri::menu::{MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager, WebviewWindow};

/// Chrome's steps.
const LEVELS: [f64; 17] = [
    0.25, 0.33, 0.5, 0.67, 0.75, 0.8, 0.9, 1.0, 1.1, 1.25, 1.5, 1.75, 2.0, 2.5, 3.0, 4.0, 5.0,
];
const ACTUAL_SIZE: f64 = 1.0;
/// Chosen level, in the data dir.
const ZOOM_FILE: &str = "desktop-zoom";

const MENU_IN: &str = "zoom.in";
const MENU_OUT: &str = "zoom.out";
const MENU_ACTUAL: &str = "zoom.actual";

/// Runs in the page. A menu item has one key equivalent, and a browser also
/// takes ⌘=, ⌘⇧− and the keypad, so the page catches them all before the menu
/// does; `preventDefault` keeps the menu from acting on the same press. The
/// modifier follows the platform: Ctrl doesn't zoom on a Mac, ⌘ only there.
pub const HOTKEYS_SCRIPT: &str = r#"
window.addEventListener("keydown", (e) => {
  const mac = /Mac/.test(navigator.platform);
  if (!(mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey) || e.altKey) return;
  const action = {
    Equal: "in",
    NumpadAdd: "in",
    Minus: "out",
    NumpadSubtract: "out",
    Digit0: e.shiftKey ? null : "actual",
    Numpad0: e.shiftKey ? null : "actual",
  }[e.code];
  if (!action) return;
  e.preventDefault();
  window.__TAURI_INTERNALS__.invoke("zoom_hotkey", { action });
}, true);
"#;

struct ZoomState {
    path: PathBuf,
    level: Mutex<f64>,
}

fn next_level(current: f64) -> f64 {
    LEVELS
        .into_iter()
        .find(|&l| l > current + 0.001)
        .unwrap_or(LEVELS[LEVELS.len() - 1])
}

fn previous_level(current: f64) -> f64 {
    LEVELS
        .into_iter()
        .rev()
        .find(|&l| l < current - 0.001)
        .unwrap_or(LEVELS[0])
}

fn parse_level(raw: &str) -> f64 {
    raw.trim()
        .parse::<f64>()
        .ok()
        .filter(|l| (LEVELS[0]..=LEVELS[LEVELS.len() - 1]).contains(l))
        .unwrap_or(ACTUAL_SIZE)
}

pub fn install(app: &AppHandle, data_dir: &Path) -> tauri::Result<()> {
    let ru = sys_locale::get_locale().is_some_and(|l| l.starts_with("ru"));
    let (zoom_in, zoom_out, actual, view) = if ru {
        ("Увеличить", "Уменьшить", "Реальный размер", "Вид")
    } else {
        ("Zoom In", "Zoom Out", "Actual Size", "View")
    };

    // "NumPlus" is how the menu library spells the "+" key equivalent (⌘+).
    let in_plus = MenuItem::with_id(app, MENU_IN, zoom_in, true, Some("CmdOrCtrl+NumPlus"))?;
    let out = MenuItem::with_id(app, MENU_OUT, zoom_out, true, Some("CmdOrCtrl+Minus"))?;
    let actual = MenuItem::with_id(app, MENU_ACTUAL, actual, true, Some("CmdOrCtrl+0"))?;

    // The app menu is set up by `updater::install`, which runs first. Only the
    // macOS default menu has a View submenu.
    if let Some(menu) = app.menu() {
        let view_menu = menu
            .items()?
            .iter()
            .filter_map(|item| item.as_submenu().cloned())
            .find(|submenu| submenu.text().is_ok_and(|t| t == "View"));
        match view_menu {
            Some(submenu) => submenu.insert_items(
                &[
                    &actual,
                    &in_plus,
                    &out,
                    &PredefinedMenuItem::separator(app)?,
                ],
                0,
            )?,
            None => menu.append(&Submenu::with_items(
                app,
                view,
                true,
                &[&actual, &in_plus, &out],
            )?)?,
        }
    }

    // Tauri rejects commands from pages it didn't serve itself unless allowed:
    // this one command, for the app's own address only.
    app.add_capability(
        CapabilityBuilder::new("zoom-hotkeys")
            .remote(format!("http://127.0.0.1:{}/*", crate::PORT))
            .window(crate::MAIN_WINDOW)
            .permission("allow-zoom-hotkey"),
    )?;

    let path = data_dir.join(ZOOM_FILE);
    let level = fs::read_to_string(&path)
        .map(|raw| parse_level(&raw))
        .unwrap_or(ACTUAL_SIZE);
    app.manage(ZoomState {
        path,
        level: Mutex::new(level),
    });
    app.on_menu_event(|app, event| match event.id().as_ref() {
        MENU_IN => change(app, next_level),
        MENU_OUT => change(app, previous_level),
        MENU_ACTUAL => change(app, |_| ACTUAL_SIZE),
        _ => {}
    });
    Ok(())
}

#[tauri::command]
pub fn zoom_hotkey(app: AppHandle, action: &str) {
    match action {
        "in" => change(&app, next_level),
        "out" => change(&app, previous_level),
        "actual" => change(&app, |_| ACTUAL_SIZE),
        _ => {}
    }
}

/// Applies the saved level to a newly opened window.
pub fn restore(window: &WebviewWindow) {
    let level = *window.state::<ZoomState>().level.lock().unwrap();
    if let Err(e) = window.set_zoom(level) {
        eprintln!("Cannot set the zoom: {e}");
    }
}

fn change(app: &AppHandle, pick: impl Fn(f64) -> f64) {
    let Some(window) = app.get_webview_window(crate::MAIN_WINDOW) else {
        return;
    };
    let state = app.state::<ZoomState>();
    let mut level = state.level.lock().unwrap();
    *level = pick(*level);
    if let Err(e) = window.set_zoom(*level) {
        eprintln!("Cannot set the zoom: {e}");
    }
    if let Err(e) = fs::write(&state.path, level.to_string()) {
        eprintln!("Cannot save the zoom: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn steps_through_the_levels() {
        assert_eq!(next_level(1.0), 1.1);
        assert_eq!(previous_level(1.0), 0.9);
    }

    #[test]
    fn stops_at_the_limits() {
        assert_eq!(next_level(5.0), 5.0);
        assert_eq!(previous_level(0.25), 0.25);
    }

    #[test]
    fn moves_to_the_nearest_step_from_between_levels() {
        assert_eq!(next_level(1.05), 1.1);
        assert_eq!(previous_level(1.05), 1.0);
    }

    #[test]
    fn reads_a_saved_level() {
        assert_eq!(parse_level("1.25\n"), 1.25);
    }

    #[test]
    fn falls_back_to_actual_size_on_a_bad_value() {
        assert_eq!(parse_level(""), 1.0);
        assert_eq!(parse_level("big"), 1.0);
        assert_eq!(parse_level("NaN"), 1.0);
        assert_eq!(parse_level("100"), 1.0);
        assert_eq!(parse_level("0"), 1.0);
    }
}
