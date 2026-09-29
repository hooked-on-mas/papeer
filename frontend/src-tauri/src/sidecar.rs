//! The packaged sidecar's lifetime (release builds only; `tauri dev` talks to `just dev-sidecar`).
//!
//! The sidecar is a PyInstaller onedir bundle (sidecar.spec): the folder `sidecar` that tauri.conf.json's
//! bundle.resources installs in the resource directory (next to papeer.exe on Windows), holding the
//! launcher papeer-sidecar(.exe) and its `_internal` folder. The launcher runs Python in its own process
//! and unpacks nothing into %TEMP% (a onefile exe did, and left its _MEI* folder behind when killed).
//!
//! At exit the sidecar is given the chance to stop its jobs and end by itself; killing is the last
//! resort. It runs in a job object (job.rs) that ends it and the CLIs it runs, when it is terminated
//! here and when the app exits however it exits (a crash, 「タスクの終了」).
//!
//! What differs between platforms (starting the launcher, holding and ending its processes) is in
//! `platform` below; only the Windows one is built and tested for now.

use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::Manager;

/// The bundle's folder in the resource directory (sidecar.spec COLLECT, tauri.conf.json bundle.resources).
const SIDECAR_DIR: &str = "sidecar";
/// Its launcher, without the platform's executable suffix (sidecar.spec EXE).
const SIDECAR_EXE: &str = "papeer-sidecar";

/// How long to wait after the app exits for a sidecar the frontend has already sent /shutdown.
const EXIT_GRACE: Duration = Duration::from_secs(3);
/// How long a sidecar sent /shutdown from here may take to end before it is killed. Longer than it lets
/// its jobs and requests wind down (SHUTDOWN_JOB_TIMEOUT + SHUTDOWN_REQUEST_TIMEOUT in sidecar/routes/system.py).
const SIDECAR_EXIT_TIMEOUT: Duration = Duration::from_secs(30);
/// How long a killed sidecar may take to be gone.
const KILL_TIMEOUT: Duration = Duration::from_secs(5);

/// The launcher in the resource directory.
fn launcher(resource_dir: &Path) -> PathBuf {
    resource_dir
        .join(SIDECAR_DIR)
        .join(format!("{SIDECAR_EXE}{}", std::env::consts::EXE_SUFFIX))
}

pub struct Sidecar {
    child: Mutex<Option<Child>>,
    processes: platform::Processes,
    port: u16,
    token: String,
}

pub fn spawn(
    app: &tauri::App,
    port: u16,
    token: &str,
) -> Result<Sidecar, Box<dyn std::error::Error>> {
    let exe = launcher(&app.path().resource_dir()?);
    let mut command = Command::new(&exe);
    command
        .env("PAPEER_PORT", port.to_string())
        .env("PAPEER_TOKEN", token);
    Sidecar::start(command, port, token)
        .map_err(|e| format!("sidecar（{}）を起動できませんでした: {e}", exe.display()).into())
}

impl Sidecar {
    fn start(mut command: Command, port: u16, token: &str) -> io::Result<Sidecar> {
        // Nothing reads its output, which it writes for a console only.
        command
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        platform::prepare(&mut command);
        let child = command.spawn()?;
        let processes = platform::Processes::hold(&child);
        Ok(Sidecar {
            child: Mutex::new(Some(child)),
            processes,
            port,
            token: token.to_string(),
        })
    }

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
        self.end(EXIT_GRACE, SIDECAR_EXIT_TIMEOUT);
    }

    /// Wait up to `grace` for the sidecar to end, then send it /shutdown and wait up to `timeout`,
    /// then kill it. True if it had to be killed.
    fn end(&self, grace: Duration, timeout: Duration) -> bool {
        let Some(mut child) = self.child.lock().unwrap_or_else(|e| e.into_inner()).take() else {
            return false;
        };
        if exits_within(&mut child, grace) {
            return false;
        }
        let deadline = Instant::now() + timeout;
        request_shutdown(self.port, &self.token, timeout);
        if exits_within(
            &mut child,
            deadline.saturating_duration_since(Instant::now()),
        ) {
            return false;
        }
        self.processes.kill(&child);
        let _ = child.kill();
        exits_within(&mut child, KILL_TIMEOUT);
        true
    }
}

/// True if the process has ended, or ends within `timeout`.
fn exits_within(child: &mut Child, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            return true;
        }
        let left = deadline.saturating_duration_since(Instant::now());
        if left.is_zero() {
            return false;
        }
        std::thread::sleep(left.min(Duration::from_millis(50)));
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

#[cfg(windows)]
mod platform {
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};

    /// The launcher is a console program (sidecar.spec console=True): give it no console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn prepare(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    /// The sidecar's processes, held in a job object (job.rs); None if the job could not be made.
    pub struct Processes(Option<crate::job::Job>);

    impl Processes {
        /// Called at once after the start: the sidecar starts processes of its own (the CLIs) only
        /// when asked through its API, and those started later are in the job with it.
        pub fn hold(child: &Child) -> Processes {
            Processes(crate::job::Job::contain(child.id()).ok())
        }

        /// End the sidecar and the processes it started.
        pub fn kill(&self, child: &Child) {
            if self.0.as_ref().is_some_and(|job| job.terminate().is_ok()) {
                return;
            }
            // taskkill finds the descendants through the sidecar, so it goes before child.kill().
            let _ = Command::new("taskkill")
                .args(["/PID", &child.id().to_string(), "/T", "/F"])
                .creation_flags(CREATE_NO_WINDOW)
                .status();
        }

        #[cfg(test)]
        pub fn pids(&self) -> Vec<u32> {
            self.0
                .as_ref()
                .map(|job| job.pids().expect("pids"))
                .unwrap_or_default()
        }
    }
}

/// Not built yet. macOS and Linux have no job objects: start the launcher in a process group of its
/// own (std::os::unix::process::CommandExt::process_group(0)) and end that group with SIGKILL, so the
/// CLIs the sidecar runs end with it; what ends them if the app itself is killed is still to be decided.
#[cfg(not(windows))]
mod platform {
    use std::process::{Child, Command};

    pub fn prepare(_command: &mut Command) {}

    pub struct Processes;

    impl Processes {
        pub fn hold(_child: &Child) -> Processes {
            Processes
        }

        pub fn kill(&self, _child: &Child) {}
    }
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;

    fn cmd(script: &str) -> Command {
        let mut command = Command::new("cmd");
        command.args(["/d", "/c", script]);
        command
    }

    /// A port nobody listens on: /shutdown fails at once.
    fn closed_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("address").port()
    }

    #[test]
    fn launcher_is_in_the_bundle_folder_of_the_resource_directory() {
        let exe = launcher(Path::new(r"C:\Program Files\Papeer"));
        assert_eq!(
            exe,
            Path::new(r"C:\Program Files\Papeer\sidecar\papeer-sidecar.exe")
        );
    }

    #[test]
    fn a_sidecar_that_ends_by_itself_is_not_killed() {
        let sidecar =
            Sidecar::start(cmd("ping -n 2 127.0.0.1 >nul"), closed_port(), "t").expect("start");
        let started = Instant::now();
        assert!(!sidecar.end(Duration::from_secs(20), Duration::from_secs(1)));
        assert!(started.elapsed() < Duration::from_secs(10));
        // Once it has been ended, stopping again does nothing.
        assert!(!sidecar.end(Duration::ZERO, Duration::ZERO));
    }

    #[test]
    fn a_sidecar_that_does_not_end_is_killed_with_the_processes_it_started() {
        // cmd and the ping it runs, as the sidecar and a CLI it runs.
        let sidecar = Sidecar::start(
            cmd("ping -n 2 127.0.0.1 >nul & ping -n 60 127.0.0.1 >nul"),
            closed_port(),
            "t",
        )
        .expect("start");
        std::thread::sleep(Duration::from_millis(2500));
        assert!(sidecar.processes.pids().len() >= 2);
        assert!(sidecar.end(Duration::from_millis(100), Duration::from_millis(500)));
        let deadline = Instant::now() + Duration::from_secs(10);
        while !sidecar.processes.pids().is_empty() {
            assert!(Instant::now() < deadline, "{:?}", sidecar.processes.pids());
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    /// The real sidecar from frontend/src-tauri/sidecar (`just build-sidecar`), in the layout
    /// bundle.resources installs, started and stopped as the app does. Its data folder, LOCALAPPDATA
    /// and TEMP are a new temporary folder; nothing calls an AI.
    #[test]
    #[ignore = "needs `just build-sidecar`; run with cargo test --release -- --ignored"]
    fn the_built_sidecar_starts_from_its_folder_and_ends_by_itself() {
        let exe = launcher(Path::new(env!("CARGO_MANIFEST_DIR")));
        let root = std::env::temp_dir().join(format!("papeer-sidecar-test-{}", std::process::id()));
        let (data, local, temp) = (root.join("data"), root.join("local"), root.join("temp"));
        for dir in [&data, &local, &temp] {
            std::fs::create_dir_all(dir).expect("folder");
        }
        let port = closed_port();
        let mut command = Command::new(&exe);
        command
            .env("PAPEER_PORT", port.to_string())
            .env("PAPEER_TOKEN", "test-token")
            .env("PAPEER_DATA_DIR", &data)
            .env("LOCALAPPDATA", &local)
            .env("TEMP", &temp)
            .env("TMP", &temp);
        let started = Instant::now();
        let sidecar = Sidecar::start(command, port, "test-token").expect("start");
        let health =
            format!("GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n");
        loop {
            let mut answer = String::new();
            let answered = TcpStream::connect(SocketAddr::from(([127, 0, 0, 1], port)))
                .and_then(|mut stream| {
                    stream.write_all(health.as_bytes())?;
                    stream.read_to_string(&mut answer)
                })
                .is_ok();
            if answered && answer.starts_with("HTTP/1.1 200") {
                break;
            }
            assert!(started.elapsed() < Duration::from_secs(60), "no /health");
            std::thread::sleep(Duration::from_millis(50));
        }
        eprintln!("/health after {:?}", started.elapsed());
        assert!(!sidecar.processes.pids().is_empty());
        assert!(!sidecar.end(Duration::ZERO, SIDECAR_EXIT_TIMEOUT), "killed");
        let unpacked: Vec<_> = std::fs::read_dir(&temp)
            .expect("temp")
            .filter_map(|entry| entry.ok())
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("_MEI"))
            .collect();
        assert!(unpacked.is_empty(), "{unpacked:?}");
        let _ = std::fs::remove_dir_all(&root);
    }
}
