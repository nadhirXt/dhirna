use serde::{Deserialize, Serialize};
#[cfg(not(target_os = "linux"))]
use sysinfo::Pid;
use sysinfo::{ProcessRefreshKind, System};

#[cfg(target_os = "linux")]
pub mod linux_x11;
#[cfg(target_os = "windows")]
pub mod windows;

#[cfg(target_os = "windows")]
pub const CREATE_NO_WINDOW_FLAG: u32 = 0x0800_0000;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct WinInfo {
    pub id: u64,
    pub title: String,
    pub pid: u32,
    pub process_name: String,
}

pub trait Platform {
    fn active_window(&self) -> Option<WinInfo>;
    fn list_windows(&self) -> Vec<WinInfo>;
    fn focus_window(&self, id: u64) -> Result<(), String>;
    fn minimize_window(&self, id: u64) -> Result<(), String>;
    fn close_window(&self, id: u64) -> Result<(), String>;
    fn send_close_tab(&self, id: u64) -> Result<(), String>;
    fn idle_duration_ms(&self) -> u64;
}

/// Resolves a process executable name from its OS PID in O(1) without scanning all OS processes.
pub fn process_name_for_pid(pid: u32) -> String {
    if pid == 0 {
        return String::new();
    }

    #[cfg(target_os = "linux")]
    {
        if let Ok(comm) = std::fs::read_to_string(format!("/proc/{pid}/comm")) {
            let trimmed = comm.trim();
            if !trimmed.is_empty() {
                return trimmed.to_string();
            }
        }
        if let Ok(cmdline) = std::fs::read(format!("/proc/{pid}/cmdline")) {
            if let Some(first) = cmdline.split(|&b| b == 0).next() {
                let raw = String::from_utf8_lossy(first);
                if let Some(base) = raw.rsplit('/').next() {
                    let trimmed = base.trim();
                    if !trimmed.is_empty() {
                        return trimmed.to_string();
                    }
                }
            }
        }
        return String::new();
    }

    #[cfg(not(target_os = "linux"))]
    {
        let mut sys = System::new();
        let sys_pid = Pid::from_u32(pid);
        sys.refresh_pids_specifics(&[sys_pid], ProcessRefreshKind::new());
        if let Some(proc_info) = sys.process(sys_pid) {
            proc_info.name().to_string()
        } else {
            String::new()
        }
    }
}

/// Force-terminates processes matching the given process name (handling `.exe`, case differences,
/// and Linux 15-character `/proc/<pid>/comm` truncation). Never kills Dhirna itself.
pub fn kill_process_by_name(target_name: &str) -> Result<usize, String> {
    let clean = target_name.trim().to_lowercase();
    let clean_stem = clean.trim_end_matches(".exe");
    if clean_stem.is_empty() || clean_stem == "dhirna" || clean_stem == "dhirna-desktop" {
        return Err("Invalid process name".into());
    }
    let clean_15 = if clean_stem.len() > 15 {
        &clean_stem[..15]
    } else {
        clean_stem
    };
    let my_pid = std::process::id();

    let mut sys = System::new();
    sys.refresh_processes_specifics(ProcessRefreshKind::new());
    let mut killed = 0usize;
    for (pid, process) in sys.processes() {
        if pid.as_u32() == my_pid {
            continue;
        }
        let name = process.name().to_lowercase();
        let stem = name.trim_end_matches(".exe");
        let matched = name == clean
            || stem == clean_stem
            || (clean_15.len() >= 8 && stem == clean_15)
            || (clean_stem.len() >= 5 && stem.starts_with(clean_stem));
        if matched && process.kill() {
            killed += 1;
        }
    }
    Ok(killed)
}

/// Force-terminates a specific process PID (and guards against killing Dhirna itself).
pub fn kill_process_by_pid(target_pid: u32) -> Result<usize, String> {
    if target_pid == 0 || target_pid == std::process::id() {
        return Ok(0);
    }
    let mut sys = System::new();
    let sys_pid = sysinfo::Pid::from_u32(target_pid);
    sys.refresh_pids_specifics(&[sys_pid], ProcessRefreshKind::new());
    if let Some(proc_info) = sys.process(sys_pid) {
        let name = proc_info.name().to_lowercase();
        if name.starts_with("dhirna") {
            return Ok(0);
        }
        if proc_info.kill() {
            return Ok(1);
        }
    }
    Ok(0)
}

#[cfg(target_os = "windows")]
pub fn encode_wide_null(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// Launches the current `dhirna-desktop.exe` binary with UAC elevation (`ShellExecuteExW` `"runas"`, `SW_HIDE`)
/// to execute a single bounded privileged operation (hosts or DNS update) and waits for completion.
/// Uses zero PowerShell, zero `cmd.exe`, and zero temporary scripts.
#[cfg(target_os = "windows")]
pub fn run_elevated_self_windows(args: &[&str]) -> Result<(), String> {
    use ::windows::core::PCWSTR;
    use ::windows::Win32::Foundation::{CloseHandle, HWND};
    use ::windows::Win32::System::Threading::{GetExitCodeProcess, WaitForSingleObject, INFINITE};
    use ::windows::Win32::UI::Shell::{
        ShellExecuteExW, SEE_MASK_NOCLOSEPROCESS, SHELLEXECUTEINFOW,
    };
    use ::windows::Win32::UI::WindowsAndMessaging::SW_HIDE;
    use std::mem::{size_of, zeroed};

    let exe = std::env::current_exe().map_err(|e| format!("Cannot resolve current exe: {e}"))?;
    let exe_w = encode_wide_null(&exe.to_string_lossy());
    let verb_w = encode_wide_null("runas");

    let quoted_args: Vec<String> = args
        .iter()
        .map(|a| format!("\"{}\"", a.replace('"', "\\\"")))
        .collect();
    let params_w = encode_wide_null(&quoted_args.join(" "));

    unsafe {
        let mut sei: SHELLEXECUTEINFOW = zeroed();
        sei.cbSize = size_of::<SHELLEXECUTEINFOW>() as u32;
        sei.fMask = SEE_MASK_NOCLOSEPROCESS;
        sei.hwnd = HWND::default();
        sei.lpVerb = PCWSTR(verb_w.as_ptr());
        sei.lpFile = PCWSTR(exe_w.as_ptr());
        sei.lpParameters = PCWSTR(params_w.as_ptr());
        sei.nShow = SW_HIDE.0;

        ShellExecuteExW(&mut sei)
            .map_err(|_| "Autorisation administrateur Windows refusée ou annulée".to_string())?;

        if !sei.hProcess.is_invalid() {
            let _ = WaitForSingleObject(sei.hProcess, INFINITE);
            let mut exit_code: u32 = 1;
            let ok = GetExitCodeProcess(sei.hProcess, &mut exit_code).is_ok();
            let _ = CloseHandle(sei.hProcess);
            if !ok || exit_code != 0 {
                return Err(format!(
                    "Échec de l'opération système privilégiée (code {exit_code})"
                ));
            }
        }
    }
    Ok(())
}

/// Copies UTF-8 text into the OS clipboard natively (Win32 Clipboard API on Windows; wl-copy/xclip/xsel on Linux).
pub fn copy_text_to_clipboard(text: &str) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        use std::io::Write;
        use std::process::{Command, Stdio};

        let candidates: [(&str, &[&str]); 3] = [
            ("wl-copy", &[]),
            ("xclip", &["-selection", "clipboard"]),
            ("xsel", &["--clipboard", "--input"]),
        ];
        for (bin, args) in candidates {
            if let Ok(mut child) = Command::new(bin)
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
            {
                if let Some(mut stdin) = child.stdin.take() {
                    let _ = stdin.write_all(text.as_bytes());
                }
                if let Ok(status) = child.wait() {
                    if status.success() {
                        return Ok(());
                    }
                }
            }
        }
        return Err("Aucun outil presse-papiers Linux disponible (wl-copy/xclip/xsel)".into());
    }

    #[cfg(target_os = "windows")]
    {
        use ::windows::Win32::Foundation::{HANDLE, HWND};
        use ::windows::Win32::System::DataExchange::{
            CloseClipboard, EmptyClipboard, OpenClipboard, SetClipboardData,
        };
        use ::windows::Win32::System::Memory::{
            GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE,
        };
        use ::windows::Win32::System::Ole::CF_UNICODETEXT;

        let wide = encode_wide_null(text);
        let byte_len = wide.len() * std::mem::size_of::<u16>();

        unsafe {
            OpenClipboard(HWND::default())
                .map_err(|e| format!("OpenClipboard failed: {e}"))?;
            let result = (|| -> Result<(), String> {
                EmptyClipboard().map_err(|e| format!("EmptyClipboard failed: {e}"))?;
                let hmem = GlobalAlloc(GMEM_MOVEABLE, byte_len)
                    .map_err(|e| format!("GlobalAlloc failed: {e}"))?;
                let dst = GlobalLock(hmem) as *mut u16;
                if dst.is_null() {
                    return Err("GlobalLock returned null".into());
                }
                std::ptr::copy_nonoverlapping(wide.as_ptr(), dst, wide.len());
                let _ = GlobalUnlock(hmem);
                SetClipboardData(CF_UNICODETEXT.0 as u32, HANDLE(hmem.0))
                    .map_err(|e| format!("SetClipboardData failed: {e}"))?;
                Ok(())
            })();
            let _ = CloseClipboard();
            return result;
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = text;
        Err("Unsupported OS clipboard".into())
    }
}

/// Unmutes the OS default audio endpoint and sets its scalar volume natively.
/// On Windows, uses CoreAudio COM (`IAudioEndpointVolume`) directly with zero subprocesses.
pub fn force_unmute_and_boost_volume(target_percent: u8) -> Result<(), String> {
    let pct = target_percent.clamp(25, 100);

    #[cfg(target_os = "linux")]
    {
        use std::process::Command;
        let frac = format!("{:.2}", (pct as f32) / 100.0);
        let pct_str = format!("{pct}%");

        let _ = Command::new("wpctl")
            .args(["set-mute", "@DEFAULT_AUDIO_SINK@", "0"])
            .output();
        let _ = Command::new("wpctl")
            .args(["set-volume", "@DEFAULT_AUDIO_SINK@", &frac])
            .output();

        let _ = Command::new("pactl")
            .args(["set-sink-mute", "@DEFAULT_SINK@", "0"])
            .output();
        let _ = Command::new("pactl")
            .args(["set-sink-volume", "@DEFAULT_SINK@", &pct_str])
            .output();

        let _ = Command::new("amixer")
            .args(["-q", "sset", "Master", "unmute", &pct_str])
            .output();
    }

    #[cfg(target_os = "windows")]
    {
        use ::windows::Win32::Foundation::BOOL;
        use ::windows::Win32::Media::Audio::Endpoints::IAudioEndpointVolume;
        use ::windows::Win32::Media::Audio::{
            eConsole, eRender, IMMDeviceEnumerator, MMDeviceEnumerator,
        };
        use ::windows::Win32::System::Com::{
            CoCreateInstance, CoInitializeEx, CLSCTX_ALL, COINIT_APARTMENTTHREADED,
        };

        unsafe {
            let _ = CoInitializeEx(None, COINIT_APARTMENTTHREADED);
            if let Ok(enumerator) =
                CoCreateInstance::<_, IMMDeviceEnumerator>(&MMDeviceEnumerator, None, CLSCTX_ALL)
            {
                if let Ok(device) = enumerator.GetDefaultAudioEndpoint(eRender, eConsole) {
                    if let Ok(endpoint) =
                        device.Activate::<IAudioEndpointVolume>(CLSCTX_ALL, None)
                    {
                        let _ = endpoint.SetMute(BOOL(0), std::ptr::null());
                        let scalar = ((pct as f32) / 100.0).clamp(0.0, 1.0);
                        let _ = endpoint.SetMasterVolumeLevelScalar(scalar, std::ptr::null());
                    }
                }
            }
        }
    }

    Ok(())
}

pub fn current_platform() -> Box<dyn Platform + Send + Sync> {
    #[cfg(target_os = "linux")]
    {
        Box::new(linux_x11::LinuxX11Platform::new())
    }
    #[cfg(target_os = "windows")]
    {
        Box::new(windows::WindowsPlatform::new())
    }
    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        Box::new(UnsupportedPlatform)
    }
}

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
struct UnsupportedPlatform;

#[cfg(not(any(target_os = "linux", target_os = "windows")))]
impl Platform for UnsupportedPlatform {
    fn active_window(&self) -> Option<WinInfo> {
        None
    }
    fn list_windows(&self) -> Vec<WinInfo> {
        Vec::new()
    }
    fn focus_window(&self, _id: u64) -> Result<(), String> {
        Err("Unsupported OS".into())
    }
    fn minimize_window(&self, _id: u64) -> Result<(), String> {
        Err("Unsupported OS".into())
    }
    fn close_window(&self, _id: u64) -> Result<(), String> {
        Err("Unsupported OS".into())
    }
    fn send_close_tab(&self, _id: u64) -> Result<(), String> {
        Err("Unsupported OS".into())
    }
    fn idle_duration_ms(&self) -> u64 {
        0
    }
}
