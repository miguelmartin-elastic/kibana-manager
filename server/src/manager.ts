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
import { setupPrivateLocation, teardownPrivateLocation, areContainersRunning } from './private-location';

interface InstanceRuntime {
  config: InstanceConfig;
  status: InstanceStatus;
  esProcess: ChildProcess | null;
  kibanaProcess: ChildProcess | null;
  privateLocationProcess: ChildProcess | null;
  privateLocationEnabled: boolean;
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

function nextFreePort(startPort: number, exclude: Set<number> = new Set()): Promise<number> {
  return new Promise((resolve) => {
    const tryPort = (port: number) => {
      if (exclude.has(port)) {
        tryPort(port + 1);
        return;
      }
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

const PRIV_LOCATION_FLEET_CONFIG = (esPort: number) => `
# Private Location Fleet config (added by kibana-manager — do not edit manually)
xpack.fleet.agentPolicies:
  - name: Fleet Server policy
    id: fleet-server-policy
    is_default_fleet_server: true
    description: Fleet server policy
    namespace: default
    package_policies:
      - name: Fleet Server
        package:
          name: fleet_server
        inputs:
          - type: fleet-server
            keep_enabled: true
            vars:
              - name: host
                value: 0.0.0.0
                frozen: true
              - name: port
                value: 8220
                frozen: true

xpack.fleet.fleetServerHosts:
  - id: default-fleet-server
    name: Default Fleet server
    is_default: true
    host_urls: ['https://host.docker.internal:8220']

xpack.fleet.outputs:
  - id: es-default-output
    name: Default output
    type: elasticsearch
    is_default: true
    is_default_monitoring: true
    hosts: ['http://host.docker.internal:${esPort}']

xpack.fleet.packages:
  - name: fleet_server
    version: latest
`;

function patchKibanaDevYml(dir: string, esPort: number): void {
  const configPath = path.join(dir, 'config', 'kibana.dev.yml');
  const backupPath = `${configPath}.kibana-manager-backup`;

  // Use existing backup as base (idempotent re-patch)
  const sourcePath = fs.existsSync(backupPath) ? backupPath : configPath;
  let original = '';
  if (fs.existsSync(sourcePath)) {
    original = fs.readFileSync(sourcePath, 'utf8');
  }

  // Save backup of original (only once)
  if (!fs.existsSync(backupPath)) {
    fs.writeFileSync(backupPath, original, 'utf8');
  }

  // Comment out all non-empty, non-comment lines
  const commented = original.split('\n').map(line => {
    if (line.trim() === '' || line.trim().startsWith('#')) return line;
    return `# ${line}`;
  }).join('\n');

  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, commented + PRIV_LOCATION_FLEET_CONFIG(esPort), 'utf8');
}

function restoreKibanaDevYml(dir: string): void {
  const configPath = path.join(dir, 'config', 'kibana.dev.yml');
  const backupPath = `${configPath}.kibana-manager-backup`;
  if (fs.existsSync(backupPath)) {
    fs.writeFileSync(configPath, fs.readFileSync(backupPath, 'utf8'), 'utf8');
    fs.rmSync(backupPath);
  }
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
  private bootstrapConcurrency = 2;
  private bootstrapRunning = 0;
  private bootstrapWaiters: Array<() => void> = [];

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
        privateLocationProcess: null,
        privateLocationEnabled: false,
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
          privateLocationProcess: null,
          privateLocationEnabled: false,
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

    // Limit concurrent bootstraps so they don't OOM the machine
    this.runWithConcurrencyLimit(() => this.bootstrapThenStart(runtime)).catch(() => {});
    return `Starting ${name} (running yarn kbn bootstrap first — check logs)...`;
  }

  private spawnEs(runtime: InstanceRuntime): void {
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

    // When privateLocationEnabled, keep Docker containers alive and yml patched
    // so they reconnect automatically on next start. Only kill the log-tailing
    // process handle (not the actual containers).
    if (runtime.privateLocationProcess) {
      const proc = runtime.privateLocationProcess;
      runtime.privateLocationProcess = null;
      if (!runtime.privateLocationEnabled) {
        kills.push(killProcess(proc));
      } else {
        // Just detach our process handle; Docker containers keep running
        try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      }
    }

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

    const usedPorts = new Set(
      Array.from(this.runtimes.values()).flatMap(r => [r.config.kPort, r.config.esPort])
    );
    const kPort = await nextFreePort(5603, usedPorts);
    usedPorts.add(kPort);
    const esPort = await nextFreePort(9202, usedPorts);

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
      privateLocationProcess: null,
      privateLocationEnabled: false,
      logs: [],
      kibanaHealth: { up: false, status: 'down', version: null },
      esStartupTimer: null,
    };

    this.runtimes.set(name, runtime);
    this.persistTemporaryInstances();

    // start() sets status + fires bootstrap (fire-and-forget)
    void this.start(name);
    return `Created instance '${name}' on Kibana :${kPort} / ES :${esPort} — running yarn kbn bootstrap (check logs)`;
  }

  private async runWithConcurrencyLimit(fn: () => Promise<void>): Promise<void> {
    if (this.bootstrapRunning >= this.bootstrapConcurrency) {
      await new Promise<void>(resolve => this.bootstrapWaiters.push(resolve));
    }
    this.bootstrapRunning++;
    try {
      await fn();
    } finally {
      this.bootstrapRunning--;
      this.bootstrapWaiters.shift()?.();
    }
  }

  private async bootstrapThenStart(runtime: InstanceRuntime): Promise<void> {
    // runtime.status is already 'starting-es' (set by start())
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

    // If stop() was called while bootstrapping, don't spawn processes
    if (runtime.status === 'stopped') return;

    this.spawnEs(runtime);

    // If private location was enabled before stop, restore it after Kibana is healthy
    if (runtime.privateLocationEnabled) {
      this.restorePrivateLocation(runtime);
    }
  }

  private async restorePrivateLocation(runtime: InstanceRuntime): Promise<void> {
    pushLog(runtime, '[priv-location] Private location enabled — will verify after Kibana is healthy…');

    const MAX_WAIT_MS = 10 * 60 * 1000;
    const POLL_MS = 5000;
    const deadline = Date.now() + MAX_WAIT_MS;

    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, POLL_MS));

      if (runtime.status === 'stopped' || runtime.status === 'error') {
        pushLog(runtime, '[priv-location] Aborted restore: instance stopped or errored');
        return;
      }

      const health = await checkKibanaHealth(runtime.config.kPort);
      if (health.up) break;

      if (Date.now() + POLL_MS >= deadline) {
        pushLog(runtime, '[priv-location] Timed out waiting for Kibana to restore private location');
        return;
      }
    }

    // Docker containers should still be running from before stop()
    if (areContainersRunning(runtime.config.name)) {
      pushLog(runtime, '[priv-location] Docker containers still running — private location restored');
      // Attach a log-tailing process so the UI shows the badge
      const { spawn: nodeSpawn } = require('child_process') as typeof import('child_process');
      const containerName = `km-${runtime.config.name.replace(/[^a-zA-Z0-9_.-]/g, '-')}-agent`;
      runtime.privateLocationProcess = nodeSpawn('docker', ['logs', '-f', containerName], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      return;
    }

    // Containers died — re-setup via API + Docker
    pushLog(runtime, '[priv-location] Docker containers not running — re-creating…');
    const MAX_RETRIES = 5;
    const RETRY_BASE_MS = 3000;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const { kPort, esPort } = runtime.config;
        const result = await setupPrivateLocation(
          runtime.config.name,
          `http://localhost:${kPort}`,
          `http://localhost:${esPort}`,
          (msg) => pushLog(runtime, msg),
        );
        runtime.privateLocationProcess = result.agentProc;
        this.pipeProcessLogs(result.fleetServerProc, runtime, 'fleet-server');
        this.pipeProcessLogs(result.agentProc, runtime, 'agent');
        return;
      } catch (e: any) {
        const isTransient = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket hang up|not available with the current configuration/i.test(e.message);
        if (isTransient && attempt < MAX_RETRIES) {
          const delayMs = RETRY_BASE_MS * attempt;
          pushLog(runtime, `[priv-location] Transient error (${e.message}), retrying in ${delayMs / 1000}s (attempt ${attempt}/${MAX_RETRIES})…`);
          await new Promise(r => setTimeout(r, delayMs));
          continue;
        }
        pushLog(runtime, `[priv-location] Failed to restore: ${e.message}`);
        return;
      }
    }
  }

  private pipeProcessLogs(proc: ChildProcess, runtime: InstanceRuntime, label: string): void {
    let stdoutBuf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      stdoutBuf += chunk.toString();
      const lines = stdoutBuf.split('\n');
      stdoutBuf = lines.pop() ?? '';
      for (const line of lines) pushLog(runtime, `[priv-location:${label}] ${line}`);
    });
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
      const lines = stderrBuf.split('\n');
      stderrBuf = lines.pop() ?? '';
      for (const line of lines) pushLog(runtime, `[priv-location:${label}:err] ${line}`);
    });
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

    // Clean up Docker containers before stopping (stop() preserves them when enabled)
    if (runtime.privateLocationEnabled) {
      runtime.privateLocationEnabled = false;
      teardownPrivateLocation(name, (msg) => pushLog(runtime, msg));
      restoreKibanaDevYml(runtime.config.dir);
    }

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

  async startPrivateLocation(name: string): Promise<string> {
    const runtime = this.runtimes.get(name);
    if (!runtime) throw new Error(`Instance '${name}' not found`);

    if (runtime.privateLocationEnabled && areContainersRunning(name)) {
      return `Private location already running for '${name}'`;
    }

    runtime.privateLocationEnabled = true;

    // Patch kibana.dev.yml with Fleet config (backs up original automatically)
    patchKibanaDevYml(runtime.config.dir, runtime.config.esPort);
    pushLog(runtime, '[priv-location] Patched kibana.dev.yml with Fleet config');

    // Restart Kibana so it picks up the new config
    if (runtime.status !== 'stopped') {
      pushLog(runtime, '[priv-location] Stopping instance to apply Fleet config…');
      await this.stop(name);
    }

    // start() fires bootstrap then ES then Kibana; restorePrivateLocation() will
    // handle the Docker containers + Kibana API setup once Kibana is healthy
    void this.start(name);

    return `Private location setup started for '${name}' — check logs`;
  }

  async stopPrivateLocation(name: string): Promise<string> {
    const runtime = this.runtimes.get(name);
    if (!runtime) throw new Error(`Instance '${name}' not found`);

    runtime.privateLocationEnabled = false;

    if (runtime.privateLocationProcess) {
      try { runtime.privateLocationProcess.kill('SIGTERM'); } catch { /* ignore */ }
      runtime.privateLocationProcess = null;
    }

    teardownPrivateLocation(name, (msg) => pushLog(runtime, msg));
    restoreKibanaDevYml(runtime.config.dir);
    pushLog(runtime, '[priv-location] Stopped. Docker containers removed, kibana.dev.yml restored.');

    return `Stopped private location for '${name}'`;
  }

  getInstances(): InstanceView[] {
    const views: InstanceView[] = [];

    for (const [, runtime] of this.runtimes) {
      const { config, status, esProcess, kibanaProcess, kibanaHealth, privateLocationEnabled } = runtime;
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
        privLocationRunning: privateLocationEnabled,
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
    // Clean up Docker containers for all private-location-enabled instances
    for (const [name, runtime] of this.runtimes) {
      if (runtime.privateLocationEnabled) {
        runtime.privateLocationEnabled = false;
        teardownPrivateLocation(name, () => {});
        restoreKibanaDevYml(runtime.config.dir);
      }
    }

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
