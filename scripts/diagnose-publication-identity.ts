import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readlinkSync } from "node:fs";
import { queryProcessIdentity } from "../lib/pipeline/process-identity";

type Result = "PASS" | "FAIL";
type ProductionState = "present" | "absent" | "unknown";

const mirrorCode = String.raw`
import os, sys
pid = int(sys.argv[1])
def read(path):
    with open(path) as f:
        return f.read().strip()
try:
    self_stat = read("/proc/self/stat")
except Exception:
    print("SELF_STAT_READ_FAILED"); sys.exit(0)
try:
    self_pid = int(self_stat.split(" ", 1)[0])
except Exception:
    print("SELF_STAT_PARSE_FAILED"); sys.exit(0)
if self_pid != os.getpid():
    print("SELF_PID_MISMATCH"); sys.exit(0)
try:
    proc1_ns = os.readlink("/proc/1/ns/pid")
except Exception:
    print("PROC1_PID_NS_READ_FAILED"); sys.exit(0)
try:
    self_ns = os.readlink("/proc/self/ns/pid")
except Exception:
    print("SELF_PID_NS_READ_FAILED"); sys.exit(0)
if proc1_ns != self_ns:
    print("PID_NAMESPACE_MISMATCH"); sys.exit(0)
try:
    boot_id = read("/proc/sys/kernel/random/boot_id")
except Exception:
    print("BOOT_ID_READ_FAILED"); sys.exit(0)
if not boot_id:
    print("BOOT_ID_EMPTY"); sys.exit(0)
try:
    target_stat = read("/proc/" + str(pid) + "/stat")
except Exception:
    print("TARGET_STAT_READ_FAILED"); sys.exit(0)
try:
    fields = target_stat[target_stat.rfind(")") + 2:].split()
    starttime = fields[19]
except Exception:
    print("TARGET_STAT_PARSE_FAILED"); sys.exit(0)
if not starttime:
    print("STARTTIME_MISSING"); sys.exit(0)
if not starttime.isdecimal():
    print("STARTTIME_INVALID"); sys.exit(0)
print("PRESENT")
`;

const safeCodes = new Set([
  "PRESENT", "SELF_STAT_READ_FAILED", "SELF_STAT_PARSE_FAILED", "SELF_PID_MISMATCH",
  "PROC1_PID_NS_READ_FAILED", "SELF_PID_NS_READ_FAILED", "PID_NAMESPACE_MISMATCH",
  "BOOT_ID_READ_FAILED", "BOOT_ID_EMPTY", "TARGET_STAT_READ_FAILED",
  "TARGET_STAT_PARSE_FAILED", "STARTTIME_MISSING", "STARTTIME_INVALID",
  "PYTHON_DIAGNOSTIC_FAILED",
]);

function runPython(code: string, args: string[] = [], timeout = 2_000): { result: Result; stdout: string } {
  try {
    const stdout = execFileSync("/usr/bin/python3", ["-I", "-c", code, ...args], {
      timeout, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1024, encoding: "utf8",
    }).trim();
    return { result: "PASS", stdout };
  } catch { return { result: "FAIL", stdout: "" }; }
}

function readResult(path: string): Result {
  try { readFileSync(path, "utf8"); return "PASS"; } catch { return "FAIL"; }
}

function parseStat(path: string): Result {
  try {
    const value = readFileSync(path, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(/\s+/);
    return fields.length > 19 ? "PASS" : "FAIL";
  } catch { return "FAIL"; }
}

function main(): void {
  const pythonExists: Result = existsSync("/usr/bin/python3") ? "PASS" : "FAIL";
  const pythonExecutable = pythonExists === "PASS" ? runPython("import sys; sys.exit(0)").result : "FAIL";
  const pythonIsolatedMode = pythonExists === "PASS" ? runPython("import sys; sys.exit(0)").result : "FAIL";
  const procSelfStatReadable = readResult("/proc/self/stat");
  const selfPidMatches = pythonExecutable === "PASS"
    ? runPython("import os; fields=open('/proc/self/stat').read().split(); assert int(fields[0]) == os.getpid()").result
    : "FAIL";
  let proc1PidNamespaceReadable: Result = "FAIL";
  let selfPidNamespaceReadable: Result = "FAIL";
  let pidNamespaceMatches: Result = "FAIL";
  try { readlinkSync("/proc/1/ns/pid"); proc1PidNamespaceReadable = "PASS"; } catch { /* safe status only */ }
  try { readlinkSync("/proc/self/ns/pid"); selfPidNamespaceReadable = "PASS"; } catch { /* safe status only */ }
  if (proc1PidNamespaceReadable === "PASS" && selfPidNamespaceReadable === "PASS") {
    try { pidNamespaceMatches = readlinkSync("/proc/1/ns/pid") === readlinkSync("/proc/self/ns/pid") ? "PASS" : "FAIL"; } catch { pidNamespaceMatches = "FAIL"; }
  }
  const bootIdReadable = readResult("/proc/sys/kernel/random/boot_id");
  let bootIdNonEmpty: Result = "FAIL";
  try { bootIdNonEmpty = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() ? "PASS" : "FAIL"; } catch { /* safe status only */ }
  const targetNodeStatReadable = readResult(`/proc/${process.pid}/stat`);
  const targetNodeStatParsable = parseStat(`/proc/${process.pid}/stat`);
  let targetNodeStarttimeValid: Result = "FAIL";
  try {
    const value = readFileSync(`/proc/${process.pid}/stat`, "utf8");
    const fields = value.slice(value.lastIndexOf(")") + 2).split(/\s+/);
    targetNodeStarttimeValid = /^\d+$/.test(fields[19] ?? "") ? "PASS" : "FAIL";
  } catch { /* safe status only */ }
  const mirror = runPython(mirrorCode, [String(process.pid)]);
  const mirrorProbe = safeCodes.has(mirror.stdout) ? mirror.stdout : "PYTHON_DIAGNOSTIC_FAILED";
  void queryProcessIdentity(process.pid).then((identity) => {
    const productionQueryState: ProductionState = identity.state;
    console.log(`PUBLICATION_IDENTITY_DIAGNOSTIC_V2=${JSON.stringify({
      pythonExists, pythonExecutable, pythonIsolatedMode,
      procSelfStatReadable, selfPidMatches,
      proc1PidNamespaceReadable, selfPidNamespaceReadable, pidNamespaceMatches,
      bootIdReadable, bootIdNonEmpty,
      targetNodeStatReadable, targetNodeStatParsable, targetNodeStarttimeValid,
      mirrorProbe, productionQueryState,
    })}`);
  });
}

main();
