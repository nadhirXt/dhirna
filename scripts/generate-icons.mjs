import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// CRC32 helper for PNG chunks
const crcTable = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  }
  crcTable[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makeChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  const combined = Buffer.concat([typeBuf, data]);
  crcBuf.writeUInt32BE(crc32(combined), 0);
  return Buffer.concat([len, combined, crcBuf]);
}

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function sdRoundedBox(px, py, bx, by, r) {
  const qx = Math.abs(px) - bx + r;
  const qy = Math.abs(py) - by + r;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

function createIconPng(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  const half = (size - 1) / 2;
  const aa = Math.max(0.75, size * 0.012);

  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    raw[rowStart] = 0;
    for (let x = 0; x < size; x++) {
      const idx = rowStart + 1 + x * 4;
      const dx = x - half;
      const dy = y - half;

      // Outer rounded squircle container (#131720)
      const boxDist = sdRoundedBox(dx, dy, size * 0.45, size * 0.45, size * 0.22);
      const bgAlpha = clamp01(0.5 - boxDist / aa);

      let r = 19;
      let g = 23;
      let b = 32;
      let a = Math.round(bgAlpha * 255);

      if (bgAlpha > 0) {
        // Crisp Dhirna geometric chronometer ring + vertical focus needle (#5E8BFF)
        const dist = Math.hypot(dx, dy);
        const ringRadius = size * 0.265;
        const ringHalfStroke = Math.max(1.0, size * 0.048);
        const ringAlpha = clamp01(0.5 - (Math.abs(dist - ringRadius) - ringHalfStroke) / aa);

        // Vertical upper needle + center pivot (#E8ECF1)
        const needleDist = sdRoundedBox(
          dx,
          dy + size * 0.085,
          Math.max(0.85, size * 0.036),
          size * 0.125,
          size * 0.02
        );
        const pivotAlpha = clamp01(0.5 - (dist - Math.max(1.1, size * 0.055)) / aa);
        const markWhiteAlpha = Math.max(clamp01(0.5 - needleDist / aa), pivotAlpha);

        if (ringAlpha > 0) {
          r = Math.round(r * (1 - ringAlpha) + 94 * ringAlpha);
          g = Math.round(g * (1 - ringAlpha) + 139 * ringAlpha);
          b = Math.round(b * (1 - ringAlpha) + 255 * ringAlpha);
        }
        if (markWhiteAlpha > 0) {
          r = Math.round(r * (1 - markWhiteAlpha) + 232 * markWhiteAlpha);
          g = Math.round(g * (1 - markWhiteAlpha) + 236 * markWhiteAlpha);
          b = Math.round(b * (1 - markWhiteAlpha) + 241 * markWhiteAlpha);
        }
      }

      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = a;
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    makeChunk("IHDR", ihdr),
    makeChunk("IDAT", idat),
    makeChunk("IEND", Buffer.alloc(0))
  ]);
}

/**
 * Wraps PNG buffers into a valid multi-resolution Windows .ico container.
 */
function createIcoFromPngs(entries) {
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(count, 4);

  const dirEntries = [];
  let offset = 6 + count * 16;

  for (const { size, png } of entries) {
    const dir = Buffer.alloc(16);
    dir[0] = size >= 256 ? 0 : size;
    dir[1] = size >= 256 ? 0 : size;
    dir[2] = 0;
    dir[3] = 0;
    dir.writeUInt16LE(1, 4);
    dir.writeUInt16LE(32, 6);
    dir.writeUInt32LE(png.length, 8);
    dir.writeUInt32LE(offset, 12);
    dirEntries.push(dir);
    offset += png.length;
  }

  return Buffer.concat([header, ...dirEntries, ...entries.map((e) => e.png)]);
}

const ICON_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128" fill="none">
  <rect x="6" y="6" width="116" height="116" rx="28" fill="#131720" stroke="#262E3D" stroke-width="2"/>
  <circle cx="64" cy="64" r="34" stroke="#5E8BFF" stroke-width="11"/>
  <rect x="59" y="38" width="10" height="30" rx="5" fill="#E8ECF1"/>
  <circle cx="64" cy="64" r="7" fill="#E8ECF1"/>
</svg>
`;

const extIconsDir = path.resolve("extension/assets/icons");
const tauriIconsDir = path.resolve("desktop/src-tauri/icons");
fs.mkdirSync(extIconsDir, { recursive: true });
fs.mkdirSync(tauriIconsDir, { recursive: true });

fs.writeFileSync(path.join(extIconsDir, "icon.svg"), ICON_SVG, "utf8");
fs.writeFileSync(path.join(tauriIconsDir, "icon.svg"), ICON_SVG, "utf8");

for (const size of [16, 24, 32, 48, 64, 128, 256]) {
  const png = createIconPng(size);
  if ([16, 48, 128].includes(size)) {
    fs.writeFileSync(path.join(extIconsDir, `icon${size}.png`), png);
    fs.writeFileSync(path.join(tauriIconsDir, `icon${size}.png`), png);
  }
  if (size === 32) {
    fs.writeFileSync(path.join(tauriIconsDir, "32x32.png"), png);
  }
  if (size === 128) {
    fs.writeFileSync(path.join(tauriIconsDir, "128x128.png"), png);
    fs.writeFileSync(path.join(tauriIconsDir, "icon.png"), png);
  }
  if (size === 256) {
    fs.writeFileSync(path.join(tauriIconsDir, "128x128@2x.png"), png);
  }
}

const icoBuf = createIcoFromPngs([
  { size: 16, png: createIconPng(16) },
  { size: 24, png: createIconPng(24) },
  { size: 32, png: createIconPng(32) },
  { size: 48, png: createIconPng(48) },
  { size: 64, png: createIconPng(64) },
  { size: 128, png: createIconPng(128) },
  { size: 256, png: createIconPng(256) }
]);
fs.writeFileSync(path.join(tauriIconsDir, "icon.ico"), icoBuf);
console.log("Generated Dhirna SVG, PNG, and multi-resolution Windows ICO icons");
