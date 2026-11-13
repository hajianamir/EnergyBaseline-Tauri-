use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, Runtime};
use tauri_plugin_shell::process::{CommandChild, CommandEvent};
use tauri_plugin_shell::ShellExt;
use tokio::sync::{oneshot, watch};

pub(crate) const PROTOCOL_VERSION: &str = "1.0";
const MAX_FRAME_BYTES: usize = 1024 * 1024;
const DEFAULT_READY_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_READY_TIMEOUT: Duration = Duration::from_secs(30);
const RPC_TIMEOUT: Duration = Duration::from_secs(30);
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(10);
const FORCE_SHUTDOWN_WAIT: Duration = Duration::from_secs(2);
const PROGRESS_INTERVAL: Duration = Duration::from_millis(100);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimePhase {
    Stopped,
    Starting,
    Ready,
    Failed,
    Stopping,
}

impl RuntimePhase {
    fn as_str(self) -> &'static str {
        match self {
            Self::Stopped => "stopped",
            Self::Starting => "starting",
            Self::Ready => "ready",
            Self::Failed => "failed",
            Self::Stopping => "stopping",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SidecarUiStatus {
    state: String,
    message: Option<String>,
    log_path: String,
    db: Option<Value>,
}

struct RuntimeState {
    phase: RuntimePhase,
    child: Option<CommandChild>,
    process_tree: Option<ProcessTreeGuard>,
    pid: Option<u32>,
    generation: u64,
    pending: HashMap<String, oneshot::Sender<Result<Value, String>>>,
    last_progress: HashMap<String, Instant>,
}

impl Default for RuntimeState {
    fn default() -> Self {
        Self {
            phase: RuntimePhase::Stopped,
            child: None,
            process_tree: None,
            pid: None,
            generation: 0,
            pending: HashMap::new(),
            last_progress: HashMap::new(),
        }
    }
}

pub(crate) struct SidecarHandle<R: Runtime = tauri::Wry> {
    app: AppHandle<R>,
    app_home: PathBuf,
    #[cfg(test)]
    test_command: Option<(PathBuf, Vec<OsString>, PathBuf)>,
    log_path: PathBuf,
    runtime: Mutex<RuntimeState>,
    status_tx: watch::Sender<SidecarUiStatus>,
    terminated_tx: watch::Sender<u64>,
    next_internal_id: AtomicU64,
    shutdown_lock: tokio::sync::Mutex<()>,
}

impl<R: Runtime> SidecarHandle<R> {
    pub(crate) fn new(app: AppHandle<R>, app_home: PathBuf, log_path: PathBuf) -> Arc<Self> {
        let initial = SidecarUiStatus {
            state: RuntimePhase::Stopped.as_str().to_string(),
            message: None,
            log_path: log_path.to_string_lossy().into_owned(),
            db: None,
        };
        let (status_tx, _) = watch::channel(initial);
        let (terminated_tx, _) = watch::channel(0);
        Arc::new(Self {
            app,
            app_home,
            #[cfg(test)]
            test_command: None,
            log_path,
            runtime: Mutex::new(RuntimeState::default()),
            status_tx,
            terminated_tx,
            next_internal_id: AtomicU64::new(1),
            shutdown_lock: tokio::sync::Mutex::new(()),
        })
    }

    fn publish_status(&self, status: SidecarUiStatus) {
        self.status_tx.send_replace(status.clone());
        let _ = self.app.emit("sidecar-state", status);
    }

    fn status(&self, phase: RuntimePhase, message: Option<String>, db: Option<Value>) -> SidecarUiStatus {
        SidecarUiStatus {
            state: phase.as_str().to_string(),
            message,
            log_path: self.log_path.to_string_lossy().into_owned(),
            db,
        }
    }

    fn ready_timeout() -> Duration {
        std::env::var("ENERGYBASELINE_READY_TIMEOUT_SECS")
            .ok()
            .and_then(|value| value.parse::<u64>().ok())
            .map(|seconds| Duration::from_secs(seconds.clamp(
                DEFAULT_READY_TIMEOUT.as_secs(),
                MAX_READY_TIMEOUT.as_secs(),
            )))
            .unwrap_or(DEFAULT_READY_TIMEOUT)
    }

    /// Start the packaged onedir executable, or the Python entry point in a dev build.
    /// The onedir folder is a resource rather than `externalBin`: PyInstaller requires
    /// its sibling `_internal` tree to stay intact.
    pub(crate) fn start(self: &Arc<Self>) -> Result<(), String> {
        let (generation, stale_child, stale_tree, stale_pending) = {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "INTERNAL: Sidecar state lock is poisoned".to_string())?;
            match runtime.phase {
                RuntimePhase::Starting | RuntimePhase::Ready => return Ok(()),
                RuntimePhase::Stopping => {
                    return Err("INTERNAL: Sidecar is shutting down".to_string())
                }
                RuntimePhase::Stopped | RuntimePhase::Failed => {}
            }

            runtime.generation = runtime.generation.wrapping_add(1).max(1);
            runtime.phase = RuntimePhase::Starting;
            runtime.last_progress.clear();
            let generation = runtime.generation;
            let stale_child = runtime.child.take();
            let stale_tree = runtime.process_tree.take();
            let stale_pending = std::mem::take(&mut runtime.pending);
            (generation, stale_child, stale_tree, stale_pending)
        };

        for (_, sender) in stale_pending {
            let _ = sender.send(Err("CANCELLED: Sidecar is restarting".to_string()));
        }
        drop(stale_child);
        drop(stale_tree);
        self.publish_status(self.status(RuntimePhase::Starting, None, None));

        let (program, args, working_dir) = match self.command_details() {
            Ok(details) => details,
            Err(message) => {
                self.fail_generation(generation, message.clone());
                return Err(message);
            }
        };

        let mut command = self
            .app
            .shell()
            .command(program.as_os_str())
            .args(args)
            .current_dir(&working_dir)
            .set_process_group(true)
            .env("APP_HOME", self.app_home.as_os_str())
            .env("ENERGYBASELINE_LOG_PATH", self.log_path.as_os_str());

        // Make all database environment inputs explicit to the child. The Python
        // resolver remains the only component that reads and interprets them.
        for name in [
            "EB_DATABASE_URL",
            "DATABASE_URL",
            "POSTGRES_URL",
            "DB_CONNECTION_STRING",
            "DB_URI",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command = command.env(name, value);
            }
        }
        if cfg!(debug_assertions) {
            command = command.env("PYTHONUNBUFFERED", "1");
        }

        let (receiver, child) = match command.spawn() {
            Ok(spawned) => spawned,
            Err(error) => {
                let message = format!(
                    "INTERNAL: Could not start the EnergyBaseline sidecar. See {}. ({})",
                    self.log_path.display(),
                    error
                );
                self.fail_generation(generation, message.clone());
                return Err(message);
            }
        };
        let pid = child.pid();
        let process_tree = match ProcessTreeGuard::assign(pid) {
            Ok(guard) => guard,
            Err(error) => {
                let _ = child.kill();
                let message = format!(
                    "INTERNAL: Could not attach the sidecar to its process tree guard. See {}. ({})",
                    self.log_path.display(),
                    error
                );
                self.fail_generation(generation, message.clone());
                return Err(message);
            }
        };

        {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "INTERNAL: Sidecar state lock is poisoned".to_string())?;
            if runtime.generation != generation || runtime.phase != RuntimePhase::Starting {
                drop(runtime);
                drop(child);
                drop(process_tree);
                return Err("CANCELLED: Sidecar startup was superseded".to_string());
            }
            runtime.pid = Some(pid);
            runtime.child = Some(child);
            runtime.process_tree = Some(process_tree);
        }

        self.spawn_reader(receiver, generation);

        let hello = json!({
            "protocol_version": PROTOCOL_VERSION,
            "app_version": env!("CARGO_PKG_VERSION"),
            "parent_pid": std::process::id(),
            "app_home": self.app_home.to_string_lossy(),
        });
        let mut frame = match serde_json::to_vec(&hello) {
            Ok(frame) => frame,
            Err(error) => {
                let message = format!("INTERNAL: Could not encode sidecar handshake: {error}");
                self.fail_generation(generation, message.clone());
                return Err(message);
            }
        };
        frame.push(b'\n');
        if frame.len() > MAX_FRAME_BYTES {
            let message = "VALIDATION: Sidecar handshake exceeds the 1 MiB IPC frame limit".to_string();
            self.fail_generation(generation, message.clone());
            return Err(message);
        }
        if let Err(error) = self.write_to_child(generation, &frame) {
            let message = format!("INTERNAL: Could not send sidecar handshake: {error}");
            self.fail_generation(generation, message.clone());
            return Err(message);
        }

        Ok(())
    }

    fn command_details(&self) -> Result<(PathBuf, Vec<OsString>, PathBuf), String> {
        #[cfg(test)]
        if let Some((program, args, working_dir)) = &self.test_command {
            return Ok((program.clone(), args.clone(), working_dir.clone()));
        }

        if cfg!(debug_assertions) {
            let repository_root = Path::new(env!("CARGO_MANIFEST_DIR"))
                .parent()
                .ok_or_else(|| "INTERNAL: Could not resolve the repository root".to_string())?
                .to_path_buf();
            let entry = repository_root.join("sidecar").join("energybaseline").join("main.py");
            if !entry.is_file() {
                return Err(format!(
                    "INTERNAL: Development sidecar entry point is missing: {}",
                    entry.display()
                ));
            }
            let python = if cfg!(windows) { "python" } else { "python3" };
            return Ok((
                PathBuf::from(python),
                vec![entry.into_os_string(), OsString::from("--stdio")],
                repository_root,
            ));
        }

        let resources = self
            .app
            .path()
            .resource_dir()
            .map_err(|error| format!("INTERNAL: Could not resolve the application resources: {error}"))?;
        let sidecar_dir = resources.join("energybaseline_sidecar");
        #[cfg(windows)]
        let binary_name = "energybaseline_sidecar.exe";
        #[cfg(not(windows))]
        let binary_name = "energybaseline_sidecar";
        let executable = sidecar_dir.join(binary_name);
        if !executable.is_file() {
            return Err(format!(
                "INTERNAL: Packaged onedir sidecar is missing: {} (log: {})",
                executable.display(),
                self.log_path.display()
            ));
        }
        Ok((
            executable,
            vec![OsString::from("--stdio")],
            sidecar_dir,
        ))
    }

    fn spawn_reader(self: &Arc<Self>, mut receiver: tauri::async_runtime::Receiver<CommandEvent>, generation: u64) {
        let sidecar = Arc::clone(self);
        tauri::async_runtime::spawn(async move {
            while let Some(event) = receiver.recv().await {
                match event {
                    CommandEvent::Stdout(bytes) => sidecar.handle_stdout(generation, bytes),
                    CommandEvent::Stderr(_bytes) => {
                        // Never copy arbitrary stderr into the UI or logs: exceptions may
                        // contain user-provided SQL or connection details.
                    }
                    CommandEvent::Error(_error) => {
                        sidecar.fail_generation(
                            generation,
                            format!(
                                "INTERNAL: Sidecar I/O failed. See {}.",
                                sidecar.log_path.display()
                            ),
                        );
                    }
                    CommandEvent::Terminated(payload) => {
                        sidecar.handle_terminated(generation, payload.code, payload.signal);
                        break;
                    }
                    _ => {}
                }
            }
        });
    }

    fn handle_stdout(&self, generation: u64, bytes: Vec<u8>) {
        if bytes.len() > MAX_FRAME_BYTES {
            self.fail_generation(
                generation,
                "PROTOCOL_VERSION: Sidecar emitted a frame larger than 1 MiB".to_string(),
            );
            return;
        }
        let frame = match std::str::from_utf8(&bytes) {
            Ok(text) => text,
            Err(_) => {
                self.fail_generation(
                    generation,
                    "PROTOCOL_VERSION: Sidecar emitted a non-UTF-8 frame".to_string(),
                );
                return;
            }
        };
        let message: Value = match serde_json::from_str(frame) {
            Ok(value) => value,
            Err(_) => {
                self.fail_generation(
                    generation,
                    format!(
                        "PROTOCOL_VERSION: Sidecar emitted invalid JSON. See {}.",
                        self.log_path.display()
                    ),
                );
                return;
            }
        };
        let Some(object) = message.as_object() else {
            self.fail_generation(generation, "PROTOCOL_VERSION: Sidecar frame must be a JSON object".to_string());
            return;
        };

        match object.get("type").and_then(Value::as_str) {
            Some("sidecar.ready") => {
                if object.get("protocol_version").and_then(Value::as_str) != Some(PROTOCOL_VERSION) {
                    self.fail_generation(
                        generation,
                        format!(
                            "PROTOCOL_VERSION: Shell expects protocol {PROTOCOL_VERSION}; sidecar reported a different version. See {}.",
                            self.log_path.display()
                        ),
                    );
                    return;
                }
                let db = object.get("db").cloned();
                {
                    let Ok(mut runtime) = self.runtime.lock() else {
                        return;
                    };
                    if runtime.generation != generation || runtime.phase == RuntimePhase::Stopping {
                        return;
                    }
                    runtime.phase = RuntimePhase::Ready;
                }
                self.publish_status(self.status(RuntimePhase::Ready, None, db));
            }
            Some("sidecar.fatal") => {
                let detail = object
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Sidecar rejected the protocol handshake.");
                let app_code = object
                    .get("app_code")
                    .and_then(Value::as_str)
                    .unwrap_or("INTERNAL");
                self.fail_generation(
                    generation,
                    format!("{app_code}: {detail} (log: {})", self.log_path.display()),
                );
            }
            _ if object.get("method").and_then(Value::as_str) == Some("sidecar.progress") => {
                self.handle_progress(generation, object.get("params").cloned().unwrap_or(Value::Null));
            }
            _ => self.handle_rpc_response(generation, &message),
        }
    }

    fn handle_progress(&self, generation: u64, params: Value) {
        let target = params.get("target").and_then(Value::as_str).unwrap_or("global");
        let stage = params.get("stage").and_then(Value::as_str).unwrap_or("unknown");
        let test_id = params.get("test_id").and_then(Value::as_str).unwrap_or("");
        let throttle_key = format!("{target}:{stage}:{test_id}");
        let now = Instant::now();
        let should_emit = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            if runtime.generation != generation {
                return;
            }
            match runtime.last_progress.get(&throttle_key) {
                Some(last) if now.duration_since(*last) < PROGRESS_INTERVAL => false,
                _ => {
                    runtime.last_progress.insert(throttle_key, now);
                    true
                }
            }
        };
        if should_emit {
            let _ = self.app.emit("sidecar-progress", params);
        }
    }

    fn handle_rpc_response(&self, generation: u64, message: &Value) {
        if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
            self.fail_generation(generation, "PROTOCOL_VERSION: Invalid JSON-RPC response".to_string());
            return;
        }
        let Some(id) = message.get("id") else {
            self.fail_generation(generation, "PROTOCOL_VERSION: JSON-RPC response has no id".to_string());
            return;
        };
        let Ok(key) = id_key(id) else {
            self.fail_generation(generation, "PROTOCOL_VERSION: JSON-RPC response has an invalid id".to_string());
            return;
        };
        let sender = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            if runtime.generation != generation {
                return;
            }
            runtime.pending.remove(&key)
        };
        let Some(sender) = sender else {
            // A response may arrive after the caller's timeout/cancel. It is stale, not fatal.
            return;
        };
        let result = if let Some(value) = message.get("result") {
            Ok(value.clone())
        } else if let Some(error) = message.get("error") {
            let app_code = error
                .get("app_code")
                .and_then(Value::as_str)
                .unwrap_or("INTERNAL");
            let description = error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Sidecar returned an error without a message.");
            let log_ref = error
                .get("log_ref")
                .and_then(Value::as_str)
                .unwrap_or_else(|| self.log_path.to_str().unwrap_or("sidecar log"));
            let jsonrpc_code = error
                .get("code")
                .and_then(Value::as_i64)
                .map(|code| format!("JSON-RPC {code}: "))
                .unwrap_or_default();
            Err(format!("{jsonrpc_code}{app_code}: {description} (log: {log_ref})"))
        } else {
            self.fail_generation(
                generation,
                "PROTOCOL_VERSION: JSON-RPC response has neither result nor error".to_string(),
            );
            return;
        };
        let _ = sender.send(result);
    }

    fn write_to_child(&self, generation: u64, frame: &[u8]) -> Result<(), String> {
        let mut runtime = self
            .runtime
            .lock()
            .map_err(|_| "INTERNAL: Sidecar state lock is poisoned".to_string())?;
        if runtime.generation != generation || runtime.phase == RuntimePhase::Stopping {
            return Err("INTERNAL: Sidecar is not accepting requests".to_string());
        }
        let child = runtime
            .child
            .as_mut()
            .ok_or_else(|| "INTERNAL: Sidecar stdin is unavailable".to_string())?;
        child
            .write(frame)
            .map_err(|error| format!("INTERNAL: Could not write to sidecar stdin: {error}"))
    }

    async fn wait_until_ready(&self) -> Result<u64, String> {
        let generation = {
            self.runtime
                .lock()
                .map_err(|_| "INTERNAL: Sidecar state lock is poisoned".to_string())?
                .generation
        };
        let mut receiver = self.status_tx.subscribe();
        let timeout = Self::ready_timeout();
        let deadline = tokio::time::Instant::now() + timeout;
        loop {
            let status = receiver.borrow().clone();
            match status.state.as_str() {
                "ready" => return Ok(generation),
                "failed" => {
                    return Err(status.message.unwrap_or_else(|| {
                        format!("INTERNAL: Sidecar failed to start (log: {})", self.log_path.display())
                    }))
                }
                "stopped" => {
                    return Err("INTERNAL: Sidecar stopped before becoming ready".to_string())
                }
                _ => {}
            }
            if tokio::time::timeout_at(deadline, receiver.changed()).await.is_err() {
                let message = format!(
                    "TIMEOUT: Sidecar did not become ready within {} seconds. See {}.",
                    timeout.as_secs(),
                    self.log_path.display()
                );
                self.fail_generation(generation, message.clone());
                return Err(message);
            }
        }
    }

    pub(crate) async fn call(self: &Arc<Self>, method: String, params: Value, id: Value) -> Result<Value, String> {
        if !is_valid_id(&id) {
            return Err("VALIDATION: RPC id must be a string, number, or null".to_string());
        }
        if !params.is_object() {
            return Err("VALIDATION: RPC params must be a JSON object".to_string());
        }
        self.start()?;
        let generation = self.wait_until_ready().await?;
        self.call_ready(method, params, id, generation).await
    }

    async fn call_ready(&self, method: String, params: Value, id: Value, generation: u64) -> Result<Value, String> {
        let key = id_key(&id)?;
        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params,
        });
        let mut frame = serde_json::to_vec(&request)
            .map_err(|error| format!("INTERNAL: Could not encode RPC request: {error}"))?;
        frame.push(b'\n');
        if frame.len() > MAX_FRAME_BYTES {
            return Err("VALIDATION: RPC frame exceeds the 1 MiB limit".to_string());
        }

        let (sender, receiver) = oneshot::channel();
        {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "INTERNAL: Sidecar state lock is poisoned".to_string())?;
            if runtime.generation != generation || runtime.phase != RuntimePhase::Ready {
                return Err("INTERNAL: Sidecar is no longer ready".to_string());
            }
            if runtime.pending.contains_key(&key) {
                return Err("VALIDATION: An RPC request with the same id is already active".to_string());
            }
            runtime.pending.insert(key.clone(), sender);
            let write_result = match runtime.child.as_mut() {
                Some(child) => child
                    .write(&frame)
                    .map_err(|error| format!("INTERNAL: Could not write to sidecar stdin: {error}")),
                None => Err("INTERNAL: Sidecar stdin is unavailable".to_string()),
            };
            if let Err(message) = write_result {
                runtime.pending.remove(&key);
                drop(runtime);
                self.fail_generation(generation, message.clone());
                return Err(message);
            }
        }

        match tokio::time::timeout(RPC_TIMEOUT, receiver).await {
            Ok(Ok(result)) => result,
            Ok(Err(_)) => Err("INTERNAL: Sidecar response channel closed".to_string()),
            Err(_) => {
                if let Ok(mut runtime) = self.runtime.lock() {
                    if runtime.generation == generation {
                        runtime.pending.remove(&key);
                    }
                }
                Err(format!(
                    "TIMEOUT: Sidecar RPC did not respond within {} seconds (log: {})",
                    RPC_TIMEOUT.as_secs(),
                    self.log_path.display()
                ))
            }
        }
    }

    pub(crate) async fn cancel(self: &Arc<Self>, id: Value) -> Result<Value, String> {
        if !is_valid_id(&id) {
            return Err("VALIDATION: Cancellation id must be a string, number, or null".to_string());
        }
        self.start()?;
        let generation = self.wait_until_ready().await?;
        let key = id_key(&id)?;
        let pending = {
            let mut runtime = self
                .runtime
                .lock()
                .map_err(|_| "INTERNAL: Sidecar state lock is poisoned".to_string())?;
            if runtime.generation != generation {
                return Err("INTERNAL: Sidecar restarted before cancellation".to_string());
            }
            runtime.pending.remove(&key)
        };
        if let Some(sender) = pending {
            let _ = sender.send(Err("CANCELLED: Request cancelled by the user".to_string()));
        }
        let cancel_id = Value::String(format!(
            "rpc-cancel-{}",
            self.next_internal_id.fetch_add(1, Ordering::Relaxed)
        ));
        self.call_ready("rpc_cancel".to_string(), json!({ "id": id }), cancel_id, generation)
            .await
    }

    fn handle_terminated(&self, generation: u64, code: Option<i32>, signal: Option<i32>) {
        let (phase, child, process_tree, pid, pending) = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            if runtime.generation != generation {
                return;
            }
            let phase = if runtime.phase == RuntimePhase::Stopping {
                RuntimePhase::Stopped
            } else {
                RuntimePhase::Failed
            };
            runtime.phase = phase;
            let pid = runtime.pid.take();
            (
                phase,
                runtime.child.take(),
                runtime.process_tree.take(),
                pid,
                std::mem::take(&mut runtime.pending),
            )
        };
        drop(child);
        terminate_process_tree(process_tree, pid);
        for (_, sender) in pending {
            let _ = sender.send(Err(format!(
                "INTERNAL: Sidecar exited unexpectedly (code: {code:?}, signal: {signal:?}; log: {}).",
                self.log_path.display()
            )));
        }
        self.terminated_tx.send_replace(generation);
        let message = if phase == RuntimePhase::Failed {
            Some(format!(
                "Sidecar exited unexpectedly (code: {code:?}, signal: {signal:?}). See {}.",
                self.log_path.display()
            ))
        } else {
            None
        };
        self.publish_status(self.status(phase, message, None));
    }

    fn fail_generation(&self, generation: u64, message: String) {
        let (child, process_tree, pid, pending) = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            if runtime.generation != generation || runtime.phase == RuntimePhase::Stopped {
                return;
            }
            runtime.phase = RuntimePhase::Failed;
            (
                runtime.child.take(),
                runtime.process_tree.take(),
                runtime.pid.take(),
                std::mem::take(&mut runtime.pending),
            )
        };
        for (_, sender) in pending {
            let _ = sender.send(Err(message.clone()));
        }
        drop(child); // closing the writer sends the authoritative stdin EOF
        terminate_process_tree(process_tree, pid);
        self.publish_status(self.status(RuntimePhase::Failed, Some(message), None));
    }

    pub(crate) async fn shutdown_gracefully(&self) {
        let _shutdown_guard = self.shutdown_lock.lock().await;
        let (generation, child, phase, has_process) = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            if runtime.phase == RuntimePhase::Stopped {
                return;
            }
            let phase = runtime.phase;
            runtime.phase = RuntimePhase::Stopping;
            let has_process = runtime.pid.is_some();
            let child = runtime.child.take();
            (runtime.generation, child, phase, has_process)
        };
        self.publish_status(self.status(RuntimePhase::Stopping, None, None));

        let mut terminated = self.terminated_tx.subscribe();
        drop(child); // EOF is the graceful shutdown request; keep the process-tree guard alive while it exits.
        if !has_process {
            self.force_terminate(generation);
            self.terminated_tx.send_replace(generation);
        } else {
            if phase == RuntimePhase::Failed {
                self.force_terminate(generation);
            }
            let stopped = tokio::time::timeout(
                SHUTDOWN_TIMEOUT,
                wait_for_generation(&mut terminated, generation),
            )
            .await
            .is_ok();
            if !stopped {
                self.force_terminate(generation);
                let _ = tokio::time::timeout(
                    FORCE_SHUTDOWN_WAIT,
                    wait_for_generation(&mut terminated, generation),
                )
                .await;
            }
        }

        if let Ok(mut runtime) = self.runtime.lock() {
            if runtime.generation == generation && runtime.phase == RuntimePhase::Stopping {
                runtime.phase = RuntimePhase::Stopped;
                runtime.pid = None;
                runtime.process_tree.take();
                runtime.pending.clear();
            }
        }
        self.publish_status(self.status(RuntimePhase::Stopped, None, None));
    }

    fn force_terminate(&self, generation: u64) {
        let (process_tree, pid) = {
            let Ok(mut runtime) = self.runtime.lock() else {
                return;
            };
            if runtime.generation != generation {
                return;
            }
            (runtime.process_tree.take(), runtime.pid.take())
        };
        terminate_process_tree(process_tree, pid);
    }
}

async fn wait_for_generation(receiver: &mut watch::Receiver<u64>, generation: u64) {
    while *receiver.borrow() != generation {
        if receiver.changed().await.is_err() {
            break;
        }
    }
}

fn is_valid_id(id: &Value) -> bool {
    matches!(id, Value::Null | Value::String(_) | Value::Number(_))
}

fn id_key(id: &Value) -> Result<String, String> {
    if !is_valid_id(id) {
        return Err("VALIDATION: RPC id must be a string, number, or null".to_string());
    }
    serde_json::to_string(id).map_err(|error| format!("INTERNAL: Could not encode RPC id: {error}"))
}

#[cfg(windows)]
struct ProcessTreeGuard {
    job: windows_sys::Win32::Foundation::HANDLE,
}

#[cfg(windows)]
unsafe impl Send for ProcessTreeGuard {}
#[cfg(windows)]
unsafe impl Sync for ProcessTreeGuard {}

#[cfg(windows)]
impl ProcessTreeGuard {
    fn assign(pid: u32) -> Result<Self, String> {
        use std::mem::{size_of, zeroed};
        use std::ptr;
        use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
        use windows_sys::Win32::System::JobObjects::{
            AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
            SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
            JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        let job: HANDLE = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if job.is_null() {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut limits: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { zeroed() };
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        let configured = unsafe {
            SetInformationJobObject(
                job,
                JobObjectExtendedLimitInformation,
                &limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION as *const std::ffi::c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )
        };
        if configured == 0 {
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error.to_string());
        }

        // The shell plugin starts process-group children suspended, attaches its own
        // Job Object, then resumes them. This second nested job adds KILL_ON_JOB_CLOSE,
        // which guarantees cleanup if the desktop process crashes without running hooks.
        let process = unsafe { OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid) };
        if process.is_null() {
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error.to_string());
        }
        let assigned = unsafe { AssignProcessToJobObject(job, process) };
        unsafe { CloseHandle(process) };
        if assigned == 0 {
            let error = std::io::Error::last_os_error();
            unsafe { CloseHandle(job) };
            return Err(error.to_string());
        }
        Ok(Self { job })
    }
}

#[cfg(windows)]
impl Drop for ProcessTreeGuard {
    fn drop(&mut self) {
        unsafe {
            windows_sys::Win32::Foundation::CloseHandle(self.job);
        }
    }
}

#[cfg(unix)]
struct ProcessTreeGuard {
    pid: u32,
}

#[cfg(unix)]
impl ProcessTreeGuard {
    fn assign(pid: u32) -> Result<Self, String> {
        Ok(Self { pid })
    }
}

fn terminate_process_tree(process_tree: Option<ProcessTreeGuard>, pid: Option<u32>) {
    #[cfg(unix)]
    {
        let process_group = process_tree.map(|guard| guard.pid).or(pid);
        if let Some(process_group) = process_group {
            unsafe {
                libc::killpg(process_group as libc::pid_t, libc::SIGKILL);
            }
        }
    }
    #[cfg(windows)]
    {
        // Dropping the KILL_ON_JOB_CLOSE handle atomically terminates the whole tree.
        drop(process_tree);
        let _ = pid;
    }
}

#[cfg(test)]
mod tests {
    use super::{id_key, is_valid_id, SidecarHandle, MAX_FRAME_BYTES};
    use serde_json::json;
    use std::ffi::OsString;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::time::{Duration, Instant};
    use tauri::test::{mock_builder, mock_context, noop_assets, MockRuntime};
    use tauri::Manager;

    fn mock_app() -> tauri::App<MockRuntime> {
        mock_builder()
            .plugin(tauri_plugin_shell::init())
            .build(mock_context(noop_assets()))
            .expect("mock Tauri app should build")
    }

    fn test_app_home(test_name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "EnergyBaseline-M1-{test_name}-{}",
            std::process::id()
        ));
        std::fs::create_dir_all(&path).expect("test APP_HOME should be created");
        path
    }

    fn test_sidecar(
        app: &tauri::App<MockRuntime>,
        app_home: PathBuf,
        args: Vec<OsString>,
        working_dir: PathBuf,
    ) -> Arc<SidecarHandle<MockRuntime>> {
        let log_path = app_home.join("logs").join("sidecar.log");
        let program = if cfg!(windows) { "python" } else { "python3" };
        let mut sidecar = SidecarHandle::new(app.handle().clone(), app_home, log_path);
        Arc::get_mut(&mut sidecar)
            .expect("test handle should be uniquely owned before startup")
            .test_command = Some((PathBuf::from(program), args, working_dir));
        sidecar
    }

    #[test]
    fn rust_bridge_round_trips_real_python_sidecar_and_preserves_rpc_error_code() {
        let app = mock_app();
        let app_home = test_app_home("rpc-roundtrip");
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri should be inside the repository")
            .to_path_buf();
        let entry = repo_root.join("sidecar").join("energybaseline").join("main.py");
        let sidecar = test_sidecar(
            &app,
            app_home.clone(),
            vec![entry.into_os_string(), OsString::from("--stdio")],
            repo_root,
        );

        let (status, unknown_method) = tauri::async_runtime::block_on(async {
            let status = sidecar
                .call("system.status".to_string(), json!({}), json!("status-1"))
                .await;
            let unknown_method = sidecar
                .call("not.allowlisted".to_string(), json!({}), json!("unknown-1"))
                .await;
            sidecar.shutdown_gracefully().await;
            (status, unknown_method)
        });
        drop(app);
        let _ = std::fs::remove_dir_all(&app_home);

        let status = status.expect("system.status should return a JSON-RPC result");
        assert_eq!(status.get("protocol_version").and_then(|value| value.as_str()), Some("1.0"));
        assert!(status.get("pid").and_then(|value| value.as_u64()).is_some());
        let error = unknown_method.expect_err("unallowlisted method must return a JSON-RPC error");
        assert!(error.contains("JSON-RPC -32601"), "unexpected error: {error}");
        assert!(error.contains("not.allowlisted"), "unexpected error: {error}");
    }

    #[test]
    fn rpc_cancel_resolves_a_pending_rust_call_as_cancelled() {
        let app = mock_app();
        let app_home = test_app_home("rpc-cancel");
        let repo_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri should be inside the repository")
            .to_path_buf();
        let fixture = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("tests")
            .join("fixtures")
            .join("rpc_cancellation_sidecar.py");
        let sidecar = test_sidecar(&app, app_home.clone(), vec![fixture.into_os_string()], repo_root);
        let request_id = json!("pending-test-request");
        let key = id_key(&request_id).expect("request id should be valid");
        let call_sidecar = Arc::clone(&sidecar);
        let call_id = request_id.clone();
        let pending_call = tauri::async_runtime::spawn(async move {
            call_sidecar
                .call("test.wait".to_string(), json!({}), call_id)
                .await
        });

        let (cancel_result, call_result) = tauri::async_runtime::block_on(async {
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                let is_pending = sidecar
                    .runtime
                    .lock()
                    .expect("runtime lock should be available")
                    .pending
                    .contains_key(&key);
                if is_pending {
                    break;
                }
                assert!(Instant::now() < deadline, "test RPC never became pending");
                tokio::time::sleep(Duration::from_millis(10)).await;
            }

            let cancel_result = sidecar.cancel(request_id.clone()).await;
            let call_result = pending_call.await.expect("pending RPC task should complete");
            sidecar.shutdown_gracefully().await;
            (cancel_result, call_result)
        });
        drop(app);
        let _ = std::fs::remove_dir_all(&app_home);

        assert_eq!(
            cancel_result.expect("sidecar should acknowledge rpc_cancel"),
            json!({"cancelled": request_id})
        );
        let error = call_result.expect_err("cancelled request must not resolve successfully");
        assert!(error.starts_with("CANCELLED:"), "unexpected error: {error}");
    }

    #[test]
    fn rpc_ids_are_limited_to_json_rpc_primitives() {
        assert!(is_valid_id(&json!("run-1")));
        assert!(is_valid_id(&json!(42)));
        assert!(is_valid_id(&json!(null)));
        assert!(!is_valid_id(&json!(true)));
        assert!(!is_valid_id(&json!([1, 2])));
        assert!(!is_valid_id(&json!({"id": 1})));
        assert_eq!(id_key(&json!(42)).unwrap(), "42");
    }

    #[test]
    fn request_frame_limit_is_one_mib() {
        assert_eq!(MAX_FRAME_BYTES, 1024 * 1024);
    }

    #[cfg(windows)]
    #[test]
    fn dropping_crash_guard_terminates_its_process() {
        use super::ProcessTreeGuard;
        use std::process::Command as StdCommand;
        use std::ptr;
        use std::thread;
        use std::time::{Duration, Instant};
        use windows_sys::Win32::Foundation::CloseHandle;
        use windows_sys::Win32::System::JobObjects::{AssignProcessToJobObject, CreateJobObjectW};
        use windows_sys::Win32::System::Threading::{
            OpenProcess, PROCESS_SET_QUOTA, PROCESS_TERMINATE,
        };

        let mut child = StdCommand::new("powershell.exe")
            .args(["-NoProfile", "-NonInteractive", "-Command", "Start-Sleep -Seconds 60"])
            .spawn()
            .expect("PowerShell should be available on the Windows runner");
        // Simulate the shell plugin's processGroup Job Object, which has no
        // KILL_ON_JOB_CLOSE flag of its own. Our crash guard is a nested job.
        let parent_job = unsafe { CreateJobObjectW(ptr::null(), ptr::null()) };
        if parent_job.is_null() {
            let _ = child.kill();
            panic!("could not create the simulated shell processGroup job");
        }
        let process = unsafe {
            OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, child.id())
        };
        if process.is_null() || unsafe { AssignProcessToJobObject(parent_job, process) } == 0 {
            if !process.is_null() {
                unsafe { CloseHandle(process) };
            }
            unsafe { CloseHandle(parent_job) };
            let _ = child.kill();
            panic!("could not attach the simulated processGroup job");
        }
        unsafe { CloseHandle(process) };
        let guard = match ProcessTreeGuard::assign(child.id()) {
            Ok(guard) => guard,
            Err(error) => {
                unsafe { CloseHandle(parent_job) };
                let _ = child.kill();
                panic!("could not attach the nested KILL_ON_JOB_CLOSE guard: {error}");
            }
        };
        unsafe { CloseHandle(parent_job) };
        drop(guard);

        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if child.try_wait().expect("querying child status should succeed").is_some() {
                return;
            }
            if Instant::now() >= deadline {
                let _ = child.kill();
                panic!("process survived closing its KILL_ON_JOB_CLOSE guard");
            }
            thread::sleep(Duration::from_millis(25));
        }
    }
}
