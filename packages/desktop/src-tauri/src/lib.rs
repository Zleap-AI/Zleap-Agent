use serde::Deserialize;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, LazyLock, Mutex, OnceLock};
use std::thread;
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::{
    menu::{Menu, MenuItem},
    tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
    AppHandle, Manager, RunEvent, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

/// Build a `Command` that never pops a console window on Windows. The desktop
/// shell is a GUI process, so spawning console subprocesses (node, tar,
/// powershell) would otherwise flash a cmd window for each child.
fn hidden_command<S: AsRef<std::ffi::OsStr>>(program: S) -> Command {
    let cmd = Command::new(program);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let mut cmd = cmd;
        cmd.creation_flags(CREATE_NO_WINDOW);
        return cmd;
    }
    #[cfg(not(windows))]
    cmd
}

static WEB_PORT: OnceLock<u16> = OnceLock::new();
const DEFAULT_WEB_PORT: u16 = 4789;
static DESKTOP_SESSION_ID: OnceLock<String> = OnceLock::new();
static BOOTSTRAP_ERROR: LazyLock<Arc<Mutex<Option<String>>>> =
    LazyLock::new(|| Arc::new(Mutex::new(None)));

#[derive(Debug, Deserialize, Default)]
struct DistributionRuntime {
    #[serde(rename = "webPort")]
    web_port: Option<u16>,
    #[serde(rename = "nodeVersion")]
    node_version: Option<String>,
    #[serde(rename = "authMode")]
    auth_mode: Option<String>,
    #[serde(rename = "serveMode")]
    serve_mode: Option<String>,
    gateway: Option<bool>,
}

#[derive(Debug, Deserialize, Default)]
struct DistributionConfig {
    runtime: Option<DistributionRuntime>,
}

#[derive(Debug, Deserialize, Default, Clone)]
struct AppMetadata {
    version: Option<String>,
    #[serde(rename = "builtAt")]
    built_at: Option<String>,
    #[serde(rename = "nodeVersion")]
    node_version: Option<String>,
}

#[derive(Debug, Deserialize)]
struct BootstrapProgress {
    step: String,
    message: String,
    ok: Option<bool>,
}

#[derive(Debug, Deserialize)]
struct BootstrapResult {
    ok: bool,
    url: Option<String>,
    error: Option<String>,
    step: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ServeState {
    #[serde(rename = "startedBy")]
    started_by: Option<String>,
    #[serde(rename = "sessionId")]
    session_id: Option<String>,
    #[serde(rename = "stopPolicy")]
    stop_policy: Option<String>,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            retry_bootstrap,
            open_logs_folder,
            get_bootstrap_error
        ])
        .setup(|app| {
            open_splash_window(app.handle())?;
            spawn_bootstrap(app.handle().clone());
            setup_tray(app.handle())?;
            #[cfg(target_os = "macos")]
            install_app_menu(app)?;
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if matches!(event, RunEvent::Exit) {
                stop_all_services(&app_handle);
            }
        });
}

/// Standard update flow. `interactive` = triggered by the user (menu/tray): always
/// reports the outcome (up to date / error). `interactive=false` = the silent
/// launch check: only surfaces a prompt when a newer version actually exists.
fn check_for_update(app: &AppHandle, interactive: bool) {
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        let updater = match app.updater() {
            Ok(updater) => updater,
            Err(error) => {
                if interactive {
                    app.dialog()
                        .message(format!("更新组件不可用：{error}"))
                        .title("Zleap 更新")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                }
                return;
            }
        };

        match updater.check().await {
            Ok(Some(update)) => {
                let proceed = app
                    .dialog()
                    .message(format!(
                        "发现新版本 v{}（当前 v{}）。\n是否现在下载并安装更新？完成后应用会自动重启。",
                        update.version, update.current_version
                    ))
                    .title("Zleap 有可用更新")
                    .kind(MessageDialogKind::Info)
                    .buttons(MessageDialogButtons::OkCancelCustom(
                        "立即更新".to_string(),
                        "稍后".to_string(),
                    ))
                    .blocking_show();
                if proceed {
                    perform_update(&app, update).await;
                }
            }
            Ok(None) => {
                if interactive {
                    app.dialog()
                        .message("当前已是最新版本。")
                        .title("Zleap 更新")
                        .kind(MessageDialogKind::Info)
                        .blocking_show();
                }
            }
            Err(error) => {
                if interactive {
                    app.dialog()
                        .message(format!(
                            "检查更新失败：{error}\n请稍后重试，或前往官网下载最新安装包。"
                        ))
                        .title("Zleap 更新")
                        .kind(MessageDialogKind::Error)
                        .blocking_show();
                }
            }
        }
    });
}

/// Download + install a confirmed update, surfacing progress on the splash window.
/// Services are only stopped once the download succeeds, so a failed/cancelled
/// download leaves the running app fully intact.
async fn perform_update(app: &AppHandle, update: tauri_plugin_updater::Update) {
    show_progress_splash(app);
    set_splash_hint(app, "正在下载更新，请保持网络连接，勿关闭窗口。");
    set_splash_progress(app, 0, "正在下载更新…");

    let reporter = app.clone();
    let mut downloaded: u64 = 0;
    let result = update
        .download_and_install(
            move |chunk, total| {
                downloaded = downloaded.saturating_add(chunk as u64);
                let mb = |bytes: u64| (bytes as f64 / 1_048_576.0).round() as u64;
                match total {
                    Some(total) if total > 0 => {
                        let pct = ((downloaded.min(total) as f64 / total as f64) * 100.0) as u8;
                        set_splash_progress(
                            &reporter,
                            pct,
                            &format!("正在下载更新 {pct}%（{}/{} MB）", mb(downloaded), mb(total)),
                        );
                    }
                    _ => set_splash_progress(
                        &reporter,
                        0,
                        &format!("正在下载更新 {} MB…", mb(downloaded)),
                    ),
                }
            },
            || {},
        )
        .await;

    match result {
        Ok(_) => {
            stop_all_services(app);
            set_splash_progress(app, 100, "更新完成，正在重启…");
            app.restart();
        }
        Err(error) => {
            if let Some(splash) = app.get_webview_window("splash") {
                let _ = splash.close();
            }
            app.dialog()
                .message(format!(
                    "更新安装失败：{error}\n你可以前往官网下载最新安装包手动更新。"
                ))
                .title("Zleap 更新")
                .kind(MessageDialogKind::Error)
                .blocking_show();
        }
    }
}

#[cfg(target_os = "macos")]
fn install_app_menu(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{AboutMetadata, PredefinedMenuItem, Submenu};

    let about_metadata = AboutMetadata {
        name: Some("Zleap".to_string()),
        version: Some(env!("CARGO_PKG_VERSION").to_string()),
        ..Default::default()
    };
    let check_update = MenuItem::with_id(app, "check_update", "检查更新…", true, None::<&str>)?;
    let app_submenu = Submenu::with_items(
        app,
        "Zleap",
        true,
        &[
            &PredefinedMenuItem::about(app, Some("关于 Zleap"), Some(about_metadata))?,
            &check_update,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::services(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::hide(app, None)?,
            &PredefinedMenuItem::hide_others(app, None)?,
            &PredefinedMenuItem::show_all(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::quit(app, None)?,
        ],
    )?;
    // Keep a standard Edit menu so copy/paste/select-all keyboard shortcuts work
    // inside the web app webview (a custom menu replaces the macOS default).
    let edit_submenu = Submenu::with_items(
        app,
        "编辑",
        true,
        &[
            &PredefinedMenuItem::undo(app, None)?,
            &PredefinedMenuItem::redo(app, None)?,
            &PredefinedMenuItem::separator(app)?,
            &PredefinedMenuItem::cut(app, None)?,
            &PredefinedMenuItem::copy(app, None)?,
            &PredefinedMenuItem::paste(app, None)?,
            &PredefinedMenuItem::select_all(app, None)?,
        ],
    )?;
    let menu = Menu::with_items(app, &[&app_submenu, &edit_submenu])?;
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        if event.id().as_ref() == "check_update" {
            check_for_update(app, true);
        }
    });
    Ok(())
}

// Window create / show / eval must happen on the main thread (AppKit requirement);
// the updater download progress runs on a worker thread, so dispatch via the app.
fn show_progress_splash(app: &AppHandle) {
    let app = app.clone();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(splash) = app.get_webview_window("splash") {
            let _ = splash.show();
            let _ = splash.set_focus();
        } else {
            let _ = open_splash_window(&app);
        }
    });
}

fn set_splash_progress(app: &AppHandle, pct: u8, message: &str) {
    let app = app.clone();
    let message = message.to_string();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window("splash") {
            let script = format!(
                "window.__zleapSetProgress && window.__zleapSetProgress({}, {:?});",
                pct, message
            );
            let _ = win.eval(&script);
        }
    });
}

fn set_splash_hint(app: &AppHandle, text: &str) {
    let app = app.clone();
    let text = text.to_string();
    let _ = app.clone().run_on_main_thread(move || {
        if let Some(win) = app.get_webview_window("splash") {
            let _ = win.eval(&format!(
                "window.__zleapSetHint && window.__zleapSetHint({:?});",
                text
            ));
        }
    });
}

fn spawn_bootstrap(app: AppHandle) {
    thread::spawn(move || {
        let result = run_desktop_bootstrap(&app);
        let app_for_main = app.clone();
        let _ = app.run_on_main_thread(move || {
            finish_bootstrap(&app_for_main, result);
        });
    });
}

#[tauri::command]
fn retry_bootstrap(app: AppHandle) {
    if let Some(main) = app.get_webview_window("main") {
        let _ = main.close();
    }
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.show();
        let _ = splash.set_focus();
    } else {
        let _ = open_splash_window(&app);
    }
    spawn_bootstrap(app);
}

#[tauri::command]
fn open_logs_folder(app: AppHandle) -> Result<(), String> {
    let logs = zleap_home().join("logs");
    std::fs::create_dir_all(&logs).map_err(|e| e.to_string())?;
    app.shell()
        .open(logs.to_string_lossy().to_string(), None)
        .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
fn get_bootstrap_error() -> Option<String> {
    BOOTSTRAP_ERROR.lock().ok().and_then(|error| error.clone())
}

fn finish_bootstrap(app: &AppHandle, result: Result<String, String>) {
    if let Some(splash) = app.get_webview_window("splash") {
        let _ = splash.close();
    }
    match result {
        Ok(url) => {
            *BOOTSTRAP_ERROR.lock().unwrap() = None;
            let _ = open_main_window(app, &url);
            // Standard flow: once the app is up, silently check for a newer version and
            // only prompt the user if one exists (no nagging when already up to date).
            check_for_update(app, false);
        }
        Err(message) => {
            eprintln!("Zleap desktop bootstrap failed: {message}");
            *BOOTSTRAP_ERROR.lock().unwrap() = Some(message.clone());
            let _ = open_error_window(app, &message);
        }
    }
}

fn open_splash_window(app: &AppHandle) -> tauri::Result<()> {
    WebviewWindowBuilder::new(app, "splash", WebviewUrl::App("splash.html".into()))
        .title("Zleap")
        .inner_size(480.0, 420.0)
        .resizable(false)
        .center()
        .build()?;
    Ok(())
}

fn open_main_window(app: &AppHandle, url: &str) -> tauri::Result<()> {
    if app.get_webview_window("main").is_some() {
        return Ok(());
    }
    WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url.parse().unwrap()))
        .title("Zleap")
        .inner_size(1280.0, 840.0)
        .center()
        .build()?;
    Ok(())
}

fn open_error_window(app: &AppHandle, message: &str) -> tauri::Result<()> {
    let escaped = message.replace('&', "&amp;").replace('<', "&lt;");
    let url = format!("error.html?message={}", percent_encode(message));
    WebviewWindowBuilder::new(app, "main", WebviewUrl::App(url.into()))
        .title("Zleap")
        .inner_size(720.0, 480.0)
        .center()
        .build()?;
    if let Some(win) = app.get_webview_window("main") {
        let script = format!(
            "window.__zleapSetError && window.__zleapSetError({:?});",
            escaped
        );
        let _ = win.eval(&script);
    }
    Ok(())
}

fn percent_encode(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char);
            }
            _ => encoded.push_str(&format!("%{byte:02X}")),
        }
    }
    encoded
}

fn run_desktop_bootstrap(app: &AppHandle) -> Result<String, String> {
    let home = zleap_home();
    let resources = resolve_resources_root(app);
    let slim = resources.as_ref().is_some_and(|root| {
        root.join("bootstrap.tar.gz").exists()
            && root.join("download.json").exists()
            && !root.join("payload").join("app.tar.gz").exists()
    });

    let (script_root, dist, bundled_for_seed, payload_dir, use_download) = if slim {
        let resources = resources.ok_or("slim desktop resources missing")?;
        let bootstrap = ensure_bootstrap_root(app, &resources)?;
        let meta = read_metadata_file(&resources.join("metadata.json")).unwrap_or_default();
        let mut runtime = DistributionRuntime::default();
        runtime.web_port = Some(resolve_web_port_from_metadata(&meta));
        runtime.node_version = meta.node_version.clone();
        runtime.auth_mode = Some("localhost".to_string());
        runtime.serve_mode = Some("production".to_string());
        runtime.gateway = Some(true);
        let dist = DistributionConfig {
            runtime: Some(runtime),
        };
        (
            bootstrap,
            dist,
            None,
            Some(resources),
            true,
        )
    } else {
        let bundled = prepare_runtime_root(app)?;
        let dist = load_distribution(&bundled);
        (
            bundled.clone(),
            dist,
            Some(bundled),
            resolve_bundled_payload_dir(app),
            false,
        )
    };

    let port = dist
        .runtime
        .as_ref()
        .and_then(|runtime| runtime.web_port)
        .unwrap_or_else(|| resolve_web_port(&script_root));
    let _ = WEB_PORT.set(port);

    let script = host_script(&script_root, "desktop-bootstrap-cli.js");
    if !script.exists() {
        return Err(format!(
            "desktop-bootstrap-cli not found at {}",
            script.display()
        ));
    }

    let runtime = dist.runtime.unwrap_or_default();
    let node_bin = resolve_node_bin(
        app,
        &script_root,
        runtime.node_version.as_deref(),
    )?;

    let mut cmd = hidden_command(&node_bin);
    cmd.arg(&script);
    cmd.arg("--json");
    cmd.env("ZLEAP_HOME", &home);
    if let Some(bundled) = bundled_for_seed.as_ref() {
        cmd.env("ZLEAP_BUNDLED_ROOT", bundled);
    }
    if let Some(payload) = payload_dir {
        cmd.env("ZLEAP_BUNDLED_PAYLOAD", payload);
    }
    cmd.env("ZLEAP_RUNTIME_ROOT", home.join("app"));
    cmd.env("ZLEAP_DESKTOP", "1");
    cmd.env("ZLEAP_INSTALL_METHOD", "desktop");
    cmd.env("ZLEAP_STARTED_BY", "desktop");
    cmd.env("ZLEAP_LAUNCHER_SESSION_ID", desktop_session_id());
    cmd.env("ZLEAP_STOP_POLICY", "onDesktopQuit");
    cmd.env("ZLEAP_NODE_BIN", &node_bin);
    cmd.env(
        "ZLEAP_SERVE_MODE",
        runtime
            .serve_mode
            .unwrap_or_else(|| "production".to_string()),
    );
    cmd.env("ZLEAP_SKIP_BUILD", "1");
    cmd.env(
        "ZLEAP_AUTH_MODE",
        runtime.auth_mode.unwrap_or_else(|| "localhost".to_string()),
    );
    cmd.env(
        "ZLEAP_GATEWAY",
        if runtime.gateway.unwrap_or(false) {
            "1"
        } else {
            "0"
        },
    );
    cmd.env("ZLEAP_WEB_PORT", port.to_string());
    cmd.env(
        "ZLEAP_DESKTOP_DOWNLOAD",
        if use_download { "1" } else { "0" },
    );
    cmd.env("ZLEAP_DESKTOP_AUTO_UPDATE", "0");
    if !use_download {
        if let Some(pg_archive) = resolve_bundled_postgres_archive(app) {
            cmd.env("ZLEAP_POSTGRES_BUNDLE", &pg_archive);
        }
    }
    cmd.current_dir(&script_root);
    cmd.stdout(Stdio::piped());
    cmd.stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| e.to_string())?;
    let stdout = child.stdout.take().ok_or("missing stdout")?;
    let stderr = child.stderr.take().ok_or("missing stderr")?;
    let reader = BufReader::new(stdout);
    let stderr_buffer = Arc::new(Mutex::new(String::new()));
    let stderr_for_thread = stderr_buffer.clone();
    let stderr_thread = thread::spawn(move || {
        for line in BufReader::new(stderr).lines().map_while(Result::ok) {
            let mut buffer = stderr_for_thread.lock().unwrap();
            if !buffer.is_empty() {
                buffer.push('\n');
            }
            buffer.push_str(&line);
        }
    });

    let mut final_url: Option<String> = None;
    let mut last_error: Option<String> = None;

    for line in reader.lines() {
        let line = line.map_err(|e| e.to_string())?;
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        if let Ok(progress) = serde_json::from_str::<BootstrapProgress>(trimmed) {
            let ui = app.clone();
            let step = progress.step.clone();
            let message = progress.message.clone();
            let _ = ui.clone().run_on_main_thread(move || {
                update_splash_step(&ui, &step, &message);
            });
            continue;
        }
        if let Ok(result) = serde_json::from_str::<BootstrapResult>(trimmed) {
            if result.ok {
                final_url = result.url;
            } else {
                last_error = result.error;
            }
        }
    }

    let status = child.wait().map_err(|e| e.to_string())?;
    let _ = stderr_thread.join();
    if !status.success() {
        let stderr = stderr_buffer.lock().unwrap().trim().to_string();
        return Err(last_error.unwrap_or_else(|| {
            if stderr.is_empty() {
                format!("bootstrap exited with {status}")
            } else {
                stderr
            }
        }));
    }

    final_url.ok_or_else(|| last_error.unwrap_or_else(|| "bootstrap finished without URL".into()))
}

fn update_splash_step(app: &AppHandle, step: &str, message: &str) {
    if let Some(win) = app.get_webview_window("splash") {
        let script = format!(
            "window.__zleapSetStep && window.__zleapSetStep({:?}, {:?});",
            step, message
        );
        let _ = win.eval(&script);
    }
}

/// Push a splash step from a worker thread (e.g. the bootstrap thread, before the
/// node child starts streaming progress). eval must run on the main thread.
fn emit_splash_step(app: &AppHandle, step: &str, message: &str) {
    let ui = app.clone();
    let step = step.to_string();
    let message = message.to_string();
    let _ = ui.clone().run_on_main_thread(move || {
        update_splash_step(&ui, &step, &message);
    });
}

fn stop_all_services(app: &AppHandle) {
    if !desktop_owns_runtime_session() {
        return;
    }
    let app_root = resolve_runtime_root(app);
    let node_bin = resolve_node_bin(app, &app_root, None).unwrap_or_else(|_| PathBuf::from("node"));
    let control = host_script(&app_root, "control-cli.js");
    if control.exists() {
        let _ = hidden_command(node_bin)
            .arg(control)
            .arg("stop")
            .arg("--desktop-session-only")
            .arg("--session-id")
            .arg(desktop_session_id())
            .env("ZLEAP_APP_ROOT", &app_root)
            .env("ZLEAP_REPO_ROOT", &app_root)
            .status();
    }
}

fn desktop_owns_runtime_session() -> bool {
    let state_path = zleap_home().join("state").join("serve.json");
    let raw = match std::fs::read_to_string(state_path) {
        Ok(raw) => raw,
        Err(_) => return false,
    };
    let state = match serde_json::from_str::<ServeState>(&raw) {
        Ok(state) => state,
        Err(_) => return false,
    };
    state.started_by.as_deref() == Some("desktop")
        && state.session_id.as_deref() == Some(desktop_session_id())
        && state.stop_policy.as_deref() == Some("onDesktopQuit")
}

fn load_distribution(app_root: &Path) -> DistributionConfig {
    let path = app_root.join("distribution.json");
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

fn resolve_web_port(app_root: &Path) -> u16 {
    if let Ok(port) = std::env::var("ZLEAP_WEB_PORT") {
        if let Ok(parsed) = port.parse::<u16>() {
            return parsed;
        }
    }
    load_distribution(app_root)
        .runtime
        .and_then(|runtime| runtime.web_port)
        .unwrap_or(DEFAULT_WEB_PORT)
}

fn zleap_home() -> PathBuf {
    if let Ok(home) = std::env::var("ZLEAP_HOME") {
        return PathBuf::from(home);
    }
    dirs::home_dir()
        .unwrap_or_else(|| PathBuf::from("."))
        .join(".zleap")
}

fn desktop_session_id() -> &'static str {
    DESKTOP_SESSION_ID.get_or_init(|| {
        let millis = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0);
        format!("desktop-{}-{millis}", std::process::id())
    })
}

fn resolve_bundled_root(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(root) = std::env::var("ZLEAP_BUNDLED_ROOT") {
        let path = PathBuf::from(root);
        if host_script(&path, "serve-cli.js").exists() {
            return Some(path);
        }
    }
    if let Ok(dir) = app.path().resource_dir() {
        for bundled in [dir.join("resources").join("app"), dir.join("app")] {
            let serve_cli = host_script(&bundled, "serve-cli.js");
            if serve_cli.exists() {
                return Some(bundled);
            }
        }
    }
    None
}

fn prepare_runtime_root(app: &AppHandle) -> Result<PathBuf, String> {
    if let Some(expanded) = resolve_bundled_root(app) {
        return Ok(expanded);
    }

    let current = zleap_home().join("app").join("current");
    let seed = resolve_bundled_seed_archive(app);
    if let Some(seed_archive) = seed.as_ref() {
        if should_install_seed(app, &current)? {
            // Self-contained installer: this unpacks the embedded ~880MB payload and is
            // the longest step of a first launch. It runs on the bootstrap thread before
            // node starts streaming progress, so surface it to the splash directly —
            // otherwise the window looks frozen on "初始化环境" for the whole extraction.
            emit_splash_step(app, "seed", "首次启动：正在本地解压运行时（约 30–60 秒，无需联网）…");
            return install_seed_archive(seed_archive);
        }
    }

    if is_app_root(&current) {
        return Ok(current);
    }

    if let Some(seed_archive) = seed {
        emit_splash_step(app, "seed", "正在本地解压运行时（无需联网）…");
        return install_seed_archive(&seed_archive);
    }

    Err("未找到可用 app runtime（~/.zleap/app/current 或 Resources/resources/payload）".to_string())
}

fn resolve_runtime_root(app: &AppHandle) -> PathBuf {
    let current = zleap_home().join("app").join("current");
    if host_script(&current, "serve-cli.js").exists() {
        return current;
    }
    resolve_bundled_root(app).unwrap_or(current)
}

fn is_app_root(root: &Path) -> bool {
    host_script(root, "desktop-bootstrap-cli.js").exists()
        && host_script(root, "serve-cli.js").exists()
        && root.join("web").join("packages").join("web").join("server.js").exists()
}

fn host_script(root: &Path, script: &str) -> PathBuf {
    root
        .join("runtime")
        .join("node_modules")
        .join("@zleap")
        .join("host")
        .join("dist")
        .join(script)
}

fn should_install_seed(app: &AppHandle, current: &Path) -> Result<bool, String> {
    if !is_app_root(current) {
        return Ok(true);
    }
    let seed_meta = match read_seed_metadata(app) {
        Some(meta) => meta,
        None => return Ok(false),
    };
    let current_meta = read_installed_metadata(current).unwrap_or_default();
    let Some(seed_version) = seed_meta.version.as_deref() else {
        return Ok(false);
    };
    let Some(current_version) = current_meta.version.as_deref() else {
        return Ok(true);
    };
    let version_order = compare_versions(seed_version, current_version);
    if version_order > 0 {
        return Ok(true);
    }
    if version_order < 0 {
        return Ok(false);
    }
    Ok(seed_meta.built_at.is_some() && seed_meta.built_at != current_meta.built_at)
}

fn read_seed_metadata(app: &AppHandle) -> Option<AppMetadata> {
    let seed_dir = resolve_bundled_seed_dir(app)?;
    [
        seed_dir.join("manifest.json"),
        seed_dir.join("metadata.json"),
    ]
    .into_iter()
    .find_map(|path| read_metadata_file(&path))
}

fn read_installed_metadata(current: &Path) -> Option<AppMetadata> {
    let app_root = current.parent()?;
    [
        app_root.join("metadata.json"),
        current.join("manifest.json"),
        current.join("metadata.json"),
    ]
    .into_iter()
    .find_map(|path| read_metadata_file(&path))
}

fn read_metadata_file(path: &Path) -> Option<AppMetadata> {
    std::fs::read_to_string(path)
        .ok()
        .and_then(|raw| serde_json::from_str(&raw).ok())
}

fn compare_versions(left: &str, right: &str) -> i8 {
    let left_parts = version_parts(left);
    let right_parts = version_parts(right);
    let len = left_parts.len().max(right_parts.len());
    for index in 0..len {
        let a = *left_parts.get(index).unwrap_or(&0);
        let b = *right_parts.get(index).unwrap_or(&0);
        if a > b {
            return 1;
        }
        if a < b {
            return -1;
        }
    }
    0
}

fn version_parts(value: &str) -> Vec<u64> {
    value
        .trim_start_matches('v')
        .split(|ch: char| !ch.is_ascii_digit())
        .filter(|part| !part.is_empty())
        .map(|part| part.parse::<u64>().unwrap_or(0))
        .collect()
}

fn resolve_bundled_seed_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(root) = std::env::var("ZLEAP_BUNDLED_SEED_ROOT") {
        let path = PathBuf::from(root);
        if path.exists() {
            return Some(path);
        }
    }
    app.path().resource_dir().ok().and_then(|dir| {
        [
            dir.join("resources").join("payload"),
            dir.join("payload"),
            dir.join("resources").join("seed"),
            dir.join("seed"),
            dir.join("resources"),
        ]
        .into_iter()
        .find(|candidate| candidate.exists())
    })
}

fn resolve_bundled_seed_archive(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(archive) = std::env::var("ZLEAP_BUNDLED_SEED_ARCHIVE") {
        let path = PathBuf::from(archive);
        if path.exists() {
            return Some(path);
        }
    }
    let seed_dir = resolve_bundled_seed_dir(app)?;
    let payload_app = seed_dir.join("app.tar.gz");
    if payload_app.exists() {
        return Some(payload_app);
    }
    let mut candidates: Vec<PathBuf> = std::fs::read_dir(seed_dir)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .filter(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| {
                    (name.starts_with("zleap-app-seed-") || name.starts_with("zleap-runtime-"))
                        && (name.ends_with(".tar.gz") || name.ends_with(".zip"))
                })
                .unwrap_or(false)
        })
        .collect();
    candidates.sort();
    candidates.pop()
}

fn resolve_resources_root(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(root) = std::env::var("ZLEAP_DESKTOP_RESOURCES") {
        let path = PathBuf::from(root);
        if path.join("manifest.json").exists() {
            return Some(path);
        }
    }
    app.path().resource_dir().ok().and_then(|dir| {
        [
            dir.join("resources"),
            dir.clone(),
            dir.join("resources").join("payload"),
            dir.join("payload"),
        ]
        .into_iter()
        .find(|candidate| candidate.join("manifest.json").exists())
    })
}

fn resolve_web_port_from_metadata(_meta: &AppMetadata) -> u16 {
    if let Ok(port) = std::env::var("ZLEAP_WEB_PORT") {
        if let Ok(parsed) = port.parse::<u16>() {
            return parsed;
        }
    }
    DEFAULT_WEB_PORT
}

fn ensure_bootstrap_root(app: &AppHandle, resources: &Path) -> Result<PathBuf, String> {
    let archive = resources.join("bootstrap.tar.gz");
    if !archive.exists() {
        return Err(format!(
            "bootstrap archive missing at {}",
            archive.display()
        ));
    }
    let meta = read_metadata_file(&resources.join("metadata.json")).unwrap_or_default();
    let cache_key = format!(
        "{}-{}",
        safe_path_component(&meta.version.unwrap_or_else(|| "unknown".to_string())),
        safe_path_component(&meta.built_at.unwrap_or_else(|| "unknown".to_string()))
    );
    let cache = zleap_home().join("bootstrap").join(cache_key);
    if host_script(&cache, "desktop-bootstrap-cli.js").exists() {
        return Ok(cache);
    }
    std::fs::create_dir_all(&cache).map_err(|e| e.to_string())?;
    extract_archive(&archive, &cache)?;
    if !host_script(&cache, "desktop-bootstrap-cli.js").exists() {
        return Err(format!(
            "bootstrap archive is invalid: {}",
            archive.display()
        ));
    }
    Ok(cache)
}

fn safe_path_component(value: &str) -> String {
    let sanitized: String = value
        .chars()
        .map(|ch| match ch {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '-',
            ch if ch.is_control() => '-',
            ch => ch,
        })
        .collect();
    let trimmed = sanitized.trim_matches([' ', '.']).trim();
    if trimmed.is_empty() {
        "unknown".to_string()
    } else {
        trimmed.to_string()
    }
}

fn resolve_bundled_payload_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(root) = std::env::var("ZLEAP_BUNDLED_PAYLOAD") {
        let path = PathBuf::from(root);
        if path.join("manifest.json").exists() {
            return Some(path);
        }
    }
    app.path().resource_dir().ok().and_then(|dir| {
        [
            dir.join("resources"),
            dir.join("payload"),
            dir.join("resources").join("payload"),
        ]
        .into_iter()
        .find(|candidate| {
            candidate.join("manifest.json").exists()
                && (candidate.join("app.tar.gz").exists()
                    || candidate.join("download.json").exists())
        })
    })
}

fn install_seed_archive(archive: &Path) -> Result<PathBuf, String> {
    let app_root = zleap_home().join("app");
    let current = app_root.join("current");
    let previous = app_root.join("previous");
    std::fs::create_dir_all(&app_root).map_err(|e| e.to_string())?;

    let tmp = app_root.join(format!(
        ".seed-extract-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map(|duration| duration.as_millis())
            .unwrap_or(0)
    ));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    extract_archive(archive, &tmp)?;
    let staging = tmp.join("app");
    if !is_app_root(&staging) {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!(
            "app seed archive is invalid: {}",
            archive.display()
        ));
    }

    let _ = std::fs::remove_dir_all(&previous);
    if current.exists() {
        std::fs::rename(&current, &previous).map_err(|e| e.to_string())?;
    }

    if let Err(error) = std::fs::rename(&staging, &current) {
        if previous.exists() {
            let _ = std::fs::rename(&previous, &current);
        }
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(error.to_string());
    }

    let metadata_src = tmp.join("metadata.json");
    if metadata_src.exists() {
        let _ = std::fs::copy(metadata_src, app_root.join("metadata.json"));
    } else {
        let _ = std::fs::copy(
            current.join("manifest.json"),
            app_root.join("metadata.json"),
        );
    }
    let _ = std::fs::remove_dir_all(&tmp);
    Ok(current)
}

fn extract_archive(archive: &Path, dest: &Path) -> Result<(), String> {
    let name = archive
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    let status = if name.ends_with(".zip") {
        if cfg!(target_os = "windows") {
            hidden_command("powershell")
                .arg("-NoProfile")
                .arg("-Command")
                .arg(format!(
                    "Expand-Archive -Path '{}' -DestinationPath '{}' -Force",
                    archive.display(),
                    dest.display()
                ))
                .status()
        } else {
            hidden_command("unzip")
                .arg("-q")
                .arg(archive)
                .arg("-d")
                .arg(dest)
                .status()
        }
    } else {
        hidden_command("tar")
            .arg("-xzf")
            .arg(archive)
            .arg("-C")
            .arg(dest)
            .status()
    }
    .map_err(|e| e.to_string())?;

    if status.success() {
        Ok(())
    } else {
        Err(format!("failed to extract app seed: {status}"))
    }
}

fn resolve_node_bin(
    app: &AppHandle,
    app_root: &Path,
    node_version: Option<&str>,
) -> Result<PathBuf, String> {
    if let Ok(node) = std::env::var("ZLEAP_NODE_BIN") {
        let path = PathBuf::from(node);
        if path.exists() {
            return Ok(path);
        }
    }
    if let Some(version) = node_version {
        let managed = node_bin_in_root(&managed_node_root(version));
        if managed.exists() {
            return Ok(managed);
        }
        let bootstrap_node = app_root.join("node.tar.gz");
        if bootstrap_node.exists() {
            return install_node_dependency(version, &bootstrap_node);
        }
        if let Some(archive) = resolve_bundled_node_archive(app, version) {
            return install_node_dependency(version, &archive);
        }
    }
    let candidates = [
        app_root.join("node").join("bin").join("node"),
        app_root.join("node").join("node.exe"),
    ];
    for candidate in candidates {
        if candidate.exists() {
            return Ok(candidate);
        }
    }
    Ok(PathBuf::from("node"))
}

fn managed_node_root(version: &str) -> PathBuf {
    zleap_home()
        .join("tools")
        .join("node")
        .join(platform_tag())
        .join(version)
}

fn node_bin_in_root(root: &Path) -> PathBuf {
    if cfg!(target_os = "windows") {
        root.join("node.exe")
    } else {
        root.join("bin").join("node")
    }
}

fn resolve_bundled_deps_dir(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(root) = std::env::var("ZLEAP_BUNDLED_DEPS_ROOT") {
        let path = PathBuf::from(root);
        if path.exists() {
            return Some(path);
        }
    }
    app.path().resource_dir().ok().and_then(|dir| {
        [
            dir.join("resources").join("payload"),
            dir.join("payload"),
            dir.join("resources").join("deps"),
            dir.join("deps"),
        ]
            .into_iter()
            .find(|candidate| candidate.exists())
    })
}

fn resolve_bundled_node_archive(app: &AppHandle, version: &str) -> Option<PathBuf> {
    if let Some(payload) = resolve_bundled_payload_dir(app) {
        let archive = payload.join("node.tar.gz");
        if archive.exists() {
            return Some(archive);
        }
    }
    let archive = format!("node-v{}-{}.tar.gz", version, node_download_platform());
    resolve_bundled_deps_dir(app)
        .map(|deps| deps.join(archive))
        .filter(|path| path.exists())
}

fn resolve_bundled_postgres_archive(app: &AppHandle) -> Option<PathBuf> {
    if let Some(payload) = resolve_bundled_payload_dir(app) {
        let archive = payload.join("postgres.tar.gz");
        if archive.exists() {
            return Some(archive);
        }
    }
    let deps = resolve_bundled_deps_dir(app)?;
    let prefix = "zleap-postgres-";
    std::fs::read_dir(deps)
        .ok()?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| {
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.starts_with(prefix) && name.ends_with(".tar.gz"))
                .unwrap_or(false)
        })
}

fn install_node_dependency(version: &str, archive: &Path) -> Result<PathBuf, String> {
    let root = managed_node_root(version);
    let node_bin = node_bin_in_root(&root);
    if node_bin.exists() {
        return Ok(node_bin);
    }

    let parent = root
        .parent()
        .ok_or_else(|| "invalid managed Node root".to_string())?;
    std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;

    let tmp = parent.join(format!(".node-extract-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&tmp);
    std::fs::create_dir_all(&tmp).map_err(|e| e.to_string())?;

    let status = hidden_command("tar")
        .arg("-xzf")
        .arg(archive)
        .arg("-C")
        .arg(&tmp)
        .status()
        .map_err(|e| e.to_string())?;
    if !status.success() {
        let _ = std::fs::remove_dir_all(&tmp);
        return Err(format!("failed to extract Node dependency: {status}"));
    }

    let extracted = std::fs::read_dir(&tmp)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|entry| entry.path())
        .find(|path| node_bin_in_root(path).exists())
        .ok_or_else(|| "Node archive did not contain a node executable".to_string())?;

    let _ = std::fs::remove_dir_all(&root);
    match std::fs::rename(&extracted, &root) {
        Ok(()) => {}
        Err(_) => {
            copy_dir_all(&extracted, &root)?;
            let _ = std::fs::remove_dir_all(&extracted);
        }
    }
    let _ = std::fs::remove_dir_all(&tmp);

    let node_bin = node_bin_in_root(&root);
    if node_bin.exists() {
        Ok(node_bin)
    } else {
        Err(format!(
            "managed Node missing after install: {}",
            node_bin.display()
        ))
    }
}

fn copy_dir_all(src: &Path, dest: &Path) -> Result<(), String> {
    std::fs::create_dir_all(dest).map_err(|e| e.to_string())?;
    for entry in std::fs::read_dir(src).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let file_type = entry.file_type().map_err(|e| e.to_string())?;
        let from = entry.path();
        let to = dest.join(entry.file_name());
        if file_type.is_dir() {
            copy_dir_all(&from, &to)?;
        } else {
            std::fs::copy(&from, &to).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

fn node_download_platform() -> &'static str {
    if cfg!(target_os = "windows") {
        "win-x64"
    } else if cfg!(target_os = "macos") && cfg!(target_arch = "aarch64") {
        "darwin-arm64"
    } else if cfg!(target_os = "macos") {
        "darwin-x64"
    } else if cfg!(target_arch = "aarch64") {
        "linux-arm64"
    } else {
        "linux-x64"
    }
}

fn platform_tag() -> &'static str {
    if cfg!(target_os = "windows") {
        "win-x64"
    } else if cfg!(target_arch = "aarch64") {
        "mac-arm64"
    } else {
        "mac-x64"
    }
}

fn setup_tray(app: &AppHandle) -> tauri::Result<()> {
    let open = MenuItem::with_id(app, "open", "打开 Zleap", true, None::<&str>)?;
    let check_update = MenuItem::with_id(app, "check_update", "检查更新…", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &check_update, &quit])?;
    TrayIconBuilder::new()
        .menu(&menu)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => {
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
            "check_update" => check_for_update(app, true),
            "quit" => {
                stop_all_services(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                let app = tray.app_handle();
                if let Some(win) = app.get_webview_window("main") {
                    let _ = win.show();
                    let _ = win.set_focus();
                }
            }
        })
        .build(app)?;
    Ok(())
}
