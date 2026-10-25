/** AES-256-GCM encryption for OAuth tokens at rest. The account ID is bound as additional data. */

export interface EncryptedBlob {
  ciphertext: ArrayBuffer;
  iv: ArrayBuffer;
}

export async function encryptJson(
  value: unknown,
  base64Key: string,
  accountId: string,
): Promise<EncryptedBlob> {
  const key = await importKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: new TextEncoder().encode(accountId) },
    key,
    new TextEncoder().encode(JSON.stringify(value)),
  );
  return { ciphertext, iv: iv.buffer };
}

/** Throws if the key, the account ID, or the ciphertext does not match. */
export async function decryptJson<T>(
  blob: EncryptedBlob,
  base64Key: string,
  accountId: string,
): Promise<T> {
  const key = await importKey(base64Key);
  const plaintext = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: blob.iv, additionalData: new TextEncoder().encode(accountId) },
    key,
    blob.ciphertext,
  );
  return JSON.parse(new TextDecoder().decode(plaintext)) as T;
}

/** Imported keys per encoded key, so that each isolate imports a key once. */
const aesKeys = new Map<string, Promise<CryptoKey>>();

function importKey(base64Key: string): Promise<CryptoKey> {
  let key = aesKeys.get(base64Key);
  if (!key) {
    const raw = Uint8Array.from(atob(base64Key.trim()), (char) => char.charCodeAt(0));
    key = crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
    aesKeys.set(base64Key, key);
  }
  return key;
}
