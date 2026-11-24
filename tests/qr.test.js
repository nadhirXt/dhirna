import test from "node:test";
import assert from "node:assert/strict";
import { encodeQrMatrix, renderQrSvg } from "../core/qr.js";
import { SHIELD_PROVIDERS } from "../core/shield.js";

// Independent ISO/IEC 18004 verifier/decoder (reads format bits, unmasks, de-interleaves RS blocks,
// verifies zero GF(256) syndromes, and decodes Byte-mode UTF-8 payload).
const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(() => {
  let x = 1;
  for (let i = 0; i < 255; i += 1) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i += 1) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  return a === 0 || b === 0 ? 0 : GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function verifyRsSyndrome(blockWithEc, ecCount) {
  for (let i = 0; i < ecCount; i += 1) {
    let val = 0;
    const root = GF_EXP[i];
    for (let j = 0; j < blockWithEc.length; j += 1) {
      val = gfMul(val, root) ^ blockWithEc[j];
    }
    if (val !== 0) return false;
  }
  return true;
}

const DECODER_SPECS = {
  1: { align: [], L: [7, [[1, 19]]], M: [10, [[1, 16]]], Q: [13, [[1, 13]]], H: [17, [[1, 9]]] },
  2: { align: [6, 18], L: [10, [[1, 34]]], M: [16, [[1, 28]]], Q: [22, [[1, 22]]], H: [28, [[1, 16]]] },
  3: { align: [6, 22], L: [15, [[1, 55]]], M: [26, [[1, 44]]], Q: [18, [[2, 17]]], H: [22, [[2, 13]]] },
  4: { align: [6, 26], L: [20, [[1, 80]]], M: [18, [[2, 32]]], Q: [26, [[2, 24]]], H: [16, [[4, 9]]] },
  5: { align: [6, 30], L: [26, [[1, 108]]], M: [24, [[2, 43]]], Q: [18, [[2, 15], [2, 16]]], H: [22, [[2, 11], [2, 12]]] },
  6: { align: [6, 34], L: [18, [[2, 68]]], M: [16, [[4, 27]]], Q: [24, [[4, 19]]], H: [28, [[4, 15]]] }
};

function independentDecodeMatrix(modules) {
  const n = modules.length;
  const version = (n - 17) / 4;
  const spec = DECODER_SPECS[version];
  assert.ok(spec, `Unsupported version ${version}`);

  let fmt = 0;
  for (let i = 0; i <= 5; i += 1) fmt |= (modules[i][8] ? 1 : 0) << i;
  fmt |= (modules[7][8] ? 1 : 0) << 6;
  fmt |= (modules[8][8] ? 1 : 0) << 7;
  fmt |= (modules[8][7] ? 1 : 0) << 8;
  for (let i = 9; i < 15; i += 1) fmt |= (modules[8][14 - i] ? 1 : 0) << i;
  const unmaskedFmt = fmt ^ 0b101010000010010;
  const ecBits = (unmaskedFmt >>> 13) & 0b11;
  const mask = (unmaskedFmt >>> 10) & 0b111;
  const ecMap = { 0b01: "L", 0b00: "M", 0b11: "Q", 0b10: "H" };
  const ecLevel = ecMap[ecBits];

  const isFunc = Array.from({ length: n }, () => new Array(n).fill(false));
  const markFinder = (top, left) => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const r = top + dy;
        const c = left + dx;
        if (r >= 0 && r < n && c >= 0 && c < n) isFunc[r][c] = true;
      }
    }
  };
  markFinder(0, 0);
  markFinder(0, n - 7);
  markFinder(n - 7, 0);
  for (const cy of spec.align) {
    for (const cx of spec.align) {
      if (isFunc[cy][cx]) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) isFunc[cy + dy][cx + dx] = true;
      }
    }
  }
  for (let i = 0; i < n; i += 1) {
    isFunc[6][i] = true;
    isFunc[i][6] = true;
  }
  for (let i = 0; i <= 8; i += 1) {
    isFunc[8][i] = true;
    isFunc[i][8] = true;
  }
  for (let i = 0; i < 8; i += 1) {
    isFunc[8][n - 1 - i] = true;
    isFunc[n - 1 - i][8] = true;
  }

  const maskFn = (r, c) => {
    if (mask === 0) return (r + c) % 2 === 0;
    if (mask === 1) return r % 2 === 0;
    if (mask === 2) return c % 3 === 0;
    if (mask === 3) return (r + c) % 3 === 0;
    if (mask === 4) return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    if (mask === 5) return ((r * c) % 2) + ((r * c) % 3) === 0;
    if (mask === 6) return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  };

  const rawBits = [];
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert += 1) {
      const upward = ((right + 1) & 2) === 0;
      const r = upward ? n - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const c = right - j;
        if (isFunc[r][c]) continue;
        const val = maskFn(r, c) ? !modules[r][c] : modules[r][c];
        rawBits.push(val ? 1 : 0);
      }
    }
  }

  const [ecPerBlock, blockGroups] = spec[ecLevel];
  const blockLengths = [];
  for (const [count, len] of blockGroups) {
    for (let i = 0; i < count; i += 1) blockLengths.push(len);
  }
  const totalCodewords = blockLengths.reduce((s, l) => s + l + ecPerBlock, 0);
  const codewords = [];
  for (let i = 0; i < totalCodewords; i += 1) {
    let b = 0;
    for (let j = 0; j < 8; j += 1) b = (b << 1) | rawBits[i * 8 + j];
    codewords.push(b);
  }

  const dataBlocks = blockLengths.map(() => []);
  const ecBlocks = blockLengths.map(() => []);
  let idx = 0;
  const maxDataLen = Math.max(...blockLengths);
  for (let col = 0; col < maxDataLen; col += 1) {
    for (let b = 0; b < blockLengths.length; b += 1) {
      if (col < blockLengths[b]) dataBlocks[b].push(codewords[idx++]);
    }
  }
  for (let col = 0; col < ecPerBlock; col += 1) {
    for (let b = 0; b < blockLengths.length; b += 1) {
      ecBlocks[b].push(codewords[idx++]);
    }
  }

  for (let b = 0; b < blockLengths.length; b += 1) {
    assert.equal(
      verifyRsSyndrome([...dataBlocks[b], ...ecBlocks[b]], ecPerBlock),
      true,
      `RS syndrome check failed for block ${b} (V${version}-${ecLevel})`
    );
  }

  const dataBytes = dataBlocks.flat();
  const dataBits = [];
  for (const byte of dataBytes) {
    for (let i = 7; i >= 0; i -= 1) dataBits.push((byte >>> i) & 1);
  }
  const readBits = (pos, len) => {
    let v = 0;
    for (let i = 0; i < len; i += 1) v = (v << 1) | dataBits[pos + i];
    return v;
  };
  const mode = readBits(0, 4);
  assert.equal(mode, 0b0100, "Expected Byte mode 0100");
  const len = readBits(4, 8);
  const outBytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    outBytes[i] = readBits(12 + i * 8, 8);
  }
  return {
    version,
    ecLevel,
    mask,
    text: new TextDecoder().decode(outBytes)
  };
}

test("encodeQrMatrix encodes and RS-verifies local iOS mobileconfig URL across EC levels L, M, Q, H", () => {
  const sampleUrl = "http://192.168.1.42:47890/dhirna-shield.mobileconfig";
  for (const level of ["L", "M", "Q", "H"]) {
    const qr = encodeQrMatrix(sampleUrl, level);
    assert.equal(qr.ecLevel, level);
    assert.equal(qr.size, 17 + 4 * qr.version);
    assert.equal(qr.modules[0][0], true);
    assert.equal(qr.modules[3][3], true);
    assert.equal(qr.modules[1][1], false);
    assert.equal(qr.modules[qr.size - 8][8], true);

    const decoded = independentDecodeMatrix(qr.modules);
    assert.equal(decoded.ecLevel, level);
    assert.equal(decoded.text, sampleUrl);
  }
});

test("encodeQrMatrix generates valid EC-Q matrices for all Shield Android DoT hostnames and DoH URLs", () => {
  for (const p of Object.values(SHIELD_PROVIDERS)) {
    const dotQr = encodeQrMatrix(p.dotHost, "Q");
    assert.equal(dotQr.ecLevel, "Q");
    assert.equal(independentDecodeMatrix(dotQr.modules).text, p.dotHost);

    const dohQr = encodeQrMatrix(p.dohUrl, "M");
    assert.equal(dohQr.ecLevel, "M");
    assert.equal(independentDecodeMatrix(dohQr.modules).text, p.dohUrl);
  }
});

test("renderQrSvg outputs crisp self-contained SVG with EC level metadata", () => {
  const svg = renderQrSvg("family.cloudflare-dns.com", { sizePx: 156, ecLevel: "Q" });
  assert.ok(svg.startsWith("<svg "));
  assert.ok(svg.includes('width="156"'));
  assert.ok(svg.includes('data-ec-level="Q"'));
  assert.ok(svg.includes('<path d="M'));
  assert.ok(svg.endsWith("</svg>"));
});
