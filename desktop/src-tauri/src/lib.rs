use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::env;
use std::ffi::OsStr;
use std::fs;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::thread;
use tauri::{Manager, Url};
use tauri_plugin_deep_link::DeepLinkExt;

const SERVICE_LABEL: &str = "chat.botcord.daemon";
const DEFAULT_DAEMON_BIN: &str = "botcord-daemon";
const DEFAULT_HUB_URL: &str = "https://api.botcord.chat";
const DEFAULT_DASHBOARD_URL: &str = "https://botcord.chat/chats";
const DEEP_LINK_CALLBACK: &str = "botcord://install";
const DAEMON_PACKAGE: &str = "@botcord/daemon@latest";
const NODE_VERSION: &str = "v20.18.1";
const NODE_DIST_URL: &str = "https://nodejs.org/dist";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DesktopConfig {
    #[serde(default = "default_daemon_bin")]
    daemon_bin: String,
    #[serde(default = "default_hub_url")]
    hub_url: String,
    #[serde(default = "default_dashboard_url")]
    dashboard_url: String,
    #[serde(default)]
    label: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct UserAuthConfig {
    #[serde(default)]
    label: Option<String>,
}

impl Default for DesktopConfig {
    fn default() -> Self {
        Self {
            daemon_bin: default_daemon_bin(),
            hub_url: default_hub_url(),
            dashboard_url: default_dashboard_url(),
            label: String::new(),
        }
    }
}

fn default_daemon_bin() -> String {
    DEFAULT_DAEMON_BIN.to_string()
}

fn default_hub_url() -> String {
    DEFAULT_HUB_URL.to_string()
}

fn default_dashboard_url() -> String {
    DEFAULT_DASHBOARD_URL.to_string()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ServiceStatus {
    supported: bool,
    manager: String,
    installed: bool,
    active: bool,
    detail: String,
}

#[tauri::command]
fn get_config() -> Result<DesktopConfig, String> {
    load_config()
}

#[tauri::command]
fn save_config(config: DesktopConfig) -> Result<(), String> {
    let normalized = DesktopConfig {
        daemon_bin: blank_default(config.daemon_bin, DEFAULT_DAEMON_BIN),
        hub_url: blank_default(config.hub_url, DEFAULT_HUB_URL),
        dashboard_url: blank_default(config.dashboard_url, DEFAULT_DASHBOARD_URL),
        label: config.label.trim().to_string(),
    };
    let path = config_path()?;
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let data = serde_json::to_vec_pretty(&normalized).map_err(|err| err.to_string())?;
    fs::write(path, data).map_err(|err| err.to_string())
}

#[tauri::command]
fn get_daemon_status() -> Result<Value, String> {
    let config = load_config()?;
    let output = run_daemon(&config, ["status", "--json"])?;
    serde_json::from_str(&output).map_err(|err| format!("status output was not JSON: {err}"))
}

#[tauri::command]
fn start_daemon(hub_url: String, label: String) -> Result<String, String> {
    let mut config = load_config()?;
    config.hub_url = blank_default(hub_url, DEFAULT_HUB_URL);
    config.label = label.trim().to_string();
    save_config(config.clone())?;
    ensure_daemon_available(&config)?;

    let mut args = vec!["start".to_string(), "--background".to_string(), "--hub".to_string(), config.hub_url];
    if !config.label.is_empty() {
        args.push("--label".to_string());
        args.push(config.label);
    }
    run_daemon_owned(&config.daemon_bin, args)
}

#[tauri::command]
fn open_connect_page(hub_url: String, dashboard_url: String, label: String) -> Result<String, String> {
    let mut config = load_config()?;
    config.hub_url = blank_default(hub_url, DEFAULT_HUB_URL);
    config.dashboard_url = blank_default(dashboard_url, DEFAULT_DASHBOARD_URL);
    config.label = label.trim().to_string();
    save_config(config.clone())?;

    let url = desktop_install_url(&config)?;
    open_url(&url)?;
    Ok("Opened BotCord dashboard authorization.".to_string())
}

#[tauri::command]
fn connect_with_install_token(
    hub_url: String,
    install_token: String,
    label: String,
) -> Result<String, String> {
    let token = install_token.trim();
    if token.is_empty() {
        return Err("install token is missing".to_string());
    }

    let mut config = load_config()?;
    config.hub_url = blank_default(hub_url, DEFAULT_HUB_URL);
    if !label.trim().is_empty() {
        config.label = label.trim().to_string();
    }
    save_config(config.clone())?;
    ensure_daemon_available(&config)?;

    let mut args = vec![
        "start".to_string(),
        "--background".to_string(),
        "--hub".to_string(),
        config.hub_url,
        "--install-token".to_string(),
        token.to_string(),
    ];
    if !config.label.is_empty() {
        args.push("--label".to_string());
        args.push(config.label);
    }
    run_daemon_owned(&config.daemon_bin, args)
}

#[tauri::command]
fn stop_daemon() -> Result<String, String> {
    let config = load_config()?;
    run_daemon(&config, ["stop"])
}

#[tauri::command]
fn restart_daemon(hub_url: String, label: String) -> Result<String, String> {
    let _ = stop_daemon();
    start_daemon(hub_url, label)
}

#[tauri::command]
fn tail_logs() -> Result<String, String> {
    let path = home_dir()?.join(".botcord").join("logs").join("daemon.log");
    if !path.exists() {
        return Ok(String::new());
    }
    let data = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let mut lines: Vec<&str> = data.lines().rev().take(160).collect();
    lines.reverse();
    Ok(lines.join("\n"))
}

#[tauri::command]
fn get_service_status() -> Result<ServiceStatus, String> {
    service_status()
}

#[tauri::command]
fn install_service(hub_url: String, label: String) -> Result<String, String> {
    let mut config = load_config()?;
    config.hub_url = blank_default(hub_url, DEFAULT_HUB_URL);
    config.label = label.trim().to_string();
    save_config(config.clone())?;
    ensure_daemon_available(&config)?;

    match service_manager() {
        ServiceManager::Launchd => install_launchd(&config),
        ServiceManager::Systemd => install_systemd(&config),
        ServiceManager::Unsupported => Err("This platform does not support launchd or systemd --user.".to_string()),
    }
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let trimmed = url.trim();
    if !(trimmed.starts_with("https://") || trimmed.starts_with("http://")) {
        return Err("URL must start with http:// or https://".to_string());
    }
    open_url(trimmed)
}

#[tauri::command]
fn uninstall_service() -> Result<String, String> {
    match service_manager() {
        ServiceManager::Launchd => uninstall_launchd(),
        ServiceManager::Systemd => uninstall_systemd(),
        ServiceManager::Unsupported => Err("This platform does not support launchd or systemd --user.".to_string()),
    }
}

pub fn run() {
    tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            get_config,
            save_config,
            get_daemon_status,
            open_connect_page,
            connect_with_install_token,
            start_daemon,
            stop_daemon,
            restart_daemon,
            tail_logs,
            get_service_status,
            install_service,
            uninstall_service,
            open_external_url
        ])
        .plugin(tauri_plugin_deep_link::init())
        .plugin(desktop_auth_plugin())
        .setup(|_| {
            thread::spawn(|| {
                if let Err(err) = auto_start_daemon_if_authorized() {
                    eprintln!("[desktop-daemon] auto-start skipped: {err}");
                }
            });
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("error while running BotCord desktop");
}

fn auto_start_daemon_if_authorized() -> Result<(), String> {
    let user_auth = load_user_auth_config()?;
    let mut config = load_config()?;
    if config.label.is_empty() {
        if let Some(label) = user_auth
            .label
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
        {
            config.label = label.to_string();
        }
    }

    ensure_daemon_available(&config)?;

    if daemon_status_alive(&config)? {
        return Ok(());
    }

    let mut args = vec![
        "start".to_string(),
        "--background".to_string(),
        "--hub".to_string(),
        config.hub_url.clone(),
    ];
    if !config.label.is_empty() {
        args.push("--label".to_string());
        args.push(config.label.clone());
    }
    run_daemon_owned(&config.daemon_bin, args)?;
    Ok(())
}

fn load_user_auth_config() -> Result<UserAuthConfig, String> {
    let path = user_auth_path()?;
    if !path.exists() {
        return Err("no daemon user-auth record".to_string());
    }
    let data = fs::read_to_string(path).map_err(|err| err.to_string())?;
    serde_json::from_str(&data).map_err(|err| err.to_string())
}

fn daemon_status_alive(config: &DesktopConfig) -> Result<bool, String> {
    let output = run_daemon(config, ["status", "--json"])?;
    let parsed: Value = serde_json::from_str(&output)
        .map_err(|err| format!("status output was not JSON: {err}"))?;
    Ok(parsed
        .get("alive")
        .and_then(Value::as_bool)
        .unwrap_or(false))
}

fn desktop_auth_plugin<R: tauri::Runtime>() -> tauri::plugin::TauriPlugin<R> {
    tauri::plugin::Builder::new("botcord-auth")
        .on_navigation(|_, url| {
            if let Some(external_url) = external_oauth_url(url) {
                match open_url(&external_url) {
                    Ok(()) => {
                        eprintln!("[desktop-auth] opened OAuth URL externally: {external_url}");
                        return false;
                    }
                    Err(err) => {
                        eprintln!("[desktop-auth] failed to open OAuth URL externally: {err}");
                        return true;
                    }
                }
            }
            true
        })
        .setup(|app, _| {
            let app_handle = app.clone();
            app.deep_link().on_open_url(move |event| {
                for url in event.urls() {
                    if let Some(target) = dashboard_auth_callback_url(&url) {
                        if let Some(window) = app_handle.get_webview_window("main") {
                            let _ = window.navigate(target);
                        }
                    } else if let Some(request) = install_request_from_deep_link(&url) {
                        let app_handle = app_handle.clone();
                        thread::spawn(move || {
                            if let Err(err) = connect_with_install_token(
                                request.hub_url,
                                request.install_token,
                                request.label,
                            ) {
                                eprintln!("[desktop-install] failed to connect daemon: {err}");
                            }
                            if let Some(window) = app_handle.get_webview_window("main") {
                                let target = load_config()
                                    .ok()
                                    .and_then(|config| Url::parse(&config.dashboard_url).ok())
                                    .or_else(|| Url::parse(DEFAULT_DASHBOARD_URL).ok());
                                if let Some(target) = target {
                                    let _ = window.navigate(target);
                                }
                            }
                        });
                    }
                }
            });
            Ok(())
        })
        .build()
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServiceManager {
    Launchd,
    Systemd,
    Unsupported,
}

fn service_manager() -> ServiceManager {
    if cfg!(target_os = "macos") {
        ServiceManager::Launchd
    } else if cfg!(target_os = "linux") && command_exists("systemctl") {
        ServiceManager::Systemd
    } else {
        ServiceManager::Unsupported
    }
}

fn service_status() -> Result<ServiceStatus, String> {
    match service_manager() {
        ServiceManager::Launchd => {
            let plist = launchd_plist_path()?;
            let installed = plist.exists();
            let target = launchd_target()?;
            let output = Command::new("launchctl")
                .args(["print", &format!("{target}/{SERVICE_LABEL}")])
                .output();
            let (active, detail) = match output {
                Ok(out) if out.status.success() => {
                    let text = String::from_utf8_lossy(&out.stdout).to_string();
                    let running = text.contains("state = running") || text.contains("pid = ");
                    (running, first_nonempty_line(&text).unwrap_or_else(|| "loaded".to_string()))
                }
                Ok(out) => (
                    false,
                    String::from_utf8_lossy(&out.stderr).trim().to_string(),
                ),
                Err(err) => (false, err.to_string()),
            };
            Ok(ServiceStatus {
                supported: true,
                manager: "launchd".to_string(),
                installed,
                active,
                detail,
            })
        }
        ServiceManager::Systemd => {
            let unit = systemd_unit_path()?;
            let installed = unit.exists();
            let active = command_success("systemctl", ["--user", "is-active", "--quiet", SERVICE_LABEL]);
            let enabled = command_success("systemctl", ["--user", "is-enabled", "--quiet", SERVICE_LABEL]);
            Ok(ServiceStatus {
                supported: true,
                manager: "systemd".to_string(),
                installed,
                active,
                detail: if enabled { "enabled".to_string() } else { "disabled".to_string() },
            })
        }
        ServiceManager::Unsupported => Ok(ServiceStatus {
            supported: false,
            manager: "unsupported".to_string(),
            installed: false,
            active: false,
            detail: "launchd/systemd user services are unavailable".to_string(),
        }),
    }
}

fn install_launchd(config: &DesktopConfig) -> Result<String, String> {
    let plist = launchd_plist_path()?;
    if let Some(parent) = plist.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let daemon_bin = resolve_daemon_bin(&config.daemon_bin);
    let mut args = vec![
        daemon_bin,
        "start".to_string(),
        "--foreground".to_string(),
        "--hub".to_string(),
        config.hub_url.clone(),
    ];
    if !config.label.is_empty() {
        args.push("--label".to_string());
        args.push(config.label.clone());
    }

    let mut plist_data = String::new();
    plist_data.push_str(r#"<?xml version="1.0" encoding="UTF-8"?>"#);
    plist_data.push_str("\n<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" ");
    plist_data.push_str("\"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n");
    plist_data.push_str("<plist version=\"1.0\">\n<dict>\n");
    plist_data.push_str("  <key>Label</key>\n");
    plist_data.push_str(&format!("  <string>{SERVICE_LABEL}</string>\n"));
    plist_data.push_str("  <key>ProgramArguments</key>\n  <array>\n");
    for arg in args {
        plist_data.push_str(&format!("    <string>{}</string>\n", xml_escape(&arg)));
    }
    plist_data.push_str("  </array>\n");
    plist_data.push_str("  <key>EnvironmentVariables</key>\n  <dict>\n");
    plist_data.push_str(&format!("    <key>BOTCORD_HUB</key><string>{}</string>\n", xml_escape(&config.hub_url)));
    plist_data.push_str(&format!(
        "    <key>PATH</key><string>{}</string>\n",
        xml_escape(&daemon_path_env()?)
    ));
    plist_data.push_str("  </dict>\n");
    plist_data.push_str("  <key>RunAtLoad</key><true/>\n");
    plist_data.push_str("  <key>KeepAlive</key><dict><key>SuccessfulExit</key><false/></dict>\n");
    plist_data.push_str("  <key>StandardOutPath</key><string>");
    plist_data.push_str(&xml_escape(&home_dir()?.join(".botcord").join("logs").join("daemon.launchd.out.log").display().to_string()));
    plist_data.push_str("</string>\n");
    plist_data.push_str("  <key>StandardErrorPath</key><string>");
    plist_data.push_str(&xml_escape(&home_dir()?.join(".botcord").join("logs").join("daemon.launchd.err.log").display().to_string()));
    plist_data.push_str("</string>\n");
    plist_data.push_str("</dict>\n</plist>\n");
    atomic_write(&plist, plist_data.as_bytes())?;

    let target = launchd_target()?;
    let _ = Command::new("launchctl").args(["bootout", &target, plist.to_string_lossy().as_ref()]).output();
    run_command("launchctl", ["bootstrap", &target, plist.to_string_lossy().as_ref()])?;
    run_command("launchctl", ["enable", &format!("{target}/{SERVICE_LABEL}")])?;
    Ok("launchd service installed and started.".to_string())
}

fn uninstall_launchd() -> Result<String, String> {
    let plist = launchd_plist_path()?;
    let target = launchd_target()?;
    let _ = Command::new("launchctl").args(["bootout", &target, plist.to_string_lossy().as_ref()]).output();
    if plist.exists() {
        fs::remove_file(plist).map_err(|err| err.to_string())?;
    }
    Ok("launchd service removed.".to_string())
}

fn install_systemd(config: &DesktopConfig) -> Result<String, String> {
    let unit = systemd_unit_path()?;
    if let Some(parent) = unit.parent() {
        fs::create_dir_all(parent).map_err(|err| err.to_string())?;
    }
    let daemon_bin = resolve_daemon_bin(&config.daemon_bin);
    let mut exec = vec![
        shell_quote(&daemon_bin),
        "start".to_string(),
        "--foreground".to_string(),
        "--hub".to_string(),
        shell_quote(&config.hub_url),
    ];
    if !config.label.is_empty() {
        exec.push("--label".to_string());
        exec.push(shell_quote(&config.label));
    }
    let data = format!(
        "[Unit]\nDescription=BotCord local daemon\nAfter=network-online.target\n\n[Service]\nType=simple\nExecStart={}\nRestart=on-failure\nRestartSec=5\nEnvironment=BOTCORD_HUB={}\nEnvironment=PATH={}\n\n[Install]\nWantedBy=default.target\n",
        exec.join(" "),
        shell_quote(&config.hub_url),
        shell_quote(&daemon_path_env()?)
    );
    atomic_write(&unit, data.as_bytes())?;
    run_command("systemctl", ["--user", "daemon-reload"])?;
    run_command("systemctl", ["--user", "enable", "--now", SERVICE_LABEL])?;
    Ok("systemd user service installed and started.".to_string())
}

fn uninstall_systemd() -> Result<String, String> {
    let unit = systemd_unit_path()?;
    let _ = Command::new("systemctl").args(["--user", "disable", "--now", SERVICE_LABEL]).output();
    if unit.exists() {
        fs::remove_file(unit).map_err(|err| err.to_string())?;
    }
    let _ = Command::new("systemctl").args(["--user", "daemon-reload"]).output();
    Ok("systemd user service removed.".to_string())
}

fn load_config() -> Result<DesktopConfig, String> {
    let path = config_path()?;
    if !path.exists() {
        return Ok(DesktopConfig::default());
    }
    let data = fs::read_to_string(path).map_err(|err| err.to_string())?;
    let parsed: DesktopConfig = serde_json::from_str(&data).map_err(|err| err.to_string())?;
    Ok(DesktopConfig {
        daemon_bin: blank_default(parsed.daemon_bin, DEFAULT_DAEMON_BIN),
        hub_url: blank_default(parsed.hub_url, DEFAULT_HUB_URL),
        dashboard_url: blank_default(parsed.dashboard_url, DEFAULT_DASHBOARD_URL),
        label: parsed.label.trim().to_string(),
    })
}

fn desktop_install_url(config: &DesktopConfig) -> Result<String, String> {
    let mut base = Url::parse(config.dashboard_url.trim())
        .map_err(|_| "dashboard URL must start with http:// or https://".to_string())?;
    if base.scheme() != "https" && base.scheme() != "http" {
        return Err("dashboard URL must start with http:// or https://".to_string());
    }
    base.set_path("/desktop/install");
    base.set_query(None);
    base.set_fragment(None);

    let mut url = format!(
        "{}?callback={}&hub={}",
        base.as_str().trim_end_matches('/'),
        url_encode(DEEP_LINK_CALLBACK),
        url_encode(&config.hub_url)
    );
    if !config.label.is_empty() {
        url.push_str("&label=");
        url.push_str(&url_encode(&config.label));
    }
    Ok(url)
}

fn external_oauth_url(url: &Url) -> Option<String> {
    if is_supabase_oauth_authorize(url) {
        let config = load_config().unwrap_or_default();
        return Some(rewrite_oauth_redirect(url, &config));
    }

    // If a provider page is reached before the Supabase authorize URL is
    // intercepted, move it out of the app WebView. Google blocks embedded
    // browser flows, which otherwise leaves the desktop client stuck.
    if matches!(
        url.host_str(),
        Some("accounts.google.com") | Some("github.com")
    ) {
        return Some(url.to_string());
    }

    None
}

fn is_supabase_oauth_authorize(url: &Url) -> bool {
    if url.scheme() != "https" || url.path() != "/auth/v1/authorize" {
        return false;
    }
    let has_provider = url
        .query_pairs()
        .any(|(key, value)| key == "provider" && matches!(value.as_ref(), "google" | "github"));
    let host = url.host_str().unwrap_or_default();
    has_provider && (host.ends_with(".supabase.co") || host.contains("supabase"))
}

fn rewrite_oauth_redirect(url: &Url, config: &DesktopConfig) -> String {
    let mut desktop_redirect = Url::parse(&config.dashboard_url)
        .or_else(|_| Url::parse(DEFAULT_DASHBOARD_URL))
        .expect("valid default dashboard URL");
    desktop_redirect.set_path("/auth/desktop-callback");
    desktop_redirect.set_query(None);
    desktop_redirect.set_fragment(None);

    let mut rewritten = url.clone();
    rewritten.set_query(None);
    {
        let mut pairs = rewritten.query_pairs_mut();
        for (key, value) in url.query_pairs() {
            if key == "redirect_to" {
                pairs.append_pair("redirect_to", desktop_redirect.as_str());
            } else {
                pairs.append_pair(&key, &value);
            }
        }
    }
    rewritten.to_string()
}

fn dashboard_auth_callback_url(url: &Url) -> Option<Url> {
    if url.scheme() != "botcord" || url.host_str() != Some("auth") || url.path() != "/callback" {
        return None;
    }

    let config = load_config().unwrap_or_default();
    let mut target = Url::parse(&config.dashboard_url)
        .or_else(|_| Url::parse(DEFAULT_DASHBOARD_URL))
        .ok()?;
    target.set_path("/auth/callback");
    target.set_query(url.query());
    target.set_fragment(url.fragment());
    Some(target)
}

struct InstallRequest {
    hub_url: String,
    install_token: String,
    label: String,
}

fn install_request_from_deep_link(url: &Url) -> Option<InstallRequest> {
    if url.scheme() != "botcord" || url.host_str() != Some("install") {
        return None;
    }

    let mut install_token = None;
    let mut hub_url = None;
    let mut label = String::new();
    for (key, value) in url.query_pairs() {
        match key.as_ref() {
            "install_token" => install_token = Some(value.to_string()),
            "hub" => hub_url = Some(value.to_string()),
            "label" => label = value.to_string(),
            _ => {}
        }
    }
    let install_token = install_token?.trim().to_string();
    if install_token.is_empty() {
        return None;
    }

    Some(InstallRequest {
        hub_url: blank_default(hub_url.unwrap_or_default(), DEFAULT_HUB_URL),
        install_token,
        label: label.trim().to_string(),
    })
}

fn open_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "macos")]
    {
        run_command("open", [url])?;
        return Ok(());
    }

    #[cfg(target_os = "linux")]
    {
        run_command("xdg-open", [url])?;
        return Ok(());
    }

    #[cfg(target_os = "windows")]
    {
        run_command("cmd", ["/C", "start", "", url])?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err("opening URLs is unsupported on this platform".to_string())
}

fn config_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".botcord").join("desktop").join("config.json"))
}

fn user_auth_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".botcord").join("daemon").join("user-auth.json"))
}

fn launchd_plist_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join("Library").join("LaunchAgents").join(format!("{SERVICE_LABEL}.plist")))
}

fn systemd_unit_path() -> Result<PathBuf, String> {
    Ok(home_dir()?.join(".config").join("systemd").join("user").join(format!("{SERVICE_LABEL}.service")))
}

fn launchd_target() -> Result<String, String> {
    let uid = run_command("id", ["-u"])?;
    Ok(format!("gui/{}", uid.trim()))
}

fn home_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .filter(|p| !p.as_os_str().is_empty())
        .ok_or_else(|| "HOME is not set".to_string())
}

fn ensure_daemon_available(config: &DesktopConfig) -> Result<String, String> {
    let resolved = resolve_daemon_bin(&config.daemon_bin);
    if Path::new(&resolved).is_file() || command_exists(&config.daemon_bin) {
        return Ok(resolved);
    }
    install_managed_daemon()
}

fn install_managed_daemon() -> Result<String, String> {
    let home = home_dir()?;
    let install_root = home.join(".botcord");
    let bin_dir = install_root.join("bin");
    let node_root = install_root.join("node");
    let daemon_prefix = install_root.join("daemon");
    fs::create_dir_all(&bin_dir).map_err(|err| err.to_string())?;
    fs::create_dir_all(&node_root).map_err(|err| err.to_string())?;
    fs::create_dir_all(&daemon_prefix).map_err(|err| err.to_string())?;

    let (node_bin, npm_bin) = node_toolchain(&node_root)?;
    let node_bin_dir = node_bin
        .parent()
        .ok_or_else(|| format!("invalid node path: {}", node_bin.display()))?;
    let path_env = format!("{}:{}", node_bin_dir.display(), daemon_path_env()?);

    let output = Command::new(&npm_bin)
        .args(["install", "--prefix"])
        .arg(&daemon_prefix)
        .arg(DAEMON_PACKAGE)
        .env("PATH", &path_env)
        .output()
        .map_err(|err| format!("failed to run npm install: {err}"))?;
    command_output(output)?;

    let daemon_bin = daemon_prefix
        .join("node_modules")
        .join(".bin")
        .join("botcord-daemon");
    if !daemon_bin.is_file() {
        return Err(format!(
            "botcord-daemon executable not found after install: {}",
            daemon_bin.display()
        ));
    }

    let wrapper = bin_dir.join(DEFAULT_DAEMON_BIN);
    let data = format!(
        "#!/bin/sh\nPATH=\"{}:$PATH\"\nexport PATH\nexec \"{}\" \"{}\" \"$@\"\n",
        node_bin_dir.display(),
        node_bin.display(),
        daemon_bin.display()
    );
    atomic_write(&wrapper, data.as_bytes())?;
    make_executable(&wrapper)?;
    Ok(wrapper.display().to_string())
}

fn node_toolchain(node_root: &Path) -> Result<(PathBuf, PathBuf), String> {
    if let (Some(node), Some(npm)) = (usable_system_node(), command_path("npm")) {
        return Ok((node, npm));
    }

    let platform = node_platform()?;
    let node_name = format!("node-{NODE_VERSION}-{platform}");
    let node_dir = node_root.join(&node_name);
    let node_bin = node_dir.join("bin").join("node");
    let npm_bin = node_dir.join("bin").join("npm");
    if node_bin.is_file() && npm_bin.is_file() {
        return Ok((node_bin, npm_bin));
    }

    let node_tgz = node_root.join(format!("{node_name}.tar.gz"));
    let node_url = format!("{NODE_DIST_URL}/{NODE_VERSION}/{node_name}.tar.gz");
    let tmp_dir = node_root.join(format!("{node_name}.tmp"));
    let _ = fs::remove_dir_all(&tmp_dir);
    fs::create_dir_all(&tmp_dir).map_err(|err| err.to_string())?;

    let output = Command::new("curl")
        .args(["-fL", &node_url, "-o"])
        .arg(&node_tgz)
        .output()
        .map_err(|err| format!("failed to download private Node.js: {err}"))?;
    command_output(output)?;

    let output = Command::new("tar")
        .args(["-xzf"])
        .arg(&node_tgz)
        .args(["-C"])
        .arg(&tmp_dir)
        .args(["--strip-components", "1"])
        .output()
        .map_err(|err| format!("failed to extract private Node.js: {err}"))?;
    command_output(output)?;

    let _ = fs::remove_dir_all(&node_dir);
    fs::rename(&tmp_dir, &node_dir).map_err(|err| err.to_string())?;
    let _ = fs::remove_file(&node_tgz);

    if node_bin.is_file() && npm_bin.is_file() {
        Ok((node_bin, npm_bin))
    } else {
        Err(format!(
            "private Node.js install incomplete: {}",
            node_dir.display()
        ))
    }
}

fn usable_system_node() -> Option<PathBuf> {
    let node = command_path("node")?;
    let output = Command::new(&node).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8_lossy(&output.stdout);
    let major = version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()
        .and_then(|part| part.parse::<u64>().ok())?;
    (major >= 18).then_some(node)
}

fn command_path(program: &str) -> Option<PathBuf> {
    let output = Command::new("sh")
        .args(["-c", &format!("command -v {}", shell_quote(program))])
        .env("PATH", daemon_path_env().unwrap_or_else(|_| fallback_path().to_string()))
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!path.is_empty()).then(|| PathBuf::from(path))
}

fn node_platform() -> Result<&'static str, String> {
    match (env::consts::OS, env::consts::ARCH) {
        ("macos", "aarch64") => Ok("darwin-arm64"),
        ("macos", "x86_64") => Ok("darwin-x64"),
        ("linux", "aarch64") => Ok("linux-arm64"),
        ("linux", "x86_64") => Ok("linux-x64"),
        (os, arch) => Err(format!("unsupported private Node.js platform: {os}/{arch}")),
    }
}

fn make_executable(path: &Path) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut perms = fs::metadata(path).map_err(|err| err.to_string())?.permissions();
        perms.set_mode(0o755);
        fs::set_permissions(path, perms).map_err(|err| err.to_string())
    }

    #[cfg(not(unix))]
    {
        let _ = path;
        Ok(())
    }
}

fn run_daemon<const N: usize>(config: &DesktopConfig, args: [&str; N]) -> Result<String, String> {
    let daemon_bin = resolve_daemon_bin(&config.daemon_bin);
    let output = Command::new(&daemon_bin)
        .args(args)
        .env("PATH", daemon_path_env()?)
        .output()
        .map_err(|err| format!("failed to run {daemon_bin}: {err}"))?;
    command_output(output)
}

fn run_daemon_owned(daemon_bin: &str, args: Vec<String>) -> Result<String, String> {
    let resolved = resolve_daemon_bin(daemon_bin);
    let output = Command::new(&resolved)
        .args(args)
        .env("PATH", daemon_path_env()?)
        .output()
        .map_err(|err| format!("failed to run {resolved}: {err}"))?;
    command_output(output)
}

fn run_command<const N: usize, S>(program: &str, args: [S; N]) -> Result<String, String>
where
    S: AsRef<OsStr>,
{
    let output = Command::new(program)
        .args(args)
        .output()
        .map_err(|err| format!("failed to run {program}: {err}"))?;
    command_output(output)
}

fn command_success<const N: usize, S>(program: &str, args: [S; N]) -> bool
where
    S: AsRef<OsStr>,
{
    Command::new(program)
        .args(args)
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn command_output(output: std::process::Output) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
        Err(if stderr.is_empty() { stdout } else { stderr })
    }
}

fn command_exists(program: &str) -> bool {
    Command::new("sh")
        .args(["-c", &format!("command -v {}", shell_quote(program))])
        .env(
            "PATH",
            daemon_path_env().unwrap_or_else(|_| fallback_path().to_string()),
        )
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

fn resolve_daemon_bin(value: &str) -> String {
    if value.contains('/') {
        return value.to_string();
    }
    if let Ok(home) = home_dir() {
        let candidate = home.join(".botcord").join("bin").join(value);
        if candidate.is_file() {
            return candidate.display().to_string();
        }
    }
    for dir in ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"] {
        let candidate = Path::new(dir).join(value);
        if candidate.is_file() {
            return candidate.display().to_string();
        }
    }
    Command::new("sh")
        .args(["-c", &format!("command -v {}", shell_quote(value))])
        .env("PATH", daemon_path_env().unwrap_or_else(|_| fallback_path().to_string()))
        .output()
        .ok()
        .filter(|out| out.status.success())
        .map(|out| String::from_utf8_lossy(&out.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| value.to_string())
}

fn daemon_path_env() -> Result<String, String> {
    let home = home_dir()?;
    let mut parts = vec![home.join(".botcord").join("bin").display().to_string()];
    parts.extend(fallback_path().split(':').map(ToString::to_string));
    if let Ok(existing) = env::var("PATH") {
        for part in existing.split(':') {
            if !part.is_empty() && !parts.iter().any(|p| p == part) {
                parts.push(part.to_string());
            }
        }
    }
    Ok(parts.join(":"))
}

fn fallback_path() -> &'static str {
    "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin"
}

fn atomic_write(path: &Path, data: &[u8]) -> Result<(), String> {
    let tmp = path.with_extension("tmp");
    {
        let mut file = fs::File::create(&tmp).map_err(|err| err.to_string())?;
        file.write_all(data).map_err(|err| err.to_string())?;
        file.sync_all().map_err(|err| err.to_string())?;
    }
    fs::rename(tmp, path).map_err(|err| err.to_string())
}

fn blank_default(value: String, fallback: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        fallback.to_string()
    } else {
        trimmed.to_string()
    }
}

fn first_nonempty_line(text: &str) -> Option<String> {
    text.lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(ToString::to_string)
}

fn xml_escape(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn shell_quote(value: &str) -> String {
    if value.chars().all(|c| c.is_ascii_alphanumeric() || "-_./:@".contains(c)) {
        return value.to_string();
    }
    format!("'{}'", value.replace('\'', "'\\''"))
}

fn url_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn authorize_url(redirect_to: &str) -> Url {
        Url::parse(&format!(
            "https://example.supabase.co/auth/v1/authorize?provider=google&redirect_to={}",
            url_encode(redirect_to)
        ))
        .expect("valid authorize URL")
    }

    fn redirect_to(url: &str) -> Url {
        Url::parse(url)
            .expect("rewritten URL should parse")
            .query_pairs()
            .find_map(|(key, value)| (key == "redirect_to").then(|| Url::parse(&value).ok()))
            .flatten()
            .expect("redirect_to should be present")
    }

    #[test]
    fn oauth_redirect_uses_preview_desktop_callback() {
        let config = DesktopConfig {
            dashboard_url: "https://preview.botcord.chat/chats".to_string(),
            ..DesktopConfig::default()
        };
        let original = authorize_url("https://preview.botcord.chat/auth/callback?next=%2Fchats%2Fhome");

        let rewritten = rewrite_oauth_redirect(&original, &config);
        let redirect = redirect_to(&rewritten);

        assert_eq!(
            redirect.origin().unicode_serialization(),
            "https://preview.botcord.chat"
        );
        assert_eq!(redirect.path(), "/auth/desktop-callback");
        assert_eq!(redirect.query(), None);
    }

    #[test]
    fn oauth_redirect_uses_prod_desktop_callback() {
        let config = DesktopConfig {
            dashboard_url: "https://botcord.chat/chats".to_string(),
            ..DesktopConfig::default()
        };
        let original = authorize_url("https://botcord.chat/auth/callback?next=%2Fsettings%2Fdaemons");

        let rewritten = rewrite_oauth_redirect(&original, &config);
        let redirect = redirect_to(&rewritten);

        assert_eq!(
            redirect.origin().unicode_serialization(),
            "https://botcord.chat"
        );
        assert_eq!(redirect.path(), "/auth/desktop-callback");
        assert_eq!(redirect.query(), None);
    }

    #[test]
    fn desktop_install_url_uses_dashboard_origin_not_current_path() {
        let config = DesktopConfig {
            dashboard_url: "https://preview.botcord.chat/chats".to_string(),
            hub_url: "https://api.preview.botcord.chat".to_string(),
            label: "Local Mac".to_string(),
            ..DesktopConfig::default()
        };

        let url = Url::parse(&desktop_install_url(&config).expect("install URL")).expect("valid URL");

        assert_eq!(url.origin().unicode_serialization(), "https://preview.botcord.chat");
        assert_eq!(url.path(), "/desktop/install");
        assert_eq!(
            url.query(),
            Some("callback=botcord%3A%2F%2Finstall&hub=https%3A%2F%2Fapi.preview.botcord.chat&label=Local%20Mac")
        );
    }

    #[test]
    fn install_deep_link_extracts_install_request() {
        let url = Url::parse(
            "botcord://install?install_token=dit_123&hub=https%3A%2F%2Fapi.preview.botcord.chat&label=Local%20Mac",
        )
        .expect("valid install link");

        let request = install_request_from_deep_link(&url).expect("install request");

        assert_eq!(request.install_token, "dit_123");
        assert_eq!(request.hub_url, "https://api.preview.botcord.chat");
        assert_eq!(request.label, "Local Mac");
    }

    #[test]
    fn install_deep_link_requires_token() {
        let url = Url::parse("botcord://install?hub=https%3A%2F%2Fapi.botcord.chat")
            .expect("valid install link");

        assert!(install_request_from_deep_link(&url).is_none());
    }
}
