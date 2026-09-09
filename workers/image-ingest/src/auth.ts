/** Authenticate only the HTTP Authorization header; credentials in URLs or bodies are never accepted. */
export async function authenticateBearer(request: Request, expected: string): Promise<boolean> {
  if (expected.length === 0) return false;
  const header = request.headers.get("Authorization");
  if (header === null) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (match === null) return false;

  const encoder = new TextEncoder();
  const [actualDigest, expectedDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(match[1]!)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const actualBytes = new Uint8Array(actualDigest);
  const expectedBytes = new Uint8Array(expectedDigest);
  let difference = 0;
  for (let index = 0; index < 32; index += 1) {
    difference |= actualBytes[index]! ^ expectedBytes[index]!;
  }
  return difference === 0;
}
