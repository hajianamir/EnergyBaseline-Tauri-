mod sidecar;

use serde_json::Value;
use sidecar::SidecarHandle;
use std::path::PathBuf;
use std::sync::Arc;
use tauri::Manager;
use tauri_plugin_fs::FsExt;

/// Compile-time method allowlist matching SCR-7 / ARC-6. The Rust shell never
/// forwards arbitrary frontend method names to the Python process.
fn is_method_allowed(method: &str) -> bool {
    const ALLOWLIST: &[&str] = &[
        "data.ingest",
        "data.window",
        "vsg.get",
        "vsg.set",
        "vsg.preset_save",
        "vsg.preset_load",
        "tcp.get",
        "tcp.set",
        "tcp.estimate",
        "tcp.reevaluate",
        "analysis.run",
        "analysis.cancel",
        "diagnostics.run",
        "model.predict",
        "model.export",
        "model.card",
        "report.generate",
        "report.diff",
        "sql.test_connection",
        "sql.run_query",
        "session.save",
        "session.load",
        "system.status",
        "system.health",
        "system.sbom",
    ];
    ALLOWLIST.contains(&method)
}

#[tauri::command]
async fn rpc_call(
    state: tauri::State<'_, Arc<SidecarHandle>>,
    method: String,
    params: Value,
    id: Value,
) -> Result<Value, String> {
    if !is_method_allowed(&method) {
        return Err(format!(
            "VALIDATION: Method '{}' is not on the compile-time allowlist.",
            method
        ));
    }
    state.inner().clone().call(method, params, id).await
}

#[tauri::command]
async fn rpc_cancel(
    state: tauri::State<'_, Arc<SidecarHandle>>,
    id: Value,
) -> Result<Value, String> {
    state.inner().clone().cancel(id).await
}

fn resolve_app_home(app: &tauri::AppHandle) -> PathBuf {
    if let Ok(executable) = std::env::current_exe() {
        if let Some(executable_dir) = executable.parent() {
            if executable_dir.join("portable.flag").is_file() {
                return executable_dir.to_path_buf();
            }
        }
    }
    let base = app
        .path()
        .local_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    base.join("EnergyBaseline")
}

fn resolve_log_path(app_home: &PathBuf) -> PathBuf {
    let preferred = app_home.join("logs").join("sidecar.log");
    if std::fs::create_dir_all(preferred.parent().expect("log path has parent")).is_ok() {
        return preferred;
    }
    let fallback = std::env::temp_dir()
        .join("EnergyBaseline")
        .join("logs")
        .join("sidecar.log");
    let _ = std::fs::create_dir_all(fallback.parent().expect("fallback log path has parent"));
    fallback
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_home = resolve_app_home(app.handle());
            // Preserve the requested APP_HOME even when it is read-only: the sidecar
            // owns the SQLite fallback ladder and will select TEMP or memory as needed.
            let _ = std::fs::create_dir_all(&app_home);
            // The capability grants fs operations but starts with no global paths.
            // Allow only the resolved APP_HOME (including portable mode); the dialog
            // plugin separately grants paths the user explicitly selects.
            if let Err(error) = app.fs_scope().allow_directory(&app_home, true) {
                eprintln!("Could not scope the filesystem to APP_HOME: {error}");
            }
            let log_path = resolve_log_path(&app_home);
            let sidecar = SidecarHandle::new(app.handle().clone(), app_home, log_path);
            app.manage(Arc::clone(&sidecar));
            if let Err(error) = sidecar.start() {
                eprintln!("EnergyBaseline sidecar startup deferred: {error}");
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                // Closing the CommandChild writer sends stdin EOF. Let the Python sidecar
                // close cleanly, then terminate its whole process tree if it exceeds 10 s.
                api.prevent_close();
                let app = window.app_handle().clone();
                let sidecar = window.state::<Arc<SidecarHandle>>().inner().clone();
                tauri::async_runtime::spawn(async move {
                    sidecar.shutdown_gracefully().await;
                    app.exit(0);
                });
            }
        })
        .invoke_handler(tauri::generate_handler![rpc_call, rpc_cancel])
        .run(tauri::generate_context!())
        .expect("error while running EnergyBaseline");
}

#[cfg(test)]
mod tests {
    use super::is_method_allowed;

    #[test]
    fn frontend_method_allowlist_is_closed() {
        assert!(is_method_allowed("system.status"));
        assert!(is_method_allowed("analysis.cancel"));
        assert!(!is_method_allowed("system.shutdown"));
        assert!(!is_method_allowed("sql.drop_table"));
    }
}
