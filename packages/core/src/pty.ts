import { spawn, type IPty } from "node-pty";
import { spawnSync } from "node:child_process";

export interface PtyRunInput {
  cmd: string;
  args: string[];
  cwd: string;
  cols?: number;
  rows?: number;
}

export class PtyManager {
  private readonly sessions = new Map<string, IPty>();

  run(sessionId: string, input: PtyRunInput): IPty {
    const env = {
      ...(process.env as Record<string, string>),
      TERM: "xterm-256color",
      COLORTERM: "truecolor",
      LANG: process.env.LANG ?? "ko_KR.UTF-8",
      LC_ALL: process.env.LC_ALL ?? "ko_KR.UTF-8",
      LC_CTYPE: process.env.LC_CTYPE ?? "ko_KR.UTF-8",
      PYTHONUTF8: process.env.PYTHONUTF8 ?? "1",
      PYTHONIOENCODING: process.env.PYTHONIOENCODING ?? "utf-8",
      TERM_PROGRAM: process.env.TERM_PROGRAM ?? "wincmux"
    };

    const pty = spawn(input.cmd, input.args, {
      name: "xterm-256color",
      cwd: input.cwd,
      cols: input.cols ?? 120,
      rows: input.rows ?? 30,
      env
    });
    this.sessions.set(sessionId, pty);
    return pty;
  }

  get(sessionId: string): IPty | undefined {
    return this.sessions.get(sessionId);
  }

  write(sessionId: string, data: string): void {
    const pty = this.sessions.get(sessionId);
    if (!pty) {
      return;
    }
    pty.write(data);
  }

  resize(sessionId: string, cols: number, rows: number): void {
    const pty = this.sessions.get(sessionId);
    if (!pty) {
      return;
    }
    pty.resize(cols, rows);
  }

  close(sessionId: string): void {
    const pty = this.sessions.get(sessionId);
    if (!pty) {
      return;
    }
    const pid = pty.pid;
    try {
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
      }
      pty.kill();
    } finally {
      this.sessions.delete(sessionId);
    }
  }

  closeAll(): void {
    for (const id of this.sessions.keys()) {
      this.close(id);
    }
  }
}
