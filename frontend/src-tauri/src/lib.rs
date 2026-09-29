use std::collections::HashMap;
use std::ffi::OsString;
use std::path::PathBuf;

use tauri::ipc::CapabilityBuilder;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, TrayIconBuilder, TrayIconEvent};
use tauri::utils::config::{Csp, CspDirectiveSources};
use tauri::Emitter;
use tauri::Manager;

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

/// The folders the sidecar's library may be in, by the rules of `papeer.core.paths.data_directory`:
/// PAPEER_DATA_DIR when set, else the platform's place (Windows `%LOCALAPPDATA%\Papeer`, macOS
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

#[cfg(not(target_os = "linux"))]
fn tray_available() -> bool {
    true
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

    let mut builder = tauri::Builder::default();
    if remember_window {
        builder = builder.plugin(tauri_plugin_window_state::Builder::default().build());
    }
    let app = builder
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![get_backend_config])
        .setup(move |app| {
            #[cfg(debug_assertions)]
            if let Some(dir) = &e2e_dir {
                for config in app.config().app.windows.clone() {
                    tauri::WebviewWindowBuilder::from_config(app, &config)?
                        .data_directory(dir.clone())
                        .build()?;
                }
            }

            let show_i = MenuItem::with_id(app, "show", "開く", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            // The tray icon is a convenience: the window has everything it offers. Without it (no
            // appindicator library on Linux, no tray in the desktop), the app runs on without one.
            if let Some(icon) = app.default_window_icon().filter(|_| tray_available()) {
                let tray = TrayIconBuilder::with_id(TRAY_ID)
                    .icon(icon.clone())
                    .menu(&menu)
                    .on_menu_event(|app, event| {
                        if event.id.as_ref() == "quit" {
                            let _ = app.emit("tray-quit-requested", ());
                        } else if event.id.as_ref() == "show" {
                            if let Some(window) = app.get_webview_window("main") {
                                let _ = window.show();
                                let _ = window.set_focus();
                            }
                        }
                    })
                    .on_tray_icon_event(|tray, event| {
                        if let TrayIconEvent::Click {
                            button: MouseButton::Left,
                            ..
                        } = event
                        {
                            let app = tray.app_handle();
                            if let Some(window) = app.get_webview_window("main") {
                                let is_visible = window.is_visible().unwrap_or(false);
                                if is_visible {
                                    let _ = window.hide();
                                } else {
                                    let _ = window.show();
                                    let _ = window.set_focus();
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
            app.manage(sidecar::spawn(app, port, &token, search_path)?);
            Ok(())
        })
        .build(context)
        .expect("error while building tauri application");

    app.run(move |app_handle, event| {
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
        assert!(directives["img-src"].contains("http://127.0.0.1:51234"));
        assert_eq!(directives["script-src"], "'self'");
    }
}
