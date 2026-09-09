/** Authenticate only the HTTP Authorization header; credentials in URLs or bodies are never accepted. */
export async function authenticateBearer(request: Request, expected: string): Promise<boolean> {
  if (expected.length === 0) return false;
  const header = request.headers.get("Authorization");
  if (header === null) return false;
  const match = /^Bearer ([^\s]+)$/i.exec(header);
  if (match === null) return false;

  const actualBytes = new TextEncoder().encode(match[1]!);
  const expectedBytes = new TextEncoder().encode(expected);
  const length = Math.max(actualBytes.byteLength, expectedBytes.byteLength);
  let difference = actualBytes.byteLength ^ expectedBytes.byteLength;
  for (let index = 0; index < length; index += 1) {
    difference |= (actualBytes[index] ?? 0) ^ (expectedBytes[index] ?? 0);
  }
  return difference === 0;
}
