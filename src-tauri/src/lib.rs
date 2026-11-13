// EnergyBaseline Tauri 2 Shell Core (ARC-1..ARC-7, IPC-1..IPC-10, LIF-1..LIF-5)
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::{Arc, Mutex};
use tauri::Manager;

const MAX_FRAME_BYTES: usize = 1024 * 1024; // 1 MiB (IPC-1)
const PROTOCOL_VERSION: &str = "1.0";

/// Compile-time method allowlist matching SCR-7 / ARC-6
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

pub struct SidecarHandle {
    child: Mutex<Option<Child>>,
    stdin: Mutex<Option<ChildStdin>>,
    app_home: String,
    active_ids: Mutex<HashSet<String>>,
}

impl SidecarHandle {
    pub fn shutdown_gracefully(&self) {
        // LIF-1: Close stdin (authoritative EOF signal), then wait/reap
        if let Ok(mut guard) = self.stdin.lock() {
            *guard = None;
        }
        if let Ok(mut child_guard) = self.child.lock() {
            if let Some(mut ch) = child_guard.take() {
                let _ = ch.wait();
            }
        }
    }
}

#[tauri::command]
pub async fn rpc_call(
    state: tauri::State<'_, Arc<SidecarHandle>>,
    method: String,
    params: serde_json::Value,
    id: serde_json::Value,
) -> Result<serde_json::Value, String> {
    if !is_method_allowed(&method) {
        return Err(format!("VALIDATION: Method '{}' is not on the compile-time allowlist (ARC-6).", method));
    }

    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": method,
        "params": params
    });
    let serialized = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    if serialized.len() > MAX_FRAME_BYTES {
        return Err("VALIDATION: Frame exceeds 1 MiB limit (IPC-1).".to_string());
    }

    let mut stdin_guard = state.stdin.lock().map_err(|_| "INTERNAL: Lock poisoned".to_string())?;
    let stdin = stdin_guard
        .as_mut()
        .ok_or_else(|| "INTERNAL: Sidecar stdin unavailable".to_string())?;
    writeln!(stdin, "{}", serialized).map_err(|e| format!("INTERNAL: Write failed: {}", e))?;
    stdin.flush().map_err(|e| e.to_string())?;

    Ok(serde_json::json!({ "dispatched": true, "method": method }))
}

#[tauri::command]
pub async fn rpc_cancel(
    state: tauri::State<'_, Arc<SidecarHandle>>,
    id: serde_json::Value,
) -> Result<serde_json::Value, String> {
    let req = serde_json::json!({
        "jsonrpc": "2.0",
        "id": id,
        "method": "rpc_cancel",
        "params": { "id": id }
    });
    let serialized = serde_json::to_string(&req).map_err(|e| e.to_string())?;
    let mut stdin_guard = state.stdin.lock().map_err(|_| "INTERNAL: Lock poisoned".to_string())?;
    if let Some(stdin) = stdin_guard.as_mut() {
        let _ = writeln!(stdin, "{}", serialized);
        let _ = stdin.flush();
    }
    Ok(serde_json::json!({ "cancelled": true }))
}

pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(win) = app.get_webview_window("main") {
                let _ = win.set_focus();
            }
        }))
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let app_home = app
                .path()
                .app_local_data_dir()
                .map(|p| p.join("EnergyBaseline").to_string_lossy().to_string())
                .unwrap_or_else(|_| ".".to_string());

            // In production Windows NSIS, resolves bundled onedir sidecar; in dev uses python3
            let mut cmd = Command::new("python3");
            cmd.arg("sidecar/energybaseline/main.py")
                .env("APP_HOME", &app_home)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped());

            let handle = match cmd.spawn() {
                Ok(mut child) => {
                    let mut stdin = child.stdin.take();
                    if let Some(ref mut s) = stdin {
                        let hello = serde_json::json!({
                            "protocol_version": PROTOCOL_VERSION,
                            "app_version": "5.2.0",
                            "parent_pid": std::process::id(),
                            "app_home": app_home,
                        });
                        let _ = writeln!(s, "{}", hello);
                        let _ = s.flush();
                    }
                    if let Some(stdout) = child.stdout.take() {
                        std::thread::spawn(move || {
                            let reader = BufReader::new(stdout);
                            for line in reader.lines().flatten() {
                                eprintln!("[sidecar-frame] {}", line);
                            }
                        });
                    }
                    Arc::new(SidecarHandle {
                        child: Mutex::new(Some(child)),
                        stdin: Mutex::new(stdin),
                        app_home,
                        active_ids: Mutex::new(HashSet::new()),
                    })
                }
                Err(_) => Arc::new(SidecarHandle {
                    child: Mutex::new(None),
                    stdin: Mutex::new(None),
                    app_home,
                    active_ids: Mutex::new(HashSet::new()),
                }),
            };

            app.manage(handle);
            Ok(())
        })
        .on_window_event(|window, event| {
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                let handle = window.state::<Arc<SidecarHandle>>();
                handle.shutdown_gracefully();
            }
        })
        .invoke_handler(tauri::generate_handler![rpc_call, rpc_cancel])
        .run(tauri::generate_context!())
        .expect("error while running EnergyBaseline");
}
