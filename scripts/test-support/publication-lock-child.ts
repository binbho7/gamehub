import { acquirePublicationLock } from "../../lib/pipeline/publication-lock";

process.stdin.resume();
process.stdin.once("data", () => {
  void acquirePublicationLock(process.argv[2]!).then((release) => {
    process.stdout.write("acquired\n");
    process.stdin.once("data", () => { void release().then(() => process.exit(0)); });
  }, () => { process.stdout.write("blocked\n"); process.exit(0); });
});
process.stdout.write("ready\n");
