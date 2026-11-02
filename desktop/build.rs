fn main() {
    // App commands need a permission to be callable from the page, which is
    // loaded over http (see `zoom::install`).
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["zoom_hotkey"]),
    ))
    .expect("error while building the tauri application");
}
