const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64Url(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/u, "");
}

export function base64UrlToBytes(value) {
  const normalized = String(value).replaceAll("-", "+").replaceAll("_", "/");
  const padded = normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function randomToken(byteLength = 12) {
  const bytes = new Uint8Array(byteLength);
  globalThis.crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function createRoomCredentials() {
  const roomKey = new Uint8Array(32);
  globalThis.crypto.getRandomValues(roomKey);
  const signingKeys = await globalThis.crypto.subtle.generateKey(
    { name: "ECDSA", namedCurve: "P-256" },
    true,
    ["sign", "verify"],
  );
  const [privateJwk, publicRaw] = await Promise.all([
    globalThis.crypto.subtle.exportKey("jwk", signingKeys.privateKey),
    globalThis.crypto.subtle.exportKey("raw", signingKeys.publicKey),
  ]);

  return {
    roomId: randomToken(15),
    roomKey: bytesToBase64Url(roomKey),
    signingPrivateJwk: privateJwk,
    signingPublicKey: bytesToBase64Url(new Uint8Array(publicRaw)),
  };
}

export async function importRoomKey(encodedKey) {
  const raw = base64UrlToBytes(encodedKey);
  if (raw.byteLength !== 32) throw new Error("올바르지 않은 방 열쇠입니다.");
  return globalThis.crypto.subtle.importKey("raw", raw, "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

export async function importSigningPrivateKey(jwk) {
  return globalThis.crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
}

export async function importSigningPublicKey(encodedKey) {
  const raw = base64UrlToBytes(encodedKey);
  if (raw.byteLength !== 65) throw new Error("올바르지 않은 확인 열쇠입니다.");
  return globalThis.crypto.subtle.importKey(
    "raw",
    raw,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["verify"],
  );
}

function canonicalPayload(payload) {
  return JSON.stringify(payload);
}

export async function signPayload(payload, privateKey) {
  const signature = await globalThis.crypto.subtle.sign(
    { name: "ECDSA", hash: "SHA-256" },
    privateKey,
    encoder.encode(canonicalPayload(payload)),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyPayload(payload, signature, publicKey) {
  try {
    return await globalThis.crypto.subtle.verify(
      { name: "ECDSA", hash: "SHA-256" },
      publicKey,
      base64UrlToBytes(signature),
      encoder.encode(canonicalPayload(payload)),
    );
  } catch {
    return false;
  }
}

export async function sealMessage(value, roomKey, roomId) {
  const iv = new Uint8Array(12);
  globalThis.crypto.getRandomValues(iv);
  const encrypted = await globalThis.crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv,
      additionalData: encoder.encode(`joy-room:${roomId}`),
    },
    roomKey,
    encoder.encode(JSON.stringify(value)),
  );
  return `j1.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}

export async function openMessage(envelope, roomKey, roomId) {
  const [version, ivPart, messagePart] = String(envelope).split(".");
  if (version !== "j1" || !ivPart || !messagePart) {
    throw new Error("지원하지 않는 메시지 형식입니다.");
  }
  const decrypted = await globalThis.crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: base64UrlToBytes(ivPart),
      additionalData: encoder.encode(`joy-room:${roomId}`),
    },
    roomKey,
    base64UrlToBytes(messagePart),
  );
  return JSON.parse(decoder.decode(decrypted));
}

export function createJoinHash(credentials) {
  const params = new URLSearchParams({
    join: credentials.roomId,
    key: credentials.roomKey,
    verify: credentials.signingPublicKey,
  });
  return `#${params.toString()}`;
}

export function parseJoinHash(hash = globalThis.location?.hash ?? "") {
  const params = new URLSearchParams(String(hash).replace(/^#/u, ""));
  const roomId = params.get("join") ?? "";
  const roomKey = params.get("key") ?? "";
  const signingPublicKey = params.get("verify") ?? "";
  if (!/^[A-Za-z0-9_-]{20}$/u.test(roomId)) return null;
  try {
    if (base64UrlToBytes(roomKey).byteLength !== 32) return null;
    if (base64UrlToBytes(signingPublicKey).byteLength !== 65) return null;
  } catch {
    return null;
  }
  return { roomId, roomKey, signingPublicKey };
}
