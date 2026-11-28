// This entry point is compiled only in the isolated trial Cargo overlay.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
#[cfg(not(target_os = "windows"))]
compile_error!("The shared trial is Windows-only");
mod guard;
fn main() {
    let root = std::path::Path::new(env!("PAPEER_SHARED_TRIAL_ROOT"));
    if let Err(error) = guard::prepare(root) {
        eprintln!("Trial isolation unavailable: {error}");
        std::process::exit(1);
    }
    papeer_lib::run();
}
