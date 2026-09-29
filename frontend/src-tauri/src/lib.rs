use std::collections::HashMap;
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

/// Mirrors `papeer.core.config.data_directory` in the sidecar.
fn data_directory(app: &tauri::App) -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("PAPEER_DATA_DIR")
        .or_else(|| std::env::var_os("PAPERDESK_DATA_DIR"))
        .filter(|v| !v.is_empty())
    {
        let dir = PathBuf::from(dir);
        let dir = match dir.strip_prefix("~") {
            Ok(rest) => app.path().home_dir().ok()?.join(rest),
            Err(_) => dir,
        };
        return std::path::absolute(dir).ok();
    }
    let base = match std::env::var_os("LOCALAPPDATA") {
        Some(dir) => PathBuf::from(dir),
        None => app.path().home_dir().ok()?.join(".local/share"),
    };
    let current = base.join("Papeer");
    let legacy = base.join("PaperDesk");
    // A stray, empty Papeer folder must not hide a PaperDesk library that holds papers.
    let has_papers = |root: &PathBuf| {
        std::fs::read_dir(root.join("papers")).is_ok_and(|mut it| it.next().is_some())
    };
    Some(
        if (!current.exists() && legacy.is_dir()) || (has_papers(&legacy) && !has_papers(&current))
        {
            legacy
        } else {
            current
        },
    )
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

            if let Some(icon) = app.default_window_icon() {
                let _tray = TrayIconBuilder::with_id(TRAY_ID)
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
                    .build(app)?;
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
            if let Some(dir) = data_directory(app) {
                let scope = PathBuf::from(glob::Pattern::escape(&dir.to_string_lossy())).join("**");
                app.add_capability(
                    CapabilityBuilder::new("open-data-directory")
                        .window("main")
                        .permission_scoped(
                            "opener:allow-open-path",
                            vec![serde_json::json!({ "path": scope })],
                            vec![],
                        ),
                )?;
            }

            #[cfg(not(debug_assertions))]
            app.manage(sidecar::spawn(app, port, &token)?);
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
