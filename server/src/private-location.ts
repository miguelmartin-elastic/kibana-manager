import { execSync, spawn, ChildProcess } from 'child_process';
import http from 'http';

interface KibanaRequestOptions {
  method: string;
  path: string;
  body?: Record<string, unknown>;
  kibanaUrl: string;
  username?: string;
  password?: string;
}

function kibanaRequest(opts: KibanaRequestOptions): Promise<{ status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const url = new URL(opts.kibanaUrl);
    const payload = opts.body ? JSON.stringify(opts.body) : undefined;
    const auth = `${opts.username ?? 'elastic'}:${opts.password ?? 'changeme'}`;

    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: opts.path,
        method: opts.method,
        headers: {
          'kbn-xsrf': 'true',
          'elastic-api-version': '2023-10-31',
          'Content-Type': 'application/json',
          Authorization: `Basic ${Buffer.from(auth).toString('base64')}`,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
        timeout: 30000,
      },
      (res) => {
        let data = '';
        res.on('data', (chunk) => (data += chunk));
        res.on('end', () => {
          try {
            resolve({ status: res.statusCode ?? 0, data: JSON.parse(data) });
          } catch {
            resolve({ status: res.statusCode ?? 0, data });
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Kibana request timed out')); });
    if (payload) req.write(payload);
    req.end();
  });
}

function sanitizeForDocker(name: string): string {
  return name.replace(/[^a-zA-Z0-9_.-]/g, '-');
}

function containerName(instanceName: string, role: 'fleet-server' | 'agent'): string {
  return `km-${sanitizeForDocker(instanceName)}-${role}`;
}

function policyName(instanceName: string): string {
  return `kibana-manager-${instanceName}`;
}

function locationName(instanceName: string): string {
  return `kibana-manager-${instanceName}`;
}

function isContainerRunning(name: string): boolean {
  try {
    const out = execSync(`docker ps -q --filter name=^/${name}$`, { stdio: 'pipe' }).toString().trim();
    return out.length > 0;
  } catch {
    return false;
  }
}

function removeContainer(name: string): void {
  try {
    execSync(`docker stop ${name}`, { stdio: 'pipe', timeout: 15000 });
  } catch { /* container might not exist */ }
  try {
    execSync(`docker rm -f ${name}`, { stdio: 'pipe', timeout: 10000 });
  } catch { /* ignore */ }
}

async function getKibanaVersion(kibanaUrl: string): Promise<string> {
  const res = await kibanaRequest({ method: 'GET', path: '/api/status', kibanaUrl });
  return res.data?.version?.number ?? '8.0.0';
}

async function waitForFleetReady(
  kibanaUrl: string,
  log: (msg: string) => void,
  maxWaitMs = 120000,
): Promise<void> {
  const pollMs = 5000;
  const deadline = Date.now() + maxWaitMs;

  log('[priv-location] Waiting for Fleet to be ready…');

  while (Date.now() < deadline) {
    try {
      const res = await kibanaRequest({ method: 'GET', path: '/api/fleet/agents/setup', kibanaUrl });
      if (res.data?.isReady) {
        log('[priv-location] Fleet is ready.');
        return;
      }
    } catch {
      // connection error — Kibana may still be starting
    }
    await new Promise(r => setTimeout(r, pollMs));
  }

  log('[priv-location] Warning: Fleet readiness check timed out — proceeding anyway');
}

async function findOrCreateAgentPolicy(
  instanceName: string,
  kibanaUrl: string,
  log: (msg: string) => void,
): Promise<string> {
  const name = policyName(instanceName);

  // Check if policy already exists
  const search = await kibanaRequest({
    method: 'GET',
    path: `/api/fleet/agent_policies?kuery=name:${encodeURIComponent(`"${name}"`)}`,
    kibanaUrl,
  });

  const existing = search.data?.items?.find((p: any) => p.name === name);
  if (existing) {
    log(`[priv-location] Reusing existing agent policy '${name}' (${existing.id})`);
    return existing.id;
  }

  const create = await kibanaRequest({
    method: 'POST',
    path: '/api/fleet/agent_policies',
    kibanaUrl,
    body: {
      name,
      description: `Managed by kibana-manager for instance ${instanceName}`,
      namespace: 'default',
      monitoring_enabled: ['logs', 'metrics'],
      inactivity_timeout: 1209600,
      is_protected: false,
    },
  });

  if (create.status >= 400) {
    throw new Error(`Failed to create agent policy: ${JSON.stringify(create.data)}`);
  }

  const id = create.data?.item?.id;
  log(`[priv-location] Created agent policy '${name}' (${id})`);
  return id;
}

async function findOrCreatePrivateLocation(
  instanceName: string,
  kibanaUrl: string,
  agentPolicyId: string,
  log: (msg: string) => void,
): Promise<string> {
  const label = locationName(instanceName);

  // Check if private location already exists
  const list = await kibanaRequest({
    method: 'GET',
    path: '/api/synthetics/private_locations',
    kibanaUrl,
  });

  const existing = (list.data ?? []).find((loc: any) => loc.label === label);
  if (existing) {
    log(`[priv-location] Reusing existing private location '${label}' (${existing.id})`);
    return existing.id;
  }

  const create = await kibanaRequest({
    method: 'POST',
    path: '/api/synthetics/private_locations',
    kibanaUrl,
    body: { label, agentPolicyId },
  });

  if (create.status >= 400) {
    throw new Error(`Failed to create private location: ${JSON.stringify(create.data)}`);
  }

  log(`[priv-location] Created private location '${label}' (${create.data?.id})`);
  return create.data?.id;
}

async function getEnrollmentToken(
  kibanaUrl: string,
  agentPolicyId: string,
): Promise<string> {
  const res = await kibanaRequest({
    method: 'GET',
    path: `/api/fleet/enrollment_api_keys?kuery=policy_id:${agentPolicyId}`,
    kibanaUrl,
  });

  const token = res.data?.list?.[0]?.api_key;
  if (!token) throw new Error('No enrollment token found for agent policy');
  return token;
}

function startFleetServerContainer(
  instanceName: string,
  esHost: string,
  kibanaUrl: string,
  version: string,
  log: (msg: string) => void,
): ChildProcess {
  const name = containerName(instanceName, 'fleet-server');

  if (isContainerRunning(name)) {
    log(`[priv-location] Fleet Server container '${name}' already running`);
    // Return a dummy process — container is managed by Docker
    return spawn('docker', ['logs', '-f', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  removeContainer(name);

  const esUrl = new URL(esHost);
  if (esUrl.hostname === 'localhost') esUrl.hostname = 'host.docker.internal';
  const kUrl = new URL(kibanaUrl);
  if (kUrl.hostname === 'localhost') kUrl.hostname = 'host.docker.internal';

  log(`[priv-location] Starting Fleet Server container '${name}'…`);

  const proc = spawn('docker', [
    'run',
    '--name', name,
    '-e', 'FLEET_SERVER_ENABLE=1',
    '-e', `FLEET_SERVER_ELASTICSEARCH_HOST=${esUrl.origin}`,
    '-e', 'FLEET_SERVER_POLICY_ID=fleet-server-policy',
    '-e', 'FLEET_INSECURE=1',
    '-e', `KIBANA_HOST=${kUrl.origin}`,
    '-e', 'KIBANA_USERNAME=elastic',
    '-e', 'KIBANA_PASSWORD=changeme',
    '-e', 'KIBANA_FLEET_SETUP=1',
    '-p', '8220:8220',
    `docker.elastic.co/elastic-agent/elastic-agent:${version}-SNAPSHOT`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return proc;
}

function startAgentContainer(
  instanceName: string,
  enrollmentToken: string,
  version: string,
  log: (msg: string) => void,
): ChildProcess {
  const name = containerName(instanceName, 'agent');

  if (isContainerRunning(name)) {
    log(`[priv-location] Agent container '${name}' already running`);
    return spawn('docker', ['logs', '-f', name], { stdio: ['ignore', 'pipe', 'pipe'] });
  }

  removeContainer(name);

  log(`[priv-location] Starting Agent container '${name}'…`);

  const proc = spawn('docker', [
    'run',
    '--name', name,
    '-e', 'FLEET_URL=https://host.docker.internal:8220',
    '-e', 'FLEET_ENROLL=1',
    '-e', `FLEET_ENROLLMENT_TOKEN=${enrollmentToken}`,
    '-e', 'FLEET_INSECURE=1',
    `docker.elastic.co/elastic-agent/elastic-agent-complete:${version}-SNAPSHOT`,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  return proc;
}

export interface PrivateLocationResult {
  fleetServerProc: ChildProcess;
  agentProc: ChildProcess;
}

async function waitForFleetServer(
  log: (msg: string) => void,
  maxWaitMs = 120000,
): Promise<void> {
  const pollMs = 5000;
  const deadline = Date.now() + maxWaitMs;

  log('[priv-location] Waiting for Fleet Server to be ready on port 8220…');

  while (Date.now() < deadline) {
    try {
      execSync('curl -sk https://localhost:8220/api/status', { stdio: 'pipe', timeout: 5000 });
      log('[priv-location] Fleet Server is ready.');
      return;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, pollMs));
  }

  log('[priv-location] Warning: Fleet Server readiness check timed out — proceeding anyway');
}

export async function setupPrivateLocation(
  instanceName: string,
  kibanaUrl: string,
  esHost: string,
  log: (msg: string) => void,
): Promise<PrivateLocationResult> {
  log('[priv-location] Setting up private location (idempotent)…');

  await waitForFleetReady(kibanaUrl, log);

  const agentPolicyId = await findOrCreateAgentPolicy(instanceName, kibanaUrl, log);
  await findOrCreatePrivateLocation(instanceName, kibanaUrl, agentPolicyId, log);
  const enrollmentToken = await getEnrollmentToken(kibanaUrl, agentPolicyId);
  const version = await getKibanaVersion(kibanaUrl);

  log(`[priv-location] Kibana version: ${version}, starting Docker containers…`);

  const fleetServerProc = startFleetServerContainer(instanceName, esHost, kibanaUrl, version, log);
  await waitForFleetServer(log);
  const agentProc = startAgentContainer(instanceName, enrollmentToken, version, log);

  return { fleetServerProc, agentProc };
}

export function teardownPrivateLocation(
  instanceName: string,
  log: (msg: string) => void,
): void {
  const fleet = containerName(instanceName, 'fleet-server');
  const agent = containerName(instanceName, 'agent');

  log(`[priv-location] Stopping Docker containers…`);
  removeContainer(agent);
  removeContainer(fleet);
  log(`[priv-location] Docker containers removed.`);
}

export function areContainersRunning(instanceName: string): boolean {
  return (
    isContainerRunning(containerName(instanceName, 'fleet-server')) ||
    isContainerRunning(containerName(instanceName, 'agent'))
  );
}
