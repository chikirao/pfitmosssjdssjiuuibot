// Шифрование токенов ИТМО: AES-256-GCM, случайный 96-битный IV на каждое шифрование,
// AAD привязывает шифротекст к пользователю и типу токена — чужой/подменённый блоб не расшифруется.

const enc = new TextEncoder();
const dec = new TextDecoder();

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

export function b64decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

function aesKey(secretB64: string): Promise<CryptoKey> {
  let k = keyCache.get(secretB64);
  if (!k) {
    const raw = b64decode(secretB64);
    if (raw.length !== 32) throw new Error("TOKEN_ENC_KEY должен быть 32 байта в base64");
    k = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    keyCache.set(secretB64, k);
  }
  return k;
}

export async function encryptString(secretB64: string, plaintext: string, aad: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: enc.encode(aad) },
    await aesKey(secretB64),
    enc.encode(plaintext),
  );
  const out = new Uint8Array(iv.length + ct.byteLength);
  out.set(iv);
  out.set(new Uint8Array(ct), iv.length);
  return b64encode(out);
}

export async function decryptString(secretB64: string, blob: string, aad: string): Promise<string> {
  const data = b64decode(blob);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: data.slice(0, 12), additionalData: enc.encode(aad) },
    await aesKey(secretB64),
    data.slice(12),
  );
  return dec.decode(pt);
}

export async function hmacSha256(key: Uint8Array | string, data: string): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    typeof key === "string" ? enc.encode(key) : key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, enc.encode(data)));
}

export const toHex = (b: Uint8Array) => [...b].map((x) => x.toString(16).padStart(2, "0")).join("");

/** Сравнение без утечки по времени (длины у нас фиксированные — hex SHA-256 / секреты). */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
