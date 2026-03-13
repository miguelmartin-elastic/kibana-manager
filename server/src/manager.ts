import { spawn, execSync, ChildProcess } from 'child_process';
import fs from 'fs';
import net from 'net';
import path from 'path';

import {
  InstanceConfig,
  InstanceStatus,
  InstanceView,
  KibanaHealth,
} from './types';
import {
  HOME,
  KIBANA_REPO,
  WORKTREES_DIR,
  STATE_FILE,
  ES_DATA_DIR,
  ES_TRIGGER,
  LOG_BUFFER,
  ES_STARTUP_TIMEOUT_MS,
} from './config';
import { resolveNodeBin } from './nvm';
import { checkKibanaHealth } from './health';

interface InstanceRuntime {
  config: InstanceConfig;
  status: InstanceStatus;
  esProcess: ChildProcess | null;
  kibanaProcess: ChildProcess | null;
  logs: string[];
  kibanaHealth: KibanaHealth;
  esStartupTimer: ReturnType<typeof setTimeout> | null;
}

interface ManagerState {
  featBranch?: string;
  temporaryInstances?: InstanceConfig[];
}

function readState(): ManagerState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      const raw = fs.readFileSync(STATE_FILE, 'utf8');
      return JSON.parse(raw);
    }
  } catch {
    // ignore
  }
  return {};
}

function writeState(state: ManagerState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

function mergeState(updates: Partial<ManagerState>): void {
  const current = readState();
  writeState({ ...current, ...updates });
}

function pushLog(runtime: InstanceRuntime, line: string): void {
  runtime.logs.push(line);
  if (runtime.logs.length > LOG_BUFFER) {
    runtime.logs.shift();
  }
}

function nextFreePort(startPort: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const tryPort = (port: number) => {
      const server = net.createServer();
      server.once('error', () => {
        tryPort(port + 1);
      });
      server.once('listening', () => {
        server.close(() => resolve(port));
      });
      server.listen(port, '127.0.0.1');
    };
    tryPort(startPort);
  });
}

function killProcess(proc: ChildProcess): Promise<void> {
  return new Promise((resolve) => {
    if (proc.exitCode !== null || proc.killed) {
      resolve();
      return;
    }

    const pid = proc.pid;
    if (!pid) {
      resolve();
      return;
    }

    // Try to kill the process group (catches Java child spawned by ES)
    try {
      process.kill(-pid, 'SIGTERM');
    } catch {
      try {
        proc.kill('SIGTERM');
      } catch {
        // ignore
      }
    }

    const timer = setTimeout(() => {
      if (proc.exitCode === null) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          try {
            proc.kill('SIGKILL');
          } catch {
            // ignore
          }
        }
      }
      resolve();
    }, 3000);

    proc.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function buildEnv(nodeBinDir: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    PATH: `/opt/homebrew/bin:${nodeBinDir}:${process.env.PATH ?? ''}`,
  };
}

export class InstanceManager {
  private runtimes: Map<string, InstanceRuntime> = new Map();
  private healthPollTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    const state = readState();
    const featBranch = state.featBranch ?? 'main';

    const permanentInstances: InstanceConfig[] = [
      {
        name: 'kibana-feat',
        type: 'permanent',
        branch: featBranch,
        dir: path.join(WORKTREES_DIR, 'feat'),
        kPort: 5601,
        esPort: 9200,
        esDataFolder: 'feat',
      },
      {
        name: 'kibana-main',
        type: 'permanent',
        branch: 'main',
        dir: path.join(HOME, 'elastic', 'kibana'),
        kPort: 5602,
        esPort: 9201,
        esDataFolder: 'main',
      },
    ];

    for (const config of permanentInstances) {
      this.runtimes.set(config.name, {
        config,
        status: 'stopped',
        esProcess: null,
        kibanaProcess: null,
        logs: [],
        kibanaHealth: { up: false, status: 'down', version: null },
        esStartupTimer: null,
      });
    }

    // Restore persisted temporary instances (stopped, not auto-started)
    for (const config of state.temporaryInstances ?? []) {
      if (fs.existsSync(config.dir)) {
        this.runtimes.set(config.name, {
          config,
          status: 'stopped',
          esProcess: null,
          kibanaProcess: null,
          logs: [],
          kibanaHealth: { up: false, status: 'down', version: null },
        esStartupTimer: null,
        });
      }
    }

    this.startHealthPoller();
  }

  private startHealthPoller(): void {
    this.healthPollTimer = setInterval(async () => {
      for (const [, runtime] of this.runtimes) {
        const health = await checkKibanaHealth(runtime.config.kPort);
        runtime.kibanaHealth = health;
      }
    }, 5000);

    if (this.healthPollTimer.unref) {
      this.healthPollTimer.unref();
    }
  }

  async start(name: string): Promise<string> {
    const runtime = this.runtimes.get(name);
    if (!runtime) {
      throw new Error(`Instance '${name}' not found`);
    }

    if (
      runtime.status === 'starting-es' ||
      runtime.status === 'starting-kibana' ||
      runtime.status === 'running'
    ) {
      return `Instance '${name}' is already running (status: ${runtime.status})`;
    }

    if (!fs.existsSync(runtime.config.dir)) {
      throw new Error(
        `Directory '${runtime.config.dir}' does not exist. Set up the worktree first.`
      );
    }

    runtime.status = 'starting-es';
    runtime.logs = [];
    runtime.kibanaHealth = { up: false, status: 'down', version: null };

    // Remove stale ES lock files (Java leaves these behind when killed uncleanly)
    const esDataPath = path.join(ES_DATA_DIR, runtime.config.esDataFolder);
    const removeStaleLocks = (dir: string) => {
      if (!fs.existsSync(dir)) return;
      try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            removeStaleLocks(full);
          } else if (entry.name.endsWith('.lock')) {
            fs.rmSync(full);
            pushLog(runtime, `[manager] Removed stale lock: ${full}`);
          }
        }
      } catch {
        pushLog(runtime, `[manager] Warning: could not clean locks in ${dir}`);
      }
    };
    removeStaleLocks(esDataPath);

    const nodeBinDir = resolveNodeBin(runtime.config.dir);
    const env = buildEnv(nodeBinDir);

    const { esPort, kPort } = runtime.config;
    const esTransportPort = esPort + 100;
    const folder = runtime.config.esDataFolder;

    // Kill any zombie processes still holding ES ports from a previous run
    for (const port of [esPort, esTransportPort, kPort]) {
      try {
        execSync(`lsof -ti:${port} | xargs kill -9`, { stdio: 'pipe' });
        pushLog(runtime, `[manager] Killed zombie process on port ${port}`);
      } catch { /* no process on that port, ignore */ }
    }

    const esArgs = [
      'es',
      'snapshot',
      '--license', 'trial',
      '-E', `node.name=${folder}`,
      '-E', `http.port=${esPort}`,
      '-E', `transport.port=${esTransportPort}`,
      '-E', 'discovery.type=single-node',
      '-E', `path.data=${esDataPath}`,
    ];

    pushLog(runtime, `[manager] Spawning ES: yarn ${esArgs.join(' ')}`);

    const esProc = spawn('yarn', esArgs, {
      cwd: runtime.config.dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    runtime.esProcess = esProc;

    // Guard: if ES never prints the trigger, transition to error after timeout
    runtime.esStartupTimer = setTimeout(() => {
      runtime.esStartupTimer = null;
      if (runtime.status === 'starting-es') {
        pushLog(runtime, `[manager] ES startup timed out after ${ES_STARTUP_TIMEOUT_MS / 1000}s — no trigger received`);
        runtime.status = 'error';
      }
    }, ES_STARTUP_TIMEOUT_MS);

    const onEsLine = (line: string) => {
      pushLog(runtime, `[es] ${line}`);
      if (line.includes(ES_TRIGGER)) {
        if (runtime.esStartupTimer) {
          clearTimeout(runtime.esStartupTimer);
          runtime.esStartupTimer = null;
        }
        this.startKibana(runtime);
      }
    };

    let esStdoutBuffer = '';
    esProc.stdout?.on('data', (chunk: Buffer) => {
      esStdoutBuffer += chunk.toString();
      const lines = esStdoutBuffer.split('\n');
      esStdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        onEsLine(line);
      }
    });

    let esStderrBuffer = '';
    esProc.stderr?.on('data', (chunk: Buffer) => {
      esStderrBuffer += chunk.toString();
      const lines = esStderrBuffer.split('\n');
      esStderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        pushLog(runtime, `[es:err] ${line}`);
      }
    });

    esProc.on('exit', (code, signal) => {
      if (esStdoutBuffer) {
        pushLog(runtime, `[es] ${esStdoutBuffer}`);
        esStdoutBuffer = '';
      }
      if (esStderrBuffer) {
        pushLog(runtime, `[es:err] ${esStderrBuffer}`);
        esStderrBuffer = '';
      }
      if (runtime.esStartupTimer) {
        clearTimeout(runtime.esStartupTimer);
        runtime.esStartupTimer = null;
      }
      pushLog(runtime, `[manager] ES process exited (code=${code}, signal=${signal})`);
      runtime.esProcess = null;
      if (runtime.status !== 'stopped') {
        runtime.status = 'error';
      }
    });

    return `Starting ES for ${name} on :${esPort} (Kibana will start on :${kPort} after ES is ready)...`;
  }

  private async startKibana(runtime: InstanceRuntime): Promise<void> {
    if (runtime.status === 'stopped') {
      return;
    }

    runtime.status = 'starting-kibana';

    const nodeBinDir = resolveNodeBin(runtime.config.dir);
    const env = buildEnv(nodeBinDir);

    const { kPort, esPort } = runtime.config;

    const kArgs = [
      'start',
      '--no-base-path',
      '--host=localhost',
      `--port=${kPort}`,
      `--elasticsearch.hosts=http://localhost:${esPort}`,
      // Override kibana.dev.yml which may point to a remote cluster with wrong credentials
      '--elasticsearch.username=kibana_system',
      '--elasticsearch.password=changeme',
      // Unique cookie name per instance to prevent session conflicts between instances
      `--xpack.security.cookieName=${runtime.config.name}`,
    ];

    pushLog(runtime, `[manager] Spawning Kibana: yarn ${kArgs.join(' ')}`);

    const kProc = spawn('yarn', kArgs, {
      cwd: runtime.config.dir,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    runtime.kibanaProcess = kProc;

    let kStdoutBuffer = '';
    kProc.stdout?.on('data', (chunk: Buffer) => {
      kStdoutBuffer += chunk.toString();
      const lines = kStdoutBuffer.split('\n');
      kStdoutBuffer = lines.pop() ?? '';
      for (const line of lines) {
        pushLog(runtime, `[kibana] ${line}`);
      }
    });

    let kStderrBuffer = '';
    kProc.stderr?.on('data', (chunk: Buffer) => {
      kStderrBuffer += chunk.toString();
      const lines = kStderrBuffer.split('\n');
      kStderrBuffer = lines.pop() ?? '';
      for (const line of lines) {
        pushLog(runtime, `[kibana:err] ${line}`);
      }
    });

    kProc.on('exit', (code, signal) => {
      if (kStdoutBuffer) {
        pushLog(runtime, `[kibana] ${kStdoutBuffer}`);
        kStdoutBuffer = '';
      }
      if (kStderrBuffer) {
        pushLog(runtime, `[kibana:err] ${kStderrBuffer}`);
        kStderrBuffer = '';
      }
      pushLog(runtime, `[manager] Kibana process exited (code=${code}, signal=${signal})`);
      runtime.kibanaProcess = null;
      runtime.kibanaHealth = { up: false, status: 'down', version: null };
      if (runtime.status !== 'stopped') {
        runtime.status = 'error';
      }
    });

    runtime.status = 'running';
  }

  async stop(name: string): Promise<string> {
    const runtime = this.runtimes.get(name);
    if (!runtime) {
      throw new Error(`Instance '${name}' not found`);
    }

    runtime.status = 'stopped';
    runtime.kibanaHealth = { up: false, status: 'down', version: null };

    if (runtime.esStartupTimer) {
      clearTimeout(runtime.esStartupTimer);
      runtime.esStartupTimer = null;
    }

    const kills: Promise<void>[] = [];

    if (runtime.kibanaProcess) {
      const proc = runtime.kibanaProcess;
      runtime.kibanaProcess = null;
      kills.push(killProcess(proc));
    }

    if (runtime.esProcess) {
      const proc = runtime.esProcess;
      runtime.esProcess = null;
      kills.push(killProcess(proc));
    }

    await Promise.all(kills);

    return `Stopped ${name}`;
  }

  async switchBranch(branch: string): Promise<string> {
    await this.stop('kibana-feat');

    // Remove existing worktree
    try {
      execSync(`git -C "${KIBANA_REPO}" worktree remove --force "${path.join(WORKTREES_DIR, 'feat')}"`, {
        stdio: 'pipe',
      });
    } catch {
      // If worktree remove fails (e.g. dir doesn't exist), try rm -rf
      try {
        execSync(`rm -rf "${path.join(WORKTREES_DIR, 'feat')}"`, { stdio: 'pipe' });
        execSync(`git -C "${KIBANA_REPO}" worktree prune`, { stdio: 'pipe' });
      } catch {
        // ignore
      }
    }

    // Check if branch exists locally
    let branchExists = false;
    try {
      execSync(`git -C "${KIBANA_REPO}" rev-parse --verify "${branch}"`, { stdio: 'pipe' });
      branchExists = true;
    } catch {
      branchExists = false;
    }

    const featDir = path.join(WORKTREES_DIR, 'feat');

    if (branchExists) {
      execSync(
        `git -C "${KIBANA_REPO}" worktree add "${featDir}" "${branch}"`,
        { stdio: 'pipe' }
      );
    } else {
      execSync(
        `git -C "${KIBANA_REPO}" worktree add "${featDir}" -b "${branch}" "origin/${branch}"`,
        { stdio: 'pipe' }
      );
    }

    const runtime = this.runtimes.get('kibana-feat');
    if (runtime) {
      runtime.config.branch = branch;
      runtime.config.dir = featDir;
    }

    const state = readState();
    state.featBranch = branch;
    writeState(state);

    return `Switched kibana-feat to branch '${branch}'. Run start to launch it.`;
  }

  async newInstance(branch: string): Promise<string> {
    const name = `kibana-${branch}`;
    const worktreeDir = path.join(WORKTREES_DIR, branch);

    // If instance already tracked in memory, just start it
    if (this.runtimes.has(name)) {
      await this.start(name);
      const { kPort, esPort } = this.runtimes.get(name)!.config;
      return `Starting existing instance '${name}' on Kibana :${kPort} / ES :${esPort}`;
    }

    const kPort = await nextFreePort(5603);
    const esPort = await nextFreePort(9202);

    // Resolve the actual worktree directory (may already exist elsewhere on disk)
    let resolvedDir = worktreeDir;

    if (!fs.existsSync(worktreeDir)) {
      let branchExists = false;
      try {
        execSync(`git -C "${KIBANA_REPO}" rev-parse --verify "${branch}"`, { stdio: 'pipe' });
        branchExists = true;
      } catch {
        branchExists = false;
      }

      try {
        if (branchExists) {
          execSync(`git -C "${KIBANA_REPO}" worktree add "${worktreeDir}" "${branch}"`, { stdio: 'pipe' });
        } else {
          execSync(`git -C "${KIBANA_REPO}" worktree add "${worktreeDir}" -b "${branch}" "origin/${branch}"`, { stdio: 'pipe' });
        }
      } catch (e: any) {
        // Branch already checked out in another worktree — extract that path and reuse it
        const match = String(e.stderr ?? e.message).match(/already used by worktree at '([^']+)'/);
        if (match) {
          resolvedDir = match[1];
        } else {
          throw e;
        }
      }
    }

    const config: InstanceConfig = {
      name,
      type: 'temporary',
      branch,
      dir: resolvedDir,
      kPort,
      esPort,
      esDataFolder: branch,
    };

    const runtime: InstanceRuntime = {
      config,
      status: 'stopped',
      esProcess: null,
      kibanaProcess: null,
      logs: [],
      kibanaHealth: { up: false, status: 'down', version: null },
      esStartupTimer: null,
    };

    this.runtimes.set(name, runtime);
    this.persistTemporaryInstances();

    // Always bootstrap before starting (fire-and-forget, progress visible in logs)
    this.bootstrapThenStart(runtime);
    return `Created instance '${name}' on Kibana :${kPort} / ES :${esPort} — running yarn kbn bootstrap (check logs)`;
  }

  private async bootstrapThenStart(runtime: InstanceRuntime): Promise<void> {
    runtime.status = 'starting-es'; // show activity in UI

    const nodeBinDir = resolveNodeBin(runtime.config.dir);
    const env = buildEnv(nodeBinDir);

    pushLog(runtime, '[manager] Running yarn kbn bootstrap…');

    await new Promise<void>((resolve) => {
      const proc = spawn('yarn', ['kbn', 'bootstrap'], {
        cwd: runtime.config.dir,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      let stdoutBuf = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        stdoutBuf += chunk.toString();
        const lines = stdoutBuf.split('\n');
        stdoutBuf = lines.pop() ?? '';
        for (const line of lines) pushLog(runtime, `[bootstrap] ${line}`);
      });

      let stderrBuf = '';
      proc.stderr?.on('data', (chunk: Buffer) => {
        stderrBuf += chunk.toString();
        const lines = stderrBuf.split('\n');
        stderrBuf = lines.pop() ?? '';
        for (const line of lines) pushLog(runtime, `[bootstrap:err] ${line}`);
      });

      proc.on('exit', (code) => {
        if (stdoutBuf) pushLog(runtime, `[bootstrap] ${stdoutBuf}`);
        if (stderrBuf) pushLog(runtime, `[bootstrap:err] ${stderrBuf}`);
        pushLog(runtime, `[manager] Bootstrap finished (code=${code})`);
        resolve();
      });
    });

    runtime.status = 'stopped';
    await this.start(runtime.config.name);
  }

  private persistTemporaryInstances(): void {
    const temporary = Array.from(this.runtimes.values())
      .filter(r => r.config.type === 'temporary')
      .map(r => r.config);
    mergeState({ temporaryInstances: temporary });
  }

  async killInstance(branch: string): Promise<string> {
    const name = `kibana-${branch}`;
    const runtime = this.runtimes.get(name);
    if (!runtime) {
      throw new Error(`Instance '${name}' not found`);
    }

    const worktreeDir = runtime.config.dir;
    const isOwnedWorktree = worktreeDir.startsWith(WORKTREES_DIR);

    await this.stop(name);
    this.runtimes.delete(name);
    this.persistTemporaryInstances();

    // Only remove the worktree if it was created by us (inside WORKTREES_DIR)
    // Don't touch external worktrees that were just reused
    if (isOwnedWorktree) {
    try {
      execSync(`git -C "${KIBANA_REPO}" worktree remove --force "${worktreeDir}"`, {
        stdio: 'pipe',
      });
    } catch {
      try {
        execSync(`rm -rf "${worktreeDir}"`, { stdio: 'pipe' });
        execSync(`git -C "${KIBANA_REPO}" worktree prune`, { stdio: 'pipe' });
      } catch {
        // ignore
      }
    }
    }

    return `Killed instance '${name}' and removed worktree at '${worktreeDir}'`;
  }

  getInstances(): InstanceView[] {
    const views: InstanceView[] = [];

    for (const [, runtime] of this.runtimes) {
      const { config, status, esProcess, kibanaProcess, kibanaHealth } = runtime;
      views.push({
        name: config.name,
        type: config.type,
        branch: config.branch,
        kPort: config.kPort,
        esPort: config.esPort,
        status,
        tmuxRunning: esProcess !== null || kibanaProcess !== null,
        tmuxAttached: false,
        tmuxWindows: 0,
        kibanaHealth,
        url: `http://localhost:${config.kPort}`,
        dir: config.dir,
      });
    }

    return views;
  }

  getLogs(name: string): string[] {
    const runtime = this.runtimes.get(name);
    if (!runtime) {
      throw new Error(`Instance '${name}' not found`);
    }
    return runtime.logs;
  }

  getGitBranches(): string[] {
    try {
      const output = execSync(
        `git -C "${KIBANA_REPO}" branch --format='%(refname:short)'`,
        { stdio: 'pipe' }
      )
        .toString()
        .trim();

      if (!output) return [];

      return output
        .split('\n')
        .map((b) => b.trim())
        .filter(Boolean)
        .slice(0, 100);
    } catch {
      return [];
    }
  }

  async shutdown(): Promise<void> {
    const stops: Promise<string>[] = [];
    for (const [name, runtime] of this.runtimes) {
      if (runtime.status !== 'stopped') {
        stops.push(this.stop(name));
      }
    }
    await Promise.all(stops);

    if (this.healthPollTimer !== null) {
      clearInterval(this.healthPollTimer);
      this.healthPollTimer = null;
    }
  }
}

export const manager = new InstanceManager();
