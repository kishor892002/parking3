/* Minimal QR Code generator (no dependencies).
 * Byte mode, error-correction level M, versions 1-10 (up to ~150 characters).
 * Used to build a UPI payment QR with the amount already filled in.
 *
 *   const qr  = QRCode.encode('upi://pay?...');   // { size, modules, version, mask }
 *   const svg = QRCode.toSvg(qr);                 // SVG string
 */
(function (root) {
  'use strict';

  const MAX_VERSION = 10;
  const ECC_PER_BLOCK = [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26]; // level M
  const NUM_BLOCKS    = [-1,  1,  1,  1,  2,  2,  4,  4,  4,  5,  5]; // level M
  const FORMAT_ECL_M = 0;

  const bit = (x, i) => ((x >>> i) & 1) !== 0;

  function rawModules(ver) {
    let result = (16 * ver + 128) * ver + 64;
    if (ver >= 2) {
      const n = Math.floor(ver / 7) + 2;
      result -= (25 * n - 10) * n - 55;
      if (ver >= 7) result -= 36;
    }
    return result;
  }

  const dataCodewords = ver =>
    Math.floor(rawModules(ver) / 8) - ECC_PER_BLOCK[ver] * NUM_BLOCKS[ver];

  /* ----- Reed-Solomon over GF(256) ----- */
  function gfMul(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
      z = (z << 1) ^ ((z >>> 7) * 0x11D);
      z ^= ((y >>> i) & 1) * x;
    }
    return z;
  }

  function rsDivisor(degree) {
    const result = new Array(degree - 1).fill(0);
    result.push(1);
    let root = 1;
    for (let i = 0; i < degree; i++) {
      for (let j = 0; j < result.length; j++) {
        result[j] = gfMul(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = gfMul(root, 2);
    }
    return result;
  }

  function rsRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    data.forEach(b => {
      const factor = b ^ result.shift();
      result.push(0);
      divisor.forEach((coef, i) => { result[i] ^= gfMul(coef, factor); });
    });
    return result;
  }

  function addEccAndInterleave(data, ver) {
    const numBlocks = NUM_BLOCKS[ver];
    const eccLen = ECC_PER_BLOCK[ver];
    const rawCodewords = Math.floor(rawModules(ver) / 8);
    const numShort = numBlocks - (rawCodewords % numBlocks);
    const shortLen = Math.floor(rawCodewords / numBlocks);

    const blocks = [];
    const divisor = rsDivisor(eccLen);
    for (let i = 0, k = 0; i < numBlocks; i++) {
      const dat = data.slice(k, k + shortLen - eccLen + (i < numShort ? 0 : 1));
      k += dat.length;
      const ecc = rsRemainder(dat, divisor);
      if (i < numShort) dat.push(0);
      blocks.push(dat.concat(ecc));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i++) {
      blocks.forEach((block, j) => {
        if (i !== shortLen - eccLen || j >= numShort) result.push(block[i]);
      });
    }
    return result;
  }

  /* ----- Matrix construction ----- */
  function alignmentPositions(ver) {
    if (ver === 1) return [];
    const n = Math.floor(ver / 7) + 2;
    const step = Math.ceil((ver * 4 + 4) / (n * 2 - 2)) * 2;
    const size = ver * 4 + 17;
    const result = [6];
    for (let pos = size - 7; result.length < n; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function encode(text, forceMask) {
    const bytes = Array.from(new TextEncoder().encode(text));

    let ver = 1;
    for (; ver <= MAX_VERSION; ver++) {
      const need = 4 + (ver <= 9 ? 8 : 16) + bytes.length * 8;
      if (need <= dataCodewords(ver) * 8) break;
    }
    if (ver > MAX_VERSION) throw new Error('Text is too long for this QR generator');

    // Data bits
    const bits = [];
    const put = (val, len) => { for (let i = len - 1; i >= 0; i--) bits.push((val >>> i) & 1); };
    const capBits = dataCodewords(ver) * 8;
    put(4, 4);                                  // byte mode
    put(bytes.length, ver <= 9 ? 8 : 16);
    bytes.forEach(b => put(b, 8));
    put(0, Math.min(4, capBits - bits.length)); // terminator
    put(0, (8 - (bits.length % 8)) % 8);
    for (let pad = 0xEC; bits.length < capBits; pad ^= 0xEC ^ 0x11) put(pad, 8);

    const data = [];
    for (let i = 0; i < bits.length; i += 8) {
      let v = 0;
      for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j];
      data.push(v);
    }
    const codewords = addEccAndInterleave(data, ver);

    // Grid
    const size = ver * 4 + 17;
    const modules = Array.from({ length: size }, () => new Array(size).fill(false));
    const isFn = Array.from({ length: size }, () => new Array(size).fill(false));
    const setFn = (x, y, dark) => { modules[y][x] = dark; isFn[y][x] = true; };

    // Timing patterns
    for (let i = 0; i < size; i++) { setFn(6, i, i % 2 === 0); setFn(i, 6, i % 2 === 0); }

    // Finder patterns (with separators)
    const finder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy++) {
        for (let dx = -4; dx <= 4; dx++) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          const x = cx + dx, y = cy + dy;
          if (x >= 0 && x < size && y >= 0 && y < size) setFn(x, y, dist !== 2 && dist !== 4);
        }
      }
    };
    finder(3, 3); finder(size - 4, 3); finder(3, size - 4);

    // Alignment patterns
    const pos = alignmentPositions(ver);
    const last = pos.length - 1;
    pos.forEach((px, i) => pos.forEach((py, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) setFn(px + dx, py + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }));

    // Format bits
    const drawFormat = mask => {
      const d = (FORMAT_ECL_M << 3) | mask;
      let rem = d;
      for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
      const bitsF = ((d << 10) | rem) ^ 0x5412;
      for (let i = 0; i <= 5; i++) setFn(8, i, bit(bitsF, i));
      setFn(8, 7, bit(bitsF, 6));
      setFn(8, 8, bit(bitsF, 7));
      setFn(7, 8, bit(bitsF, 8));
      for (let i = 9; i < 15; i++) setFn(14 - i, 8, bit(bitsF, i));
      for (let i = 0; i < 8; i++) setFn(size - 1 - i, 8, bit(bitsF, i));
      for (let i = 8; i < 15; i++) setFn(8, size - 15 + i, bit(bitsF, i));
      setFn(8, size - 8, true);
    };
    drawFormat(0); // reserve the area

    // Version info
    if (ver >= 7) {
      let rem = ver;
      for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
      const v = (ver << 12) | rem;
      for (let i = 0; i < 18; i++) {
        const a = size - 11 + (i % 3), b = Math.floor(i / 3);
        setFn(a, b, bit(v, i));
        setFn(b, a, bit(v, i));
      }
    }

    // Place data (zig-zag)
    let k = 0;
    for (let right = size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5;
      for (let vert = 0; vert < size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? size - 1 - vert : vert;
          if (!isFn[y][x] && k < codewords.length * 8) {
            modules[y][x] = bit(codewords[k >>> 3], 7 - (k & 7));
            k++;
          }
        }
      }
    }

    const MASKS = [
      (x, y) => (x + y) % 2 === 0,
      (x, y) => y % 2 === 0,
      (x, y) => x % 3 === 0,
      (x, y) => (x + y) % 3 === 0,
      (x, y) => (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0,
      (x, y) => ((x * y) % 2) + ((x * y) % 3) === 0,
      (x, y) => (((x * y) % 2) + ((x * y) % 3)) % 2 === 0,
      (x, y) => (((x + y) % 2) + ((x * y) % 3)) % 2 === 0
    ];
    const applyMask = m => {
      for (let y = 0; y < size; y++) {
        for (let x = 0; x < size; x++) if (!isFn[y][x] && MASKS[m](x, y)) modules[y][x] = !modules[y][x];
      }
    };

    const penalty = () => {
      let score = 0;
      const lines = [];
      for (let y = 0; y < size; y++) lines.push(modules[y].map(Number));
      for (let x = 0; x < size; x++) lines.push(modules.map(row => Number(row[x])));

      lines.forEach(line => {
        // Rule 1: runs of 5+ same-coloured modules
        let run = 1;
        for (let i = 1; i <= size; i++) {
          if (i < size && line[i] === line[i - 1]) run++;
          else { if (run >= 5) score += 3 + (run - 5); run = 1; }
        }
        // Rule 3: finder-like patterns
        const s = line.join('');
        score += 40 * ((s.match(/(?=00001011101)/g) || []).length + (s.match(/(?=10111010000)/g) || []).length);
      });

      // Rule 2: 2x2 blocks
      for (let y = 0; y < size - 1; y++) {
        for (let x = 0; x < size - 1; x++) {
          const c = modules[y][x];
          if (c === modules[y][x + 1] && c === modules[y + 1][x] && c === modules[y + 1][x + 1]) score += 3;
        }
      }

      // Rule 4: dark/light balance
      let dark = 0;
      modules.forEach(row => row.forEach(c => { if (c) dark++; }));
      const total = size * size;
      score += (Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1) * 10;
      return score;
    };

    let mask = forceMask;
    if (mask === undefined) {
      let best = Infinity;
      for (let m = 0; m < 8; m++) {
        applyMask(m); drawFormat(m);
        const p = penalty();
        if (p < best) { best = p; mask = m; }
        applyMask(m); // undo
      }
    }
    applyMask(mask);
    drawFormat(mask);

    return { size, modules, version: ver, mask };
  }

  function toSvg(qr, border) {
    const b = border === undefined ? 4 : border;
    const dim = qr.size + b * 2;
    let d = '';
    qr.modules.forEach((row, y) => row.forEach((dark, x) => {
      if (dark) d += `M${x + b},${y + b}h1v1h-1z`;
    }));
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" shape-rendering="crispEdges" role="img" aria-label="Payment QR code">` +
           `<rect width="${dim}" height="${dim}" fill="#fff"/><path d="${d}" fill="#000"/></svg>`;
  }

  const api = { encode, toSvg };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.QRCode = api;
})(typeof window !== 'undefined' ? window : globalThis);
