fn main() {
    // The app's own commands get permissions (allow-<name>) so the
    // capabilities can grant each page only what it uses: the placeholder
    // page Retry and Start, the dashboard (a remote origin to Tauri) the
    // expired-session signal, its notifications and, behind BUDDI_SHELL_DEBUG, its console.
    tauri_build::try_build(tauri_build::Attributes::new().app_manifest(
        tauri_build::AppManifest::new().commands(&["retry", "start_buddi", "session_expired", "notify", "shell_log"]),
    ))
    .expect("tauri-build failed");
}
