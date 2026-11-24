//! Custom "Retour au travail" sound storage & validation for Dhirna (Phase 3).
//! Copies validated `.mp3`, `.wav`, or `.ogg` files (<= 5 MB) into `<appData>/sounds/`
//! so moving or deleting the user's original file never breaks playback.

use serde::Serialize;
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

pub const MAX_SOUND_BYTES: usize = 5 * 1024 * 1024; // 5 MB

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct StoredSoundInfo {
    pub file_name: String,
    pub original_name: String,
    pub mime: String,
    pub data_url: String,
}

const B64_TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

pub fn encode_base64(input: &[u8]) -> String {
    let mut out = String::with_capacity(((input.len() + 2) / 3) * 4);
    for chunk in input.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = if chunk.len() > 1 { chunk[1] as u32 } else { 0 };
        let b2 = if chunk.len() > 2 { chunk[2] as u32 } else { 0 };
        let triple = (b0 << 16) | (b1 << 8) | b2;

        out.push(B64_TABLE[((triple >> 18) & 0x3f) as usize] as char);
        out.push(B64_TABLE[((triple >> 12) & 0x3f) as usize] as char);
        if chunk.len() > 1 {
            out.push(B64_TABLE[((triple >> 6) & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
        if chunk.len() > 2 {
            out.push(B64_TABLE[(triple & 0x3f) as usize] as char);
        } else {
            out.push('=');
        }
    }
    out
}

pub fn decode_base64(raw: &str) -> Result<Vec<u8>, String> {
    let payload = match raw.find(',') {
        Some(idx) if raw[..idx].contains("base64") => &raw[idx + 1..],
        _ => raw,
    };

    let mut lut = [255u8; 256];
    for (i, &c) in B64_TABLE.iter().enumerate() {
        lut[c as usize] = i as u8;
    }

    let cleaned: Vec<u8> = payload
        .bytes()
        .filter(|b| !b.is_ascii_whitespace())
        .collect();
    if cleaned.is_empty() {
        return Err("Empty audio payload".into());
    }

    let mut out = Vec::with_capacity((cleaned.len() * 3) / 4);
    let mut buf = 0u32;
    let mut bits = 0u8;

    for &b in &cleaned {
        if b == b'=' {
            break;
        }
        let val = lut[b as usize];
        if val == 255 {
            return Err("Invalid base64 audio payload".into());
        }
        buf = (buf << 6) | (val as u32);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }

    Ok(out)
}

pub fn validate_audio_bytes(original_name: &str, bytes: &[u8]) -> Result<(&'static str, &'static str), String> {
    let ext_raw = Path::new(original_name)
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    let (ext, mime) = match ext_raw.as_str() {
        "mp3" => ("mp3", "audio/mpeg"),
        "wav" => ("wav", "audio/wav"),
        "ogg" => ("ogg", "audio/ogg"),
        _ => return Err("Format non supporté (.mp3, .wav, .ogg uniquement).".into()),
    };

    if bytes.is_empty() {
        return Err("Le fichier audio sélectionné est vide.".into());
    }
    if bytes.len() > MAX_SOUND_BYTES {
        return Err("Le fichier dépasse la taille maximale autorisée (5 Mo).".into());
    }
    if bytes.len() < 4 {
        return Err("En-tête audio invalide ou fichier tronqué.".into());
    }

    match ext {
        "wav" => {
            if &bytes[0..4] != b"RIFF" || (bytes.len() >= 12 && &bytes[8..12] != b"WAVE") {
                return Err("En-tête WAV invalide.".into());
            }
        }
        "ogg" => {
            if &bytes[0..4] != b"OggS" {
                return Err("En-tête OGG invalide.".into());
            }
        }
        "mp3" => {
            let is_id3 = bytes.len() >= 3 && &bytes[0..3] == b"ID3";
            let is_mpeg_sync = bytes[0] == 0xff && (bytes[1] & 0xe0) == 0xe0;
            if !is_id3 && !is_mpeg_sync {
                return Err("En-tête MP3 invalide.".into());
            }
        }
        _ => unreachable!(),
    }

    Ok((ext, mime))
}

fn sounds_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let base = app
        .path()
        .app_data_dir()
        .or_else(|_| app.path().app_config_dir())
        .map_err(|e| format!("Cannot resolve Dhirna data dir: {e}"))?;
    let dir = base.join("sounds");
    fs::create_dir_all(&dir).map_err(|e| format!("Cannot create sounds dir: {e}"))?;
    Ok(dir)
}

pub fn save_custom_sound_in_dir(
    dir: &Path,
    original_name: &str,
    data_base64: &str,
) -> Result<StoredSoundInfo, String> {
    fs::create_dir_all(dir).map_err(|e| format!("Cannot create sounds dir: {e}"))?;
    let bytes = decode_base64(data_base64)?;
    let (ext, mime) = validate_audio_bytes(original_name, &bytes)?;

    for old_ext in ["mp3", "wav", "ogg"] {
        let _ = fs::remove_file(dir.join(format!("custom_alert.{old_ext}")));
    }

    let file_name = format!("custom_alert.{ext}");
    let dest = dir.join(&file_name);
    fs::write(&dest, &bytes).map_err(|e| format!("Cannot write custom sound: {e}"))?;

    let clean_orig = Path::new(original_name)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(&file_name)
        .chars()
        .take(120)
        .collect::<String>();

    let b64 = encode_base64(&bytes);
    Ok(StoredSoundInfo {
        file_name,
        original_name: clean_orig,
        mime: mime.to_string(),
        data_url: format!("data:{mime};base64,{b64}"),
    })
}

pub fn load_custom_sound_from_dir(dir: &Path) -> Option<StoredSoundInfo> {
    for (ext, mime) in [("mp3", "audio/mpeg"), ("wav", "audio/wav"), ("ogg", "audio/ogg")] {
        let file_name = format!("custom_alert.{ext}");
        let path = dir.join(&file_name);
        if let Ok(bytes) = fs::read(&path) {
            if validate_audio_bytes(&file_name, &bytes).is_ok() {
                let b64 = encode_base64(&bytes);
                return Some(StoredSoundInfo {
                    file_name: file_name.clone(),
                    original_name: file_name,
                    mime: mime.to_string(),
                    data_url: format!("data:{mime};base64,{b64}"),
                });
            }
        }
    }
    None
}

pub fn remove_custom_sound_in_dir(dir: &Path) -> Result<(), String> {
    for ext in ["mp3", "wav", "ogg"] {
        let p = dir.join(format!("custom_alert.{ext}"));
        if p.exists() {
            fs::remove_file(&p).map_err(|e| format!("Cannot remove {}: {e}", p.display()))?;
        }
    }
    Ok(())
}

pub fn import_custom_sound(
    app: &AppHandle,
    original_name: &str,
    data_base64: &str,
) -> Result<StoredSoundInfo, String> {
    let dir = sounds_dir(app)?;
    save_custom_sound_in_dir(&dir, original_name, data_base64)
}

pub fn load_custom_sound(app: &AppHandle) -> Option<StoredSoundInfo> {
    let dir = sounds_dir(app).ok()?;
    load_custom_sound_from_dir(&dir)
}

pub fn remove_custom_sound(app: &AppHandle) -> Result<(), String> {
    let dir = sounds_dir(app)?;
    remove_custom_sound_in_dir(&dir)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validates_magic_bytes_size_and_persists_custom_sounds() {
        let mut wav = b"RIFF\x24\x00\x00\x00WAVEfmt ".to_vec();
        wav.extend_from_slice(&[0u8; 32]);
        let b64 = encode_base64(&wav);

        let dir = std::env::temp_dir().join(format!("dhirna_sounds_test_{}", std::process::id()));
        let saved = save_custom_sound_in_dir(&dir, "focus_bell.wav", &b64).expect("valid wav");
        assert_eq!(saved.file_name, "custom_alert.wav");
        assert_eq!(saved.mime, "audio/wav");
        assert!(saved.data_url.starts_with("data:audio/wav;base64,"));

        let reloaded = load_custom_sound_from_dir(&dir).expect("reload custom sound");
        assert_eq!(reloaded.file_name, "custom_alert.wav");

        // Reject unsupported extension
        assert!(save_custom_sound_in_dir(&dir, "evil.exe", &b64).is_err());

        // Reject corrupt header
        let bad_b64 = encode_base64(b"NOT_A_WAV_FILE_HEADER");
        assert!(save_custom_sound_in_dir(&dir, "fake.wav", &bad_b64).is_err());

        remove_custom_sound_in_dir(&dir).expect("remove");
        assert!(load_custom_sound_from_dir(&dir).is_none());
        let _ = fs::remove_dir_all(&dir);
    }
}
