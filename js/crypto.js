/* =========================================================
   CRYPTO — AES-GCM + PBKDF2
   Cifra a chave Gemini com a senha-mestra do usuário.
   Servidor jamais vê a senha nem a chave em claro.
   ========================================================= */

const enc = new TextEncoder();
const dec = new TextDecoder();

function buf2b64(buf) {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function b642buf(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes.buffer;
}

async function deriveKey(password, salt) {
  const baseKey = await crypto.subtle.importKey(
    "raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveKey"]
  );
  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      salt,
      iterations: 250000,
      hash: "SHA-256"
    },
    baseKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

export async function encryptString(plaintext, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt);
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, enc.encode(plaintext)
  );
  return {
    v: 1,
    salt: buf2b64(salt),
    iv: buf2b64(iv),
    data: buf2b64(ct)
  };
}

export async function decryptString(blob, password) {
  if (!blob || blob.v !== 1) throw new Error("Formato inválido");
  const salt = new Uint8Array(b642buf(blob.salt));
  const iv = new Uint8Array(b642buf(blob.iv));
  const key = await deriveKey(password, salt);
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv }, key, b642buf(blob.data)
  );
  return dec.decode(pt);
}

/** Verifica senha tentando decifrar — joga se errada. */
export async function verifyPassword(blob, password) {
  await decryptString(blob, password);
  return true;
}
