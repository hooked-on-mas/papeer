use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;

use tauri::ipc::{CapabilityBuilder, InvokeBody, Request};
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::{Csp, CspDirectiveSources};
use tauri::Emitter;
use tauri::Manager;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_window_state::{StateFlags, WindowExt};

#[cfg(any(test, not(debug_assertions)))]
mod job;
#[cfg(not(debug_assertions))]
mod sidecar;

/// The tray icon's id, so it can be hidden while the app waits for the sidecar at exit.
const TRAY_ID: &str = "main";

#[derive(Clone)]
struct BackendConfig {
    port: u16,
    token: String,
}

/// The token `just dev-sidecar` starts the development sidecar with; a debug build does not launch its own.
#[cfg(debug_assertions)]
const DEV_TOKEN: &str = "dev_token";

/// The end-to-end tests (frontend/e2e) name a folder here: the main window's WebView2 profile goes there,
/// and the window-state plugin is left out. Debug builds only, so the tests never touch the user's
/// %LOCALAPPDATA%\local.paperdesk (the WebView2 profile Tauri would otherwise pick through the Windows
/// known folders, which ignore LOCALAPPDATA) nor the window position saved in %APPDATA%\local.paperdesk.
#[cfg(debug_assertions)]
const E2E_DIR_VARIABLE: &str = "PAPEER_E2E_DIR";

#[cfg(debug_assertions)]
fn e2e_dir() -> Option<PathBuf> {
    std::env::var_os(E2E_DIR_VARIABLE)
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// A fresh token for each launch: 256 bits from the OS CSPRNG, hex-encoded.
#[cfg(not(debug_assertions))]
fn new_token() -> Result<String, getrandom::Error> {
    let mut bytes = [0u8; 32];
    getrandom::fill(&mut bytes)?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[tauri::command]
fn get_backend_config(state: tauri::State<BackendConfig>) -> (u16, String) {
    (state.port, state.token.clone())
}

const MAX_OUTPUT_BYTES: usize = 512 * 1024 * 1024;

fn output_name(encoded: &str, format: &str) -> Result<String, &'static str> {
    if encoded.len() > 2048 || !matches!(format, "pdf" | "png") {
        return Err("output-invalid-request");
    }
    let bytes = encoded.as_bytes();
    let mut decoded = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' {
            if i + 2 >= bytes.len() {
                return Err("output-invalid-name");
            }
            let hex = |b: u8| (b as char).to_digit(16).map(|n| n as u8);
            decoded.push(
                hex(bytes[i + 1])
                    .zip(hex(bytes[i + 2]))
                    .map(|(a, b)| a * 16 + b)
                    .ok_or("output-invalid-name")?,
            );
            i += 3;
        } else {
            decoded.push(bytes[i]);
            i += 1;
        }
    }
    let name = String::from_utf8(decoded).map_err(|_| "output-invalid-name")?;
    if name.is_empty()
        || name.len() > 240
        || name == "."
        || name == ".."
        || name
            .chars()
            .any(|c| c.is_control() || "/\\:*?\"<>|".contains(c))
    {
        return Err("output-invalid-name");
    }
    let suffix = format!(".{format}");
    Ok(if name.to_ascii_lowercase().ends_with(&suffix) {
        name
    } else {
        format!("{name}{suffix}")
    })
}

fn validate_output(bytes: &[u8], format: &str) -> Result<(), &'static str> {
    if bytes.is_empty() || bytes.len() > MAX_OUTPUT_BYTES {
        return Err("output-invalid-size");
    }
    match format {
        "pdf" if bytes.starts_with(b"%PDF-") => Ok(()),
        "png" if bytes.starts_with(b"\x89PNG\r\n\x1a\n") => Ok(()),
        _ => Err("output-invalid-format"),
    }
}

/// Write to a unique sibling and rename only after all bytes have reached the OS.
fn write_output(path: &std::path::Path, bytes: &[u8]) -> Result<(), &'static str> {
    use std::io::Write;
    let parent = path.parent().ok_or("output-write-failed")?;
    let mut random = [0u8; 16];
    getrandom::fill(&mut random).map_err(|_| "output-write-failed")?;
    let suffix: String = random.iter().map(|byte| format!("{byte:02x}")).collect();
    let temporary = parent.join(format!(".papeer-output-{suffix}.tmp"));
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|_| "output-write-failed")?;
    let result = file.write_all(bytes).and_then(|_| file.sync_all());
    drop(file);
    if result.is_err() || std::fs::rename(&temporary, path).is_err() {
        let _ = std::fs::remove_file(&temporary);
        return Err("output-write-failed");
    }
    Ok(())
}

#[derive(serde::Serialize)]
struct OutputResult {
    status: &'static str,
}

#[tauri::command]
async fn save_output_file(
    app: tauri::AppHandle,
    request: Request<'_>,
) -> Result<OutputResult, &'static str> {
    let format = request
        .headers()
        .get("X-Papeer-Output-Format")
        .and_then(|v| v.to_str().ok())
        .ok_or("output-invalid-request")?
        .to_owned();
    let encoded = request
        .headers()
        .get("X-Papeer-Output-Name")
        .and_then(|v| v.to_str().ok())
        .ok_or("output-invalid-request")?;
    let name = output_name(encoded, &format)?;
    let bytes = match request.body() {
        InvokeBody::Raw(bytes) => bytes,
        _ => return Err("output-invalid-request"),
    };
    validate_output(bytes, &format)?;
    let bytes = bytes.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let window = app
            .get_webview_window("main")
            .ok_or("output-window-unavailable")?;
        let selected = app
            .dialog()
            .file()
            .set_parent(&window)
            .set_file_name(name)
            .add_filter(format.to_uppercase(), &[&format])
            .blocking_save_file();
        let Some(selected) = selected else {
            return Ok(OutputResult {
                status: "cancelled",
            });
        };
        let path = selected.into_path().map_err(|_| "output-write-failed")?;
        write_output(&path, &bytes)?;
        Ok(OutputResult { status: "saved" })
    })
    .await
    .map_err(|_| "output-write-failed")?
}

/// The folders the sidecar's library may be in, by the rules of `papeer.core.paths.data_directory`:
/// PAPEER_DATA_DIR when set, else storage-location.json, else the platform's place (Windows `%LOCALAPPDATA%\Papeer`, macOS
/// `~/Library/Application Support/Papeer`, Linux `$XDG_DATA_HOME/papeer`). The old `%LOCALAPPDATA%\PaperDesk`
/// is no longer read.
/// `os` is `std::env::consts::OS`; `var` reads the environment; `home` is the home folder.
fn library_directories(
    os: &str,
    var: impl Fn(&str) -> Option<OsString>,
    home: Option<PathBuf>,
) -> Vec<PathBuf> {
    let set = |name: &str| var(name).filter(|v| !v.is_empty());
    if let Some(dir) = set("PAPEER_DATA_DIR").or_else(|| set("PAPERDESK_DATA_DIR")) {
        let dir = PathBuf::from(dir);
        let dir = match dir.strip_prefix("~") {
            Ok(rest) => match &home {
                Some(home) => home.join(rest),
                None => return vec![],
            },
            Err(_) => dir,
        };
        return std::path::absolute(dir).ok().into_iter().collect();
    }
    let device = match os {
        "windows" => set("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| home.as_ref().map(|home| home.join("AppData").join("Local")))
            .map(|base| base.join("PapeerSync")),
        "macos" => home.as_ref().map(|home| {
            home.join("Library")
                .join("Application Support")
                .join("PapeerSync")
        }),
        _ => set("XDG_STATE_HOME")
            .map(PathBuf::from)
            .filter(|path| path.is_absolute())
            .or_else(|| home.as_ref().map(|home| home.join(".local").join("state")))
            .map(|base| base.join("papeer")),
    };
    if let Some(settings) =
        device.and_then(|dir| std::fs::read_to_string(dir.join("storage-location.json")).ok())
    {
        let selected = storage_directories(&settings);
        if !selected.is_empty() {
            return selected;
        }
    }
    match os {
        "windows" => {
            let Some(base) = set("LOCALAPPDATA")
                .map(PathBuf::from)
                .or_else(|| home.map(|home| home.join("AppData").join("Local")))
            else {
                return vec![];
            };
            vec![base.join("Papeer")]
        }
        "macos" => home
            .map(|home| {
                home.join("Library")
                    .join("Application Support")
                    .join("Papeer")
            })
            .into_iter()
            .collect(),
        _ => set("XDG_DATA_HOME")
            .map(PathBuf::from)
            .filter(|dir| dir.is_absolute())
            .or_else(|| home.map(|home| home.join(".local").join("share")))
            .map(|base| base.join("papeer"))
            .into_iter()
            .collect(),
    }
}

/// Include the pending location: the sidecar may finish the copy during this launch.
fn storage_directories(settings: &str) -> Vec<PathBuf> {
    let Ok(value) = serde_json::from_str::<serde_json::Value>(settings) else {
        return vec![];
    };
    let mut directories = Vec::new();
    for path in [
        value.get("path"),
        value.get("pending").and_then(|v| v.get("destination")),
    ]
    .into_iter()
    .flatten()
    .filter_map(|v| v.as_str())
    .map(PathBuf::from)
    {
        if path.is_absolute() && !directories.contains(&path) {
            directories.push(path);
        }
    }
    directories
}

/// Whether a tray icon can be made. Linux: whether one of the libraries it uses loads (tray-icon loads
/// one at run time, and panics when there is none: the .deb only recommends libayatana-appindicator3-1,
/// tauri.linux.conf.json).
#[cfg(target_os = "linux")]
fn tray_available() -> bool {
    ["libayatana-appindicator3.so.1", "libappindicator3.so.1"]
        .iter()
        .any(|name| {
            let name = std::ffi::CString::new(*name).expect("no NUL");
            // SAFETY: a library name without NUL; the handle is kept (tray-icon loads the same library).
            !unsafe { libc::dlopen(name.as_ptr(), libc::RTLD_LAZY) }.is_null()
        })
}

/// Whether a left click on the tray icon opens its menu (Windows, Linux) instead of showing or hiding the
/// window (macOS, where the menu comes on a right click only).
fn left_click_shows_menu() -> bool {
    !cfg!(target_os = "macos")
}

/// Whether `event` shows or hides the window: a left click released, where the left click does not open the
/// menu (a click that opens the menu must not also hide the window).
fn toggles_window(event: &TrayIconEvent, left_click_shows_menu: bool) -> bool {
    !left_click_shows_menu && is_left_click_release(event)
}

/// The tray icon reports a click twice, when the button goes down and when it comes up: only the release
/// of a left click shows or hides the window (once for each click).
fn is_left_click_release(event: &TrayIconEvent) -> bool {
    matches!(
        event,
        TrayIconEvent::Click {
            button: MouseButton::Left,
            button_state: MouseButtonState::Up,
            ..
        }
    )
}

#[cfg(not(target_os = "linux"))]
fn tray_available() -> bool {
    true
}

/// Linux: WebKitGTK's DMA-BUF renderer leaves the window blank or garbled with NVIDIA's own driver
/// (a known WebKitGTK issue). With that driver loaded, and nothing set by the user, WebKitGTK draws
/// without it. Called before anything starts another thread: the environment is not safe to change after.
#[cfg(target_os = "linux")]
fn webkit_workarounds() {
    const VARIABLE: &str = "WEBKIT_DISABLE_DMABUF_RENDERER";
    if std::env::var_os(VARIABLE).is_none()
        && std::path::Path::new("/proc/driver/nvidia/version").exists()
    {
        std::env::set_var(VARIABLE, "1");
    }
}

/// The ids of the menu bar's own items (macOS); the tray's items are "show" and "quit". Tauri hands every
/// menu's events to every handler, so each handler looks for its own ids only.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MENU_QUIT: &str = "app-quit";
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
const MENU_SETTINGS: &str = "app-settings";

/// What a menu bar item asks of the frontend: the same closing as the tray's 「終了」, or the settings.
#[cfg_attr(not(target_os = "macos"), allow(dead_code))]
fn menu_event_name(id: &str) -> Option<&'static str> {
    match id {
        MENU_QUIT => Some("tray-quit-requested"),
        MENU_SETTINGS => Some("open-settings-requested"),
        _ => None,
    }
}

/// macOS: the menu bar. Without one Tauri shows its own, whose Quit (⌘Q) ends the app at once, past the
/// window's closing (frontend AppShell useCloseHandling: unsaved input, running jobs, the sync at exit).
/// 「Papeer を終了」 and 「設定…」 are the app's own items (menu_event_name); the Edit menu keeps ⌘C, ⌘V,
/// ⌘X, ⌘A and ⌘Z working in the webview's text fields; ⌘W closes the window as its close button does.
#[cfg(target_os = "macos")]
fn app_menu<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<Menu<R>> {
    use tauri::menu::{AboutMetadata, PredefinedMenuItem, Submenu};
    let settings = MenuItem::with_id(app, MENU_SETTINGS, "設定…", true, Some("CmdOrCtrl+,"))?;
    let quit = MenuItem::with_id(app, MENU_QUIT, "Papeer を終了", true, Some("CmdOrCtrl+Q"))?;
    let about = AboutMetadata {
        name: Some("Papeer".into()),
        ..Default::default()
    };
    let app_submenu = Submenu::with_items(
        app,
        "Papeer",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("Papeer について"), Some(about))?,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, Some("サービス"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, Some("Papeer を隠す"))?,
            &PredefinedMenuItem::hide_others(app, Some("ほかを隠す"))?,
            &PredefinedMenuItem::show_all(app, Some("すべてを表示"))?,
            &PredefinedMenuItem::separator(app)?,
            &quit,
        ],
    )?;
    let edit = Submenu::with_items(
        app,
        "編集",
        true,
        &[
            &PredefinedMenuItem::undo(app, Some("取り消す"))?,
            &PredefinedMenuItem::redo(app, Some("やり直す"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, Some("カット"))?,
            &PredefinedMenuItem::copy(app, Some("コピー"))?,
            &PredefinedMenuItem::paste(app, Some("ペースト"))?,
            &PredefinedMenuItem::select_all(app, Some("すべてを選択"))?,
        ],
    )?;
    let window = Submenu::with_items(
        app,
        "ウインドウ",
        true,
        &[
            &PredefinedMenuItem::minimize(app, Some("しまう"))?,
            &PredefinedMenuItem::maximize(app, Some("拡大／縮小"))?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::close_window(app, Some("閉じる"))?,
        ],
    )?;
    Menu::with_items(app, &[&app_submenu, &edit, &window])
}

/// Show the main window and bring it to the front (the tray's 「開く」, the Dock icon and the menu bar on macOS).
fn show_main_window<R: tauri::Runtime>(app: &tauri::AppHandle<R>) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

/// tauri.conf.json names the sidecar as `http://127.0.0.1:*` (and `ws://`), since a release build learns
/// its port only at launch. Narrow those sources to the port the sidecar was given, so a page in the
/// webview cannot reach other servers on this PC. Tauri reads the CSP from the config for each page.
fn pin_sidecar_port(csp: Csp, port: u16) -> Csp {
    let directives: HashMap<String, CspDirectiveSources> = csp.into();
    Csp::DirectiveMap(
        directives
            .into_iter()
            .map(|(directive, sources)| {
                let sources = Vec::<String>::from(sources)
                    .into_iter()
                    .map(|source| match source.strip_suffix("//127.0.0.1:*") {
                        Some(scheme) => format!("{scheme}//127.0.0.1:{port}"),
                        None => source,
                    })
                    .collect();
                (directive, CspDirectiveSources::List(sources))
            })
            .collect(),
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    webkit_workarounds();
    // Chosen before the app is built, so the CSP can name it (pin_sidecar_port). A debug build talks to
    // `just dev-sidecar` on 8000; `tauri dev` loads the page from Vite, which Tauri serves without the CSP.
    #[cfg(debug_assertions)]
    let port: u16 = 8000;
    #[cfg(not(debug_assertions))]
    let port: u16 = {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        listener.local_addr().unwrap().port()
    };
    // macOS and Linux: the login shell's PATH for the sidecar, looked up while the app is built.
    #[cfg(not(debug_assertions))]
    let search_path = sidecar::SearchPath::look_up();
    let mut context = tauri::generate_context!();
    let security = &mut context.config_mut().app.security;
    security.csp = security.csp.take().map(|csp| pin_sidecar_port(csp, port));
    // zoomHotkeysEnabled lets touchpad pinch reach the page as Ctrl+wheel in WebView2. On macOS and
    // Linux Tauri would instead add a script that zooms the whole webview on ⌘/Ctrl + - 0 and Ctrl+wheel,
    // which are the PDF's zoom there (the reader takes pinch from WebKit's gesture events).
    for window in &mut context.config_mut().app.windows {
        window.zoom_hotkeys_enabled &= cfg!(windows);
    }

    // Under the end-to-end tests the main window is made in setup, with its own WebView2 profile.
    #[cfg(debug_assertions)]
    let e2e_dir = e2e_dir();
    #[cfg(debug_assertions)]
    if e2e_dir.is_some() {
        for window in &mut context.config_mut().app.windows {
            window.create = false;
        }
    }
    #[cfg(debug_assertions)]
    let remember_window = e2e_dir.is_none();
    #[cfg(not(debug_assertions))]
    let remember_window = true;

    // Keep the initial dimensions off screen until the saved size and maximization are restored.
    // E2E windows have no window-state plugin and keep their configured visibility.
    if remember_window {
        for window in &mut context.config_mut().app.windows {
            if window.label == "main" {
                window.visible = false;
            }
        }
    }
    // Visibility is a startup decision, not saved state: even an app quit from the tray must open.
    let window_state_flags = StateFlags::all() & !StateFlags::VISIBLE;
    let mut builder = tauri::Builder::default();
    if remember_window {
        builder = builder.plugin(
            tauri_plugin_window_state::Builder::default()
                .with_state_flags(window_state_flags)
                .skip_initial_state("main")
                .build(),
        );
    }
    let app = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![
            get_backend_config,
            save_output_file
        ])
        .setup(move |app| {
            #[cfg(debug_assertions)]
            if let Some(dir) = &e2e_dir {
                for config in app.config().app.windows.clone() {
                    tauri::WebviewWindowBuilder::from_config(app, &config)?
                        .data_directory(dir.clone())
                        .build()?;
                }
            }

            if remember_window {
                if let Some(window) = app.get_webview_window("main") {
                    if let Err(error) = window.restore_state(window_state_flags) {
                        eprintln!("ウィンドウの状態を復元できませんでした: {error}");
                    }
                    // Show the default size on first launch or if restoration failed, too.
                    window.show()?;
                    window.set_focus()?;
                }
            }

            #[cfg(target_os = "macos")]
            {
                app.set_menu(app_menu(app)?)?;
                app.on_menu_event(|app, event| {
                    if let Some(name) = menu_event_name(event.id.as_ref()) {
                        show_main_window(app);
                        let _ = app.emit(name, ());
                    }
                });
            }

            let show_i = MenuItem::with_id(app, "show", "開く", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            // The tray icon is a convenience: the window has everything it offers. Without it (no
            // appindicator library on Linux, no tray in the desktop), the app runs on without one.
            // macOS: a black-and-white template image, which the menu bar draws in its own colours (the app
            // icon would be a coloured square there), and the menu on a right click only: a left click
            // shows or hides the window. Elsewhere a left click opens the menu, and only that.
            #[cfg(target_os = "macos")]
            let icon = Some(tauri::include_image!("icons/tray-template.png"));
            #[cfg(not(target_os = "macos"))]
            let icon = app.default_window_icon().cloned();
            if let Some(icon) = icon.filter(|_| tray_available()) {
                let tray = TrayIconBuilder::with_id(TRAY_ID)
                    .icon(icon)
                    .icon_as_template(cfg!(target_os = "macos"))
                    .show_menu_on_left_click(left_click_shows_menu())
                    .menu(&menu)
                    .on_menu_event(|app, event| {
                        if event.id.as_ref() == "quit" {
                            let _ = app.emit("tray-quit-requested", ());
                        } else if event.id.as_ref() == "show" {
                            show_main_window(app);
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if toggles_window(&event, left_click_shows_menu()) {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let is_visible = window.is_visible().unwrap_or(false);
                                if is_visible {
                                    let _ = window.hide();
                                } else {
                                    show_main_window(app);
                                }
                            }
                        }
                    })
                    .build(app);
                if let Err(error) = tray {
                    eprintln!(
                        "タスクトレイのアイコンを作れませんでした（トレイなしで続けます）: {error}"
                    );
                }
            }

            #[cfg(debug_assertions)]
            let token = DEV_TOKEN.to_string();
            #[cfg(not(debug_assertions))]
            let token = new_token()
                .map_err(|e| format!("sidecar の認証トークンを作れませんでした: {e}"))?;

            app.manage(BackendConfig {
                port,
                token: token.clone(),
            });

            // The frontend opens paper folders and PDFs in external apps. Limit that to the
            // sidecar's data directory so a script in the webview cannot launch arbitrary files.
            let scopes: Vec<_> = library_directories(
                std::env::consts::OS,
                |name| std::env::var_os(name),
                app.path().home_dir().ok(),
            )
            .iter()
            .map(|dir| {
                let scope = PathBuf::from(glob::Pattern::escape(&dir.to_string_lossy())).join("**");
                serde_json::json!({ "path": scope })
            })
            .collect();
            if !scopes.is_empty() {
                app.add_capability(
                    CapabilityBuilder::new("open-data-directory")
                        .window("main")
                        .permission_scoped("opener:allow-open-path", scopes, vec![]),
                )?;
            }

            #[cfg(not(debug_assertions))]
            {
                app.manage(sidecar::spawn(app, port, &token, search_path)?);
                // A sidecar that finds the library in use by another Papeer exits with code 4: say so.
                sidecar::watch_startup(app.handle());
            }
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application");

    app.run(move |app_handle, event| {
        // macOS: clicking the Dock icon brings back a window the tray or ⌘H hid.
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen {
            has_visible_windows: false,
            ..
        } = event
        {
            show_main_window(app_handle);
        }
        #[cfg(debug_assertions)]
        let _ = (app_handle, event);
        // Wait for the sidecar to end by itself (it has usually been sent /shutdown); kill only as a last resort.
        #[cfg(not(debug_assertions))]
        if let tauri::RunEvent::Exit = event {
            if let Some(sidecar) = app_handle.try_state::<sidecar::Sidecar>() {
                sidecar.stop(app_handle);
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn click(button: MouseButton, button_state: MouseButtonState) -> TrayIconEvent {
        use tauri::tray::TrayIconId;
        TrayIconEvent::Click {
            id: TrayIconId::new("t"),
            position: Default::default(),
            rect: Default::default(),
            button,
            button_state,
        }
    }

    #[test]
    fn the_window_is_toggled_only_where_a_left_click_does_not_open_the_menu() {
        let up = click(MouseButton::Left, MouseButtonState::Up);
        assert!(toggles_window(&up, false));
        assert!(!toggles_window(&up, true));
        assert!(!toggles_window(
            &click(MouseButton::Left, MouseButtonState::Down),
            false
        ));
        assert!(!toggles_window(
            &click(MouseButton::Right, MouseButtonState::Up),
            false
        ));
    }

    #[test]
    fn only_the_release_of_a_left_click_toggles_the_window() {
        assert!(is_left_click_release(&click(
            MouseButton::Left,
            MouseButtonState::Up
        )));
        assert!(!is_left_click_release(&click(
            MouseButton::Left,
            MouseButtonState::Down
        )));
        assert!(!is_left_click_release(&click(
            MouseButton::Right,
            MouseButtonState::Up
        )));
    }

    fn env<'a>(pairs: &'a [(&'a str, &'a str)]) -> impl Fn(&str) -> Option<OsString> + 'a {
        move |name| {
            pairs
                .iter()
                .find(|(key, _)| *key == name)
                .map(|(_, value)| OsString::from(value))
        }
    }

    /// An absolute folder on the platform the test runs on.
    fn root(name: &str) -> PathBuf {
        std::env::temp_dir().join(name)
    }

    #[test]
    fn library_directories_follow_each_platforms_custom() {
        let home = root("home");
        let local = root("local");
        let local_text = local.to_string_lossy().into_owned();
        assert_eq!(
            library_directories(
                "windows",
                env(&[("LOCALAPPDATA", &local_text)]),
                Some(home.clone())
            ),
            vec![local.join("Papeer")]
        );
        assert_eq!(
            library_directories("windows", env(&[]), Some(home.clone())),
            vec![home.join("AppData").join("Local").join("Papeer")]
        );
        // LOCALAPPDATA means nothing on macOS and Linux.
        assert_eq!(
            library_directories(
                "macos",
                env(&[("LOCALAPPDATA", &local_text)]),
                Some(home.clone())
            ),
            vec![home
                .join("Library")
                .join("Application Support")
                .join("Papeer")]
        );
        assert_eq!(
            library_directories(
                "linux",
                env(&[("LOCALAPPDATA", &local_text)]),
                Some(home.clone())
            ),
            vec![home.join(".local").join("share").join("papeer")]
        );
        let xdg = root("xdg-data");
        let xdg_text = xdg.to_string_lossy().into_owned();
        assert_eq!(
            library_directories(
                "linux",
                env(&[("XDG_DATA_HOME", &xdg_text)]),
                Some(home.clone())
            ),
            vec![xdg.join("papeer")]
        );
        // A relative XDG folder is ignored, as the XDG Base Directory specification says.
        assert_eq!(
            library_directories(
                "linux",
                env(&[("XDG_DATA_HOME", "relative")]),
                Some(home.clone())
            ),
            vec![home.join(".local").join("share").join("papeer")]
        );
        assert!(library_directories("macos", env(&[]), None).is_empty());
    }

    #[test]
    fn storage_scopes_include_current_and_pending_locations() {
        let current = root("current-library");
        let pending = root("pending-library");
        let settings = serde_json::json!({"path": current, "pending": {"destination": pending}});
        assert_eq!(
            storage_directories(&settings.to_string()),
            vec![current.clone(), pending]
        );
        assert_eq!(
            storage_directories(&serde_json::json!({"path": current}).to_string()),
            vec![current]
        );
        assert!(storage_directories("invalid json").is_empty());
        assert!(storage_directories(r#"{"path":"relative"}"#).is_empty());
    }

    #[test]
    fn papeer_data_dir_names_the_only_library_directory() {
        let home = root("home");
        let data = root("elsewhere");
        let data_text = data.to_string_lossy().into_owned();
        for os in ["windows", "macos", "linux"] {
            assert_eq!(
                library_directories(
                    os,
                    env(&[("PAPEER_DATA_DIR", &data_text)]),
                    Some(home.clone())
                ),
                vec![data.clone()]
            );
            assert_eq!(
                library_directories(
                    os,
                    env(&[("PAPERDESK_DATA_DIR", "~/old")]),
                    Some(home.clone())
                ),
                vec![home.join("old")]
            );
        }
    }

    #[test]
    fn menu_bar_items_ask_the_frontend_as_the_tray_does() {
        assert_eq!(menu_event_name(MENU_QUIT), Some("tray-quit-requested"));
        assert_eq!(
            menu_event_name(MENU_SETTINGS),
            Some("open-settings-requested")
        );
        // The tray's own items are its handler's, not the menu bar's.
        assert_eq!(menu_event_name("quit"), None);
        assert_eq!(menu_event_name("show"), None);
    }

    #[test]
    fn csp_names_only_the_sidecar_port() {
        let config: serde_json::Value =
            serde_json::from_str(include_str!("../tauri.conf.json")).expect("tauri.conf.json");
        let csp: Csp =
            serde_json::from_value(config["app"]["security"]["csp"].clone()).expect("csp");
        let pinned = pin_sidecar_port(csp, 51234).to_string();
        assert!(!pinned.contains("127.0.0.1:*"), "{pinned}");
        let directives: HashMap<&str, &str> = pinned
            .split(';')
            .filter_map(|d| d.trim().split_once(' '))
            .collect();
        assert!(directives["connect-src"].contains("http://127.0.0.1:51234"));
        assert!(directives["connect-src"].contains("ws://127.0.0.1:51234"));
        assert!(directives["connect-src"].contains("ipc:"));
        assert!(directives["connect-src"]
            .split_whitespace()
            .any(|source| source == "blob:"));
        assert!(directives["img-src"].contains("http://127.0.0.1:51234"));
        assert_eq!(directives["frame-src"], "http://127.0.0.1:51234");
        assert_eq!(directives["script-src"], "'self'");
    }
}
#[cfg(test)]
mod output_file_tests {
    use super::*;
    #[test]
    fn filename_and_body_are_validated() {
        assert_eq!(
            output_name("%E6%97%A5%E6%9C%AC", "pdf"),
            Ok("日本.pdf".into())
        );
        assert_eq!(output_name("a.PNG", "png"), Ok("a.PNG".into()));
        assert!(output_name("..%2Fsecret", "pdf").is_err());
        assert!(output_name("%FF", "pdf").is_err());
        assert!(output_name("a", "exe").is_err());
        assert!(validate_output(b"%PDF-1.7", "pdf").is_ok());
        assert!(validate_output(b"\x89PNG\r\n\x1a\nrest", "png").is_ok());
        assert!(validate_output(b"bad", "pdf").is_err());
    }
    #[test]
    fn replacement_preserves_old_file_when_rename_fails() {
        let dir = std::env::temp_dir().join(format!("papeer-output-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("test.pdf");
        std::fs::write(&file, b"old").unwrap();
        write_output(&file, b"new").unwrap();
        assert_eq!(std::fs::read(&file).unwrap(), b"new");
        let target_dir = dir.join("directory");
        std::fs::create_dir(&target_dir).unwrap();
        assert!(write_output(&target_dir, b"new").is_err());
        assert!(target_dir.is_dir());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 2);
        std::fs::remove_file(file).unwrap();
        std::fs::remove_dir(target_dir).unwrap();
        std::fs::remove_dir(dir).unwrap();
    }
}
