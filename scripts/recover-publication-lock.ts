import { OPERATOR_RECOVERY_CONFIRMATION, recoverPublicationLock } from "../lib/pipeline/publication-lock";

export function parseRecoveryArgs(argv: string[]): { confirmed: true } {
  let stopped = false;
  let confirmation: string | undefined;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--confirm-all-exporters-stopped") {
      if (stopped) throw new Error("operator confirmation flag must be provided once");
      stopped = true;
    } else if (argument === "--confirmation") {
      if (confirmation !== undefined) throw new Error("operator confirmation value must be provided once");
      confirmation = argv[++index];
      if (!confirmation) throw new Error("operator confirmation value is required");
    } else {
      throw new Error(`unsupported argument ${argument}`);
    }
  }
  if (!stopped || confirmation !== OPERATOR_RECOVERY_CONFIRMATION) {
    throw new Error(`exact operator confirmation is required: --confirm-all-exporters-stopped --confirmation ${OPERATOR_RECOVERY_CONFIRMATION}`);
  }
  return { confirmed: true };
}

type RecoveryResult = { generation: number; status: "recovered" | "already_released" };
export async function runRecoveryCommand(options: {
  argv: string[];
  recover?: (path: string, confirmation: string) => Promise<RecoveryResult>;
  stdout?: (value: string) => void;
}): Promise<RecoveryResult> {
  parseRecoveryArgs(options.argv);
  const result = await (options.recover ?? recoverPublicationLock)("generated/site-data.json", OPERATOR_RECOVERY_CONFIRMATION);
  (options.stdout ?? ((value) => process.stdout.write(value)))(`publication lock generation ${result.generation} recovery completed\n`);
  return result;
}

if (process.argv[1]?.endsWith("recover-publication-lock.ts")) {
  void runRecoveryCommand({ argv: process.argv.slice(2) }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : "publication lock recovery failed");
    process.exitCode = 1;
  });
}
