import { execFile } from "node:child_process";
import { ScoutError } from "./errors.js";

const ALLOWED = new Set(["git", "node"]);
/** Safe subprocess: no shell, allow-listed binary, scrubbed env, timeout, output cap. Used only for `doctor`. */
export function safeExec(
  bin: string,
  args: string[],
  opts: { timeoutMs?: number; cwd?: string } = {},
): Promise<{ stdout: string; stderr: string }> {
  if (!ALLOWED.has(bin))
    return Promise.reject(new ScoutError("SECURITY_BLOCKED", `Binary not allow-listed: ${bin}`));
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    SYSTEMROOT: process.env.SYSTEMROOT,
    GIT_TERMINAL_PROMPT: "0",
  };
  return new Promise((resolve, reject) => {
    execFile(
      bin,
      args,
      {
        timeout: opts.timeoutMs ?? 5000,
        maxBuffer: 1 << 20,
        env,
        cwd: opts.cwd,
        shell: false,
        windowsHide: true,
      },
      (err, stdout, stderr) => {
        if (err) reject(new ScoutError("INTERNAL", `${bin} failed: ${err.message.slice(0, 200)}`));
        else resolve({ stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}
