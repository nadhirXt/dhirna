/**
 * Pure zero-dependency ISO/IEC 18004 QR Code encoder (Byte mode, EC Levels L/M/Q/H, Versions 1..6)
 * with multi-block Reed-Solomon interleaving for Dhirna.
 * Generates deterministic, offline SVG QR codes with high error correction (default Q or H).
 */

// ISO/IEC 18004 Table 12: Format Information EC Level indicator bits
const EC_INDICATOR = {
  L: 0b01,
  M: 0b00,
  Q: 0b11,
  H: 0b10
};

// ISO/IEC 18004 Table 9 & Annex E: Versions 1..6 parameters for L, M, Q, H
const VERSION_SPECS = [
  {
    version: 1,
    size: 21,
    align: [],
    ec: {
      L: { dataBytes: 19, ecPerBlock: 7, blocks: [[1, 19]] },
      M: { dataBytes: 16, ecPerBlock: 10, blocks: [[1, 16]] },
      Q: { dataBytes: 13, ecPerBlock: 13, blocks: [[1, 13]] },
      H: { dataBytes: 9, ecPerBlock: 17, blocks: [[1, 9]] }
    }
  },
  {
    version: 2,
    size: 25,
    align: [6, 18],
    ec: {
      L: { dataBytes: 34, ecPerBlock: 10, blocks: [[1, 34]] },
      M: { dataBytes: 28, ecPerBlock: 16, blocks: [[1, 28]] },
      Q: { dataBytes: 22, ecPerBlock: 22, blocks: [[1, 22]] },
      H: { dataBytes: 16, ecPerBlock: 28, blocks: [[1, 16]] }
    }
  },
  {
    version: 3,
    size: 29,
    align: [6, 22],
    ec: {
      L: { dataBytes: 55, ecPerBlock: 15, blocks: [[1, 55]] },
      M: { dataBytes: 44, ecPerBlock: 26, blocks: [[1, 44]] },
      Q: { dataBytes: 34, ecPerBlock: 18, blocks: [[2, 17]] },
      H: { dataBytes: 26, ecPerBlock: 22, blocks: [[2, 13]] }
    }
  },
  {
    version: 4,
    size: 33,
    align: [6, 26],
    ec: {
      L: { dataBytes: 80, ecPerBlock: 20, blocks: [[1, 80]] },
      M: { dataBytes: 64, ecPerBlock: 18, blocks: [[2, 32]] },
      Q: { dataBytes: 48, ecPerBlock: 26, blocks: [[2, 24]] },
      H: { dataBytes: 36, ecPerBlock: 16, blocks: [[4, 9]] }
    }
  },
  {
    version: 5,
    size: 37,
    align: [6, 30],
    ec: {
      L: { dataBytes: 108, ecPerBlock: 26, blocks: [[1, 108]] },
      M: { dataBytes: 86, ecPerBlock: 24, blocks: [[2, 43]] },
      Q: { dataBytes: 62, ecPerBlock: 18, blocks: [[2, 15], [2, 16]] },
      H: { dataBytes: 46, ecPerBlock: 22, blocks: [[2, 11], [2, 12]] }
    }
  },
  {
    version: 6,
    size: 41,
    align: [6, 34],
    ec: {
      L: { dataBytes: 136, ecPerBlock: 18, blocks: [[2, 68]] },
      M: { dataBytes: 108, ecPerBlock: 16, blocks: [[4, 27]] },
      Q: { dataBytes: 76, ecPerBlock: 24, blocks: [[4, 19]] },
      H: { dataBytes: 60, ecPerBlock: 28, blocks: [[4, 15]] }
    }
  }
];

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
  for (let i = 255; i < 512; i += 1) {
    GF_EXP[i] = GF_EXP[i - 255];
  }
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function rsGeneratorPoly(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i += 1) {
    const next = new Array(poly.length + 1).fill(0);
    const factor = GF_EXP[i];
    for (let j = 0; j < poly.length; j += 1) {
      next[j] ^= poly[j];
      next[j + 1] ^= gfMul(poly[j], factor);
    }
    poly = next;
  }
  return poly;
}

function rsComputeEc(data, ecCount) {
  const gen = rsGeneratorPoly(ecCount);
  const rem = new Uint8Array(ecCount);
  for (let i = 0; i < data.length; i += 1) {
    const factor = data[i] ^ rem[0];
    rem.copyWithin(0, 1);
    rem[ecCount - 1] = 0;
    if (factor !== 0) {
      for (let j = 0; j < ecCount; j += 1) {
        rem[j] ^= gfMul(gen[j + 1], factor);
      }
    }
  }
  return Array.from(rem);
}

function encodeUtf8(text) {
  if (typeof TextEncoder !== "undefined") {
    return Array.from(new TextEncoder().encode(text));
  }
  const out = [];
  for (let i = 0; i < text.length; i += 1) {
    out.push(text.charCodeAt(i) & 0xff);
  }
  return out;
}

function normalizeEcLevel(level) {
  const up = String(level || "Q").toUpperCase();
  if (up === "L" || up === "M" || up === "Q" || up === "H") {
    return up;
  }
  return "Q";
}

function buildInterleavedCodewords(bytes, ecSpec) {
  const bits = [];
  const pushBits = (val, len) => {
    for (let i = len - 1; i >= 0; i -= 1) {
      bits.push((val >>> i) & 1);
    }
  };

  pushBits(0b0100, 4);
  pushBits(bytes.length, 8);
  for (const b of bytes) {
    pushBits(b, 8);
  }

  const maxBits = ecSpec.dataBytes * 8;
  const termLen = Math.min(4, maxBits - bits.length);
  pushBits(0, termLen);
  while (bits.length % 8 !== 0) {
    bits.push(0);
  }

  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j += 1) {
      byte = (byte << 1) | bits[i + j];
    }
    data.push(byte);
  }

  const padBytes = [0xec, 0x11];
  let padIdx = 0;
  while (data.length < ecSpec.dataBytes) {
    data.push(padBytes[padIdx % 2]);
    padIdx += 1;
  }

  const dataBlocks = [];
  const ecBlocks = [];
  let offset = 0;
  let maxDataLen = 0;
  for (const [count, blockDataLen] of ecSpec.blocks) {
    if (blockDataLen > maxDataLen) maxDataLen = blockDataLen;
    for (let b = 0; b < count; b += 1) {
      const slice = data.slice(offset, offset + blockDataLen);
      offset += blockDataLen;
      dataBlocks.push(slice);
      ecBlocks.push(rsComputeEc(slice, ecSpec.ecPerBlock));
    }
  }

  const out = [];
  for (let col = 0; col < maxDataLen; col += 1) {
    for (const block of dataBlocks) {
      if (col < block.length) {
        out.push(block[col]);
      }
    }
  }
  for (let col = 0; col < ecSpec.ecPerBlock; col += 1) {
    for (const ecBlock of ecBlocks) {
      out.push(ecBlock[col]);
    }
  }
  return out;
}

function computeFormatBits(ecLevel, maskIndex) {
  const ecBits = EC_INDICATOR[ecLevel] ?? EC_INDICATOR.Q;
  const data = (ecBits << 3) | (maskIndex & 0b111);
  let rem = data << 10;
  const poly = 0b10100110111;
  for (let i = 14; i >= 10; i -= 1) {
    if ((rem >>> i) & 1) {
      rem ^= poly << (i - 10);
    }
  }
  return ((data << 10) | rem) ^ 0b101010000010010;
}

function maskCondition(maskIndex, r, c) {
  switch (maskIndex) {
    case 0:
      return (r + c) % 2 === 0;
    case 1:
      return r % 2 === 0;
    case 2:
      return c % 3 === 0;
    case 3:
      return (r + c) % 3 === 0;
    case 4:
      return (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0;
    case 5:
      return ((r * c) % 2) + ((r * c) % 3) === 0;
    case 6:
      return (((r * c) % 2) + ((r * c) % 3)) % 2 === 0;
    default:
      return (((r + c) % 2) + ((r * c) % 3)) % 2 === 0;
  }
}

function scoreMatrix(modules) {
  const n = modules.length;
  let penalty = 0;

  for (let r = 0; r < n; r += 1) {
    let runColor = modules[r][0];
    let runLen = 1;
    for (let c = 1; c < n; c += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  for (let c = 0; c < n; c += 1) {
    let runColor = modules[0][c];
    let runLen = 1;
    for (let r = 1; r < n; r += 1) {
      if (modules[r][c] === runColor) {
        runLen += 1;
      } else {
        if (runLen >= 5) penalty += 3 + (runLen - 5);
        runColor = modules[r][c];
        runLen = 1;
      }
    }
    if (runLen >= 5) penalty += 3 + (runLen - 5);
  }

  for (let r = 0; r < n - 1; r += 1) {
    for (let c = 0; c < n - 1; c += 1) {
      const v = modules[r][c];
      if (v === modules[r][c + 1] && v === modules[r + 1][c] && v === modules[r + 1][c + 1]) {
        penalty += 3;
      }
    }
  }

  const matchFinderPattern = (get) => {
    let p = 0;
    for (let i = 0; i <= n - 11; i += 1) {
      const a =
        get(i) &&
        !get(i + 1) &&
        get(i + 2) &&
        get(i + 3) &&
        get(i + 4) &&
        !get(i + 5) &&
        get(i + 6) &&
        !get(i + 7) &&
        !get(i + 8) &&
        !get(i + 9) &&
        !get(i + 10);
      const b =
        !get(i) &&
        !get(i + 1) &&
        !get(i + 2) &&
        !get(i + 3) &&
        get(i + 4) &&
        !get(i + 5) &&
        get(i + 6) &&
        get(i + 7) &&
        get(i + 8) &&
        !get(i + 9) &&
        get(i + 10);
      if (a || b) p += 40;
    }
    return p;
  };
  for (let r = 0; r < n; r += 1) {
    penalty += matchFinderPattern((c) => modules[r][c]);
  }
  for (let c = 0; c < n; c += 1) {
    penalty += matchFinderPattern((r) => modules[r][c]);
  }

  let dark = 0;
  for (let r = 0; r < n; r += 1) {
    for (let c = 0; c < n; c += 1) {
      if (modules[r][c]) dark += 1;
    }
  }
  const pct = (dark * 100) / (n * n);
  const k = Math.floor(Math.abs(pct - 50) / 5);
  penalty += k * 10;

  return penalty;
}

/**
 * Encodes a string into a valid ISO/IEC 18004 QR Code boolean matrix (Versions 1..6).
 */
export function encodeQrMatrix(text, opts = "Q") {
  const ecLevel = normalizeEcLevel(typeof opts === "string" ? opts : opts?.ecLevel);
  const bytes = encodeUtf8(String(text || ""));
  const spec = VERSION_SPECS.find((v) => bytes.length <= v.ec[ecLevel].dataBytes - 2);
  if (!spec) {
    const maxCap = VERSION_SPECS[VERSION_SPECS.length - 1].ec[ecLevel].dataBytes - 2;
    throw new Error(`QR payload too long for EC ${ecLevel} (max ${maxCap} UTF-8 bytes)`);
  }

  const ecSpec = spec.ec[ecLevel];
  const n = spec.size;
  const modules = Array.from({ length: n }, () => new Array(n).fill(false));
  const isFunc = Array.from({ length: n }, () => new Array(n).fill(false));

  const setFunc = (r, c, val) => {
    if (r >= 0 && r < n && c >= 0 && c >= 0 && c < n) {
      modules[r][c] = val;
      isFunc[r][c] = true;
    }
  };

  const drawFinder = (top, left) => {
    for (let dy = -1; dy <= 7; dy += 1) {
      for (let dx = -1; dx <= 7; dx += 1) {
        const r = top + dy;
        const c = left + dx;
        if (r < 0 || r >= n || c < 0 || c >= n) continue;
        const inBorder = dy === 0 || dy === 6 || dx === 0 || dx === 6;
        const inCenter = dy >= 2 && dy <= 4 && dx >= 2 && dx <= 4;
        const inside = dy >= 0 && dy <= 6 && dx >= 0 && dx <= 6;
        setFunc(r, c, inside && (inBorder || inCenter));
      }
    }
  };
  drawFinder(0, 0);
  drawFinder(0, n - 7);
  drawFinder(n - 7, 0);

  for (const cy of spec.align) {
    for (const cx of spec.align) {
      if (isFunc[cy][cx]) continue;
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          const dist = Math.max(Math.abs(dy), Math.abs(dx));
          setFunc(cy + dy, cx + dx, dist !== 1);
        }
      }
    }
  }

  for (let i = 8; i < n - 8; i += 1) {
    if (!isFunc[6][i]) setFunc(6, i, i % 2 === 0);
    if (!isFunc[i][6]) setFunc(i, 6, i % 2 === 0);
  }

  for (let i = 0; i <= 8; i += 1) {
    if (!isFunc[8][i]) setFunc(8, i, false);
    if (!isFunc[i][8]) setFunc(i, 8, false);
  }
  for (let i = 0; i < 8; i += 1) {
    setFunc(8, n - 1 - i, false);
    setFunc(n - 1 - i, 8, false);
  }
  setFunc(n - 8, 8, true);

  const codewords = buildInterleavedCodewords(bytes, ecSpec);
  let bitIdx = 0;
  const totalBits = codewords.length * 8;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert += 1) {
      const upward = ((right + 1) & 2) === 0;
      const r = upward ? n - 1 - vert : vert;
      for (let j = 0; j < 2; j += 1) {
        const c = right - j;
        if (isFunc[r][c]) continue;
        let bit = false;
        if (bitIdx < totalBits) {
          const byteVal = codewords[bitIdx >>> 3];
          bit = Boolean((byteVal >>> (7 - (bitIdx & 7))) & 1);
          bitIdx += 1;
        }
        modules[r][c] = bit;
      }
    }
  }

  const applyFormat = (mat, maskIndex) => {
    const bits = computeFormatBits(ecLevel, maskIndex);
    for (let i = 0; i <= 5; i += 1) mat[i][8] = Boolean((bits >>> i) & 1);
    mat[7][8] = Boolean((bits >>> 6) & 1);
    mat[8][8] = Boolean((bits >>> 7) & 1);
    mat[8][7] = Boolean((bits >>> 8) & 1);
    for (let i = 9; i < 15; i += 1) mat[8][14 - i] = Boolean((bits >>> i) & 1);

    for (let i = 0; i < 8; i += 1) mat[8][n - 1 - i] = Boolean((bits >>> i) & 1);
    for (let i = 8; i < 15; i += 1) mat[n - 15 + i][8] = Boolean((bits >>> i) & 1);
    mat[n - 8][8] = true;
  };

  let bestMask = 0;
  let bestScore = Infinity;
  let bestMat = null;

  for (let m = 0; m < 8; m += 1) {
    const cand = modules.map((row, r) =>
      row.map((val, c) => (!isFunc[r][c] && maskCondition(m, r, c) ? !val : val))
    );
    applyFormat(cand, m);
    const sc = scoreMatrix(cand);
    if (sc < bestScore) {
      bestScore = sc;
      bestMask = m;
      bestMat = cand;
    }
  }

  return { version: spec.version, size: n, ecLevel, mask: bestMask, modules: bestMat };
}

/**
 * Renders a crisp, offline SVG QR Code string.
 */
export function renderQrSvg(
  text,
  { sizePx = 160, fg = "#111318", bg = "#FFFFFF", quietZone = 4, ecLevel = "Q" } = {}
) {
  const { size, modules, ecLevel: usedEc } = encodeQrMatrix(text, ecLevel);
  const total = size + quietZone * 2;
  const rects = [];

  for (let r = 0; r < size; r += 1) {
    for (let c = 0; c < size; c += 1) {
      if (modules[r][c]) {
        rects.push(`M${c + quietZone},${r + quietZone}h1v1h-1z`);
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}" width="${sizePx}" height="${sizePx}" role="img" aria-label="QR Code (EC ${usedEc})" data-ec-level="${usedEc}" shape-rendering="crispEdges"><rect width="${total}" height="${total}" fill="${bg}" rx="1.5"/><path d="${rects.join("")}" fill="${fg}"/></svg>`;
}
