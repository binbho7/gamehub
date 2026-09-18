import { createLocalNodeVerificationTransport } from "./node-transport";
import { createVerifierServer } from "./server";

// The Container has no database, storage, scheduler or provider credentials.
const secret = process.env.VERIFIER_SERVICE_SECRET;
if (!secret) throw new Error("Missing verifier service secret");
const server = createVerifierServer({ secret, transport: createLocalNodeVerificationTransport(), nowMs: Date.now });
server.listen(8080, "0.0.0.0");
