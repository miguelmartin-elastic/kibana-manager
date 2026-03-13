const express = require('express');
const cors    = require('cors');
const { exec } = require('child_process');
const http    = require('http');
const fs      = require('fs');
const path    = require('path');
const os      = require('os');

const app  = express();
const PORT = 3001;

app.use(cors());
app.use(express.json());

const HOME       = os.homedir();
const STATE_FILE = path.join(HOME, '.kibana-dev-state');
const WORKTREES  = path.join(HOME, 'worktrees');
const DEV_SCRIPT = path.join(HOME, 'dev-start.sh');

// eslint-disable-next-line no-control-regex
const stripAnsi = s => (s ?? '').replace(/(\x1b|\\033)\[[0-9;]*m/g, '');

const ENV = { ...process.env, PATH: `/opt/homebrew/bin:${process.env.PATH}` };

function run(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { timeout: 30000, env: ENV }, (err, stdout, stderr) => {
      if (err) reject({ code: err.code, stderr: stripAnsi(stderr), stdout: stripAnsi(stdout) });
      else resolve(stripAnsi(stdout).trim());
    });
  });
}

function readState() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8');
    const state = {};
    raw.split('\n').forEach(line => {
      const [k, ...v] = line.split('=');
      if (k) state[k.trim()] = v.join('=').trim();
    });
    return state;
  } catch { return {}; }
}

async function listTmuxSessions() {
  try {
    const out = await run("tmux ls -F '#{session_name}:#{session_windows}:#{session_attached}'");
    return out.split('\n').filter(Boolean).map(line => {
      const [name, windows, attached] = line.split(':');
      return { name, windows: parseInt(windows), attached: attached === '1' };
    });
  } catch { return []; }
}

function checkKibanaHealth(port) {
  return new Promise(resolve => {
    const req = http.get(
      { hostname: 'localhost', port, path: '/api/status', timeout: 2000,
        headers: { 'kbn-xsrf': 'true' } },
      res => {
        let data = '';
        res.on('data', d => data += d);
        res.on('end', () => {
          try {
            const json = JSON.parse(data);
            resolve({ up: res.statusCode < 500, status: json?.status?.overall?.level ?? 'unknown', version: json?.version?.number ?? null });
          } catch { resolve({ up: res.statusCode < 500, status: 'unknown', version: null }); }
        });
      }
    );
    req.on('error', () => resolve({ up: false, status: 'down', version: null }));
    req.on('timeout', () => { req.destroy(); resolve({ up: false, status: 'timeout', version: null }); });
  });
}

async function buildInstances() {
  const sessions = await listTmuxSessions();
  const state    = readState();
  const featBranch = state['FEAT_BRANCH'] ?? state['CURRENT_FEAT_BRANCH'] ?? 'unknown';

  const known = [
    { name: 'kibana-feat', type: 'permanent', branch: featBranch, kPort: 5601, esPort: 9200 },
    { name: 'kibana-main', type: 'permanent', branch: 'main',     kPort: 5602, esPort: 9201 },
  ];

  const tempSessions = sessions.filter(s =>
    s.name.startsWith('kibana-') && s.name !== 'kibana-feat' && s.name !== 'kibana-main'
  );

  let nextPort = 5603;
  const tempInstances = tempSessions.map(s => {
    const branch = s.name.replace(/^kibana-/, '');
    return { name: s.name, type: 'temporary', branch, kPort: nextPort++, esPort: nextPort + 1598 };
  });

  return Promise.all([...known, ...tempInstances].map(async inst => {
    const session = sessions.find(s => s.name === inst.name);
    const health  = await checkKibanaHealth(inst.kPort);
    return { ...inst, tmuxRunning: !!session, tmuxAttached: session?.attached ?? false,
             tmuxWindows: session?.windows ?? 0, kibanaHealth: health,
             url: `http://localhost:${inst.kPort}` };
  }));
}

app.get('/api/instances', async (req, res) => {
  try { res.json({ instances: await buildInstances() }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/instances/new', async (req, res) => {
  const { branch, full = false } = req.body;
  if (!branch) return res.status(400).json({ error: 'branch required' });
  try { res.json({ ok: true, output: await run(`bash ${DEV_SCRIPT} new ${branch}${full ? ' --full' : ''}`) }); }
  catch (e) { res.status(500).json({ error: e.stderr || e.stdout || e.message }); }
});

app.post('/api/instances/switch', async (req, res) => {
  const { branch } = req.body;
  if (!branch) return res.status(400).json({ error: 'branch required' });
  try { res.json({ ok: true, output: await run(`bash ${DEV_SCRIPT} switch ${branch}`) }); }
  catch (e) { res.status(500).json({ error: e.stderr || e.stdout || e.message }); }
});

app.delete('/api/instances/:branch', async (req, res) => {
  const { branch } = req.params;
  if (branch === 'feat' || branch === 'main') return res.status(400).json({ error: 'Cannot kill permanent sessions' });
  try { res.json({ ok: true, output: await run(`bash ${DEV_SCRIPT} kill ${branch}`) }); }
  catch (e) { res.status(500).json({ error: e.stderr || e.stdout || e.message }); }
});

app.post('/api/instances/:name/start', async (req, res) => {
  try { res.json({ ok: true, output: await run(`bash ${DEV_SCRIPT}`) }); }
  catch (e) { res.status(500).json({ error: e.stderr || e.stdout || e.message }); }
});

app.post('/api/instances/:name/stop', async (req, res) => {
  const { name } = req.params;
  if (name === 'kibana-feat' || name === 'kibana-main') return res.status(400).json({ error: 'Use kill for permanent sessions' });
  try { await run(`tmux kill-session -t ${name}`); res.json({ ok: true }); }
  catch (e) { res.status(500).json({ error: e.stderr || e.stdout || e.message }); }
});

app.get('/api/git/branches', async (req, res) => {
  try {
    const out = await run(`git -C ${path.join(HOME, 'elastic/kibana')} branch --format='%(refname:short)' | head -100`);
    res.json({ branches: out.split('\n').filter(Boolean) });
  } catch { res.json({ branches: [] }); }
});

app.listen(PORT, () => console.log(`Kibana Manager API → http://localhost:${PORT}`));
