import crypto from "node:crypto";

const CROCKFORD32 = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

function encodeCrockfordBase32(bytes) {
  let bits = 0;
  let value = 0;
  let output = "";

  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      output += CROCKFORD32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }

  if (bits > 0) {
    output += CROCKFORD32[(value << (5 - bits)) & 31];
  }

  return output;
}

function encodeTime48(timestampMs) {
  const timeBytes = Buffer.alloc(6);
  let value = BigInt(timestampMs);
  for (let index = 5; index >= 0; index -= 1) {
    timeBytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  return encodeCrockfordBase32(timeBytes).padStart(10, "0").slice(0, 10);
}

function encodeRandom80() {
  const randomBytes = crypto.randomBytes(10);
  return encodeCrockfordBase32(randomBytes).padStart(16, "0").slice(0, 16);
}

export function ulid(timestampMs = Date.now()) {
  return encodeTime48(timestampMs) + encodeRandom80();
}

