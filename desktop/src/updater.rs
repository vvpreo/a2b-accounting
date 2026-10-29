//! Self-update from GitHub Releases, in two channels:
//! - **stable** — the newest `vX.Y.Z` release (GitHub's "latest release");
//! - **dev** — the rolling `desktop-dev` prerelease, rebuilt on every push to
//!   `main` (see .github/workflows/desktop-macos.yml).
//!
//! Each release carries a `latest.json` manifest and an archive signed with
//! the key whose public half is in tauri.conf.json. An update is offered only
//! when its version is newer: dev builds are versioned `X.Y.(Z+1)-dev.N`
//! after stable `X.Y.Z`, so switching channels never installs an older app
//! over a DB that a newer one has already migrated.
//!
//! The UI is the native app menu ("Check for Updates…", "Update Channel")
//! plus dialogs — the web frontend knows nothing about it. A silent check
//! also runs shortly after launch and then every few hours.

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_updater::UpdaterExt;

/// Channel of this very build, set by CI; a local build counts as dev.
const BUILD_CHANNEL: Option<&str> = option_env!("A2B_CHANNEL");
const SETTINGS_FILE: &str = "desktop-settings.json";
const FIRST_CHECK_DELAY: Duration = Duration::from_secs(15);
const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);

const MENU_CHECK: &str = "updates.check";
const MENU_STABLE: &str = "updates.channel.stable";
const MENU_DEV: &str = "updates.channel.dev";

#[derive(Clone, Copy, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum Channel {
    Stable,
    Dev,
}

impl Channel {
    fn of_build() -> Self {
        match BUILD_CHANNEL {
            Some("stable") => Channel::Stable,
            _ => Channel::Dev,
        }
    }

    fn manifest_url(self) -> &'static str {
        match self {
            // `releases/latest` skips prereleases, i.e. the dev build.
            Channel::Stable => {
                "https://github.com/vvpreo/a2b-accounting/releases/latest/download/latest.json"
            }
            Channel::Dev => {
                "https://github.com/vvpreo/a2b-accounting/releases/download/desktop-dev/latest.json"
            }
        }
    }
}

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Settings {
    update_channel: Option<Channel>,
}

struct UpdaterState {
    settings_path: PathBuf,
    channel: Mutex<Channel>,
    stable_item: CheckMenuItem<tauri::Wry>,
    dev_item: CheckMenuItem<tauri::Wry>,
    /// A check or an install is running.
    busy: AtomicBool,
    /// Version the user answered "Later" to: background checks stay quiet
    /// about it until the next launch (a manual check still offers it).
    postponed: Mutex<Option<String>>,
}

pub fn install(app: &AppHandle, data_dir: &Path) -> tauri::Result<()> {
    let text = Text::system();
    let settings_path = data_dir.join(SETTINGS_FILE);
    let channel = read_settings(&settings_path)
        .update_channel
        .unwrap_or_else(Channel::of_build);

    let check = MenuItem::with_id(app, MENU_CHECK, text.check_menu, true, None::<&str>)?;
    let stable_item = CheckMenuItem::with_id(
        app,
        MENU_STABLE,
        text.stable,
        true,
        channel == Channel::Stable,
        None::<&str>,
    )?;
    let dev_item = CheckMenuItem::with_id(
        app,
        MENU_DEV,
        text.dev,
        true,
        channel == Channel::Dev,
        None::<&str>,
    )?;
    let channels = Submenu::with_items(app, text.channel_menu, true, &[&stable_item, &dev_item])?;

    let menu = Menu::default(app)?;
    let items = menu.items()?;
    // On macOS the first submenu is the application menu (About, Quit…) —
    // where "Check for Updates…" conventionally lives.
    match items.first().and_then(|item| item.as_submenu()) {
        Some(app_menu) if cfg!(target_os = "macos") => app_menu.insert_items(
            &[&check, &channels, &PredefinedMenuItem::separator(app)?],
            1,
        )?,
        _ => menu.append(&Submenu::with_items(
            app,
            text.updates_menu,
            true,
            &[&check, &channels],
        )?)?,
    }
    app.set_menu(menu)?;

    app.manage(UpdaterState {
        settings_path,
        channel: Mutex::new(channel),
        stable_item,
        dev_item,
        busy: AtomicBool::new(false),
        postponed: Mutex::new(None),
    });
    app.on_menu_event(|app, event| match event.id().as_ref() {
        MENU_CHECK => spawn_check(app.clone(), true),
        MENU_STABLE => switch_channel(app, Channel::Stable),
        MENU_DEV => switch_channel(app, Channel::Dev),
        _ => {}
    });

    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(FIRST_CHECK_DELAY);
        loop {
            spawn_check(app.clone(), false);
            std::thread::sleep(CHECK_INTERVAL);
        }
    });
    Ok(())
}

fn read_settings(path: &Path) -> Settings {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn switch_channel(app: &AppHandle, channel: Channel) {
    let state = app.state::<UpdaterState>();
    // A click toggles the item by itself; make the pair a radio group again.
    let _ = state.stable_item.set_checked(channel == Channel::Stable);
    let _ = state.dev_item.set_checked(channel == Channel::Dev);
    *state.channel.lock().unwrap() = channel;
    let mut settings = read_settings(&state.settings_path);
    settings.update_channel = Some(channel);
    if let Ok(raw) = serde_json::to_string_pretty(&settings) {
        if let Err(e) = std::fs::write(&state.settings_path, raw) {
            eprintln!("cannot save {}: {e}", state.settings_path.display());
        }
    }
    // Show right away what the chosen channel has to offer.
    spawn_check(app.clone(), true);
}

fn spawn_check(app: AppHandle, manual: bool) {
    tauri::async_runtime::spawn(async move {
        let state = app.state::<UpdaterState>();
        let text = Text::system();
        if state.busy.swap(true, Ordering::SeqCst) {
            if manual {
                message(&app, text.busy.into(), MessageDialogKind::Info).await;
            }
            return;
        }
        let result = check(&app, manual).await;
        state.busy.store(false, Ordering::SeqCst);
        if let Err(e) = result {
            eprintln!("update check failed: {e}");
            if manual {
                message(&app, format!("{}\n\n{e}", text.failed), MessageDialogKind::Error).await;
            }
        }
    });
}

async fn check(app: &AppHandle, manual: bool) -> Result<(), String> {
    let state = app.state::<UpdaterState>();
    let text = Text::system();
    let channel = *state.channel.lock().unwrap();
    let current = app.package_info().version.to_string();
    let updater = app
        .updater_builder()
        .endpoints(vec![channel.manifest_url().parse().expect("valid URL")])
        .and_then(|builder| builder.build())
        .map_err(|e| e.to_string())?;
    let update = match updater.check().await {
        Ok(update) => update,
        // No stable release published yet, or the dev one is being replaced.
        Err(tauri_plugin_updater::Error::ReleaseNotFound) => None,
        Err(e) => return Err(e.to_string()),
    };
    let Some(update) = update else {
        if manual {
            let body = text.up_to_date(&current, text.channel_name(channel));
            message(app, body, MessageDialogKind::Info).await;
        }
        return Ok(());
    };

    if !manual && state.postponed.lock().unwrap().as_deref() == Some(update.version.as_str()) {
        return Ok(());
    }
    let question = text.available(&update.version, &current, text.channel_name(channel));
    let dialog = app
        .dialog()
        .message(question)
        .title(text.title)
        .kind(MessageDialogKind::Info)
        .buttons(MessageDialogButtons::OkCancelCustom(
            text.install.into(),
            text.later.into(),
        ));
    let install = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show())
        .await
        .unwrap_or(false);
    if !install {
        *state.postponed.lock().unwrap() = Some(update.version.clone());
        return Ok(());
    }

    // Download progress goes to the window title — the window stays usable.
    let window = app.get_webview_window(crate::MAIN_WINDOW);
    let mut downloaded: u64 = 0;
    let result = update
        .download_and_install(
            |chunk, total| {
                downloaded += chunk as u64;
                if let (Some(window), Some(total)) = (&window, total) {
                    let percent = downloaded * 100 / total.max(1);
                    let _ = window.set_title(&format!("A2B Accounting — {} {percent}%", text.downloading));
                }
            },
            || {},
        )
        .await;
    if let Some(window) = &window {
        let _ = window.set_title("A2B Accounting");
    }
    result.map_err(|e| e.to_string())?;
    app.restart();
}

async fn message(app: &AppHandle, body: String, kind: MessageDialogKind) {
    let dialog = app.dialog().message(body).title(Text::system().title).kind(kind);
    let _ = tauri::async_runtime::spawn_blocking(move || dialog.blocking_show()).await;
}

/// Native menu and dialog texts in the system language (ru/en, as the UI).
struct Text {
    ru: bool,
    title: &'static str,
    check_menu: &'static str,
    channel_menu: &'static str,
    updates_menu: &'static str,
    stable: &'static str,
    dev: &'static str,
    install: &'static str,
    later: &'static str,
    busy: &'static str,
    failed: &'static str,
    downloading: &'static str,
}

impl Text {
    fn system() -> Self {
        let ru = sys_locale::get_locale().is_some_and(|l| l.starts_with("ru"));
        if ru {
            Text {
                ru,
                title: "Обновление A2B Accounting",
                check_menu: "Проверить обновления…",
                channel_menu: "Канал обновлений",
                updates_menu: "Обновления",
                stable: "Стабильный",
                dev: "Разработка (dev)",
                install: "Установить и перезапустить",
                later: "Позже",
                busy: "Проверка или установка обновления уже идёт.",
                failed: "Не удалось проверить обновления.",
                downloading: "загрузка обновления",
            }
        } else {
            Text {
                ru,
                title: "A2B Accounting Update",
                check_menu: "Check for Updates…",
                channel_menu: "Update Channel",
                updates_menu: "Updates",
                stable: "Stable",
                dev: "Development (dev)",
                install: "Install and Restart",
                later: "Later",
                busy: "An update check or install is already running.",
                failed: "Could not check for updates.",
                downloading: "downloading update",
            }
        }
    }

    fn channel_name(&self, channel: Channel) -> &'static str {
        match channel {
            Channel::Stable => self.stable,
            Channel::Dev => self.dev,
        }
    }

    fn up_to_date(&self, current: &str, channel: &str) -> String {
        if self.ru {
            format!("Установлена последняя версия: {current}.\nКанал: {channel}.")
        } else {
            format!("You have the latest version: {current}.\nChannel: {channel}.")
        }
    }

    fn available(&self, new: &str, current: &str, channel: &str) -> String {
        if self.ru {
            format!("Доступна версия {new} (сейчас {current}).\nКанал: {channel}.\n\nПеред первым запуском новой версии копия базы сохраняется автоматически.")
        } else {
            format!("Version {new} is available (you have {current}).\nChannel: {channel}.\n\nA copy of the database is saved automatically before the new version first starts.")
        }
    }
}
