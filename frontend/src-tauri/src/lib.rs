use tauri::Manager;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{TrayIconBuilder, MouseButton, TrayIconEvent};
use tauri::Emitter;

#[derive(Clone)]
struct BackendConfig {
    port: u16,
    token: String,
}

#[tauri::command]
fn get_backend_config(state: tauri::State<BackendConfig>) -> (u16, String) {
    (state.port, state.token.clone())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_process::init())
        .invoke_handler(tauri::generate_handler![get_backend_config])
        .setup(|app| {
            let show_i = MenuItem::with_id(app, "show", "開く", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "終了", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            if let Some(icon) = app.default_window_icon() {
                let _tray = TrayIconBuilder::new()
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
                        if let TrayIconEvent::Click { button: MouseButton::Left, .. } = event {
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
            let port = 8000;
            #[cfg(not(debug_assertions))]
            let port = {
                let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
                listener.local_addr().unwrap().port()
            };

            #[cfg(debug_assertions)]
            let token = "dev_token".to_string();
            #[cfg(not(debug_assertions))]
            let token = format!("{:x}", std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos());
            
            app.manage(BackendConfig { port, token: token.clone() });

            #[cfg(not(debug_assertions))]
            {
                use tauri_plugin_shell::ShellExt;
                let sidecar_command = app.shell().sidecar("sidecar").unwrap()
                    .env("PAPERDESK_PORT", port.to_string())
                    .env("PAPERDESK_TOKEN", token);
                let (_rx, child) = sidecar_command.spawn().expect("Failed to spawn sidecar");
                app.manage(SidecarState(std::sync::Mutex::new(Some(child))));
            }
            Ok(())
        })
        
        .build(tauri::generate_context!())
        .expect("error while building tauri application");

    app.run(move |app_handle, event| {
        #[cfg(debug_assertions)]
        let _ = app_handle;
        if let tauri::RunEvent::Exit = event {
            #[cfg(not(debug_assertions))]
            if let Some(state) = app_handle.try_state::<SidecarState>() {
                if let Ok(mut child_guard) = state.0.lock() {
                    if let Some(child) = child_guard.take() {
                        let _ = child.kill();
                    }
                }
            }
        }
    });
}

#[cfg(not(debug_assertions))]
struct SidecarState(std::sync::Mutex<Option<tauri_plugin_shell::process::CommandChild>>);
