//! The packaged sidecar's lifetime (release builds only; `tauri dev` talks to `just dev-sidecar`).
//!
//! The sidecar is a PyInstaller onedir bundle (sidecar.spec): the folder `sidecar` that tauri.conf.json's
//! bundle.resources installs in the resource directory (next to papeer.exe on Windows, Contents/Resources
//! of Papeer.app on macOS, /usr/lib/Papeer with the .deb), holding the launcher papeer-sidecar(.exe) and its
//! `_internal` folder. The launcher runs Python in its own process and unpacks nothing into the temporary
//! folder (a onefile exe did, and left its _MEI* folder behind when killed).
//!
//! At exit the sidecar is given the chance to stop its jobs and end by itself; killing is the last
//! resort. When the app ends without that (a crash, a kill), the sidecar still stops its jobs and the
//! CLIs they run, and ends:
//!
//! - on every platform, its standard input is a pipe the app never writes to, which closes with the app's
//!   process; PAPEER_WATCH_STDIN=1 tells it to end then (sidecar/routes/system.py watch_stdin);
//! - on Windows, it also runs in a job object (job.rs) that ends it and the CLIs it runs, when it is
//!   terminated here and when the app exits however it exits (「タスクの終了」 included);
//! - on Linux, it is also sent SIGTERM when the app's process ends (PR_SET_PDEATHSIG).
//!
//! What differs between platforms (starting the launcher, holding and ending its processes, the PATH it
//! gets) is in `platform` below.

use std::ffi::OsString;
use std::io::{self, Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

use tauri::Manager;

/// The bundle's folder in the resource directory (sidecar.spec COLLECT, tauri.conf.json bundle.resources).
const SIDECAR_DIR: &str = "sidecar";
/// Its launcher, without the platform's executable suffix (sidecar.spec EXE).
const SIDECAR_EXE: &str = "papeer-sidecar";
/// Tells the sidecar to end when its standard input (the app's pipe) closes (sidecar/routes/system.py).
const WATCH_STDIN_VARIABLE: &str = "PAPEER_WATCH_STDIN";

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
    /// Holds the write end of the sidecar's stdin pipe (Child::stdin) until the sidecar has ended.
    child: Mutex<Option<Child>>,
    processes: platform::Processes,
    port: u16,
    token: String,
}

/// The PATH to start the sidecar with (platform::search_path), looked up on a thread of its own from the
/// start of run(), while Tauri builds the app, instead of on the main thread in the setup hook.
pub struct SearchPath {
    receiver: mpsc::Receiver<Option<OsString>>,
    deadline: Instant,
}

impl SearchPath {
    pub fn look_up() -> SearchPath {
        let (sender, receiver) = mpsc::channel();
        std::thread::spawn(move || {
            let _ = sender.send(platform::search_path());
        });
        SearchPath {
            receiver,
            // search_path gives up by itself after its own timeout; this only bounds the wait for it.
            deadline: Instant::now() + platform::SEARCH_PATH_TIMEOUT + Duration::from_secs(1),
        }
    }

    /// The PATH, if it was found; waits for what is left of the lookup's time at most.
    fn take(self) -> Option<OsString> {
        self.receiver
            .recv_timeout(self.deadline.saturating_duration_since(Instant::now()))
            .ok()
            .flatten()
    }
}

pub fn spawn(
    app: &tauri::App,
    port: u16,
    token: &str,
    search_path: SearchPath,
) -> Result<Sidecar, Box<dyn std::error::Error>> {
    let exe = launcher(&app.path().resource_dir()?);
    let mut command = Command::new(&exe);
    command
        .env("PAPEER_PORT", port.to_string())
        .env("PAPEER_TOKEN", token);
    if let Some(path) = search_path.take() {
        command.env("PATH", path);
    }
    // Called from the setup hook, on the main thread, which lives as long as the app: on Linux the
    // sidecar is sent SIGTERM when the thread that started it ends (PR_SET_PDEATHSIG, platform::prepare).
    Sidecar::start(command, port, token)
        .map_err(|e| format!("sidecar（{}）を起動できませんでした: {e}", exe.display()).into())
}

impl Sidecar {
    fn start(mut command: Command, port: u16, token: &str) -> io::Result<Sidecar> {
        // Nothing reads its output, which it writes for a console only. Nothing is written to its
        // stdin either: the pipe only closes when this process ends (WATCH_STDIN_VARIABLE).
        command
            .env(WATCH_STDIN_VARIABLE, "1")
            .stdin(Stdio::piped())
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
        self.processes.kill(&mut child);
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

/// The PATH printed by a login shell's output between two markers (platform::search_path), if any.
#[cfg_attr(windows, allow(dead_code))]
fn marked_path(output: &str) -> Option<&str> {
    let (_, rest) = output.split_once(PATH_MARKER)?;
    let (path, _) = rest.split_once(PATH_MARKER)?;
    Some(path.trim()).filter(|path| !path.is_empty())
}

/// Around the PATH a login shell prints, so that whatever its startup files print is left out.
#[cfg_attr(windows, allow(dead_code))]
const PATH_MARKER: &str = "__PAPEER_PATH__";

/// `first`'s folders, then those of `then` that `first` does not have. Only absolute folders: an empty
/// or relative entry would be looked up from whatever folder a program runs in.
#[cfg_attr(windows, allow(dead_code))]
fn joined_path(first: &str, then: &str) -> String {
    let mut seen = std::collections::HashSet::new();
    first
        .split(':')
        .chain(then.split(':'))
        .filter(|folder| folder.starts_with('/') && seen.insert(*folder))
        .collect::<Vec<_>>()
        .join(":")
}

#[cfg(windows)]
mod platform {
    use std::ffi::OsString;
    use std::os::windows::process::CommandExt;
    use std::process::{Child, Command};
    use std::time::Duration;

    /// The launcher is a console program (sidecar.spec console=True): give it no console window.
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;

    pub fn prepare(command: &mut Command) {
        command.creation_flags(CREATE_NO_WINDOW);
    }

    /// An app started from the Start menu has the user's PATH already.
    pub fn search_path() -> Option<OsString> {
        None
    }

    pub const SEARCH_PATH_TIMEOUT: Duration = Duration::ZERO;

    /// The sidecar's processes, held in a job object (job.rs); None if the job could not be made.
    pub struct Processes(Option<crate::job::Job>);

    impl Processes {
        /// Called at once after the start: the sidecar starts processes of its own (the CLIs) only
        /// when asked through its API, and those started later are in the job with it.
        pub fn hold(child: &Child) -> Processes {
            Processes(crate::job::Job::contain(child.id()).ok())
        }

        /// End the sidecar and the processes it started.
        pub fn kill(&self, child: &mut Child) {
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

/// macOS and Linux have no job objects. The sidecar runs in a process group of its own, which is sent
/// SIGTERM when it has to be ended (it then stops its jobs and the CLIs, sidecar/routes/system.py), and
/// SIGKILL if it is still there after TERM_GRACE. The CLIs run in sessions of their own (so that the
/// sidecar can end each with its processes: papeer/providers/common.py kill_tree), out of this group:
/// they end with the sidecar's jobs, not with the group.
#[cfg(unix)]
mod platform {
    use std::ffi::{CStr, OsStr, OsString};
    use std::io::Read;
    use std::os::unix::ffi::OsStrExt;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc;
    use std::time::Duration;

    /// How long the sidecar may take to end after SIGTERM before its group is sent SIGKILL. It stops
    /// serving (up to 3 s, SIGTERM_REQUEST_TIMEOUT in sidecar/app.py), ends the running CLIs (up to 2 s,
    /// CLI_TERM_GRACE in papeer/providers/common.py), then waits for its jobs: the CLIs, each in a session
    /// of its own out of the sidecar's group, are ended well before this runs out.
    const TERM_GRACE: Duration = Duration::from_secs(15);
    /// How long a login shell may take to print its PATH.
    pub const SEARCH_PATH_TIMEOUT: Duration = Duration::from_secs(5);

    pub fn prepare(command: &mut Command) {
        command.process_group(0);
        #[cfg(target_os = "linux")]
        {
            // The app's pid, read before the fork: the child checks it is still its parent.
            let parent = std::process::id() as libc::pid_t;
            // SAFETY: prctl and getppid are async-signal-safe, and nothing else runs in the closure.
            unsafe {
                command.pre_exec(move || {
                    if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) == -1 {
                        return Err(std::io::Error::last_os_error());
                    }
                    // The app ended between the fork and the prctl: the signal would never come.
                    if libc::getppid() != parent {
                        return Err(std::io::Error::from_raw_os_error(libc::ESRCH));
                    }
                    Ok(())
                });
            }
        }
    }

    /// The PATH of the user's login shell, then the app's own PATH. An app opened from the Finder or the
    /// Dock gets launchd's (/usr/bin:/bin:/usr/sbin:/sbin), without Homebrew, ~/.local/bin, nvm..., where
    /// the CLIs and the Node.js they need are; a Linux desktop may leave out what ~/.bashrc adds. None if
    /// the shell does not answer in time (its PATH is then only what the sidecar adds itself:
    /// papeer/providers/common.py unix_bin_folders).
    pub fn search_path() -> Option<OsString> {
        // SAFETY: isatty only looks at the descriptor. Started from a terminal, the app has its PATH.
        if unsafe { libc::isatty(libc::STDIN_FILENO) } == 1 {
            return None;
        }
        let current = std::env::var("PATH").unwrap_or_default();
        let login = login_shell_path()?;
        Some(super::joined_path(&login, &current).into())
    }

    /// $SHELL, else the user's shell in the user database (getpwuid_r), else /bin/sh.
    fn user_shell() -> OsString {
        if let Some(shell) = std::env::var_os("SHELL").filter(|shell| !shell.is_empty()) {
            return shell;
        }
        let mut buffer = vec![0 as libc::c_char; 16 * 1024];
        // SAFETY: an all-zero passwd is a valid value for getpwuid_r to fill in.
        let mut entry: libc::passwd = unsafe { std::mem::zeroed() };
        let mut found: *mut libc::passwd = std::ptr::null_mut();
        // SAFETY: the buffers are ours and sized as passed; the strings of `entry` point into `buffer`,
        // which outlives their use below.
        let status = unsafe {
            libc::getpwuid_r(
                libc::getuid(),
                &mut entry,
                buffer.as_mut_ptr(),
                buffer.len(),
                &mut found,
            )
        };
        if status == 0 && !found.is_null() && !entry.pw_shell.is_null() {
            // SAFETY: a NUL-terminated string inside `buffer`.
            let shell = unsafe { CStr::from_ptr(entry.pw_shell) }.to_bytes();
            if !shell.is_empty() {
                return OsStr::from_bytes(shell).to_os_string();
            }
        }
        "/bin/sh".into()
    }

    fn login_shell_path() -> Option<String> {
        let marker = super::PATH_MARKER;
        let mut child = Command::new(user_shell())
            .args(["-l", "-i", "-c"])
            .arg(format!("printf '%s%s%s' {marker} \"$PATH\" {marker}"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0)
            .spawn()
            .ok()?;
        let mut stdout = child.stdout.take()?;
        let (sender, receiver) = mpsc::channel();
        // Read on a thread of its own: a startup file may leave a process behind that keeps stdout open.
        std::thread::spawn(move || {
            let mut output = Vec::new();
            let _ = stdout.read_to_end(&mut output);
            let _ = sender.send(output);
        });
        let output = receiver.recv_timeout(SEARCH_PATH_TIMEOUT).ok();
        signal_group(child.id(), libc::SIGKILL);
        let _ = child.wait();
        // A startup file may print anything, in any encoding: the markers and the PATH are ASCII.
        let output = String::from_utf8_lossy(&output?).into_owned();
        super::marked_path(&output).map(str::to_string)
    }

    fn signal_group(pgid: u32, signal: libc::c_int) {
        // SAFETY: a plain system call; a group that is gone already makes it fail with ESRCH.
        unsafe {
            libc::killpg(pgid as libc::pid_t, signal);
        }
    }

    /// The sidecar's process group (its pid, as the group's leader).
    pub struct Processes(u32);

    impl Processes {
        pub fn hold(child: &Child) -> Processes {
            Processes(child.id())
        }

        /// SIGTERM to the sidecar's group, then SIGKILL if it has not ended within TERM_GRACE.
        pub fn kill(&self, child: &mut Child) {
            signal_group(self.0, libc::SIGTERM);
            if !super::exits_within(child, TERM_GRACE) {
                signal_group(self.0, libc::SIGKILL);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A shell running `script`: cmd on Windows, sh elsewhere.
    fn shell(windows: &str, unix: &str) -> Command {
        if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/d", "/c", windows]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", unix]);
            command
        }
    }

    /// A port nobody listens on: /shutdown fails at once.
    fn closed_port() -> u16 {
        let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.local_addr().expect("address").port()
    }

    #[test]
    fn launcher_is_in_the_bundle_folder_of_the_resource_directory() {
        let resources = std::env::temp_dir().join("Papeer");
        let exe = launcher(&resources);
        assert_eq!(exe.parent(), Some(resources.join("sidecar").as_path()));
        let expected = if cfg!(windows) {
            "papeer-sidecar.exe"
        } else {
            "papeer-sidecar"
        };
        assert_eq!(
            exe.file_name().and_then(|name| name.to_str()),
            Some(expected)
        );
    }

    #[test]
    fn a_login_shells_path_comes_first_and_the_apps_follows() {
        let output = format!("Welcome!\n{PATH_MARKER}/opt/homebrew/bin:/usr/bin{PATH_MARKER}");
        let login = marked_path(&output).expect("marked");
        assert_eq!(login, "/opt/homebrew/bin:/usr/bin");
        assert_eq!(
            joined_path(login, "/usr/bin:/bin::/usr/sbin:relative/bin:."),
            "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin"
        );
        assert_eq!(marked_path("no markers"), None);
        assert_eq!(marked_path(&format!("{PATH_MARKER}{PATH_MARKER}")), None);
    }

    #[test]
    fn a_sidecar_that_ends_by_itself_is_not_killed() {
        let sidecar = Sidecar::start(
            shell("ping -n 2 127.0.0.1 >nul", "sleep 1"),
            closed_port(),
            "t",
        )
        .expect("start");
        let started = Instant::now();
        assert!(!sidecar.end(Duration::from_secs(20), Duration::from_secs(1)));
        assert!(started.elapsed() < Duration::from_secs(10));
        // Once it has been ended, stopping again does nothing.
        assert!(!sidecar.end(Duration::ZERO, Duration::ZERO));
    }

    #[test]
    fn the_sidecar_is_told_to_watch_its_stdin_which_closes_with_the_app() {
        // A sidecar that ends when its stdin ends, and says whether it was asked to (exit code 0).
        let sidecar = Sidecar::start(
            shell(
                "sort >nul & if %PAPEER_WATCH_STDIN%==1 (exit 0) else (exit 3)",
                "cat >/dev/null; test \"$PAPEER_WATCH_STDIN\" = 1",
            ),
            closed_port(),
            "t",
        )
        .expect("start");
        let mut child = sidecar.child.lock().unwrap().take().expect("child");
        assert!(!exits_within(&mut child, Duration::from_millis(500)));
        // What happens to the pipe when the app's process ends, however it ends.
        drop(child.stdin.take());
        assert!(exits_within(&mut child, Duration::from_secs(10)));
        assert_eq!(child.wait().expect("status").code(), Some(0));
    }

    #[cfg(windows)]
    #[test]
    fn a_sidecar_that_does_not_end_is_killed_with_the_processes_it_started() {
        // cmd and the ping it runs, as the sidecar and a CLI it runs.
        let sidecar = Sidecar::start(
            shell("ping -n 2 127.0.0.1 >nul & ping -n 60 127.0.0.1 >nul", ""),
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

    /// Whether a process is still running.
    #[cfg(unix)]
    fn alive(pid: libc::pid_t) -> bool {
        // SAFETY: signal 0 only checks that the process exists.
        if unsafe { libc::kill(pid, 0) } != 0 {
            return false;
        }
        // A zombie (ended, waiting for a parent to read its status) runs no more.
        #[cfg(target_os = "linux")]
        if let Ok(stat) = std::fs::read_to_string(format!("/proc/{pid}/stat")) {
            if let Some((_, fields)) = stat.rsplit_once(')') {
                return !fields.trim_start().starts_with('Z');
            }
        }
        true
    }

    /// `sh` in its own group running a child (`sleep`), as the sidecar and a process it started; the
    /// child's pid is written to a file. Returned once the child runs.
    #[cfg(unix)]
    fn tree(script_before: &str) -> (Sidecar, libc::pid_t, tempfile_path::Path) {
        let file = tempfile_path::Path::new();
        let script = format!(
            "{script_before} sleep 60 & echo $! > '{}'; wait",
            file.0.display()
        );
        let sidecar = Sidecar::start(shell("", &script), closed_port(), "t").expect("start");
        let deadline = Instant::now() + Duration::from_secs(10);
        let child = loop {
            if let Some(pid) = std::fs::read_to_string(&file.0)
                .ok()
                .and_then(|text| text.trim().parse().ok())
            {
                break pid;
            }
            assert!(Instant::now() < deadline, "the child did not start");
            std::thread::sleep(Duration::from_millis(20));
        };
        (sidecar, child, file)
    }

    #[cfg(unix)]
    fn gone_within(pid: libc::pid_t, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        while alive(pid) {
            if Instant::now() > deadline {
                return false;
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        true
    }

    #[cfg(unix)]
    #[test]
    fn a_sidecar_that_does_not_end_is_sent_sigterm_with_its_group() {
        let (sidecar, child, _file) = tree("");
        let started = Instant::now();
        assert!(sidecar.end(Duration::from_millis(100), Duration::from_millis(500)));
        // SIGTERM was enough: no wait for SIGKILL.
        assert!(
            started.elapsed() < Duration::from_secs(4),
            "{:?}",
            started.elapsed()
        );
        assert!(gone_within(child, Duration::from_secs(10)));
    }

    #[cfg(unix)]
    #[test]
    fn a_sidecar_that_ignores_sigterm_is_killed_with_its_group() {
        // `trap '' TERM` is inherited by the child as well.
        let (sidecar, child, _file) = tree("trap '' TERM;");
        let started = Instant::now();
        assert!(sidecar.end(Duration::from_millis(100), Duration::from_millis(500)));
        assert!(
            started.elapsed() >= Duration::from_secs(5),
            "{:?}",
            started.elapsed()
        );
        assert!(gone_within(child, Duration::from_secs(10)));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn linux_sends_sigterm_when_the_thread_that_started_the_sidecar_ends() {
        // PR_SET_PDEATHSIG follows the thread that started the process (the app starts the sidecar
        // on its main thread): ending that thread plays the app's process ending.
        let sidecar = std::thread::spawn(|| {
            Sidecar::start(shell("", "exec sleep 60"), closed_port(), "t").expect("start")
        })
        .join()
        .expect("thread");
        let mut child = sidecar.child.lock().unwrap().take().expect("child");
        assert!(exits_within(&mut child, Duration::from_secs(10)));
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(child.wait().expect("status").signal(), Some(libc::SIGTERM));
    }

    /// A file name in the temporary folder, removed when dropped.
    #[cfg(unix)]
    mod tempfile_path {
        pub struct Path(pub std::path::PathBuf);

        impl Path {
            pub fn new() -> Path {
                use std::sync::atomic::{AtomicU32, Ordering};
                static NEXT: AtomicU32 = AtomicU32::new(0);
                Path(std::env::temp_dir().join(format!(
                    "papeer-sidecar-test-{}-{}",
                    std::process::id(),
                    NEXT.fetch_add(1, Ordering::Relaxed)
                )))
            }
        }

        impl Drop for Path {
            fn drop(&mut self) {
                let _ = std::fs::remove_file(&self.0);
            }
        }
    }

    /// The real sidecar from frontend/src-tauri/sidecar (`just build-sidecar`), in the layout
    /// bundle.resources installs, started as the app does. Its data folder, this PC's folders
    /// (LOCALAPPDATA; HOME and the XDG folders) and the temporary folder are a new temporary folder;
    /// nothing calls an AI.
    struct BuiltSidecar {
        sidecar: Sidecar,
        root: PathBuf,
        temp: PathBuf,
    }

    impl BuiltSidecar {
        fn start(name: &str) -> BuiltSidecar {
            let exe = launcher(Path::new(env!("CARGO_MANIFEST_DIR")));
            let root = std::env::temp_dir()
                .join(format!("papeer-sidecar-test-{name}-{}", std::process::id()));
            let (data, pc, temp) = (root.join("data"), root.join("pc"), root.join("temp"));
            for dir in [&data, &pc.join("home"), &temp] {
                std::fs::create_dir_all(dir).expect("folder");
            }
            let port = closed_port();
            let mut command = Command::new(&exe);
            command
                .env("PAPEER_PORT", port.to_string())
                .env("PAPEER_TOKEN", "test-token")
                .env("PAPEER_DATA_DIR", &data)
                .env("LOCALAPPDATA", pc.join("localappdata"))
                .env("XDG_DATA_HOME", pc.join("xdg-data"))
                .env("XDG_STATE_HOME", pc.join("xdg-state"))
                .env("XDG_CACHE_HOME", pc.join("xdg-cache"))
                .env("XDG_CONFIG_HOME", pc.join("xdg-config"))
                .env("TEMP", &temp)
                .env("TMP", &temp)
                .env("TMPDIR", &temp);
            if cfg!(unix) {
                // Python reads HOME only on macOS and Linux (~/Library/... on macOS).
                command.env("HOME", pc.join("home"));
            }
            let started = Instant::now();
            let sidecar = Sidecar::start(command, port, "test-token").expect("start");
            let health = format!(
                "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
            );
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
            BuiltSidecar {
                sidecar,
                root,
                temp,
            }
        }

        fn nothing_unpacked(&self) {
            let unpacked: Vec<_> = std::fs::read_dir(&self.temp)
                .expect("temp")
                .filter_map(|entry| entry.ok())
                .filter(|entry| entry.file_name().to_string_lossy().starts_with("_MEI"))
                .collect();
            assert!(unpacked.is_empty(), "{unpacked:?}");
        }
    }

    impl Drop for BuiltSidecar {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    #[ignore = "needs `just build-sidecar`; run with cargo test --release -- --ignored"]
    fn the_built_sidecar_starts_from_its_folder_and_ends_by_itself() {
        let built = BuiltSidecar::start("shutdown");
        #[cfg(windows)]
        assert!(!built.sidecar.processes.pids().is_empty());
        assert!(
            !built.sidecar.end(Duration::ZERO, SIDECAR_EXIT_TIMEOUT),
            "killed"
        );
        built.nothing_unpacked();
    }

    #[test]
    #[ignore = "needs `just build-sidecar`; run with cargo test --release -- --ignored"]
    fn the_built_sidecar_ends_by_itself_when_the_app_is_gone() {
        let built = BuiltSidecar::start("app-gone");
        let mut child = built.sidecar.child.lock().unwrap().take().expect("child");
        // What happens to the pipe when the app's process ends, however it ends (a crash, a kill).
        drop(child.stdin.take());
        assert!(
            exits_within(&mut child, SIDECAR_EXIT_TIMEOUT),
            "still running"
        );
        assert_eq!(child.wait().expect("status").code(), Some(0));
        built.nothing_unpacked();
    }
}
