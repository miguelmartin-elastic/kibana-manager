# Kibana Manager

Local dashboard for managing multiple Kibana + Elasticsearch instances from the [Elastic Kibana](https://github.com/elastic/kibana) repository.

Built with **Express** (TypeScript) and **React** (Vite).

## Requirements

- **Node.js** (managed via [nvm](https://github.com/nvm-sh/nvm) — the app reads `.nvmrc` from each Kibana worktree)
- **npm**
- **Git** with worktree support
- **Kibana repo** cloned at `~/elastic/kibana`
- **Claude CLI** installed at `~/.local/bin/claude` (only needed for the "fix with Claude" log analysis feature)
- **macOS** (paths and tooling assume a Mac environment)

### Directory layout expected

```
~/elastic/kibana        # Main Kibana repo checkout
~/worktrees/            # Git worktrees for temporary instances
~/Documents/Development/kibana/es_data/   # Elasticsearch data directories
```

## Installation

```bash
git clone <repo-url> kibana-manager
cd kibana-manager

# Install root dependencies
npm install

# Install server dependencies
npm install --prefix server

# Install UI dependencies
npm install --prefix ui
```

## Running

```bash
# Start both server (port 3001) and UI dev server
npm run dev
```

Or run them independently:

```bash
npm run dev:server   # Express API on http://localhost:3001
npm run dev:ui       # Vite dev server for the React UI
```

## Usage

### Instance types

- **Permanent instances** — `kibana-feat` and `kibana-main` are always present. `kibana-feat` can be switched between branches; `kibana-main` always tracks `main`.
- **Temporary instances** — Created on-demand from any branch. Each gets its own git worktree, ports, and ES data directory.

### Actions

| Action | Description |
|--------|-------------|
| **Start** | Spawns Elasticsearch (`yarn es snapshot`) and Kibana (`yarn start`) for the instance |
| **Stop** | Stops both ES and Kibana processes |
| **Stop All** | Stops all running instances at once |
| **Switch Branch** | Changes `kibana-feat` to a different branch (runs `git checkout`, `yarn kbn bootstrap`) |
| **New Instance** | Creates a temporary instance from a branch via `git worktree add` + bootstrap |
| **Kill** | Removes a temporary instance (stops processes, removes worktree and ES data) |
| **Open in Cursor** | Opens the instance directory in Cursor IDE |
| **Logs** | Shows live process logs (Kibana + ES) with auto-refresh every 2 seconds |
| **Fix with Claude** | Sends error logs to Claude CLI for analysis; proposes and can apply code fixes |
| **Private Location** | Starts/stops a Synthetics private location agent for the instance |

### Health monitoring

The dashboard polls each Kibana instance's `/api/status` endpoint every 5 seconds and displays:
- A colored dot: green (healthy), yellow (degraded), red (down), pulsing (starting up)
- The status label and Kibana version

## Architecture

```
┌─────────────┐       REST + SSE        ┌──────────────────┐
│   React UI  │  ◄────────────────────► │  Express Server  │
│  (Vite)     │    localhost:3001/api    │  (TypeScript)    │
└─────────────┘                         └────────┬─────────┘
                                                 │
                                          ┌──────▼──────┐
                                          │   Manager   │
                                          │ manager.ts  │
                                          └──────┬──────┘
                                                 │
                              ┌──────────────────┼──────────────────┐
                              │                  │                  │
                        git worktree       spawn ES/Kibana     health checks
                                          (child_process)      (/api/status)
```

### Key files

| File | Purpose |
|------|---------|
| `server/src/server.ts` | Express API routes |
| `server/src/manager.ts` | Instance lifecycle, git worktrees, process spawning, health polling |
| `server/src/analyzer.ts` | Claude CLI integration for log analysis and fix proposals (SSE streaming) |
| `server/src/config.ts` | Paths, ports, and constants |
| `server/src/health.ts` | Kibana health check HTTP probe |
| `server/src/nvm.ts` | Resolves the correct Node.js binary from `.nvmrc` |
| `ui/src/App.jsx` | Full React UI (single-file) |

## Ports

| Service | Port |
|---------|------|
| Manager API | 3001 |
| kibana-feat (Kibana) | 5601 |
| kibana-feat (ES) | 9200 |
| kibana-main (Kibana) | 5602 |
| kibana-main (ES) | 9201 |
| Temporary instances | 5603+ / 9203+ |

## Limitations

- **macOS only** — Hardcoded paths (`~/elastic/kibana`, `~/worktrees`, etc.) and tools (`/opt/homebrew/bin`) assume a Mac setup.
- **Single user** — Designed as a local development tool; no authentication or multi-user support.
- **Port conflicts** — Temporary instances get auto-assigned ports starting at 5603. If ports are already in use, startup will fail.
- **No persistent logs** — Process logs are kept in memory (last 300 lines per instance) and are lost when the server restarts.
- **Bootstrap can be slow** — Creating a new instance runs `yarn kbn bootstrap`, which can take several minutes depending on the branch.
- **Claude CLI required for analysis** — The "fix with Claude" feature requires the Claude CLI to be installed and authenticated separately.
