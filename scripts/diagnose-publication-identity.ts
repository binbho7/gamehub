import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { queryProcessIdentity } from "../lib/pipeline/process-identity";

type Result = "PASS" | "FAIL" | "UNKNOWN";

function pythonCheck(code: string, timeout = 2_000): Result {
  try {
    execFileSync("/usr/bin/python3", ["-I", "-c", code], {
      timeout,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 1024,
    });
    return "PASS";
  } catch {
    return "FAIL";
  }
}

function procfsCheck(): Result {
  try {
    const self = readFileSync("/proc/self/stat", "utf8");
    const pid = Number(self.slice(0, self.indexOf(" ")));
    return Number.isSafeInteger(pid) && pid > 0 ? "PASS" : "FAIL";
  } catch {
    return "FAIL";
  }
}

const pythonExists: Result = existsSync("/usr/bin/python3") ? "PASS" : "FAIL";
const pythonExecutable: Result = pythonExists === "PASS" ? pythonCheck("process.exit(0)") : "FAIL";
const pythonTimeout: Result = pythonExecutable === "PASS" ? pythonCheck("process.exit(0)", 2_000) : "FAIL";
const procfsReadable = procfsCheck();
const pidMatch = pythonExecutable === "PASS"
  ? pythonCheck("import os; fields=open('/proc/self/stat').read().split(); assert int(fields[0]) == os.getpid()")
  : "FAIL";
let pidNamespaceMatch: Result = "FAIL";
let bootIdReadable: Result = "FAIL";
let targetStatReadable: Result = "FAIL";
let starttimeValid: Result = "FAIL";
try {
  pidNamespaceMatch = readlinkSync("/proc/1/ns/pid") === readlinkSync("/proc/self/ns/pid") ? "PASS" : "FAIL";
  const bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
  bootIdReadable = bootId.length > 0 ? "PASS" : "FAIL";
  const stat = readFileSync(`/proc/${process.pid}/stat`, "utf8");
  targetStatReadable = "PASS";
  const tail = stat.slice(stat.lastIndexOf(")") + 2).split(/\s+/);
  starttimeValid = /^\d+$/.test(tail[19] ?? "") ? "PASS" : "FAIL";
} catch {
  pidNamespaceMatch = "FAIL";
}

async function main(): Promise<void> {
  const identity = await queryProcessIdentity(process.pid);
  const queryResult: Result = identity.state === "present" ? "PASS" : identity.state === "absent" ? "FAIL" : "UNKNOWN";

  console.log(`PUBLICATION_IDENTITY_DIAGNOSTIC=${JSON.stringify({
    pythonExists,
    pythonExecutable,
    pythonTimeout,
    procfsReadable,
    pidMatch,
    pidNamespaceMatch,
    bootIdReadable,
    targetStatReadable,
    starttimeValid,
    queryProcessIdentity: identity.state,
    queryProcessIdentityCheck: queryResult,
  })}`);
}

void main();
