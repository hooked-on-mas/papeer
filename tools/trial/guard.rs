use std::path::{Path, PathBuf};
use std::os::windows::fs::MetadataExt;

pub fn checked_directory(path: &Path) -> Result<(), &'static str> {
    if !path.is_absolute() { return Err("trial path must be absolute"); }
    for component in path.ancestors() {
        let info = std::fs::symlink_metadata(component).map_err(|_| "trial directory missing")?;
        if !info.is_dir() || info.file_attributes() & 0x400 != 0 {
            return Err("trial path is not a directory or contains a reparse point");
        }
    }
    Ok(())
}

pub fn checked_root(root: &Path) -> Result<Vec<PathBuf>, &'static str> {
    let dirs = vec![root.to_path_buf(), root.join("library"), root.join("localappdata"),
        root.join("localappdata/PapeerSync"), root.join("appdata"), root.join("temp"), root.join("ai"), root.join("xdg")];
    for dir in &dirs { checked_directory(dir)?; }
    // Canonical storage and backups are siblings of the selected library root.
    for sibling in [root.join(".library-shared-app"), root.join(".library-shared-app-backups")] {
        match std::fs::symlink_metadata(&sibling) {
            Ok(_) => checked_directory(&sibling)?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("cannot inspect canonical sibling"),
        }
    }
    let marker = root.join(".papeer-shared-trial");
    let info = std::fs::symlink_metadata(&marker).map_err(|_| "trial marker missing")?;
    if !info.is_file() || info.file_attributes() & 0x400 != 0 { return Err("invalid trial marker"); }
    if std::fs::read(marker).map_err(|_| "trial marker unreadable")? != b"papeer-shared-trial-v1\n" {
        return Err("trial marker mismatch");
    }
    Ok(dirs)
}

pub fn should_remove(name: &str) -> bool {
    let name = name.to_ascii_uppercase();
    ["PAPEER_", "PAPERDESK_", "WEBVIEW2_", "OPENAI_", "GEMINI_", "ANTHROPIC_", "GOOGLE_", "AZURE_", "AWS_", "CLAUDE_", "CODEX_"].iter().any(|prefix| name.starts_with(prefix)) || name.ends_with("_API_KEY") || ["PYTHONPATH", "PYTHONHOME", "VIRTUAL_ENV"].contains(&name.as_str())
}

pub fn prepare(root: &Path) -> Result<(), &'static str> {
    checked_root(root)?;
    // The only debugging override accepted is one numeric port on the local machine. WebView2
    // receives no inherited arbitrary profile/flag setting. Harnesses must use this explicit opt-in.
    let debug_port = match std::env::var("PAPEER_SHARED_TRIAL_CDP_PORT") {
        Ok(value) if value.bytes().all(|b| b.is_ascii_digit()) && value.parse::<u16>().is_ok_and(|p| p > 0) => Some(value),
        Ok(_) => return Err("invalid trial debugging port"),
        Err(std::env::VarError::NotPresent) => None,
        Err(_) => return Err("invalid trial debugging port"),
    };
    let windows = std::env::var_os("SystemRoot").ok_or("SystemRoot missing")?;
    let system32 = PathBuf::from(windows).join("System32");
    checked_directory(&system32)?;
    for (key, _) in std::env::vars_os() {
        if should_remove(&key.to_string_lossy()) { std::env::remove_var(key); }
    }
    std::env::set_var("PAPEER_DATA_DIR", root.join("library"));
    std::env::set_var("LOCALAPPDATA", root.join("localappdata"));
    std::env::set_var("APPDATA", root.join("appdata"));
    for name in ["TEMP", "TMP", "TMPDIR"] { std::env::set_var(name, root.join("temp")); }
    std::env::set_var("PATH", system32);
    std::env::set_var("CODEX_HOME", root.join("ai/codex"));
    std::env::set_var("CLAUDE_CONFIG_DIR", root.join("ai/claude"));
    for (name, suffix) in [("XDG_DATA_HOME", "data"), ("XDG_STATE_HOME", "state"), ("XDG_CACHE_HOME", "cache"), ("XDG_CONFIG_HOME", "config")] { std::env::set_var(name, root.join("xdg").join(suffix)); }
    if let Some(port) = debug_port {
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", format!("--remote-debugging-port={port} --remote-debugging-address=127.0.0.1"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    fn fresh() -> PathBuf {
        let root = std::env::temp_dir().join(format!("papeer-trial-guard-{}-{:?}", std::process::id(), std::thread::current().id()));
        fs::create_dir(&root).unwrap(); root
    }
    fn provision(root: &Path) {
        for dir in ["library", "localappdata/PapeerSync", "appdata", "temp", "ai", "xdg"] { fs::create_dir_all(root.join(dir)).unwrap(); }
        fs::write(root.join(".papeer-shared-trial"), b"papeer-shared-trial-v1\n").unwrap();
    }
    #[test] fn provisioned_root_is_accepted() { let root=fresh(); provision(&root); assert!(checked_root(&root).is_ok()); fs::remove_dir_all(root).unwrap(); }
    #[test] fn missing_or_invalid_marker_is_rejected() { let root=fresh(); provision(&root); fs::remove_file(root.join(".papeer-shared-trial")).unwrap(); assert!(checked_root(&root).is_err()); fs::write(root.join(".papeer-shared-trial"), b"wrong").unwrap(); assert!(checked_root(&root).is_err()); fs::remove_dir_all(root).unwrap(); }
    #[test] fn missing_device_or_relative_root_is_rejected() { let root=fresh(); provision(&root); fs::remove_dir(root.join("localappdata/PapeerSync")).unwrap(); assert!(checked_root(&root).is_err()); assert!(checked_root(Path::new("relative")).is_err()); fs::remove_dir_all(root).unwrap(); }
    #[test] fn environment_is_replaced_before_startup() {
        let root=fresh(); provision(&root);
        let original_temp = std::env::var_os("TEMP").unwrap();
        let original_tmp = std::env::var_os("TMP").unwrap();
        std::env::set_var("PAPEER_DATA_DIR", "unsafe");
        std::env::set_var("PAPEER_DEV_NO_AUTH", "1");
        std::env::set_var("WEBVIEW2_USER_DATA_FOLDER", "unsafe");
        std::env::set_var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", "unsafe");
        std::env::set_var("PAPEER_SHARED_TRIAL_CDP_PORT", "9229");
        prepare(&root).unwrap();
        assert_eq!(std::env::var_os("PAPEER_DATA_DIR").unwrap(), root.join("library"));
        assert_eq!(std::env::var_os("LOCALAPPDATA").unwrap(), root.join("localappdata"));
        assert!(std::env::var_os("PAPEER_DEV_NO_AUTH").is_none());
        assert!(std::env::var_os("WEBVIEW2_USER_DATA_FOLDER").is_none());
        assert_eq!(std::env::var("WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS").unwrap(), "--remote-debugging-port=9229 --remote-debugging-address=127.0.0.1");
        std::env::set_var("TEMP", original_temp);
        std::env::set_var("TMP", original_tmp);
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn invalid_canonical_sibling_is_rejected() {
        let root=fresh(); provision(&root);
        fs::write(root.join(".library-shared-app"), b"not a directory").unwrap();
        assert!(checked_root(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
    #[test] fn inherited_profile_and_secrets_are_removed() { for value in ["PAPEER_DATA_DIR", "paperdesk_dev_no_auth", "WEBVIEW2_USER_DATA_FOLDER", "OPENAI_API_KEY", "AWS_PROFILE"] { assert!(should_remove(value)); } assert!(!should_remove("SystemRoot")); }
}







