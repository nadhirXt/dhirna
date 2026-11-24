//! Minimal ephemeral LAN HTTP responder serving ONLY the Apple `.mobileconfig`
//! Anti-Porn encrypted DNS profile when the user views the iPhone QR Code in Dhirna.
//! Zero web pages, zero external links, zero PowerShell/shell calls.

use serde::Serialize;
use std::io::{Read, Write};
use std::net::{IpAddr, TcpListener, TcpStream, UdpSocket};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

const IDLE_TIMEOUT_SECS: u64 = 600;

struct ActiveQrServer {
    port: u16,
    ip: String,
    provider: String,
    stop_flag: std::sync::Arc<AtomicBool>,
}

static QR_SERVER: Mutex<Option<ActiveQrServer>> = Mutex::new(None);
static SERVER_GEN: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MobileQrInfo {
    pub available: bool,
    pub url: Option<String>,
    pub ip: Option<String>,
    pub port: Option<u16>,
    pub provider: String,
}

/// Resolves the machine's primary outbound LAN IPv4 address purely via OS kernel routing lookup
/// (`UdpSocket::connect` sends zero network packets).
pub fn detect_lan_ipv4() -> Option<String> {
    for probe in ["192.168.1.1:80", "10.0.0.1:80", "1.1.1.1:80"] {
        if let Ok(sock) = UdpSocket::bind("0.0.0.0:0") {
            if sock.connect(probe).is_ok() {
                if let Ok(local) = sock.local_addr() {
                    if let IpAddr::V4(v4) = local.ip() {
                        if !v4.is_loopback() && !v4.is_unspecified() && !v4.is_link_local() {
                            return Some(v4.to_string());
                        }
                    }
                }
            }
        }
    }
    None
}

fn current_provider() -> String {
    QR_SERVER
        .lock()
        .ok()
        .and_then(|g| g.as_ref().map(|s| s.provider.clone()))
        .unwrap_or_else(|| "cleanbrowsing".to_string())
}

fn serve_client(mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(900)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(1500)));
    let mut buf = [0u8; 2048];
    let n = match stream.read(&mut buf) {
        Ok(n) if n > 0 => n,
        _ => return,
    };
    let req = String::from_utf8_lossy(&buf[..n]);
    let first_line = req.lines().next().unwrap_or("");
    let mut parts = first_line.split_whitespace();
    let method = parts.next().unwrap_or("");
    let path = parts.next().unwrap_or("/");

    if method != "GET" && method != "HEAD" {
        let _ = stream.write_all(b"HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
        return;
    }

    let clean_path = path.split('?').next().unwrap_or("/");
    if clean_path == "/" || clean_path.ends_with(".mobileconfig") {
        let provider_id = current_provider();
        let xml = crate::shield::build_ios_mobileconfig(&provider_id);
        let filename = format!("dhirna-shield-{provider_id}.mobileconfig");
        let headers = format!(
            "HTTP/1.1 200 OK\r\n\
             Content-Type: application/x-apple-aspen-config; charset=utf-8\r\n\
             Content-Disposition: attachment; filename=\"{filename}\"\r\n\
             Cache-Control: no-store\r\n\
             Content-Length: {}\r\n\
             Connection: close\r\n\r\n",
            xml.len()
        );
        let _ = stream.write_all(headers.as_bytes());
        if method == "GET" {
            let _ = stream.write_all(xml.as_bytes());
        }
        let _ = stream.flush();
    } else {
        let _ = stream.write_all(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    }
}

pub fn start_or_update_mobile_qr(provider_id: &str) -> MobileQrInfo {
    let clean_provider = crate::shield::provider_spec(provider_id).id.to_string();

    if let Ok(mut guard) = QR_SERVER.lock() {
        if let Some(existing) = guard.as_mut() {
            if !existing.stop_flag.load(Ordering::SeqCst) {
                existing.provider = clean_provider.clone();
                let url = format!(
                    "http://{}:{}/dhirna-shield.mobileconfig",
                    existing.ip, existing.port
                );
                return MobileQrInfo {
                    available: true,
                    url: Some(url),
                    ip: Some(existing.ip.clone()),
                    port: Some(existing.port),
                    provider: clean_provider,
                };
            }
        }
    }

    let Some(lan_ip) = detect_lan_ipv4() else {
        return MobileQrInfo {
            available: false,
            url: None,
            ip: None,
            port: None,
            provider: clean_provider,
        };
    };

    let Ok(listener) = TcpListener::bind("0.0.0.0:0") else {
        return MobileQrInfo {
            available: false,
            url: None,
            ip: Some(lan_ip),
            port: None,
            provider: clean_provider,
        };
    };
    let _ = listener.set_nonblocking(true);
    let port = match listener.local_addr() {
        Ok(addr) => addr.port(),
        Err(_) => {
            return MobileQrInfo {
                available: false,
                url: None,
                ip: Some(lan_ip),
                port: None,
                provider: clean_provider,
            };
        }
    };

    let stop_flag = std::sync::Arc::new(AtomicBool::new(false));
    let stop_clone = stop_flag.clone();
    let gen_id = SERVER_GEN.fetch_add(1, Ordering::SeqCst) + 1;

    if let Ok(mut guard) = QR_SERVER.lock() {
        if let Some(old) = guard.take() {
            old.stop_flag.store(true, Ordering::SeqCst);
        }
        *guard = Some(ActiveQrServer {
            port,
            ip: lan_ip.clone(),
            provider: clean_provider.clone(),
            stop_flag,
        });
    }

    let _ = thread::Builder::new()
        .name(format!("dhirna-mobile-qr-{gen_id}"))
        .spawn(move || {
            let started = Instant::now();
            while !stop_clone.load(Ordering::SeqCst)
                && started.elapsed() < Duration::from_secs(IDLE_TIMEOUT_SECS)
            {
                match listener.accept() {
                    Ok((stream, _)) => {
                        thread::spawn(move || serve_client(stream));
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(80));
                    }
                    Err(_) => break,
                }
            }
            stop_clone.store(true, Ordering::SeqCst);
        });

    let url = format!("http://{lan_ip}:{port}/dhirna-shield.mobileconfig");
    MobileQrInfo {
        available: true,
        url: Some(url),
        ip: Some(lan_ip),
        port: Some(port),
        provider: clean_provider,
    }
}

pub fn stop_mobile_qr() {
    if let Ok(mut guard) = QR_SERVER.lock() {
        if let Some(old) = guard.take() {
            old.stop_flag.store(true, Ordering::SeqCst);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mobile_qr_stop_is_idempotent() {
        stop_mobile_qr();
        stop_mobile_qr();
    }
}
