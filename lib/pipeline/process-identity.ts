import { execFile } from "node:child_process";
import { promisify } from "node:util";

export type ProcessObservation =
  | { state: "present"; domain: string; incarnation: string }
  | { state: "absent"; domain: string }
  | { state: "unknown" };
export type ProcessQuery = (pid: number) => Promise<ProcessObservation>;
export type OwnerIdentity = { domain: string; incarnation: string };

// System Python's stdlib bridges macOS libproc without a native npm addon. Linux
// uses procfs. Missing Python, denied inspection or an unrecognized ABI fails closed.
const probe = String.raw`
import ctypes, errno, json, os, sys
pid = int(sys.argv[1])
if sys.platform == "darwin":
    libc = ctypes.CDLL(None, use_errno=True)
    boot = ctypes.create_string_buffer(128)
    size = ctypes.c_size_t(len(boot))
    if libc.sysctlbyname(b"kern.bootsessionuuid", boot, ctypes.byref(size), None, 0) != 0:
        raise RuntimeError("boot unavailable")
    domain = "darwin:" + boot.value.decode("ascii")
    # Public proc_bsdinfo ABI: 12 uint32, char[16], char[32], 6 uint32,
    # then the kernel's uint64 process birth seconds AND microseconds.
    class BsdInfo(ctypes.Structure):
        _fields_ = [("prefix", ctypes.c_uint32 * 12), ("comm", ctypes.c_char * 16),
                    ("name", ctypes.c_char * 32), ("suffix", ctypes.c_uint32 * 6),
                    ("seconds", ctypes.c_uint64), ("micros", ctypes.c_uint64)]
    info = BsdInfo()
    libproc = ctypes.CDLL("/usr/lib/libproc.dylib", use_errno=True)
    libproc.proc_pidinfo.argtypes = [ctypes.c_int, ctypes.c_int, ctypes.c_uint64, ctypes.c_void_p, ctypes.c_int]
    result = libproc.proc_pidinfo(pid, 3, 0, ctypes.byref(info), ctypes.sizeof(info))
    if result == ctypes.sizeof(info) and info.prefix[3] == pid and info.seconds > 0 and info.micros < 1000000:
        print(json.dumps(dict(state="present", domain=domain, incarnation=str(info.seconds)+":"+str(info.micros))))
    elif result == 0 and ctypes.get_errno() == errno.ESRCH:
        print(json.dumps(dict(state="absent", domain=domain)))
    else:
        raise RuntimeError("process unavailable")
elif sys.platform == "linux":
    def read(path):
        with open(path) as f: return f.read().strip()
    # Require the mounted procfs to use our PID numbering, not an ancestor's.
    if int(read("/proc/self/stat").split(" ", 1)[0]) != os.getpid():
        raise RuntimeError("incomparable procfs")
    if os.readlink("/proc/1/ns/pid") != os.readlink("/proc/self/ns/pid"):
        raise RuntimeError("ancestor procfs")
    domain = "linux:" + read("/proc/sys/kernel/random/boot_id") + ":" + os.readlink("/proc/self/ns/pid")
    try:
        stat = read("/proc/"+str(pid)+"/stat")
    except FileNotFoundError:
        print(json.dumps(dict(state="absent", domain=domain)))
    else:
        fields = stat[stat.rfind(")")+2:].split()
        start = fields[19]
        if not start.isdigit(): raise RuntimeError("invalid start")
        print(json.dumps(dict(state="present", domain=domain, incarnation=start)))
else:
    raise RuntimeError("unsupported platform")
`;

export const queryProcessIdentity: ProcessQuery = async (pid) => {
  if (!Number.isSafeInteger(pid) || pid <= 0) return { state: "unknown" };
  try {
    const { stdout } = await promisify(execFile)("/usr/bin/python3", ["-I", "-c", probe, String(pid)], {
      timeout: 2_000, killSignal: "SIGKILL", maxBuffer: 4096,
    });
    const value: unknown = JSON.parse(stdout);
    if (typeof value !== "object" || value === null || !("domain" in value) || typeof value.domain !== "string" || !value.domain) return { state: "unknown" };
    if ("state" in value && value.state === "absent") return { state: "absent", domain: value.domain };
    if ("state" in value && value.state === "present" && "incarnation" in value && typeof value.incarnation === "string" && value.incarnation) {
      return { state: "present", domain: value.domain, incarnation: value.incarnation };
    }
  } catch { /* Never expose OS errors/paths or infer absence from query failure. */ }
  return { state: "unknown" };
};

export async function compareOwner(identity: OwnerIdentity, pid: number, query: ProcessQuery): Promise<"SAME_OWNER" | "OWNER_GONE_OR_REPLACED" | "UNKNOWN"> {
  try {
    const current = await query(pid);
    if (current.state === "unknown" || current.domain !== identity.domain) return "UNKNOWN";
    if (current.state === "absent" || current.incarnation !== identity.incarnation) return "OWNER_GONE_OR_REPLACED";
    return "SAME_OWNER";
  } catch { return "UNKNOWN"; }
}
