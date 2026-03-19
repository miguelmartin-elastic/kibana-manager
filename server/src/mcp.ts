import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { API_PORT } from './config';

const BASE_URL = `http://localhost:${API_PORT}/api`;

async function api(method: string, path: string, body?: unknown): Promise<any> {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data: any = await res.json();
  if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
  return data;
}

const server = new McpServer({
  name: 'kibana-manager',
  version: '1.0.0',
});

server.registerTool(
  'list_instances',
  { description: 'List all Kibana/ES instances with their current status, ports, and health.' },
  async () => {
    const data = await api('GET', '/instances');
    return { content: [{ type: 'text', text: JSON.stringify(data.instances, null, 2) }] };
  }
);

server.registerTool(
  'create_instance',
  {
    description: 'Create a new temporary Kibana+ES instance from a git branch. Returns the instance name to use with other tools.',
    inputSchema: { branch: z.string().describe('Git branch name to create the instance from') },
  },
  async ({ branch }) => {
    const data = await api('POST', '/instances/new', { branch });
    return { content: [{ type: 'text', text: data.output }] };
  }
);

server.registerTool(
  'start_instance',
  {
    description: 'Start an instance (boots Elasticsearch then Kibana). This takes several minutes on first run due to bootstrap.',
    inputSchema: { name: z.string().describe('Instance name (e.g. "kibana-feat", "kibana-main", or a temporary instance name)') },
  },
  async ({ name }) => {
    const data = await api('POST', `/instances/${encodeURIComponent(name)}/start`);
    return { content: [{ type: 'text', text: data.output }] };
  }
);

server.registerTool(
  'stop_instance',
  {
    description: 'Stop a running instance (gracefully terminates ES and Kibana processes).',
    inputSchema: { name: z.string().describe('Instance name') },
  },
  async ({ name }) => {
    const data = await api('POST', `/instances/${encodeURIComponent(name)}/stop`);
    return { content: [{ type: 'text', text: data.output }] };
  }
);

server.registerTool(
  'kill_instance',
  {
    description: 'Permanently remove a temporary instance: stops it, deletes the git worktree and ES data. Cannot be used on permanent instances (kibana-feat, kibana-main).',
    inputSchema: { name: z.string().describe('Temporary instance name to remove') },
  },
  async ({ name }) => {
    const data = await api('DELETE', `/instances/${encodeURIComponent(name)}`);
    return { content: [{ type: 'text', text: data.output }] };
  }
);

server.registerTool(
  'switch_branch',
  {
    description: 'Switch the persistent kibana-feat instance to a different git branch.',
    inputSchema: { branch: z.string().describe('Git branch name to switch to') },
  },
  async ({ branch }) => {
    const data = await api('POST', '/instances/switch', { branch });
    return { content: [{ type: 'text', text: data.output }] };
  }
);

server.registerTool(
  'get_logs',
  {
    description: 'Get the most recent logs (last 300 lines) for an instance.',
    inputSchema: { name: z.string().describe('Instance name') },
  },
  async ({ name }) => {
    const data = await api('GET', `/instances/${encodeURIComponent(name)}/logs`);
    return { content: [{ type: 'text', text: (data.logs as string[]).join('\n') }] };
  }
);

server.registerTool(
  'list_branches',
  { description: 'List all available git branches in the Kibana repository.' },
  async () => {
    const data = await api('GET', '/git/branches');
    return { content: [{ type: 'text', text: (data.branches as string[]).join('\n') }] };
  }
);

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
