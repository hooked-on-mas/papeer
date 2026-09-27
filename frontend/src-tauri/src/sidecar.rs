//! The packaged sidecar's lifetime (release builds only; `tauri dev` talks to `just dev-sidecar`).
//!
//! At exit the sidecar is given the chance to stop its jobs and end by itself: the Python process of a
//! PyInstaller onefile exe runs under a bootloader that deletes %TEMP%\_MEI* only after a normal exit,
//! so killing the process (what `child.kill()` does) leaves that folder behind. Killing is the last resort.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use tauri::Manager;
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;

/// How long to wait after the app exits for a sidecar the frontend has already sent /shutdown.
const EXIT_GRACE: Duration = Duration::from_secs(3);
/// How long a sidecar sent /shutdown from here may take to end before it is killed. Longer than it lets
/// its jobs and requests wind down (SHUTDOWN_JOB_TIMEOUT + SHUTDOWN_REQUEST_TIMEOUT in sidecar/routes/system.py).
const SIDECAR_EXIT_TIMEOUT: Duration = Duration::from_secs(30);

/// Set once the sidecar process has ended.
#[derive(Default)]
struct Exited {
    done: Mutex<bool>,
    changed: Condvar,
}

impl Exited {
    fn set(&self) {
        *self.done.lock().unwrap_or_else(|e| e.into_inner()) = true;
        self.changed.notify_all();
    }

    /// True if the process ended within `timeout`.
    fn wait(&self, timeout: Duration) -> bool {
        let done = self.done.lock().unwrap_or_else(|e| e.into_inner());
        let (done, _) = self
            .changed
            .wait_timeout_while(done, timeout, |done| !*done)
            .unwrap_or_else(|e| e.into_inner());
        *done
    }
}

pub struct Sidecar {
    child: Mutex<Option<CommandChild>>,
    exited: Arc<Exited>,
    port: u16,
    token: String,
}

pub fn spawn(app: &tauri::App, port: u16, token: &str) -> Result<Sidecar, Box<dyn std::error::Error>> {
    let (mut events, child) = app
        .shell()
        .sidecar("sidecar")?
        .env("PAPEER_PORT", port.to_string())
        .env("PAPEER_TOKEN", token)
        .spawn()?;
    let exited = Arc::new(Exited::default());
    let signal = exited.clone();
    // The channel holds a single event, so it must be drained or the sidecar's output would stall.
    // Terminated comes after the bootloader, and with it the Python process, has exited.
    std::thread::spawn(move || {
        while let Some(event) = events.blocking_recv() {
            if matches!(event, CommandEvent::Terminated(_)) {
                break;
            }
        }
        signal.set();
    });
    Ok(Sidecar { child: Mutex::new(Some(child)), exited, port, token: token.to_string() })
}

impl Sidecar {
    /// Called as the app exits. The frontend has normally cancelled the jobs and sent /shutdown already
    /// (AppShell.tsx useCloseHandling); if the sidecar is still running, ask it here, then wait for it.
    pub fn stop(&self, app: &tauri::AppHandle) {
        // This blocks the main thread for up to SIDECAR_EXIT_TIMEOUT: nothing may stay on screen
        // meanwhile, or it would look frozen ("応答なし"). The frontend hides its window as well.
        for window in app.webview_windows().values() {
            let _ = window.hide();
        }
        if let Some(tray) = app.tray_by_id(crate::TRAY_ID) {
            let _ = tray.set_visible(false);
        }
        let Some(child) = self.child.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return;
        };
        if self.exited.wait(EXIT_GRACE) {
            return;
        }
        let deadline = Instant::now() + SIDECAR_EXIT_TIMEOUT;
        request_shutdown(self.port, &self.token, SIDECAR_EXIT_TIMEOUT);
        if !self.exited.wait(deadline.saturating_duration_since(Instant::now())) {
            let _ = child.kill();
        }
    }
}

/// POST /shutdown and wait for its answer, which comes once the sidecar's jobs have stopped.
/// Errors are ignored: a sidecar that no longer listens is already on its way out.
fn request_shutdown(port: u16, token: &str, timeout: Duration) {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let Ok(mut stream) = TcpStream::connect_timeout(&address, Duration::from_secs(2)) else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_secs(2)));
    let _ = stream.set_read_timeout(Some(timeout));
    let request = format!(
        "POST /shutdown HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nAuthorization: Bearer {token}\r\n\
         Content-Length: 0\r\nConnection: close\r\n\r\n"
    );
    if stream.write_all(request.as_bytes()).is_ok() {
        let _ = stream.read_to_end(&mut Vec::new());
    }
}
