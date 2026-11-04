#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::collections::HashMap;
use std::fs;
use std::io::{BufRead, BufReader, Read};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Serialize;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, RunEvent, State, WindowEvent};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

const CORE_NAME: &str = if cfg!(windows) { "sing-box.exe" } else { "sing-box" };
const TASK_NAME: &str = "AuroraVPN";

/// Запущенный процесс sing-box.
#[derive(Default)]
struct Core(Arc<Mutex<Option<Child>>>);

fn command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    #[allow(unused_mut)]
    let mut cmd = Command::new(program);
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);
    cmd
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

fn core_path() -> Result<PathBuf, String> {
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let path = exe.parent().ok_or("нет каталога программы")?.join(CORE_NAME);
    if path.exists() {
        Ok(path)
    } else {
        Err(format!("Не найдено ядро: {}", path.display()))
    }
}

fn strip_ansi(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars();
    while let Some(c) = chars.next() {
        if c == '\u{1b}' {
            if chars.next() == Some('[') {
                for c in chars.by_ref() {
                    if c.is_ascii_alphabetic() {
                        break;
                    }
                }
            }
        } else {
            out.push(c);
        }
    }
    out
}

fn stop_child(slot: &Mutex<Option<Child>>) {
    if let Some(mut child) = slot.lock().unwrap().take() {
        let _ = child.kill();
        let _ = child.wait();
    }
}

fn pipe_logs<R: Read + Send + 'static>(app: AppHandle, reader: R) {
    thread::spawn(move || {
        let mut reader = BufReader::new(reader);
        let mut buf = Vec::new();
        loop {
            buf.clear();
            match reader.read_until(b'\n', &mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {
                    let line = strip_ansi(String::from_utf8_lossy(&buf).trim_end());
                    if !line.is_empty() {
                        let _ = app.emit("core-log", line);
                    }
                }
            }
        }
    });
}

/// Следит за процессом ядра и сообщает интерфейсу, если он завершился сам.
fn watch(app: AppHandle, slot: Arc<Mutex<Option<Child>>>, pid: u32) {
    thread::spawn(move || loop {
        thread::sleep(Duration::from_millis(400));
        let mut guard = slot.lock().unwrap();
        let exited = match guard.as_mut() {
            Some(child) if child.id() == pid => match child.try_wait() {
                Ok(Some(status)) => Some(status.code()),
                Ok(None) => None,
                Err(_) => Some(None),
            },
            _ => return,
        };
        if let Some(code) = exited {
            *guard = None;
            drop(guard);
            let _ = app.emit("core-exit", code);
            return;
        }
    });
}

#[tauri::command]
fn start_core(app: AppHandle, core: State<'_, Core>, config: String) -> Result<(), String> {
    stop_child(&core.0);
    let dir = data_dir(&app)?;
    let cfg_path = dir.join("config.json");
    fs::write(&cfg_path, config).map_err(|e| e.to_string())?;
    let bin = core_path()?;

    let check = command(&bin)
        .arg("check")
        .arg("-c")
        .arg(&cfg_path)
        .arg("-D")
        .arg(&dir)
        .output()
        .map_err(|e| e.to_string())?;
    if !check.status.success() {
        let msg = format!(
            "{}{}",
            String::from_utf8_lossy(&check.stderr),
            String::from_utf8_lossy(&check.stdout)
        );
        return Err(strip_ansi(msg.trim()));
    }

    let mut child = command(&bin)
        .arg("run")
        .arg("-c")
        .arg(&cfg_path)
        .arg("-D")
        .arg(&dir)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("Не удалось запустить ядро: {e}"))?;
    let pid = child.id();
    if let Some(out) = child.stdout.take() {
        pipe_logs(app.clone(), out);
    }
    if let Some(err) = child.stderr.take() {
        pipe_logs(app.clone(), err);
    }
    *core.0.lock().unwrap() = Some(child);
    watch(app, core.0.clone(), pid);
    Ok(())
}

#[tauri::command]
fn stop_core(core: State<'_, Core>) {
    stop_child(&core.0);
}

#[tauri::command]
fn core_version() -> Result<String, String> {
    let out = command(core_path()?)
        .arg("version")
        .output()
        .map_err(|e| e.to_string())?;
    let text = String::from_utf8_lossy(&out.stdout);
    Ok(text.lines().next().unwrap_or("sing-box").trim().to_string())
}

#[derive(Serialize)]
struct SubResponse {
    status: u16,
    body: String,
    headers: HashMap<String, String>,
}

#[tauri::command]
async fn fetch_subscription(url: String, user_agent: String) -> Result<SubResponse, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(25))
        .user_agent(user_agent)
        .build()
        .map_err(|e| e.to_string())?;
    let resp = client.get(&url).send().await.map_err(|e| e.to_string())?;
    let status = resp.status().as_u16();
    let headers = resp
        .headers()
        .iter()
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.as_str().to_lowercase(), v.to_string())))
        .collect();
    let body = resp.text().await.map_err(|e| e.to_string())?;
    Ok(SubResponse { status, body, headers })
}

#[tauri::command]
async fn tcp_ping(host: String, port: u16) -> Result<u64, String> {
    tauri::async_runtime::spawn_blocking(move || -> Result<u64, String> {
        let addr = (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|e| e.to_string())?
            .next()
            .ok_or_else(|| "адрес не найден".to_string())?;
        let start = Instant::now();
        TcpStream::connect_timeout(&addr, Duration::from_secs(3)).map_err(|e| e.to_string())?;
        Ok(start.elapsed().as_millis() as u64)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_processes() -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(|| -> Result<Vec<String>, String> {
        #[cfg(windows)]
        let out = command("tasklist").args(["/fo", "csv", "/nh"]).output();
        #[cfg(not(windows))]
        let out = command("ps").args(["-axco", "comm="]).output();
        let out = out.map_err(|e| e.to_string())?;
        let text = String::from_utf8_lossy(&out.stdout);
        let mut names: Vec<String> = text
            .lines()
            .filter_map(|l| {
                let name = l.split(',').next()?.trim().trim_matches('"').to_string();
                (!name.is_empty()).then_some(name)
            })
            .collect();
        names.sort_by_key(|n| n.to_lowercase());
        names.dedup_by(|a, b| a.eq_ignore_ascii_case(b));
        Ok(names)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
fn self_exe_name() -> Option<String> {
    std::env::current_exe()
        .ok()?
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
}

#[tauri::command]
fn load_state(app: AppHandle) -> Result<Option<String>, String> {
    Ok(fs::read_to_string(data_dir(&app)?.join("state.json")).ok())
}

#[tauri::command]
fn save_state(app: AppHandle, state: String) -> Result<(), String> {
    let dir = data_dir(&app)?;
    let tmp = dir.join("state.json.tmp");
    fs::write(&tmp, state).map_err(|e| e.to_string())?;
    fs::rename(tmp, dir.join("state.json")).map_err(|e| e.to_string())
}

/// Автозапуск через планировщик задач: обычный ключ Run не умеет запускать
/// программу с правами администратора без окна UAC.
#[tauri::command]
fn set_autostart(enable: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        let script = if enable {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let exe = exe.display().to_string().replace('\'', "''");
            format!(
                "$a = New-ScheduledTaskAction -Execute '{exe}' -Argument '--autostart'; \
                 $t = New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME; \
                 $s = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -ExecutionTimeLimit ([TimeSpan]::Zero); \
                 $p = New-ScheduledTaskPrincipal -UserId $env:USERNAME -RunLevel Highest -LogonType Interactive; \
                 Register-ScheduledTask -TaskName '{TASK_NAME}' -Action $a -Trigger $t -Settings $s -Principal $p -Force | Out-Null"
            )
        } else {
            format!("Unregister-ScheduledTask -TaskName '{TASK_NAME}' -Confirm:$false -ErrorAction SilentlyContinue")
        };
        let out = command("powershell")
            .args(["-NoProfile", "-NonInteractive", "-Command", &script])
            .output()
            .map_err(|e| e.to_string())?;
        if !out.status.success() {
            return Err(String::from_utf8_lossy(&out.stderr).trim().to_string());
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enable;
        Err("Автозапуск поддерживается только в Windows".into())
    }
}

#[tauri::command]
fn open_url(url: String) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("неверная ссылка".into());
    }
    #[cfg(windows)]
    let program = "explorer";
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(all(unix, not(target_os = "macos")))]
    let program = "xdg-open";
    command(program).arg(url).spawn().map(|_| ()).map_err(|e| e.to_string())
}

#[tauri::command]
fn set_tray_state(app: AppHandle, connected: bool, label: String) {
    if let Some(tray) = app.tray_by_id("main") {
        let tip = if connected {
            format!("Aurora VPN — подключено ({label})")
        } else {
            "Aurora VPN — отключено".to_string()
        };
        let _ = tray.set_tooltip(Some(tip));
    }
}

#[tauri::command]
fn quit_app(app: AppHandle) {
    stop_child(&app.state::<Core>().0);
    app.exit(0);
}

fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.unminimize();
        let _ = w.show();
        let _ = w.set_focus();
    }
}

fn main() {
    let autostart = std::env::args().any(|a| a == "--autostart");

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| show_main(app)))
        .manage(Core::default())
        .invoke_handler(tauri::generate_handler![
            start_core,
            stop_core,
            core_version,
            fetch_subscription,
            tcp_ping,
            list_processes,
            self_exe_name,
            load_state,
            save_state,
            set_autostart,
            open_url,
            set_tray_state,
            quit_app,
        ])
        .setup(move |app| {
            let show = MenuItem::with_id(app, "show", "Открыть Aurora", true, None::<&str>)?;
            let toggle = MenuItem::with_id(app, "toggle", "Подключить / отключить", true, None::<&str>)?;
            let quit = MenuItem::with_id(app, "quit", "Выход", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show, &toggle, &quit])?;

            TrayIconBuilder::with_id("main")
                .icon(app.default_window_icon().cloned().ok_or("нет иконки")?)
                .tooltip("Aurora VPN — отключено")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "toggle" => {
                        let _ = app.emit("tray-toggle", ());
                    }
                    "quit" => {
                        stop_child(&app.state::<Core>().0);
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
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;

            if !autostart {
                show_main(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            // Крестик прячет окно в трей, VPN продолжает работать.
            if let WindowEvent::CloseRequested { api, .. } = event {
                api.prevent_close();
                let _ = window.hide();
            }
        })
        .build(tauri::generate_context!())
        .expect("не удалось запустить приложение");

    app.run(|app, event| {
        if let RunEvent::Exit = event {
            stop_child(&app.state::<Core>().0);
        }
    });
}
