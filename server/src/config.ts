import os from 'os';
import path from 'path';

export const HOME = os.homedir();
export const KIBANA_REPO = path.join(HOME, 'elastic', 'kibana');
export const WORKTREES_DIR = path.join(HOME, 'worktrees');
export const STATE_FILE = path.join(HOME, '.kibana-manager-state.json');
export const ES_DATA_DIR = path.join(HOME, 'Documents', 'Development', 'kibana', 'es_data');
export const ES_TRIGGER = 'succ kbn/es setup complete';
export const LOG_BUFFER = 300;
export const ES_STARTUP_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
export const API_PORT = 3001;
