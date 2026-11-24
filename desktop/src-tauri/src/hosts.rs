use std::fs;
use std::path::{Path, PathBuf};
#[cfg(target_os = "linux")]
use std::process::Command;

pub const MARKER_BEGIN: &str = "# Dhirna BEGIN";
pub const MARKER_END: &str = "# Dhirna END";

/// Pure function: removes any existing Dhirna block from a hosts file content string.
pub fn remove_dhirna_block(content: &str) -> String {
    let mut out_lines = Vec::new();
    let mut inside_block = false;

    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed == MARKER_BEGIN {
            inside_block = true;
            continue;
        }
        if trimmed == MARKER_END {
            inside_block = false;
            continue;
        }
        if !inside_block {
            out_lines.push(line);
        }
    }

    let mut result = out_lines.join("\n");
    if !result.is_empty() && !result.ends_with('\n') {
        result.push('\n');
    }
    result
}

/// Pure function: applies or removes the Dhirna hosts block for the given domain list.
pub fn apply_dhirna_block(content: &str, domains: &[String], enable: bool) -> String {
    let cleaned = remove_dhirna_block(content);
    if !enable || domains.is_empty() {
        return cleaned;
    }

    let mut block = Vec::new();
    block.push(MARKER_BEGIN.to_string());
    for raw in domains {
        let d = raw.trim().to_lowercase();
        let d = d.strip_prefix("www.").unwrap_or(&d);
        if d.is_empty() || d.contains(' ') {
            continue;
        }
        block.push(format!("0.0.0.0 {d}"));
        block.push(format!("0.0.0.0 www.{d}"));
    }
    block.push(MARKER_END.to_string());

    format!("{cleaned}{}\n", block.join("\n"))
}

pub fn system_hosts_path() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        PathBuf::from(r"C:\Windows\System32\drivers\etc\hosts")
    }
    #[cfg(not(target_os = "windows"))]
    {
        PathBuf::from("/etc/hosts")
    }
}

/// Executed inside the elevated `dhirna-desktop --internal-apply-hosts <tmp_file>` subprocess on Windows.
pub fn execute_internal_apply_hosts(tmp_file: &Path) -> Result<(), String> {
    let hosts_path = system_hosts_path();
    let content =
        fs::read_to_string(tmp_file).map_err(|e| format!("Cannot read temp hosts: {e}"))?;
    fs::write(&hosts_path, content.as_bytes())
        .map_err(|e| format!("Cannot write {}: {e}", hosts_path.display()))
}

/// Updates the system hosts file with native OS elevation (`pkexec` on Linux, Win32 `ShellExecuteExW` on Windows).
pub fn sync_system_hosts(domains: &[String], enable: bool) -> Result<(), String> {
    let hosts_path = system_hosts_path();
    let current = fs::read_to_string(&hosts_path)
        .map_err(|e| format!("Failed to read {}: {e}", hosts_path.display()))?;
    let updated = apply_dhirna_block(&current, domains, enable);

    if updated == current {
        return Ok(());
    }

    let tmp_path = std::env::temp_dir().join("dhirna_hosts.tmp");
    fs::write(&tmp_path, &updated).map_err(|e| format!("Temp write failed: {e}"))?;

    #[cfg(target_os = "linux")]
    {
        let status = Command::new("pkexec")
            .arg("cp")
            .arg(&tmp_path)
            .arg(&hosts_path)
            .status()
            .map_err(|e| format!("pkexec failed: {e}"))?;
        let _ = fs::remove_file(&tmp_path);
        if !status.success() {
            return Err("Autorisation administrateur refusée ou annulée".into());
        }
    }

    #[cfg(target_os = "windows")]
    {
        let tmp_str = tmp_path.to_string_lossy().to_string();
        let res = crate::platform::run_elevated_self_windows(&["--internal-apply-hosts", &tmp_str]);
        let _ = fs::remove_file(&tmp_path);
        res?;
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn adds_and_removes_dhirna_block_without_touching_existing_hosts() {
        let original = "127.0.0.1 localhost\n::1 ip6-localhost\n";
        let domains = vec!["instagram.com".to_string(), "tiktok.com".to_string()];

        let with_block = apply_dhirna_block(original, &domains, true);
        assert!(with_block.contains("127.0.0.1 localhost"));
        assert!(with_block.contains("# Dhirna BEGIN"));
        assert!(with_block.contains("0.0.0.0 instagram.com"));
        assert!(with_block.contains("0.0.0.0 www.instagram.com"));
        assert!(with_block.contains("0.0.0.0 tiktok.com"));
        assert!(with_block.contains("# Dhirna END"));

        let restored = apply_dhirna_block(&with_block, &domains, false);
        assert_eq!(restored, original);
    }
}
