/**
 * Hash an image without retaining the caller's bounded byte buffer.
 *
 * The digest API accepts the buffer for the duration of this call only; no
 * module-level or result-level reference is kept after the promise settles.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", bytes as BufferSource);
  const digestBytes = new Uint8Array(digest);

  let hex = "";
  for (const byte of digestBytes) hex += byte.toString(16).padStart(2, "0");
  return hex;
}
