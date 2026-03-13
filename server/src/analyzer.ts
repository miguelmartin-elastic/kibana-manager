import { spawn } from 'child_process';
import { Response } from 'express';
import path from 'path';
import os from 'os';

const PROJECT_DIR = path.resolve(__dirname, '..');
const HOME = os.homedir();
const CLAUDE_BIN = `${HOME}/.local/bin/claude`;

export interface ProposedChange {
  file: string;
  description: string;
  oldCode: string;
  newCode: string;
}

export interface Proposal {
  summary: string;
  rootCause: string;
  proposedChanges: ProposedChange[];
}

function sendEvent(res: Response, event: string, data: unknown) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

function initSse(res: Response) {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
}

function buildEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env.CLAUDECODE;        // allow nested sessions
  delete env.ANTHROPIC_API_KEY; // use enterprise Claude Code auth, not API key
  const extras = [`${HOME}/.local/bin`, '/usr/local/bin', '/opt/homebrew/bin'];
  for (const p of extras) {
    if (!(env.PATH ?? '').includes(p)) env.PATH = `${p}:${env.PATH}`;
  }
  return env;
}

function runClaude(
  prompt: string,
  tools: string[],
  maxTurns: number,
  res: Response,
  onResult?: (text: string) => void,
): Promise<void> {
  return new Promise((resolve) => {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--allowedTools', tools.join(','),
      '--permission-mode', 'acceptEdits',
      '--max-turns', String(maxTurns),
      '--verbose',
    ];

    const proc = spawn(CLAUDE_BIN, args, {
      cwd: PROJECT_DIR,
      env: buildEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = '';
    proc.stdout?.on('data', (chunk: Buffer) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop() ?? '';
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.type === 'assistant') {
            for (const block of msg.message?.content ?? []) {
              if (block.type === 'text' && block.text) {
                sendEvent(res, 'agent_text', { text: block.text });
              }
            }
          } else if (msg.type === 'result') {
            const text = msg.result ?? msg.error ?? '';
            if (text) sendEvent(res, 'agent_result', { text });
            if (onResult) onResult(text);
          }
        } catch { /* non-JSON line, skip */ }
      }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) sendEvent(res, 'agent_text', { text: `[debug] ${text}` });
    });

    proc.on('exit', () => resolve());
  });
}

export async function analyzeLogsStream(logs: string[], res: Response): Promise<Proposal | null> {
  initSse(res);

  const prompt = `You are analyzing error logs from a Kibana instance manager built with Node.js and TypeScript.

Project location: ${PROJECT_DIR}

The manager spawns Elasticsearch and Kibana processes as Node.js child processes.

Key files:
- src/manager.ts: Process lifecycle (spawn, stop, health, bootstrap)
- src/server.ts: Express REST API
- src/config.ts: Configuration constants
- src/types.ts: TypeScript types
- src/health.ts: Kibana health check
- src/nvm.ts: Node version resolution

Here are the logs to analyze:
<logs>
${logs.join('\n')}
</logs>

Please:
1. Read the relevant source files to understand the current implementation
2. Identify the root cause of the errors shown in the logs
3. Propose specific, minimal code changes to make the system more resilient

Output your final analysis as a JSON object with EXACTLY this structure (raw JSON, no markdown):
{
  "summary": "one-line description of the issue",
  "rootCause": "technical explanation of why this happens",
  "proposedChanges": [
    {
      "file": "absolute path to file",
      "description": "what this change does and why",
      "oldCode": "exact code string to find and replace",
      "newCode": "replacement code"
    }
  ]
}`;

  let proposal: Proposal | null = null;

  await runClaude(prompt, ['Read', 'Glob', 'Grep'], 20, res, (result) => {
    try {
      const match = result.match(/\{[\s\S]*\}/);
      if (match) proposal = JSON.parse(match[0]) as Proposal;
    } catch { /* not valid json */ }
  });

  sendEvent(res, 'done', { proposal });
  res.end();
  return proposal;
}

export async function applyProposalStream(proposal: Proposal, res: Response): Promise<void> {
  initSse(res);

  const changesText = proposal.proposedChanges.map((c, i) =>
    `Change ${i + 1}: ${c.description}\nFile: ${c.file}\nReplace:\n${c.oldCode}\nWith:\n${c.newCode}`
  ).join('\n\n---\n\n');

  const prompt = `Apply the following code changes to fix a bug in the kibana-manager project.

Summary: ${proposal.summary}
Root cause: ${proposal.rootCause}

Changes to apply:
${changesText}

For each change:
1. Read the file to confirm the code exists as described
2. Use Edit to apply the change
3. If the exact oldCode is not found, find the closest match and adapt accordingly

After all changes, confirm what was done.`;

  await runClaude(prompt, ['Read', 'Edit', 'Glob', 'Grep'], 30, res);

  sendEvent(res, 'done', {});
  res.end();
}
