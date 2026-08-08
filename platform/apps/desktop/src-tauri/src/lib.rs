use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::Manager;
use tauri_plugin_shell::{process::CommandEvent, ShellExt};
use tauri_plugin_updater::UpdaterExt;

const MAX_DAEMON_RESTARTS: u32 = 3;
const DAEMON_RESTART_BACKOFF_MS: u64 = 250;
const DAEMON_STABLE_WINDOW: Duration = Duration::from_secs(10);

struct LocalDaemonProcess(Mutex<LocalDaemonProcessState>);

struct LocalDaemonProcessState {
    child: Option<tauri_plugin_shell::process::CommandChild>,
    stopping: bool,
    config: DaemonLaunchConfig,
}

#[derive(Clone)]
struct DaemonLaunchConfig {
    workspace_root: PathBuf,
    license_file: PathBuf,
    public_key: Option<String>,
    key_id: Option<String>,
    auth_token: String,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DaemonReady {
    ready: bool,
    address: String,
    #[serde(default)]
    auth_token: Option<String>,
}

struct LocalDaemonRuntime(Mutex<Option<DaemonReady>>);

const LICENSE_KEYCHAIN_SERVICE: &str = "com.spyderbyte.desktop.license";
const LICENSE_KEYCHAIN_ACCOUNT: &str = "default";
const BUILD_LICENSE_PUBLIC_KEY: Option<&str> = option_env!("AGENTIC_LICENSE_PUBLIC_KEY");
const BUILD_LICENSE_KEY_ID: Option<&str> = option_env!("AGENTIC_LICENSE_KEY_ID");
const BUILD_MELTANO_PUBLIC_KEY: Option<&str> = option_env!("SPYDERBYTE_MELTANO_PUBLIC_KEY");
const BUILD_UPDATE_ENDPOINT: Option<&str> = option_env!("SPYDERBYTE_UPDATE_ENDPOINT");
const BUILD_BRIDGE_PUBLIC_KEY: Option<&str> = option_env!("SPYDERBYTE_BRIDGE_PUBLIC_KEY");

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LocalRuntimeConfig {
    pub api_base: String,
    pub auth_token: Option<String>,
    pub app_data_dir: String,
    pub license_file: String,
    pub workspace_root: String,
}

#[tauri::command]
fn local_runtime_config(app: tauri::AppHandle) -> Result<LocalRuntimeConfig, String> {
    let runtime = app
        .try_state::<LocalDaemonRuntime>()
        .ok_or_else(|| "Spyderbyte daemon state is unavailable".to_string())?;
    let ready = runtime
        .0
        .lock()
        .map_err(|_| "Spyderbyte daemon state is unavailable".to_string())?
        .clone()
        .ok_or_else(|| "Spyderbyte daemon is still starting".to_string())?;
    if !ready.ready {
        return Err("Spyderbyte daemon did not report readiness".to_string());
    }
    let process = app
        .try_state::<LocalDaemonProcess>()
        .ok_or_else(|| "Spyderbyte daemon state is unavailable".to_string())?;
    let config = process
        .0
        .lock()
        .map_err(|_| "Spyderbyte daemon state is unavailable".to_string())?
        .config
        .clone();
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve Spyderbyte data directory: {error}"))?;
    Ok(LocalRuntimeConfig {
        api_base: webview_api_base(&ready.address),
        auth_token: Some(
            ready
                .auth_token
                .unwrap_or_else(|| config.auth_token.clone()),
        ),
        app_data_dir: path_string(app_data_dir),
        license_file: path_string(config.license_file),
        workspace_root: path_string(config.workspace_root),
    })
}

fn webview_api_base(address: &str) -> String {
    address.to_owned()
}

fn path_string(path: PathBuf) -> String {
    path.to_string_lossy().into_owned()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct DesktopUpdateInfo {
    version: String,
    body: Option<String>,
    target: String,
}

#[tauri::command]
async fn check_desktop_update(app: tauri::AppHandle) -> Result<Option<DesktopUpdateInfo>, String> {
    let update = app
        .updater()
        .map_err(|error| format!("Spyderbyte updater is unavailable: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Spyderbyte update check failed: {error}"))?;
    Ok(update.map(|update| DesktopUpdateInfo {
        version: update.version,
        body: update.body,
        target: update.target,
    }))
}

#[tauri::command]
async fn install_desktop_update(app: tauri::AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|error| format!("Spyderbyte updater is unavailable: {error}"))?
        .check()
        .await
        .map_err(|error| format!("Spyderbyte update check failed: {error}"))?
        .ok_or_else(|| "No signed Spyderbyte update is available".to_string())?;
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| format!("Spyderbyte update installation failed: {error}"))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("Only HTTPS authorization URLs may be opened externally".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&url);
        command
    };
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", &url]);
        command
    };
    #[cfg(target_os = "linux")]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&url);
        command
    };
    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Unable to open the system browser: {error}"))
}

fn new_session_token() -> Result<String, String> {
    let mut bytes = [0u8; 32];
    let mut random = fs::File::open("/dev/urandom")
        .map_err(|error| format!("Unable to open the local session random source: {error}"))?;
    random
        .read_exact(&mut bytes)
        .map_err(|error| format!("Unable to read the local session random source: {error}"))?;
    Ok(bytes.iter().map(|byte| format!("{byte:02x}")).collect())
}

fn active_workspace_file(app_data_dir: &Path) -> PathBuf {
    app_data_dir.join("active-workspace.txt")
}

fn read_active_workspace(app_data_dir: &Path, fallback: PathBuf) -> PathBuf {
    let path = active_workspace_file(app_data_dir);
    let Ok(value) = fs::read_to_string(path) else {
        return fallback;
    };
    let candidate = value.trim();
    if candidate.is_empty() {
        return fallback;
    }
    let path = PathBuf::from(candidate);
    if path.is_absolute() {
        path
    } else {
        fallback
    }
}

fn write_active_workspace(app_data_dir: &Path, workspace_root: &Path) -> Result<(), String> {
    let path = active_workspace_file(app_data_dir);
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(
        &temporary,
        format!("{}\n", workspace_root.to_string_lossy()),
    )
    .map_err(|error| format!("Unable to persist the active workspace: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&temporary)
            .map_err(|error| format!("Unable to inspect the active workspace setting: {error}"))?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(&temporary, permissions)
            .map_err(|error| format!("Unable to secure the active workspace setting: {error}"))?;
    }
    fs::rename(&temporary, path)
        .map_err(|error| format!("Unable to commit the active workspace setting: {error}"))
}

fn daemon_is_stopping(app: &tauri::AppHandle) -> bool {
    app.try_state::<LocalDaemonProcess>()
        .and_then(|process| process.0.lock().ok().map(|state| state.stopping))
        .unwrap_or(true)
}

fn daemon_config(app: &tauri::AppHandle) -> Option<DaemonLaunchConfig> {
    app.try_state::<LocalDaemonProcess>()
        .and_then(|process| process.0.lock().ok().map(|state| state.config.clone()))
}

fn set_daemon_child(
    app: &tauri::AppHandle,
    child: tauri_plugin_shell::process::CommandChild,
) -> Result<(), tauri_plugin_shell::process::CommandChild> {
    let Some(process) = app.try_state::<LocalDaemonProcess>() else {
        return Err(child);
    };
    let Ok(mut state) = process.0.lock() else {
        return Err(child);
    };
    if state.stopping {
        return Err(child);
    }
    state.child = Some(child);
    Ok(())
}

fn clear_daemon_child(app: &tauri::AppHandle) {
    if let Some(process) = app.try_state::<LocalDaemonProcess>() {
        if let Ok(mut state) = process.0.lock() {
            state.child = None;
        }
    }
}

fn clear_daemon_runtime(app: &tauri::AppHandle) {
    if let Some(runtime) = app.try_state::<LocalDaemonRuntime>() {
        if let Ok(mut state) = runtime.0.lock() {
            *state = None;
        }
    }
}

fn build_daemon_command(
    app: &tauri::AppHandle,
    config: &DaemonLaunchConfig,
) -> Result<tauri_plugin_shell::process::Command, String> {
    let mut sidecar = app
        .shell()
        .sidecar("agentic-local-daemon")
        .map_err(|error| format!("Unable to resolve Spyderbyte daemon sidecar: {error}"))?
        .env("AGENTIC_WORKSPACE", &config.workspace_root)
        .env("AGENTIC_LICENSE_FILE", &config.license_file)
        .env("AGENTIC_LOCAL_API_HOST", "127.0.0.1")
        .env("AGENTIC_LOCAL_API_PORT", "0")
        .env("AGENTIC_LOCAL_API_AUTH_REQUIRED", "true")
        .env("AGENTIC_LOCAL_API_TOKEN", &config.auth_token)
        .env(
            "AGENTIC_LOCAL_API_ORIGINS",
            "tauri://localhost,http://tauri.localhost,https://tauri.localhost",
        );
    if let Ok(resource_dir) = app.path().resource_dir() {
        sidecar = sidecar.env(
            "SPYDERBYTE_BUNDLED_MELTANO_BIN",
            resource_dir.join("meltano").join("meltano"),
        );
        sidecar = sidecar.env(
            "SPYDERBYTE_MELTANO_MANIFEST",
            resource_dir.join("meltano").join("runtime-manifest.json"),
        );
        for (environment, manifest_environment, directory) in [
            ("SPYDERBYTE_PREMIERE_BRIDGE_BIN", "SPYDERBYTE_ADOBE_PREMIERE_MANIFEST", "adobe-premiere"),
            ("SPYDERBYTE_RESOLVE_BRIDGE_BIN", "SPYDERBYTE_BLACKMAGIC_RESOLVE_MANIFEST", "blackmagic-resolve"),
            ("SPYDERBYTE_FINAL_CUT_BRIDGE_BIN", "SPYDERBYTE_APPLE_FINAL_CUT_MANIFEST", "apple-final-cut"),
            ("SPYDERBYTE_MEDIA_BRIDGE_BIN", "SPYDERBYTE_LOCAL_MEDIA_MANIFEST", "local-media-bridge"),
        ] {
            sidecar = sidecar
                .env(environment, resource_dir.join("bridges").join(directory).join("bridge"))
                .env(
                    manifest_environment,
                    resource_dir.join("bridges").join(directory).join("runtime-manifest.json"),
                );
        }
    }
    if let Some(public_key) = config.public_key.as_deref() {
        sidecar = sidecar.env("AGENTIC_LICENSE_PUBLIC_KEY", public_key);
    }
    if let Some(key_id) = config.key_id.as_deref() {
        sidecar = sidecar.env("AGENTIC_LICENSE_KEY_ID", key_id);
    }
    if let Some(public_key) = BUILD_MELTANO_PUBLIC_KEY {
        sidecar = sidecar
            .env("SPYDERBYTE_MELTANO_PUBLIC_KEY", public_key)
            .env("SPYDERBYTE_REQUIRE_SIGNED_MELTANO", "true");
    }
    if let Some(endpoint) = BUILD_UPDATE_ENDPOINT {
        sidecar = sidecar.env("SPYDERBYTE_UPDATE_ENDPOINT", endpoint);
    }
    if let Some(public_key) = BUILD_BRIDGE_PUBLIC_KEY {
        sidecar = sidecar
            .env("SPYDERBYTE_BRIDGE_PUBLIC_KEY", public_key)
            .env("SPYDERBYTE_REQUIRE_SIGNED_BRIDGES", "true");
    }
    Ok(sidecar)
}

async fn supervise_local_daemon(app: tauri::AppHandle) {
    let mut restart_count = 0;
    let mut ready_at: Option<Instant> = None;

    loop {
        if daemon_is_stopping(&app) {
            break;
        }
        let Some(config) = daemon_config(&app) else {
            break;
        };
        let sidecar = match build_daemon_command(&app, &config) {
            Ok(sidecar) => sidecar,
            Err(error) => {
                clear_daemon_runtime(&app);
                eprintln!("local daemon start error: {error}");
                break;
            }
        };
        let (mut events, child) = match sidecar.spawn() {
            Ok(result) => result,
            Err(error) => {
                clear_daemon_runtime(&app);
                eprintln!("local daemon spawn error: {error}");
                restart_count += 1;
                if restart_count > MAX_DAEMON_RESTARTS {
                    eprintln!("local daemon restart limit reached");
                    break;
                }
                let backoff = DAEMON_RESTART_BACKOFF_MS * 2u64.pow(restart_count - 1);
                tokio::time::sleep(Duration::from_millis(backoff)).await;
                continue;
            }
        };
        if let Err(child) = set_daemon_child(&app, child) {
            let _ = child.kill();
            break;
        }

        let mut terminated = false;
        while let Some(event) = events.recv().await {
            match event {
                CommandEvent::Stdout(line) => {
                    if let Ok(ready) = serde_json::from_slice::<DaemonReady>(&line) {
                        if ready.ready {
                            let mut ready = ready;
                            if ready.auth_token.is_none() {
                                ready.auth_token = Some(config.auth_token.clone());
                            }
                            ready_at = Some(Instant::now());
                            if let Some(runtime) = app.try_state::<LocalDaemonRuntime>() {
                                if let Ok(mut state) = runtime.0.lock() {
                                    *state = Some(ready);
                                }
                            }
                        }
                    }
                }
                CommandEvent::Stderr(line) => {
                    eprintln!("local daemon: {}", String::from_utf8_lossy(&line));
                }
                CommandEvent::Terminated(payload) => {
                    terminated = true;
                    if ready_at.is_some_and(|started| started.elapsed() >= DAEMON_STABLE_WINDOW) {
                        restart_count = 0;
                    }
                    eprintln!(
                        "local daemon terminated (code={:?}, signal={:?})",
                        payload.code, payload.signal
                    );
                    break;
                }
                CommandEvent::Error(error) => eprintln!("local daemon error: {error}"),
                _ => {}
            }
        }
        clear_daemon_child(&app);
        clear_daemon_runtime(&app);
        if daemon_is_stopping(&app) || !terminated {
            break;
        }
        restart_count += 1;
        if restart_count > MAX_DAEMON_RESTARTS {
            eprintln!("local daemon restart limit reached");
            break;
        }
        let backoff = DAEMON_RESTART_BACKOFF_MS * 2u64.pow(restart_count - 1);
        eprintln!("restarting local daemon in {backoff}ms");
        tokio::time::sleep(Duration::from_millis(backoff)).await;
    }
}

#[tauri::command]
fn choose_workspace_directory() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(rfd::FileDialog::new()
            .set_title("Choose a Spyderbyte workspace folder")
            .pick_folder()
            .map(|path| path_string(path)));
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Native workspace dialogs are only available in the macOS Spyderbyte".to_string())
    }
}

#[tauri::command]
fn choose_workspace_archive_file() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(rfd::FileDialog::new()
            .set_title("Choose a Spyderbyte workspace archive")
            .add_filter("Agentic workspace", &["agentic"])
            .pick_file()
            .map(|path| path_string(path)));
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Native workspace dialogs are only available in the macOS Spyderbyte".to_string())
    }
}

#[tauri::command]
fn choose_workspace_archive_save_path() -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        return Ok(rfd::FileDialog::new()
            .set_title("Export the Spyderbyte workspace")
            .add_filter("Agentic workspace", &["agentic"])
            .set_file_name("workspace.agentic")
            .save_file()
            .map(|path| path_string(path)));
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Native workspace dialogs are only available in the macOS Spyderbyte".to_string())
    }
}

#[tauri::command]
fn choose_workspace_import_destination(
    suggested_name: Option<String>,
) -> Result<Option<String>, String> {
    #[cfg(target_os = "macos")]
    {
        let raw_name = suggested_name.unwrap_or_else(|| "Imported workspace".to_string());
        let safe_name: String = raw_name
            .trim()
            .chars()
            .map(|character| {
                if character.is_ascii_alphanumeric() || matches!(character, ' ' | '-' | '_') {
                    character
                } else {
                    '_'
                }
            })
            .collect();
        let safe_name = if safe_name.trim().is_empty() {
            "Imported workspace".to_string()
        } else {
            safe_name.trim().to_string()
        };
        return Ok(rfd::FileDialog::new()
            .set_title("Choose where to restore the workspace")
            .pick_folder()
            .map(|parent| {
                let mut candidate = parent.join(&safe_name);
                let mut suffix = 2u32;
                while candidate.exists() {
                    candidate = parent.join(format!("{safe_name} {suffix}"));
                    suffix += 1;
                }
                path_string(candidate)
            }));
    }
    #[cfg(not(target_os = "macos"))]
    {
        Err("Native workspace dialogs are only available in the macOS Spyderbyte".to_string())
    }
}

#[tauri::command]
fn switch_workspace(app: tauri::AppHandle, workspace_root: String) -> Result<(), String> {
    let trimmed = workspace_root.trim();
    if trimmed.is_empty() {
        return Err("A workspace folder is required".to_string());
    }
    let path = PathBuf::from(trimmed);
    if !path.is_absolute() {
        return Err("Workspace folder must be an absolute path".to_string());
    }
    fs::create_dir_all(&path)
        .map_err(|error| format!("Unable to prepare the selected workspace folder: {error}"))?;
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve Spyderbyte data directory: {error}"))?;
    write_active_workspace(&app_data_dir, &path)?;
    let process = app
        .try_state::<LocalDaemonProcess>()
        .ok_or_else(|| "Spyderbyte daemon state is unavailable".to_string())?;
    let child = {
        let mut state = process
            .0
            .lock()
            .map_err(|_| "Spyderbyte daemon state is unavailable".to_string())?;
        if state.stopping {
            return Err("Spyderbyte is shutting down".to_string());
        }
        state.config.workspace_root = path;
        state.child.take()
    };
    clear_daemon_runtime(&app);
    if let Some(child) = child {
        child
            .kill()
            .map_err(|error| format!("Unable to restart the Spyderbyte daemon: {error}"))?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn read_keychain_receipt() -> Result<Option<String>, String> {
    use security_framework::passwords::get_generic_password;

    match get_generic_password(LICENSE_KEYCHAIN_SERVICE, LICENSE_KEYCHAIN_ACCOUNT) {
        Ok(value) => String::from_utf8(value)
            .map(Some)
            .map_err(|error| format!("Stored Spyderbyte receipt is not UTF-8: {error}")),
        Err(error) if error.code() == -25300 => Ok(None),
        Err(error) => Err(format!(
            "Unable to read the Spyderbyte Keychain receipt: {error}"
        )),
    }
}

#[cfg(not(target_os = "macos"))]
fn read_keychain_receipt() -> Result<Option<String>, String> {
    Err("Spyderbyte Keychain storage is only available on macOS".to_string())
}

#[cfg(target_os = "macos")]
fn write_keychain_receipt(value: &str) -> Result<(), String> {
    use security_framework::passwords::set_generic_password;

    set_generic_password(
        LICENSE_KEYCHAIN_SERVICE,
        LICENSE_KEYCHAIN_ACCOUNT,
        value.as_bytes(),
    )
    .map_err(|error| format!("Unable to store the Spyderbyte Keychain receipt: {error}"))
}

#[cfg(not(target_os = "macos"))]
fn write_keychain_receipt(_value: &str) -> Result<(), String> {
    Err("Spyderbyte Keychain storage is only available on macOS".to_string())
}

fn write_license_cache(path: &PathBuf, value: &str) -> Result<(), String> {
    let temporary = path.with_extension(format!("tmp-{}", std::process::id()));
    fs::write(&temporary, value)
        .map_err(|error| format!("Unable to write the Spyderbyte license cache: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(&temporary)
            .map_err(|error| format!("Unable to inspect the Spyderbyte license cache: {error}"))?
            .permissions();
        permissions.set_mode(0o600);
        fs::set_permissions(&temporary, permissions)
            .map_err(|error| format!("Unable to secure the Spyderbyte license cache: {error}"))?;
    }
    if let Err(error) = fs::rename(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(format!(
            "Unable to commit the Spyderbyte license cache: {error}"
        ));
    }
    Ok(())
}

fn ensure_private_directory(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path)
        .map_err(|error| format!("Unable to create Spyderbyte private directory: {error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = fs::metadata(path)
            .map_err(|error| format!("Unable to inspect Spyderbyte private directory: {error}"))?
            .permissions();
        permissions.set_mode(0o700);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Unable to secure Spyderbyte private directory: {error}"))?;
    }
    Ok(())
}

fn seed_license_cache_from_keychain(path: &PathBuf) -> Result<(), String> {
    if let Some(receipt) = read_keychain_receipt()? {
        write_license_cache(path, &receipt)?;
    }
    Ok(())
}

#[tauri::command]
fn store_license_receipt(app: tauri::AppHandle, license_json: String) -> Result<(), String> {
    let value: serde_json::Value = serde_json::from_str(&license_json)
        .map_err(|error| format!("Signed Spyderbyte license must be valid JSON: {error}"))?;
    if !value.is_object() {
        return Err("Signed Spyderbyte license must be a JSON object".to_string());
    }
    write_keychain_receipt(&license_json)?;
    let persisted = read_keychain_receipt()?.ok_or_else(|| {
        "The Spyderbyte license receipt was not readable after import".to_string()
    })?;
    if persisted != license_json {
        return Err(
            "The Spyderbyte license receipt changed during Keychain persistence".to_string(),
        );
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|error| format!("Unable to resolve Spyderbyte data directory: {error}"))?;
    ensure_private_directory(&app_data_dir.join("license"))?;
    write_license_cache(
        &app_data_dir.join("license").join("entitlement.json"),
        &license_json,
    )
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            app.manage(LocalDaemonRuntime(Mutex::new(None)));
            let app_data_dir = app
                .path()
                .app_data_dir()
                .map_err(|error| format!("Unable to resolve Spyderbyte data directory: {error}"))?;
            let default_workspace_root = app_data_dir.join("workspaces").join("default");
            let workspace_root = read_active_workspace(&app_data_dir, default_workspace_root);
            let license_directory = app_data_dir.join("license");
            fs::create_dir_all(&workspace_root)
                .map_err(|error| format!("Unable to create Spyderbyte workspace root: {error}"))?;
            ensure_private_directory(&license_directory)?;
            let license_file = license_directory.join("entitlement.json");
            if let Err(error) = seed_license_cache_from_keychain(&license_file) {
                eprintln!("local license keychain unavailable: {error}");
            }
            let auth_token = new_session_token()
                .map_err(|error| std::io::Error::new(std::io::ErrorKind::Other, error))?;
            let config = DaemonLaunchConfig {
                workspace_root,
                license_file,
                // A release key is immutable once embedded; runtime environment values are only
                // a development fallback for binaries built without release key material.
                public_key: BUILD_LICENSE_PUBLIC_KEY.map(str::to_owned).or_else(|| {
                    std::env::var("AGENTIC_LICENSE_PUBLIC_KEY")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                }),
                key_id: BUILD_LICENSE_KEY_ID.map(str::to_owned).or_else(|| {
                    std::env::var("AGENTIC_LICENSE_KEY_ID")
                        .ok()
                        .filter(|value| !value.trim().is_empty())
                }),
                auth_token,
            };
            app.manage(LocalDaemonProcess(Mutex::new(LocalDaemonProcessState {
                child: None,
                stopping: false,
                config,
            })));
            tauri::async_runtime::spawn(supervise_local_daemon(app.handle().clone()));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            local_runtime_config,
            open_external_url,
            store_license_receipt,
            choose_workspace_directory,
            choose_workspace_archive_file,
            choose_workspace_archive_save_path,
            choose_workspace_import_destination,
            switch_workspace,
            check_desktop_update,
            install_desktop_update
        ]);
    builder
        .build(tauri::generate_context!())
        .expect("error while building Spyderbyte")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(process) = app.try_state::<LocalDaemonProcess>() {
                    if let Ok(mut state) = process.0.lock() {
                        state.stopping = true;
                        if let Some(child) = state.child.take() {
                            let _ = child.kill();
                        }
                    }
                }
            }
        });
}
