
use std::{
    io::{Read, Write},
    net::{SocketAddr, TcpStream},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    time::Duration,
};

use tauri::Manager;

#[derive(Default)]
struct ServerProcess {
    child: Mutex<Option<Child>>,
}

fn locate_server_dir() -> Result<PathBuf, String> {
    if let Ok(custom_path) = std::env::var("UNIFIED_CLOUD_SERVER_DIR") {
        let path = PathBuf::from(custom_path);

        if path.join("dist").join("index.js").exists() {
            return path.canonicalize()
                .map_err(|_| "Could not resolve configured backend directory".into());
        }

        return Err(
            "Configured backend directory does not contain dist/index.js".into()
        );
    }

    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../server");

    let path = path.canonicalize()
        .map_err(|_| "Backend directory not found. Build the server first.".to_string())?;

    if !path.join("dist").join("index.js").exists() {
        return Err(
            "Backend build missing. Run npm run build in apps/server.".into()
        );
    }

    Ok(path)
}

// 0 = no backend responded, 1 = compatible backend, 2 = incompatible backend.
// A plain HTTP 200 is not enough: an older server can still answer /health
// while lacking the raw-binary transfer protocol used by this app build.
fn backend_health_status(port: u16) -> u8 {
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    let timeout = Duration::from_millis(700);

    let Ok(mut stream) = TcpStream::connect_timeout(&address, timeout) else {
        return 0;
    };

    let _ = stream.set_read_timeout(Some(timeout));
    let _ = stream.set_write_timeout(Some(timeout));

    let request = format!(
        "GET /health HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nConnection: close\r\n\r\n"
    );

    if stream.write_all(request.as_bytes()).is_err() {
        return 0;
    }

    let mut response = Vec::new();
    if stream.read_to_end(&mut response).is_err() || response.is_empty() {
        return 0;
    }

    let response_text = String::from_utf8_lossy(&response);
    if !(response_text.starts_with("HTTP/1.1 200") || response_text.starts_with("HTTP/1.0 200")) {
        return 2;
    }

    if response_text.contains("\"apiProtocolVersion\":2") {
        1
    } else {
        2
    }
}

#[tauri::command]
fn local_server_start(
    state: tauri::State<'_, ServerProcess>,
    mode: String,
    port: Option<u16>,
) -> Result<String, String> {
    let host = match mode.as_str() {
        "standalone" => "127.0.0.1",
        "server" => "0.0.0.0",
        _ => return Err("Mode must be standalone or server".into()),
    };

    let port = port.unwrap_or(4100);

    if port == 0 {
        return Err("Invalid server port".into());
    }

    // Reuse only a backend that advertises the protocol expected by this app.
    // Never silently attach to an older server that may reject raw upload chunks.
    match backend_health_status(port) {
        1 => return Ok("already_running".into()),
        2 => return Err(format!(
            "An older or incompatible backend is already responding on port {port}. Stop that previous backend before starting this version."
        )),
        _ => {}
    }

    let mut process = state.child.lock()
        .map_err(|_| "Server process lock failed".to_string())?;

    if let Some(child) = process.as_mut() {
        match child.try_wait() {
            Ok(None) => return Ok("already_running".into()),
            Ok(Some(_)) => {
                *process = None;
            }
            Err(error) => {
                return Err(format!("Could not check server process: {error}"));
            }
        }
    }

    let server_dir = locate_server_dir()?;

    let oauth_client_file = server_dir
        .join("secrets")
        .join("google-oauth-client.json")
        .canonicalize()
        .ok();

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (host, port, server_dir, oauth_client_file);

        return Err(
            "Secure encryption-key storage is not implemented for this platform yet".into()
        );
    }

    #[cfg(target_os = "windows")]
    {
        let mut encryption_key =
            windows_credential_store::get_or_create_encryption_key()?.into_bytes();

        let mut command = Command::new("node");

        command
            .arg("dist/index.js")
            .current_dir(server_dir)
            .env("HOST", host)
            .env("PORT", port.to_string())
            .env(
                "OAUTH_REDIRECT_URI",
                format!("http://localhost:{port}/auth/google/callback"),
            )
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());

        if let Some(oauth_path) = oauth_client_file {
            command.env("GOOGLE_OAUTH_CLIENT_FILE", oauth_path);
        } else {
            command.env("GOOGLE_OAUTH_CLIENT_FILE", "");
        }

        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);

        let mut child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                encryption_key.fill(0);

                return Err(format!(
                    "Could not start Node.js backend: {error}"
                ));
            }
        };

        let transfer_result = (|| -> Result<(), String> {
            let mut stdin = child.stdin.take()
                .ok_or_else(|| {
                    "Backend key pipe could not be opened".to_string()
                })?;

            stdin.write_all(&encryption_key)
                .map_err(|_| {
                    "Could not transfer encryption key to backend".to_string()
                })?;

            stdin.write_all(b"\n")
                .map_err(|_| {
                    "Could not finish encryption-key transfer".to_string()
                })?;

            Ok(())
        })();

        encryption_key.fill(0);

        if let Err(error) = transfer_result {
            let _ = child.kill();
            let _ = child.wait();

            return Err(error);
        }

        *process = Some(child);

        Ok(format!("started:{host}:{port}"))
    }
}

#[tauri::command]
fn local_server_stop(
    state: tauri::State<'_, ServerProcess>,
) -> Result<String, String> {
    let mut process = state.child.lock()
        .map_err(|_| "Server process lock failed".to_string())?;

    if let Some(mut child) = process.take() {
        child.kill()
            .map_err(|error| format!("Could not stop backend: {error}"))?;

        child.wait()
            .map_err(|error| format!("Could not finish backend shutdown: {error}"))?;

        Ok("stopped".into())
    } else {
        Ok("not_running".into())
    }
}

#[tauri::command]
fn local_server_status(
    state: tauri::State<'_, ServerProcess>,
) -> Result<bool, String> {
    let mut process = state.child.lock()
        .map_err(|_| "Server process lock failed".to_string())?;

    let child_running = if let Some(child) = process.as_mut() {
        match child.try_wait() {
            Ok(None) => true,
            Ok(Some(_)) => {
                *process = None;
                false
            }
            Err(error) => {
                return Err(format!("Could not check backend process: {error}"));
            }
        }
    } else {
        false
    };

    // The health endpoint is authoritative for app availability. This also
    // recognizes a backend that is already running on port 4100 but is not
    // represented by this Tauri process handle (for example after a restart).
    Ok(child_running || backend_health_status(4100) == 1)
}

#[cfg(target_os = "windows")]
mod windows_credential_store {
    use std::ffi::c_void;

    use windows_sys::Win32::Foundation::{
        GetLastError, ERROR_NOT_FOUND,
    };

    use windows_sys::Win32::Security::Credentials::{
        CredDeleteW, CredFree, CredReadW, CredWriteW,
        CREDENTIALW, CRED_PERSIST_LOCAL_MACHINE, CRED_TYPE_GENERIC,
    };

    const MAX_CREDENTIAL_BYTES: usize = 2560;
    const TARGET_PREFIX: &str = "UnifiedCloudManager:";

    fn make_target(key: &str) -> Result<Vec<u16>, String> {
        if key.trim().is_empty() {
            return Err("Credential key cannot be empty".into());
        }

        let target = format!("{TARGET_PREFIX}{key}");

        if target.encode_utf16().count() > 32767 {
            return Err("Credential key is too long".into());
        }

        Ok(target.encode_utf16().chain(Some(0)).collect())
    }

    pub fn set(key: &str, value: &str) -> Result<(), String> {
        let target = make_target(key)?;
        let mut secret = value.as_bytes().to_vec();

        if secret.len() > MAX_CREDENTIAL_BYTES {
            secret.fill(0);

            return Err(
                "Credential exceeds Windows 2560-byte limit".into()
            );
        }

        let mut credential: CREDENTIALW = unsafe {
            std::mem::zeroed()
        };

        credential.Type = CRED_TYPE_GENERIC;
        credential.TargetName = target.as_ptr() as *mut u16;
        credential.CredentialBlobSize = secret.len() as u32;
        credential.CredentialBlob = secret.as_mut_ptr();
        credential.Persist = CRED_PERSIST_LOCAL_MACHINE;

        let result = unsafe {
            CredWriteW(&credential, 0)
        };

        secret.fill(0);

        if result == 0 {
            return Err(
                "Windows Credential Manager could not save the credential".into()
            );
        }

        Ok(())
    }

    pub fn get(key: &str) -> Result<Option<String>, String> {
        let target = make_target(key)?;

        let mut credential_ptr: *mut CREDENTIALW =
            std::ptr::null_mut();

        let result = unsafe {
            CredReadW(
                target.as_ptr(),
                CRED_TYPE_GENERIC,
                0,
                &mut credential_ptr,
            )
        };

        if result == 0 {
            let error = unsafe { GetLastError() };

            if error == ERROR_NOT_FOUND {
                return Ok(None);
            }

            return Err(format!(
                "Windows Credential Manager read failed: {error}"
            ));
        }

        if credential_ptr.is_null() {
            return Err("Windows returned an empty credential".into());
        }

        let credential = unsafe { &*credential_ptr };

        let bytes = if credential.CredentialBlobSize == 0 {
            Vec::new()
        } else if credential.CredentialBlob.is_null()
            || credential.CredentialBlobSize as usize > MAX_CREDENTIAL_BYTES
        {
            unsafe {
                CredFree(credential_ptr as *const c_void);
            }

            return Err("Invalid credential data returned by Windows".into());
        } else {
            unsafe {
                std::slice::from_raw_parts(
                    credential.CredentialBlob,
                    credential.CredentialBlobSize as usize,
                ).to_vec()
            }
        };

        unsafe {
            CredFree(credential_ptr as *const c_void);
        }

        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| "Stored credential is not valid UTF-8".into())
    }

    pub fn delete(key: &str) -> Result<(), String> {
        let target = make_target(key)?;

        let result = unsafe {
            CredDeleteW(
                target.as_ptr(),
                CRED_TYPE_GENERIC,
                0,
            )
        };

        if result == 0 {
            let error = unsafe { GetLastError() };

            if error == ERROR_NOT_FOUND {
                return Ok(());
            }

            return Err(format!(
                "Windows Credential Manager delete failed: {error}"
            ));
        }

        Ok(())
    }

    pub fn get_or_create_encryption_key() -> Result<String, String> {
        if let Some(existing_key) = get("encryption-key")? {
            if existing_key.len() == 64
                && existing_key.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return Ok(existing_key);
            }

            return Err("Stored encryption key is invalid".into());
        }

        let mut key = [0u8; 32];

        getrandom::fill(&mut key)
            .map_err(|error| {
                format!("Secure key generation failed: {error}")
            })?;

        let encoded_key: String = key
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();

        key.fill(0);

        set("encryption-key", &encoded_key)?;

        Ok(encoded_key)
    }
}

#[tauri::command]
fn credential_store_set(key: String, value: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_credential_store::set(&key, &value)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = (key, value);

        Err(
            "Secure credential storage is not implemented for this platform yet".into()
        )
    }
}

#[tauri::command]
fn credential_store_get(key: String) -> Result<Option<String>, String> {
    #[cfg(target_os = "windows")]
    {
        windows_credential_store::get(&key)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = key;

        Err(
            "Secure credential storage is not implemented for this platform yet".into()
        )
    }
}

#[tauri::command]
fn credential_store_delete(key: String) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        windows_credential_store::delete(&key)
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = key;

        Err(
            "Secure credential storage is not implemented for this platform yet".into()
        )
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(ServerProcess::default())
        .invoke_handler(tauri::generate_handler![
            credential_store_set,
            credential_store_get,
            credential_store_delete,
            local_server_start,
            local_server_stop,
            local_server_status
        ])
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }

            Ok(())
        });

    builder
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                if let Some(state) = app_handle.try_state::<ServerProcess>() {
                    if let Ok(mut process) = state.child.lock() {
                        if let Some(mut child) = process.take() {
                            let _ = child.kill();
                            let _ = child.wait();
                        }
                    }
                }
            }
        });
}
