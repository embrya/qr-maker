/* Offline QR encoder for byte-mode payloads. No network dependencies. */
(function (global) {
  "use strict";

  const ECC_CODEWORDS_PER_BLOCK = {
    L: [0, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    M: [0, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    Q: [0, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    H: [0, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  };

  const NUM_ERROR_CORRECTION_BLOCKS = {
    L: [0, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    M: [0, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    Q: [0, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    H: [0, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
  };

  const FORMAT_BITS = { L: 1, M: 0, Q: 3, H: 2 };

  function encodeText(text, options) {
    return encodeBytes(new TextEncoder().encode(text), options);
  }

  function encodeBytes(data, options) {
    const opts = Object.assign({ ecl: "M", minVersion: 1, maxVersion: 40, mask: -1 }, options || {});
    const ecl = String(opts.ecl || "M").toUpperCase();
    if (!ECC_CODEWORDS_PER_BLOCK[ecl]) throw new Error("Unknown QR error correction level: " + ecl);
    if (data.length > 65535) throw new Error("Single QR payload is too large");

    let version = -1;
    let dataCapacity = 0;
    for (let v = opts.minVersion; v <= opts.maxVersion; v += 1) {
      dataCapacity = getNumDataCodewords(v, ecl);
      const charCountBits = v <= 9 ? 8 : 16;
      const usedBits = 4 + charCountBits + data.length * 8;
      if (usedBits <= dataCapacity * 8) {
        version = v;
        break;
      }
    }
    if (version < 0) {
      throw new Error("Payload does not fit in a QR code at ECC " + ecl + ". Reduce chunk size.");
    }

    const bits = [];
    appendBits(0x4, 4, bits);
    appendBits(data.length, version <= 9 ? 8 : 16, bits);
    for (const byte of data) appendBits(byte, 8, bits);

    const capacityBits = getNumDataCodewords(version, ecl) * 8;
    appendBits(0, Math.min(4, capacityBits - bits.length), bits);
    while (bits.length % 8 !== 0) bits.push(0);

    const dataCodewords = [];
    for (let i = 0; i < bits.length; i += 8) {
      let byte = 0;
      for (let j = 0; j < 8; j += 1) byte = (byte << 1) | bits[i + j];
      dataCodewords.push(byte);
    }
    for (let pad = 0xec; dataCodewords.length < getNumDataCodewords(version, ecl); pad ^= 0xec ^ 0x11) {
      dataCodewords.push(pad);
    }

    const codewords = addEccAndInterleave(dataCodewords, version, ecl);
    return makeMatrix(version, ecl, codewords, opts.mask);
  }

  function appendBits(value, length, bits) {
    if (length < 0 || length > 31 || value >>> length !== 0) throw new RangeError("Invalid bit append");
    for (let i = length - 1; i >= 0; i -= 1) bits.push((value >>> i) & 1);
  }

  function getNumDataCodewords(version, ecl) {
    return Math.floor(getNumRawDataModules(version) / 8) -
      ECC_CODEWORDS_PER_BLOCK[ecl][version] * NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
  }

  function getNumRawDataModules(version) {
    if (version < 1 || version > 40) throw new RangeError("QR version out of range");
    let result = (16 * version + 128) * version + 64;
    if (version >= 2) {
      const numAlign = Math.floor(version / 7) + 2;
      result -= (25 * numAlign - 10) * numAlign - 55;
      if (version >= 7) result -= 36;
    }
    return result;
  }

  function addEccAndInterleave(data, version, ecl) {
    const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl][version];
    const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl][version];
    const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
    const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
    const shortBlockLen = Math.floor(rawCodewords / numBlocks);
    const shortDataLen = shortBlockLen - blockEccLen;
    const rsDivisor = reedSolomonComputeDivisor(blockEccLen);
    const blocks = [];

    for (let i = 0, k = 0; i < numBlocks; i += 1) {
      const dataLen = shortDataLen + (i < numShortBlocks ? 0 : 1);
      const dataBlock = data.slice(k, k + dataLen);
      k += dataLen;
      const eccBlock = reedSolomonComputeRemainder(dataBlock, rsDivisor);
      const block = dataBlock.slice();
      if (i < numShortBlocks) block.push(0);
      blocks.push(block.concat(eccBlock));
    }

    const result = [];
    for (let i = 0; i < blocks[0].length; i += 1) {
      for (let j = 0; j < blocks.length; j += 1) {
        if (i !== shortDataLen || j >= numShortBlocks) result.push(blocks[j][i]);
      }
    }
    if (result.length !== rawCodewords) throw new Error("QR interleave failed");
    return result;
  }

  function reedSolomonComputeDivisor(degree) {
    const result = new Array(degree).fill(0);
    result[degree - 1] = 1;
    let root = 1;
    for (let i = 0; i < degree; i += 1) {
      for (let j = 0; j < result.length; j += 1) {
        result[j] = reedSolomonMultiply(result[j], root);
        if (j + 1 < result.length) result[j] ^= result[j + 1];
      }
      root = reedSolomonMultiply(root, 0x02);
    }
    return result;
  }

  function reedSolomonComputeRemainder(data, divisor) {
    const result = new Array(divisor.length).fill(0);
    for (const byte of data) {
      const factor = byte ^ result.shift();
      result.push(0);
      for (let i = 0; i < result.length; i += 1) {
        result[i] ^= reedSolomonMultiply(divisor[i], factor);
      }
    }
    return result;
  }

  function reedSolomonMultiply(x, y) {
    if (x >>> 8 !== 0 || y >>> 8 !== 0) throw new RangeError("GF value out of range");
    let z = 0;
    for (let i = 7; i >= 0; i -= 1) {
      z = ((z << 1) ^ (((z >>> 7) & 1) * 0x11d)) & 0xff;
      if (((y >>> i) & 1) !== 0) z ^= x;
    }
    return z;
  }

  function makeMatrix(version, ecl, codewords, mask) {
    const size = version * 4 + 17;
    let modules = make2d(size, false);
    const isFunction = make2d(size, false);

    const setFunction = (x, y, dark) => {
      if (x < 0 || y < 0 || x >= size || y >= size) return;
      modules[y][x] = Boolean(dark);
      isFunction[y][x] = true;
    };

    const drawFinder = (cx, cy) => {
      for (let dy = -4; dy <= 4; dy += 1) {
        for (let dx = -4; dx <= 4; dx += 1) {
          const dist = Math.max(Math.abs(dx), Math.abs(dy));
          setFunction(cx + dx, cy + dy, dist !== 2 && dist !== 4);
        }
      }
    };

    const drawAlignment = (cx, cy) => {
      for (let dy = -2; dy <= 2; dy += 1) {
        for (let dx = -2; dx <= 2; dx += 1) {
          setFunction(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
        }
      }
    };

    drawFinder(3, 3);
    drawFinder(size - 4, 3);
    drawFinder(3, size - 4);

    for (let i = 0; i < size; i += 1) {
      if (!isFunction[i][6]) setFunction(6, i, i % 2 === 0);
      if (!isFunction[6][i]) setFunction(i, 6, i % 2 === 0);
    }

    const align = getAlignmentPatternPositions(version);
    for (const y of align) {
      for (const x of align) {
        if (!isFunction[y][x]) drawAlignment(x, y);
      }
    }

    drawFormatBits(0);
    drawVersionBits();
    drawCodewords(codewords);

    const baseModules = modules.map((row) => row.slice());
    let bestMask = 0;
    let bestScore = Infinity;
    let bestModules = null;
    const maskStart = mask >= 0 ? mask : 0;
    const maskEnd = mask >= 0 ? mask : 7;
    for (let m = maskStart; m <= maskEnd; m += 1) {
      modules = baseModules.map((row) => row.slice());
      applyMask(m);
      drawFormatBits(m);
      const score = getPenaltyScore(modules);
      if (score < bestScore) {
        bestScore = score;
        bestMask = m;
        bestModules = modules.map((row) => row.slice());
      }
    }

    return { version, size, ecl, mask: bestMask, modules: bestModules };

    function drawCodewords(bytes) {
      let bitIndex = 0;
      for (let right = size - 1; right >= 1; right -= 2) {
        if (right === 6) right = 5;
        for (let vert = 0; vert < size; vert += 1) {
          for (let j = 0; j < 2; j += 1) {
            const x = right - j;
            const upward = ((right + 1) & 2) === 0;
            const y = upward ? size - 1 - vert : vert;
            if (!isFunction[y][x] && bitIndex < bytes.length * 8) {
              modules[y][x] = ((bytes[bitIndex >>> 3] >>> (7 - (bitIndex & 7))) & 1) !== 0;
              bitIndex += 1;
            }
          }
        }
      }
    }

    function applyMask(m) {
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size; x += 1) {
          if (!isFunction[y][x] && getMaskBit(m, x, y)) modules[y][x] = !modules[y][x];
        }
      }
    }

    function drawFormatBits(m) {
      const data = (FORMAT_BITS[ecl] << 3) | m;
      let rem = data;
      for (let i = 0; i < 10; i += 1) rem = (rem << 1) ^ (((rem >>> 9) & 1) * 0x537);
      const bits = ((data << 10) | rem) ^ 0x5412;

      for (let i = 0; i <= 5; i += 1) setFunction(8, i, getBit(bits, i));
      setFunction(8, 7, getBit(bits, 6));
      setFunction(8, 8, getBit(bits, 7));
      setFunction(7, 8, getBit(bits, 8));
      for (let i = 9; i < 15; i += 1) setFunction(14 - i, 8, getBit(bits, i));
      for (let i = 0; i < 8; i += 1) setFunction(size - 1 - i, 8, getBit(bits, i));
      for (let i = 8; i < 15; i += 1) setFunction(8, size - 15 + i, getBit(bits, i));
      setFunction(8, size - 8, true);
    }

    function drawVersionBits() {
      if (version < 7) return;
      let rem = version;
      for (let i = 0; i < 12; i += 1) rem = (rem << 1) ^ (((rem >>> 11) & 1) * 0x1f25);
      const bits = (version << 12) | rem;
      for (let i = 0; i < 18; i += 1) {
        const bit = getBit(bits, i);
        const a = size - 11 + (i % 3);
        const b = Math.floor(i / 3);
        setFunction(a, b, bit);
        setFunction(b, a, bit);
      }
    }
  }

  function make2d(size, value) {
    return Array.from({ length: size }, () => new Array(size).fill(value));
  }

  function getAlignmentPatternPositions(version) {
    if (version === 1) return [];
    const size = version * 4 + 17;
    const numAlign = Math.floor(version / 7) + 2;
    const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
    const result = [6];
    for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
    return result;
  }

  function getBit(value, index) {
    return ((value >>> index) & 1) !== 0;
  }

  function getMaskBit(mask, x, y) {
    switch (mask) {
      case 0: return (x + y) % 2 === 0;
      case 1: return y % 2 === 0;
      case 2: return x % 3 === 0;
      case 3: return (x + y) % 3 === 0;
      case 4: return (Math.floor(y / 2) + Math.floor(x / 3)) % 2 === 0;
      case 5: return ((x * y) % 2 + (x * y) % 3) === 0;
      case 6: return (((x * y) % 2 + (x * y) % 3) % 2) === 0;
      case 7: return (((x + y) % 2 + (x * y) % 3) % 2) === 0;
      default: throw new RangeError("QR mask out of range");
    }
  }

  function getPenaltyScore(modules) {
    const size = modules.length;
    let result = 0;

    for (let y = 0; y < size; y += 1) {
      let runColor = modules[y][0];
      let runLen = 1;
      for (let x = 1; x < size; x += 1) {
        if (modules[y][x] === runColor) {
          runLen += 1;
          if (runLen === 5) result += 3;
          else if (runLen > 5) result += 1;
        } else {
          runColor = modules[y][x];
          runLen = 1;
        }
      }
    }

    for (let x = 0; x < size; x += 1) {
      let runColor = modules[0][x];
      let runLen = 1;
      for (let y = 1; y < size; y += 1) {
        if (modules[y][x] === runColor) {
          runLen += 1;
          if (runLen === 5) result += 3;
          else if (runLen > 5) result += 1;
        } else {
          runColor = modules[y][x];
          runLen = 1;
        }
      }
    }

    for (let y = 0; y < size - 1; y += 1) {
      for (let x = 0; x < size - 1; x += 1) {
        const color = modules[y][x];
        if (color === modules[y][x + 1] && color === modules[y + 1][x] && color === modules[y + 1][x + 1]) result += 3;
      }
    }

    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x <= size - 11; x += 1) {
        if (matchesFinderPenalty(modules[y], x)) result += 40;
      }
    }
    for (let x = 0; x < size; x += 1) {
      const column = [];
      for (let y = 0; y < size; y += 1) column.push(modules[y][x]);
      for (let y = 0; y <= size - 11; y += 1) {
        if (matchesFinderPenalty(column, y)) result += 40;
      }
    }

    let dark = 0;
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) if (modules[y][x]) dark += 1;
    }
    const total = size * size;
    result += Math.floor(Math.abs(dark * 20 - total * 10) / total) * 10;
    return result;
  }

  function matchesFinderPenalty(line, i) {
    const p1 = [true, false, true, true, true, false, true, false, false, false, false];
    const p2 = [false, false, false, false, true, false, true, true, true, false, true];
    for (let j = 0; j < 11; j += 1) {
      if (line[i + j] !== p1[j]) break;
      if (j === 10) return true;
    }
    for (let j = 0; j < 11; j += 1) {
      if (line[i + j] !== p2[j]) return false;
    }
    return true;
  }

  function drawToCanvas(canvas, qr, options) {
    const opts = Object.assign({ targetSize: 820, quiet: 4, dark: "#111827", light: "#ffffff" }, options || {});
    const moduleCount = qr.size + opts.quiet * 2;
    const modulePx = Math.max(2, Math.floor(opts.targetSize / moduleCount));
    const canvasSize = moduleCount * modulePx;
    canvas.width = canvasSize;
    canvas.height = canvasSize;
    const ctx = canvas.getContext("2d");
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = opts.light;
    ctx.fillRect(0, 0, canvasSize, canvasSize);
    ctx.fillStyle = opts.dark;
    for (let y = 0; y < qr.size; y += 1) {
      for (let x = 0; x < qr.size; x += 1) {
        if (qr.modules[y][x]) {
          ctx.fillRect((x + opts.quiet) * modulePx, (y + opts.quiet) * modulePx, modulePx, modulePx);
        }
      }
    }
    return { modulePx, canvasSize };
  }

  const api = { encodeText, encodeBytes, drawToCanvas };
  global.AirgapQR = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : window);
