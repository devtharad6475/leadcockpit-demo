/**
 * Password hashing using Node's built-in scrypt.
 *
 * Why scrypt (no external dependency)?
 *  - It is memory-hard, so it resists GPU/ASIC brute-force attacks far better
 *    than bcrypt at equivalent cost, and it ships with Node core (no new deps).
 *  - We store hashes in the format:  scrypt:N:param: saltHex:hashHex
 *    where N = cpu/memory cost, param = derived key length in bytes.
 *
 * This module is intentionally small and dependency-free so the security
 * boundary is easy to audit.
 */
import { NeedsActionError } from "@/lib/user-errors";
import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  // Node's scrypt options type omits `maxmem` in some @types/node versions, but
  // the runtime accepts it (it sets the memory ceiling, required for N >= 2^15).
  options?: { N?: number; r?: number; p?: number; maxmem?: number },
) => Promise<Buffer>;

// Cost parameters. N must be a power of 2. N=2^15 (32768) is a reasonable
// balance between ~150ms verify time and resistance to offline brute force.
const SCRYPT_N = 2 ** 15;
const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;
// scrypt needs a memory ceiling. For N=2^15 the working set is ~128MB; we set
// maxmem high enough to avoid the "memory limit exceeded" error while still
// bounding worst-case allocation. r and p are the OpenBSD-recommended defaults.
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_MAXMEM = 256 * 1024 * 1024; // 256 MB ceiling
const ALGORITHM_TAG = "scrypt";

// A password the person chose that cannot be used is their mistake to fix, not
// a server fault: shown as written with a 400 (2026-09-27).
export class PasswordError extends NeedsActionError {
  constructor(message: string) {
    super(message, 400);
    this.name = "PasswordError";
  }
}

function encodeHash(salt: Buffer, derived: Buffer): string {
  return `${ALGORITHM_TAG}:${SCRYPT_N}:${SCRYPT_KEYLEN}:${salt.toString("hex")}:${derived.toString("hex")}`;
}

/** Hash a plaintext password into a storable, salted scrypt hash. */
export async function hashPassword(password: string): Promise<string> {
  if (!password || password.length < 8) {
    throw new PasswordError("Password must be at least 8 characters long.");
  }
  if (password.length > 1024) {
    throw new PasswordError("Password is too long.");
  }
  // 2026-09-27 (CEO): a password may contain spaces, but not be only spaces.
  if (!password.trim()) {
    throw new PasswordError("A password can't be only spaces.");
  }
  const salt = randomBytes(SALT_BYTES);
  const derived = await scrypt(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  return encodeHash(salt, derived);
}

/**
 * Verify a plaintext password against a stored hash.
 * Returns false on any mismatch or malformed hash — never throws for a bad
 * password (only for a malformed stored hash, which is a server bug).
 *
 * Uses timingSafeEqual so an attacker cannot learn anything from how long the
 * comparison takes.
 */
let checksPerformed = 0;
/**
 * 2026-09-28 (S8) — how many password checks this process has run. Lets a
 * golden prove sign-in does the same number of checks however many companies
 * an email belongs to (the timing must not tell a stranger).
 */
export function passwordChecksPerformed(): number {
  return checksPerformed;
}

export async function verifyPassword(password: string, stored: string | undefined | null): Promise<boolean> {
  checksPerformed++;
  if (!password || !stored) return false;
  const parts = stored.split(":");
  if (parts.length !== 5 || parts[0] !== ALGORITHM_TAG) return false;
  const N = Number(parts[1]);
  const keylen = Number(parts[2]);
  const saltHex = parts[3];
  const expectedHex = parts[4];
  if (!Number.isFinite(N) || N < 1 || !Number.isFinite(keylen) || keylen < 16) return false;
  // Decode salt + expected hash from hex back to Buffers. At hash time the salt
  // is a Buffer; we must pass the same Buffer bytes at verify time, otherwise
  // scrypt treats the hex string as literal UTF-8 characters and derives a
  // different (wrong) key.
  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(saltHex, "hex");
    expected = Buffer.from(expectedHex, "hex");
  } catch {
    return false;
  }
  if (expected.length !== keylen) return false;
  let derived: Buffer;
  try {
    // Use the same cost parameters used at hash time. r/p/maxmem are fixed
    // constants (not stored per-hash) because we control all hash creation.
    derived = await scrypt(password, salt, keylen, { N, r: SCRYPT_R, p: SCRYPT_P, maxmem: SCRYPT_MAXMEM });
  } catch {
    return false;
  }
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}
