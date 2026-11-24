use crate::hosts::system_hosts_path;
use serde::Serialize;
use std::fs;
use std::net::{IpAddr, ToSocketAddrs};
use std::path::Path;
#[cfg(target_os = "linux")]
use std::process::Command;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

pub const SAFESEARCH_BEGIN: &str = "# Dhirna Shield SafeSearch BEGIN";
pub const SAFESEARCH_END: &str = "# Dhirna Shield SafeSearch END";
pub const NM_DROPIN_PATH: &str = "/etc/NetworkManager/conf.d/99-dhirna-shield.conf";
pub const RESOLVED_DROPIN_PATH: &str = "/etc/systemd/resolved.conf.d/99-dhirna-shield.conf";

#[derive(Debug, Clone, Copy)]
pub struct ProviderSpec {
    pub id: &'static str,
    pub name: &'static str,
    pub primary: &'static str,
    pub secondary: &'static str,
    pub dot_host: &'static str,
    pub doh_url: &'static str,
    pub canary: &'static str,
    pub profile_uuid: &'static str,
    pub payload_uuid: &'static str,
}

pub fn provider_spec(provider_id: &str) -> ProviderSpec {
    match provider_id {
        "cloudflare" => ProviderSpec {
            id: "cloudflare",
            name: "Cloudflare for Families",
            primary: "1.1.1.3",
            secondary: "1.0.0.3",
            dot_host: "family.cloudflare-dns.com",
            doh_url: "https://family.cloudflare-dns.com/dns-query",
            canary: "nudity.testcategory.com",
            profile_uuid: "B8C41910-6E42-4D9C-8A11-4F91D2000201",
            payload_uuid: "B8C41910-6E42-4D9C-8A11-4F91D2000202",
        },
        "adguard" => ProviderSpec {
            id: "adguard",
            name: "AdGuard Family",
            primary: "94.140.14.15",
            secondary: "94.140.15.16",
            dot_host: "family.adguard-dns.com",
            doh_url: "https://family.adguard-dns.com/dns-query",
            canary: "nudity.testcategory.com",
            profile_uuid: "B8C41910-6E42-4D9C-8A11-4F91D2000301",
            payload_uuid: "B8C41910-6E42-4D9C-8A11-4F91D2000302",
        },
        _ => ProviderSpec {
            id: "cleanbrowsing",
            name: "CleanBrowsing Adult",
            primary: "185.228.168.10",
            secondary: "185.228.169.11",
            dot_host: "adult-filter-dns.cleanbrowsing.org",
            doh_url: "https://doh.cleanbrowsing.org/doh/adult-filter/",
            canary: "badexample.com",
            profile_uuid: "B8C41910-6E42-4D9C-8A11-4F91D2000101",
            payload_uuid: "B8C41910-6E42-4D9C-8A11-4F91D2000102",
        },
    }
}

/// Builds a pure Apple iOS 14+ / iPadOS encrypted Anti-Porn DNS (`.mobileconfig`) profile.
pub fn build_ios_mobileconfig(provider_id: &str) -> String {
    let p = provider_spec(provider_id);
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>DNSSettings</key>
      <dict>
        <key>DNSProtocol</key>
        <string>HTTPS</string>
        <key>ServerURL</key>
        <string>{doh_url}</string>
      </dict>
      <key>OnDemandRules</key>
      <array>
        <dict>
          <key>Action</key>
          <string>Connect</string>
        </dict>
      </array>
      <key>PayloadDescription</key>
      <string>Encrypted Family DNS ({name}) blocking adult content across all networks</string>
      <key>PayloadDisplayName</key>
      <string>Dhirna DNS — {name}</string>
      <key>PayloadIdentifier</key>
      <string>com.dhirna.shield.dns.{id}</string>
      <key>PayloadType</key>
      <string>com.apple.dnsSettings.managed</string>
      <key>PayloadUUID</key>
      <string>{payload_uuid}</string>
      <key>PayloadVersion</key>
      <integer>1</integer>
    </dict>
  </array>
  <key>PayloadDescription</key>
  <string>Blocks adult sites across Safari and all apps via {name}.</string>
  <key>PayloadDisplayName</key>
  <string>Dhirna Bouclier — {name}</string>
  <key>PayloadIdentifier</key>
  <string>com.dhirna.shield.profile.{id}</string>
  <key>PayloadOrganization</key>
  <string>Dhirna</string>
  <key>PayloadRemovalDisallowed</key>
  <false/>
  <key>PayloadType</key>
  <string>Configuration</string>
  <key>PayloadUUID</key>
  <string>{profile_uuid}</string>
  <key>PayloadVersion</key>
  <integer>1</integer>
</dict>
</plist>
"#,
        doh_url = p.doh_url,
        name = p.name,
        id = p.id,
        payload_uuid = p.payload_uuid,
        profile_uuid = p.profile_uuid,
    )
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShieldDiagnostic {
    pub provider: String,
    pub os_dns_configured: bool,
    pub safesearch_hosts_active: bool,
    pub active_resolvers: Vec<String>,
    pub canary_domain: String,
    pub canary_blocked: bool,
    pub details: String,
}

pub fn build_nm_dropin(spec: &ProviderSpec) -> String {
    format!(
        "# Managed by Dhirna Content Shield ({name})\n\
         [global-dns-domain-*]\n\
         servers={primary},{secondary}\n",
        name = spec.name,
        primary = spec.primary,
        secondary = spec.secondary
    )
}

pub fn build_resolved_dropin(spec: &ProviderSpec) -> String {
    format!(
        "# Managed by Dhirna Content Shield ({name})\n\
         [Resolve]\n\
         DNS={primary}#{dot} {secondary}#{dot}\n\
         FallbackDNS=1.1.1.3#family.cloudflare-dns.com\n\
         DNSOverTLS=opportunistic\n\
         Domains=~.\n",
        name = spec.name,
        primary = spec.primary,
        secondary = spec.secondary,
        dot = spec.dot_host
    )
}

pub fn remove_safesearch_hosts_block(content: &str) -> String {
    let mut out_lines = Vec::new();
    let mut inside = false;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == SAFESEARCH_BEGIN {
            inside = true;
            continue;
        }
        if trimmed == SAFESEARCH_END {
            inside = false;
            continue;
        }
        if !inside {
            out_lines.push(line);
        }
    }
    let mut res = out_lines.join("\n");
    if !res.is_empty() && !res.ends_with('\n') {
        res.push('\n');
    }
    res
}

#[cfg(test)]
pub fn apply_safesearch_hosts_block(
    content: &str,
    enable: bool,
    safe_search: bool,
    youtube_restricted: bool,
) -> String {
    apply_safesearch_hosts_block_with_options(content, enable, safe_search, youtube_restricted, false)
}

pub fn apply_safesearch_hosts_block_with_options(
    content: &str,
    enable: bool,
    safe_search: bool,
    youtube_restricted: bool,
    _no_reels: bool,
) -> String {
    let cleaned = remove_safesearch_hosts_block(content);
    if !enable || (!safe_search && !youtube_restricted) {
        return cleaned;
    }

    let mut lines = vec![SAFESEARCH_BEGIN.to_string()];

    if safe_search {
        for host in [
            "www.google.com",
            "google.com",
            "www.google.fr",
            "google.fr",
            "www.google.co.uk",
            "www.google.de",
            "www.google.es",
            "www.google.ca",
            "www.google.be",
            "www.google.ch",
            "www.google.ma",
            "www.google.dz",
            "www.google.tn",
        ] {
            lines.push(format!("216.239.38.120 {host}"));
        }
        lines.push("204.79.197.220 www.bing.com".to_string());
        lines.push("204.79.197.220 bing.com".to_string());
    }

    if youtube_restricted {
        lines.push("216.239.38.119 www.youtube.com".to_string());
        lines.push("216.239.38.119 m.youtube.com".to_string());
        lines.push("216.239.38.119 youtubei.googleapis.com".to_string());
    }

    lines.push(SAFESEARCH_END.to_string());
    format!("{cleaned}{}\n", lines.join("\n"))
}

fn check_canary_blocked(domain: &str) -> bool {
    let target = format!("{domain}:80");
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        let blocked = match target.to_socket_addrs() {
            Err(_) => true,
            Ok(mut addrs) => {
                let Some(first) = addrs.next() else {
                    let _ = tx.send(true);
                    return;
                };
                match first.ip() {
                    IpAddr::V4(ip) => ip.is_unspecified() || ip.is_loopback(),
                    IpAddr::V6(ip) => ip.is_unspecified() || ip.is_loopback(),
                }
            }
        };
        let _ = tx.send(blocked);
    });
    rx.recv_timeout(Duration::from_millis(1500)).unwrap_or(false)
}

#[cfg(target_os = "windows")]
unsafe fn read_reg_string_value(
    hkey: ::windows::Win32::System::Registry::HKEY,
    name: &str,
) -> Option<String> {
    use ::windows::core::PCWSTR;
    use ::windows::Win32::Foundation::ERROR_SUCCESS;
    use ::windows::Win32::System::Registry::{RegQueryValueExW, REG_SZ, REG_VALUE_TYPE};

    let name_w = crate::platform::encode_wide_null(name);
    let mut val_type = REG_VALUE_TYPE(0);
    let mut byte_len: u32 = 0;
    let status = RegQueryValueExW(
        hkey,
        PCWSTR(name_w.as_ptr()),
        None,
        Some(&mut val_type),
        None,
        Some(&mut byte_len),
    );
    if status != ERROR_SUCCESS || byte_len == 0 || val_type != REG_SZ {
        return None;
    }
    let mut u16_buf = vec![0u16; ((byte_len as usize) + 1) / 2];
    let status2 = RegQueryValueExW(
        hkey,
        PCWSTR(name_w.as_ptr()),
        None,
        Some(&mut val_type),
        Some(u16_buf.as_mut_ptr() as *mut u8),
        Some(&mut byte_len),
    );
    if status2 != ERROR_SUCCESS {
        return None;
    }
    let end = u16_buf.iter().position(|&c| c == 0).unwrap_or(u16_buf.len());
    let text = String::from_utf16_lossy(&u16_buf[..end]).trim().to_string();
    if text.is_empty() {
        None
    } else {
        Some(text)
    }
}

fn read_active_resolvers() -> Vec<String> {
    let mut found = Vec::new();
    #[cfg(target_os = "linux")]
    {
        if let Ok(out) = Command::new("resolvectl").arg("dns").output() {
            let text = String::from_utf8_lossy(&out.stdout);
            for token in text.split_whitespace() {
                let clean = token.split('#').next().unwrap_or("");
                if clean.parse::<IpAddr>().is_ok() && !found.contains(&clean.to_string()) {
                    found.push(clean.to_string());
                }
            }
        }
        if found.is_empty() {
            if let Ok(content) = fs::read_to_string(NM_DROPIN_PATH) {
                for line in content.lines() {
                    if let Some(rest) = line.strip_prefix("servers=") {
                        for ip in rest.split(',') {
                            let c = ip.trim();
                            if !c.is_empty() {
                                found.push(c.to_string());
                            }
                        }
                    }
                }
            }
        }
    }

    // Native Win32 Registry inspection of TCP/IP interface NameServer entries (zero PowerShell)
    #[cfg(target_os = "windows")]
    {
        use ::windows::core::{PCWSTR, PWSTR};
        use ::windows::Win32::Foundation::ERROR_SUCCESS;
        use ::windows::Win32::System::Registry::{
            RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, HKEY, HKEY_LOCAL_MACHINE, KEY_READ,
        };

        let subkey = crate::platform::encode_wide_null(
            r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces",
        );
        unsafe {
            let mut parent = HKEY::default();
            if RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(subkey.as_ptr()),
                0,
                KEY_READ,
                &mut parent,
            ) == ERROR_SUCCESS
            {
                let mut idx = 0u32;
                loop {
                    let mut name_buf = [0u16; 256];
                    let mut name_len = name_buf.len() as u32;
                    let res = RegEnumKeyExW(
                        parent,
                        idx,
                        PWSTR(name_buf.as_mut_ptr()),
                        &mut name_len,
                        None,
                        PWSTR::null(),
                        None,
                        None,
                    );
                    if res != ERROR_SUCCESS {
                        break;
                    }
                    idx += 1;

                    let mut child = HKEY::default();
                    if RegOpenKeyExW(
                        parent,
                        PCWSTR(name_buf.as_ptr()),
                        0,
                        KEY_READ,
                        &mut child,
                    ) == ERROR_SUCCESS
                    {
                        for field in ["NameServer", "DhcpNameServer"] {
                            if let Some(val) = read_reg_string_value(child, field) {
                                for tok in val.split(|c: char| c == ',' || c.is_whitespace()) {
                                    let t = tok.trim();
                                    if t.parse::<IpAddr>().is_ok() && !found.iter().any(|x| x == t)
                                    {
                                        found.push(t.to_string());
                                    }
                                }
                            }
                        }
                        let _ = RegCloseKey(child);
                    }
                }
                let _ = RegCloseKey(parent);
            }
        }
    }
    found
}

pub fn check_system_shield(provider_id: &str) -> ShieldDiagnostic {
    let spec = provider_spec(provider_id);
    let active_resolvers = read_active_resolvers();
    let hosts_content = fs::read_to_string(system_hosts_path()).unwrap_or_default();
    let safesearch_hosts_active = hosts_content.contains(SAFESEARCH_BEGIN);

    #[cfg(target_os = "linux")]
    let dropin_exists = std::path::Path::new(NM_DROPIN_PATH).exists()
        || std::path::Path::new(RESOLVED_DROPIN_PATH).exists();

    #[cfg(not(target_os = "linux"))]
    let dropin_exists = false;

    let resolver_matches = active_resolvers
        .iter()
        .any(|ip| ip == spec.primary || ip == spec.secondary);
    let os_dns_configured = dropin_exists || resolver_matches;
    let canary_blocked = check_canary_blocked(spec.canary);

    let details = if os_dns_configured && canary_blocked {
        format!("DNS {} actif ({})", spec.name, spec.primary)
    } else if os_dns_configured {
        format!(
            "Configuration écrite ({}) — vérifiez le DNS sécurisé (DoH) du navigateur",
            spec.primary
        )
    } else if canary_blocked {
        format!("Filtrage DNS actif sur le réseau ({})", spec.canary)
    } else {
        "DNS famille système non activé".to_string()
    };

    ShieldDiagnostic {
        provider: spec.id.to_string(),
        os_dns_configured,
        safesearch_hosts_active,
        active_resolvers,
        canary_domain: spec.canary.to_string(),
        canary_blocked,
        details,
    }
}

/// Executed inside the elevated `dhirna-desktop.exe --internal-apply-shield <provider|off> <tmp_hosts>`
/// subprocess on Windows. Writes `hosts`, updates TCP/IP `NameServer` registry keys natively, and flushes DNS
/// using `CREATE_NO_WINDOW` (zero PowerShell, zero console flash).
pub fn execute_internal_apply_shield(mode_arg: &str, tmp_hosts: &Path) -> Result<(), String> {
    let hosts_path = system_hosts_path();
    let content =
        fs::read_to_string(tmp_hosts).map_err(|e| format!("Cannot read temp hosts: {e}"))?;
    fs::write(&hosts_path, content.as_bytes())
        .map_err(|e| format!("Cannot write {}: {e}", hosts_path.display()))?;

    #[cfg(target_os = "windows")]
    {
        use ::windows::core::{PCWSTR, PWSTR};
        use ::windows::Win32::Foundation::ERROR_SUCCESS;
        use ::windows::Win32::System::Registry::{
            RegCloseKey, RegEnumKeyExW, RegOpenKeyExW, RegSetValueExW, HKEY, HKEY_LOCAL_MACHINE,
            KEY_READ, KEY_SET_VALUE, REG_SZ,
        };
        use std::os::windows::process::CommandExt;

        let dns_value = if mode_arg.eq_ignore_ascii_case("off") {
            String::new()
        } else {
            let spec = provider_spec(mode_arg);
            format!("{},{}", spec.primary, spec.secondary)
        };
        let dns_wide = crate::platform::encode_wide_null(&dns_value);
        let dns_bytes = unsafe {
            std::slice::from_raw_parts(
                dns_wide.as_ptr() as *const u8,
                dns_wide.len() * std::mem::size_of::<u16>(),
            )
        };
        let val_name = crate::platform::encode_wide_null("NameServer");

        let subkey = crate::platform::encode_wide_null(
            r"SYSTEM\CurrentControlSet\Services\Tcpip\Parameters\Interfaces",
        );
        unsafe {
            let mut parent = HKEY::default();
            if RegOpenKeyExW(
                HKEY_LOCAL_MACHINE,
                PCWSTR(subkey.as_ptr()),
                0,
                KEY_READ,
                &mut parent,
            ) == ERROR_SUCCESS
            {
                let mut idx = 0u32;
                loop {
                    let mut name_buf = [0u16; 256];
                    let mut name_len = name_buf.len() as u32;
                    if RegEnumKeyExW(
                        parent,
                        idx,
                        PWSTR(name_buf.as_mut_ptr()),
                        &mut name_len,
                        None,
                        PWSTR::null(),
                        None,
                        None,
                    ) != ERROR_SUCCESS
                    {
                        break;
                    }
                    idx += 1;

                    let mut child = HKEY::default();
                    if RegOpenKeyExW(
                        parent,
                        PCWSTR(name_buf.as_ptr()),
                        0,
                        KEY_READ | KEY_SET_VALUE,
                        &mut child,
                    ) == ERROR_SUCCESS
                    {
                        let has_ip = read_reg_string_value(child, "DhcpIPAddress")
                            .or_else(|| read_reg_string_value(child, "IPAddress"))
                            .map(|ip| !ip.is_empty() && ip != "0.0.0.0")
                            .unwrap_or(false);
                        if has_ip || dns_value.is_empty() {
                            let _ = RegSetValueExW(
                                child,
                                PCWSTR(val_name.as_ptr()),
                                0,
                                REG_SZ,
                                Some(dns_bytes),
                            );
                        }
                        let _ = RegCloseKey(child);
                    }
                }
                let _ = RegCloseKey(parent);
            }
        }

        let _ = std::process::Command::new("ipconfig")
            .arg("/flushdns")
            .creation_flags(crate::platform::CREATE_NO_WINDOW_FLAG)
            .output();
    }

    #[cfg(not(target_os = "windows"))]
    {
        let _ = mode_arg;
    }

    Ok(())
}

/// Applies or removes the OS-wide Family DNS + SafeSearch hosts entries with a single native elevation prompt.
pub fn apply_system_shield_with_options(
    provider_id: &str,
    enable: bool,
    safe_search: bool,
    youtube_restricted: bool,
    no_reels: bool,
) -> Result<ShieldDiagnostic, String> {
    let spec = provider_spec(provider_id);
    let hosts_path = system_hosts_path();
    let current_hosts = fs::read_to_string(&hosts_path)
        .map_err(|e| format!("Impossible de lire {}: {e}", hosts_path.display()))?;
    let updated_hosts = apply_safesearch_hosts_block_with_options(
        &current_hosts,
        enable,
        safe_search,
        youtube_restricted,
        no_reels,
    );

    #[cfg(target_os = "linux")]
    {
        let tmp_dir = std::env::temp_dir();
        let tmp_nm = tmp_dir.join("dhirna_nm_shield.conf");
        let tmp_res = tmp_dir.join("dhirna_resolved_shield.conf");
        let tmp_hosts = tmp_dir.join("dhirna_hosts_shield.tmp");
        let tmp_script = tmp_dir.join("dhirna_apply_shield.sh");

        fs::write(&tmp_hosts, &updated_hosts).map_err(|e| format!("Temp hosts write failed: {e}"))?;

        let script = if enable {
            fs::write(&tmp_nm, build_nm_dropin(&spec))
                .map_err(|e| format!("Temp NM write failed: {e}"))?;
            fs::write(&tmp_res, build_resolved_dropin(&spec))
                .map_err(|e| format!("Temp resolved write failed: {e}"))?;
            format!(
                "#!/bin/sh\nset -e\n\
                 mkdir -p /etc/NetworkManager/conf.d /etc/systemd/resolved.conf.d\n\
                 command -v chattr >/dev/null 2>&1 && chattr -i '{NM_DROPIN_PATH}' '{RESOLVED_DROPIN_PATH}' 2>/dev/null || true\n\
                 cp '{}' '{NM_DROPIN_PATH}'\n\
                 cp '{}' '{RESOLVED_DROPIN_PATH}'\n\
                 cp '{}' '{}'\n\
                 command -v chattr >/dev/null 2>&1 && chattr +i '{NM_DROPIN_PATH}' '{RESOLVED_DROPIN_PATH}' 2>/dev/null || true\n\
                 systemctl is-active --quiet systemd-resolved && systemctl restart systemd-resolved || true\n\
                 systemctl is-active --quiet NetworkManager && systemctl reload-or-restart NetworkManager || true\n\
                 command -v resolvectl >/dev/null 2>&1 && resolvectl flush-caches || true\n",
                tmp_nm.display(),
                tmp_res.display(),
                tmp_hosts.display(),
                hosts_path.display()
            )
        } else {
            format!(
                "#!/bin/sh\nset -e\n\
                 command -v chattr >/dev/null 2>&1 && chattr -i '{NM_DROPIN_PATH}' '{RESOLVED_DROPIN_PATH}' 2>/dev/null || true\n\
                 rm -f '{NM_DROPIN_PATH}' '{RESOLVED_DROPIN_PATH}'\n\
                 cp '{}' '{}'\n\
                 systemctl is-active --quiet systemd-resolved && systemctl restart systemd-resolved || true\n\
                 systemctl is-active --quiet NetworkManager && systemctl reload-or-restart NetworkManager || true\n\
                 command -v resolvectl >/dev/null 2>&1 && resolvectl flush-caches || true\n",
                tmp_hosts.display(),
                hosts_path.display()
            )
        };

        fs::write(&tmp_script, &script).map_err(|e| format!("Temp script write failed: {e}"))?;

        let status = Command::new("pkexec")
            .arg("sh")
            .arg(&tmp_script)
            .status()
            .map_err(|e| format!("pkexec failed: {e}"))?;

        let _ = fs::remove_file(&tmp_nm);
        let _ = fs::remove_file(&tmp_res);
        let _ = fs::remove_file(&tmp_hosts);
        let _ = fs::remove_file(&tmp_script);

        if !status.success() {
            return Err("Autorisation administrateur refusée ou annulée".into());
        }
    }

    #[cfg(target_os = "windows")]
    {
        let tmp_hosts = std::env::temp_dir().join("dhirna_hosts_shield.tmp");
        fs::write(&tmp_hosts, &updated_hosts).map_err(|e| format!("Temp hosts write failed: {e}"))?;
        let mode_arg = if enable { spec.id } else { "off" };
        let tmp_str = tmp_hosts.to_string_lossy().to_string();
        let res = crate::platform::run_elevated_self_windows(&[
            "--internal-apply-shield",
            mode_arg,
            &tmp_str,
        ]);
        let _ = fs::remove_file(&tmp_hosts);
        res?;
    }

    let _ = set_anti_uninstall_guardian(enable);

    Ok(check_system_shield(provider_id))
}

pub fn build_systemd_guardian_unit(exe_path: &str) -> String {
    format!(
        "[Unit]\n\
         Description=Dhirna Focus & Shield Guardian\n\
         After=graphical-session.target\n\
         StartLimitIntervalSec=60\n\
         StartLimitBurst=5\n\n\
         [Service]\n\
         Type=simple\n\
         ExecStart=\"{exe_path}\"\n\
         Restart=on-failure\n\
         RestartSec=5\n\n\
         [Install]\n\
         WantedBy=default.target\n"
    )
}

pub fn build_xdg_autostart_desktop(exe_path: &str) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Dhirna Guardian\n\
         Comment=Protection Focus & Bouclier Dhirna\n\
         Exec=\"{exe_path}\"\n\
         Terminal=false\n\
         X-GNOME-Autostart-enabled=true\n"
    )
}

/// Installs or removes the OS Autostart & Anti-Uninstall Guardian natively:
/// - Linux: user systemd service (`~/.config/systemd/user/dhirna-guardian.service`) + XDG autostart.
/// - Windows: native Win32 Registry APIs (`HKCU\...\Run\DhirnaGuardian` + `Uninstall\Dhirna\NoRemove`).
///   Uses zero `reg.exe`, zero `schtasks.exe`, and zero PowerShell.
pub fn set_anti_uninstall_guardian(enable: bool) -> Result<String, String> {
    let exe_path = std::env::current_exe()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| "/usr/bin/dhirna-desktop".to_string());

    #[cfg(target_os = "linux")]
    {
        let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".to_string());
        let systemd_dir = std::path::PathBuf::from(&home).join(".config/systemd/user");
        let autostart_dir = std::path::PathBuf::from(&home).join(".config/autostart");
        let unit_file = systemd_dir.join("dhirna-guardian.service");
        let desktop_file = autostart_dir.join("dhirna-guardian.desktop");

        if enable {
            let _ = fs::create_dir_all(&systemd_dir);
            let _ = fs::create_dir_all(&autostart_dir);
            let _ = fs::write(&unit_file, build_systemd_guardian_unit(&exe_path));
            let _ = fs::write(&desktop_file, build_xdg_autostart_desktop(&exe_path));
            let _ = Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .output();
            let _ = Command::new("systemctl")
                .args(["--user", "enable", "dhirna-guardian.service"])
                .output();
            Ok("Service Gardien Linux (systemd + Autostart) activé.".into())
        } else {
            let _ = Command::new("systemctl")
                .args(["--user", "disable", "dhirna-guardian.service"])
                .output();
            let _ = fs::remove_file(&unit_file);
            let _ = fs::remove_file(&desktop_file);
            let _ = Command::new("systemctl")
                .args(["--user", "daemon-reload"])
                .output();
            Ok("Service Gardien Linux désactivé.".into())
        }
    }

    #[cfg(target_os = "windows")]
    {
        use ::windows::core::PCWSTR;
        use ::windows::Win32::Foundation::ERROR_SUCCESS;
        use ::windows::Win32::System::Registry::{
            RegCloseKey, RegCreateKeyExW, RegDeleteValueW, RegOpenKeyExW, RegSetValueExW, HKEY,
            HKEY_CURRENT_USER, KEY_SET_VALUE, KEY_WRITE, REG_DWORD, REG_OPTION_NON_VOLATILE,
            REG_SZ,
        };

        let run_subkey = crate::platform::encode_wide_null(
            r"Software\Microsoft\Windows\CurrentVersion\Run",
        );
        let uninstall_subkey = crate::platform::encode_wide_null(
            r"Software\Microsoft\Windows\CurrentVersion\Uninstall\Dhirna",
        );
        let val_guardian = crate::platform::encode_wide_null("DhirnaGuardian");
        let val_noremove = crate::platform::encode_wide_null("NoRemove");

        unsafe {
            if enable {
                let mut h_run = HKEY::default();
                if RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(run_subkey.as_ptr()),
                    0,
                    PCWSTR::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_WRITE,
                    None,
                    &mut h_run,
                    None,
                ) == ERROR_SUCCESS
                {
                    let quoted = format!("\"{exe_path}\"");
                    let wide = crate::platform::encode_wide_null(&quoted);
                    let bytes = std::slice::from_raw_parts(
                        wide.as_ptr() as *const u8,
                        wide.len() * std::mem::size_of::<u16>(),
                    );
                    let _ = RegSetValueExW(
                        h_run,
                        PCWSTR(val_guardian.as_ptr()),
                        0,
                        REG_SZ,
                        Some(bytes),
                    );
                    let _ = RegCloseKey(h_run);
                }

                let mut h_uninst = HKEY::default();
                if RegCreateKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(uninstall_subkey.as_ptr()),
                    0,
                    PCWSTR::null(),
                    REG_OPTION_NON_VOLATILE,
                    KEY_WRITE,
                    None,
                    &mut h_uninst,
                    None,
                ) == ERROR_SUCCESS
                {
                    let one: u32 = 1;
                    let _ = RegSetValueExW(
                        h_uninst,
                        PCWSTR(val_noremove.as_ptr()),
                        0,
                        REG_DWORD,
                        Some(&one.to_le_bytes()),
                    );
                    let _ = RegCloseKey(h_uninst);
                }
                Ok("Démarrage automatique Windows Dhirna activé.".into())
            } else {
                let mut h_run = HKEY::default();
                if RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(run_subkey.as_ptr()),
                    0,
                    KEY_SET_VALUE,
                    &mut h_run,
                ) == ERROR_SUCCESS
                {
                    let _ = RegDeleteValueW(h_run, PCWSTR(val_guardian.as_ptr()));
                    let _ = RegCloseKey(h_run);
                }

                let mut h_uninst = HKEY::default();
                if RegOpenKeyExW(
                    HKEY_CURRENT_USER,
                    PCWSTR(uninstall_subkey.as_ptr()),
                    0,
                    KEY_SET_VALUE,
                    &mut h_uninst,
                ) == ERROR_SUCCESS
                {
                    let zero: u32 = 0;
                    let _ = RegSetValueExW(
                        h_uninst,
                        PCWSTR(val_noremove.as_ptr()),
                        0,
                        REG_DWORD,
                        Some(&zero.to_le_bytes()),
                    );
                    let _ = RegCloseKey(h_uninst);
                }
                Ok("Démarrage automatique Windows Dhirna désactivé.".into())
            }
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    {
        let _ = exe_path;
        Ok(if enable {
            "Gardien activé.".into()
        } else {
            "Gardien désactivé.".into()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generates_networkmanager_and_resolved_configs_for_all_providers() {
        let cb = provider_spec("cleanbrowsing");
        let nm = build_nm_dropin(&cb);
        let res = build_resolved_dropin(&cb);
        assert!(nm.contains("[global-dns-domain-*]"));
        assert!(nm.contains("servers=185.228.168.10,185.228.169.11"));
        assert!(res.contains("DNS=185.228.168.10#adult-filter-dns.cleanbrowsing.org"));
        assert!(res.contains("DNSOverTLS=opportunistic"));

        let cf = provider_spec("cloudflare");
        assert!(build_nm_dropin(&cf).contains("1.1.1.3,1.0.0.3"));

        let ag = provider_spec("adguard");
        assert!(build_nm_dropin(&ag).contains("94.140.14.15,94.140.15.16"));
    }

    #[test]
    fn manages_safesearch_hosts_block_without_touching_strict_mode_block() {
        let original = "127.0.0.1 localhost\n# Dhirna BEGIN\n0.0.0.0 instagram.com\n# Dhirna END\n";
        let with_ss = apply_safesearch_hosts_block(original, true, true, false);
        assert!(with_ss.contains("# Dhirna BEGIN"));
        assert!(with_ss.contains("0.0.0.0 instagram.com"));
        assert!(with_ss.contains("216.239.38.120 www.google.com"));
        assert!(!with_ss.contains("216.239.38.119 www.youtube.com"));

        let with_yt = apply_safesearch_hosts_block(&with_ss, true, true, true);
        assert!(with_yt.contains("216.239.38.119 www.youtube.com"));

        let restored = apply_safesearch_hosts_block(&with_yt, false, true, true);
        assert_eq!(restored, original);
    }

    #[test]
    fn mobileconfig_is_pure_encrypted_dns_profile_for_dhirna() {
        let xml = build_ios_mobileconfig("cleanbrowsing");
        assert!(xml.contains("com.apple.dnsSettings.managed"));
        assert!(xml.contains("com.dhirna.shield.profile.cleanbrowsing"));
        assert!(xml.contains("Dhirna Bouclier"));
        assert!(!xml.contains("com.apple.webClip.managed"));
    }

    #[test]
    fn builds_systemd_guardian_and_xdg_autostart_configs() {
        let unit = build_systemd_guardian_unit("/usr/bin/dhirna-desktop");
        assert!(unit.contains("ExecStart=\"/usr/bin/dhirna-desktop\""));
        assert!(unit.contains("Restart=on-failure"));

        let desktop = build_xdg_autostart_desktop("/usr/bin/dhirna-desktop");
        assert!(desktop.contains("Exec=\"/usr/bin/dhirna-desktop\""));
        assert!(desktop.contains("X-GNOME-Autostart-enabled=true"));
    }
}
