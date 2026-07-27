import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { devPortFlag } from "@/lib/ast/framework";
import type { Framework } from "@/lib/ast/types";

export async function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, () => {
      const address = srv.address();
      const port = typeof address === "object" && address ? address.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

const INSTALL_TIMEOUT_MS = 5 * 60_000;
const READY_TIMEOUT_MS = 90_000;
const READY_POLL_INTERVAL_MS = 1_500;

function run(cmd: string, args: string[], cwd: string, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { cwd, stdio: "ignore" });
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      reject(new Error(`${cmd} ${args.join(" ")} timeout dopo ${timeoutMs}ms`));
    }, timeoutMs);
    proc.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    proc.on("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${cmd} ${args.join(" ")} uscito con codice ${code}`));
    });
  });
}

export interface DevServerHandle {
  proc: ChildProcess;
  port: number;
  url: string;
}

/**
 * Installa le dipendenze ed avvia il dev server del progetto clonato,
 * attendendo che risponda prima di restituire.
 *
 * SICUREZZA: `npm install` esegue script postinstall arbitrari del progetto
 * clonato — accettabile SOLO perché qui si ingeriscono esclusivamente repo di
 * proprietà dell'admin (vedi spec, scope iniziale). Se in futuro si apre
 * l'ingestion a repo di terzi, questo passo richiede isolamento (container),
 * non farlo girare così com'è sull'host.
 */
export async function startDevServer(workDir: string, framework: Framework): Promise<DevServerHandle> {
  await run("npm", ["install"], workDir, INSTALL_TIMEOUT_MS);

  const port = await findFreePort();
  const portArgs = devPortFlag(framework, port);
  const proc = spawn("npm", ["run", "dev", ...(portArgs.length ? ["--", ...portArgs] : [])], {
    cwd: workDir,
    detached: true,
    stdio: "ignore",
    env: { ...process.env, PORT: String(port) },
  });

  const url = `http://localhost:${port}`;
  try {
    await waitForReady(url, READY_TIMEOUT_MS);
  } catch (err) {
    stopDevServer({ proc, port, url });
    throw err;
  }

  return { proc, port, url };
}

async function waitForReady(url: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(5_000) });
      if (res.status < 500) return; // qualunque risposta non-5xx = server su e rispondente
    } catch {
      // non ancora pronto: connessione rifiutata o timeout, riprova
    }
    await new Promise((r) => setTimeout(r, READY_POLL_INTERVAL_MS));
  }
  throw new Error(`Dev server non pronto dopo ${timeoutMs}ms su ${url}`);
}

/** `detached: true` mette il child nel proprio process group (pgid = suo pid
 * su POSIX): npm a sua volta spawna il processo del framework come figlio,
 * killare solo `proc` lascerebbe quest'ultimo orfano e vivo. Killare il
 * gruppo intero (`-pid`) li ferma entrambi. */
export function stopDevServer(handle: DevServerHandle): void {
  if (!handle.proc.pid) return;
  try {
    process.kill(-handle.proc.pid, "SIGTERM");
  } catch {
    handle.proc.kill("SIGTERM");
  }
}
