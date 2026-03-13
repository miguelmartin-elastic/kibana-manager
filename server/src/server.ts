import express, { Request, Response } from 'express';
import cors from 'cors';
import { manager } from './manager';
import { API_PORT } from './config';
import { analyzeLogsStream, applyProposalStream, Proposal } from './analyzer';
import fs from 'fs';
import path from 'path';
import os from 'os';

const pendingProposals = new Map<string, Proposal>();

const SETTINGS_FILE = path.join(os.homedir(), '.kibana-manager-settings.json');

function readSettings(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')); }
  catch { return {}; }
}
function writeSettings(s: Record<string, string>): void {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(s, null, 2), 'utf8');
}

const _boot = readSettings();
if (_boot.anthropicApiKey) process.env.ANTHROPIC_API_KEY = _boot.anthropicApiKey;

const app = express();
app.use(cors());
app.use(express.json());

// Helper: extract the segment(s) after a prefix, supporting slashes in the value
// e.g. prefix='/api/instances/', suffix='/start' → name from '/api/instances/foo/bar/start'
function extractParam(req: Request, prefix: string, suffix = ''): string {
  const raw = decodeURIComponent(req.path);
  const start = prefix.length;
  const end = suffix ? raw.lastIndexOf(suffix) : raw.length;
  return raw.slice(start, end);
}

// GET /api/instances
app.get('/api/instances', (_req, res: Response) => {
  try { res.json({ instances: manager.getInstances() }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/instances/new
app.post('/api/instances/new', async (req: Request, res: Response) => {
  try {
    const { branch } = req.body as { branch: string };
    if (!branch) { res.status(400).json({ error: 'branch is required' }); return; }
    res.json({ ok: true, output: await manager.newInstance(branch) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/instances/stop-all
app.post('/api/instances/stop-all', async (_req, res: Response) => {
  try {
    const running = manager.getInstances().filter(i => i.tmuxRunning);
    await Promise.all(running.map(i => manager.stop(i.name)));
    res.json({ ok: true, output: `Stopped ${running.length} instance(s)` });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/instances/switch
app.post('/api/instances/switch', async (req: Request, res: Response) => {
  try {
    const { branch } = req.body as { branch: string };
    if (!branch) { res.status(400).json({ error: 'branch is required' }); return; }
    res.json({ ok: true, output: await manager.switchBranch(branch) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// DELETE /api/instances/<branch>  (branch may contain slashes)
app.delete(/^\/api\/instances\/(.+)$/, async (req: Request, res: Response) => {
  try {
    const branch = decodeURIComponent((req.params as any)[0]);
    if (branch === 'feat' || branch === 'main') {
      res.status(400).json({ error: `Cannot delete permanent instance '${branch}'` }); return;
    }
    res.json({ ok: true, output: await manager.killInstance(branch) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/instances/<name>/start
app.post(/^\/api\/instances\/(.+)\/start$/, async (req: Request, res: Response) => {
  try {
    const name = decodeURIComponent((req.params as any)[0]);
    res.json({ ok: true, output: await manager.start(name) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/instances/<name>/stop
app.post(/^\/api\/instances\/(.+)\/stop$/, async (req: Request, res: Response) => {
  try {
    const name = decodeURIComponent((req.params as any)[0]);
    res.json({ ok: true, output: await manager.stop(name) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/instances/<name>/open
app.post(/^\/api\/instances\/(.+)\/open$/, (req: Request, res: Response) => {
  try {
    const name = decodeURIComponent((req.params as any)[0]);
    const inst = manager.getInstances().find(i => i.name === name);
    if (!inst) { res.status(404).json({ error: `Instance '${name}' not found` }); return; }
    const { spawn } = require('child_process');
    spawn('cursor', [inst.dir], { detached: true, stdio: 'ignore' }).unref();
    res.json({ ok: true });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// GET /api/instances/<name>/logs
app.get(/^\/api\/instances\/(.+)\/logs$/, (req: Request, res: Response) => {
  try {
    const name = decodeURIComponent((req.params as any)[0]);
    res.json({ logs: manager.getLogs(name) });
  } catch (e: any) { res.status(500).json({ error: e.message }); }
});

// POST /api/instances/<name>/analyze
app.post(/^\/api\/instances\/(.+)\/analyze$/, async (req: Request, res: Response) => {
  const name = decodeURIComponent((req.params as any)[0]);
  const logs = manager.getLogs(name);
  if (logs.length === 0) { res.status(400).json({ error: 'No logs available' }); return; }
  const proposal = await analyzeLogsStream(logs, res);
  if (proposal) pendingProposals.set(name, proposal);
});

// POST /api/instances/<name>/apply
app.post(/^\/api\/instances\/(.+)\/apply$/, async (req: Request, res: Response) => {
  const name = decodeURIComponent((req.params as any)[0]);
  const proposal = pendingProposals.get(name);
  if (!proposal) { res.status(400).json({ error: 'No pending proposal. Run analyze first.' }); return; }
  await applyProposalStream(proposal, res);
  pendingProposals.delete(name);
});

// GET /api/settings
app.get('/api/settings', (_req, res: Response) => {
  res.json({ anthropicApiKeySet: !!readSettings().anthropicApiKey });
});

// POST /api/settings
app.post('/api/settings', (req: Request, res: Response) => {
  const { anthropicApiKey } = req.body as { anthropicApiKey?: string };
  const s = readSettings();
  if (anthropicApiKey !== undefined) {
    s.anthropicApiKey = anthropicApiKey;
    process.env.ANTHROPIC_API_KEY = anthropicApiKey;
  }
  writeSettings(s);
  res.json({ ok: true });
});

// GET /api/git/branches
app.get('/api/git/branches', (_req, res: Response) => {
  try { res.json({ branches: manager.getGitBranches() }); }
  catch (e: any) { res.status(500).json({ error: e.message }); }
});

const shutdown = async () => {
  console.log('[server] Shutting down...');
  await manager.shutdown();
  process.exit(0);
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

app.listen(API_PORT, () => {
  console.log(`[server] Kibana manager listening on port ${API_PORT}`);
});
