export type InstanceType = 'permanent' | 'temporary';

export type InstanceStatus =
  | 'stopped'
  | 'starting-es'
  | 'starting-kibana'
  | 'running'
  | 'error';

export interface InstanceConfig {
  name: string;
  type: InstanceType;
  branch: string;
  dir: string;
  kPort: number;
  esPort: number;
  esDataFolder: string;
}

export interface KibanaHealth {
  up: boolean;
  status: string;
  version: string | null;
}

// Kept backward-compatible with existing UI
export interface InstanceView {
  name: string;
  type: InstanceType;
  branch: string;
  kPort: number;
  esPort: number;
  status: InstanceStatus;
  tmuxRunning: boolean;   // true when ES or Kibana process is alive
  tmuxAttached: boolean;  // always false, kept for UI compat
  tmuxWindows: number;    // always 0, kept for UI compat
  kibanaHealth: KibanaHealth;
  url: string;
  dir: string;
  privLocationRunning: boolean;
}
