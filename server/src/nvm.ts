import fs from 'fs';
import path from 'path';
import os from 'os';

const NVM_DIR = path.join(os.homedir(), '.nvm');

export function resolveNodeBin(cwd: string): string {
  const nvmrcPath = path.join(cwd, '.nvmrc');

  if (!fs.existsSync(nvmrcPath)) {
    return path.dirname(process.execPath);
  }

  const requestedVersion = fs.readFileSync(nvmrcPath, 'utf8').trim();

  // Strip leading 'v' for directory matching
  const versionStr = requestedVersion.replace(/^v/, '');

  const versionsDir = path.join(NVM_DIR, 'versions', 'node');

  if (!fs.existsSync(versionsDir)) {
    return path.dirname(process.execPath);
  }

  let installedVersions: string[];
  try {
    installedVersions = fs.readdirSync(versionsDir);
  } catch {
    return path.dirname(process.execPath);
  }

  // Exact match first (with or without leading 'v')
  const exactMatch = installedVersions.find(
    (v) => v === `v${versionStr}` || v === versionStr
  );

  if (exactMatch) {
    const binDir = path.join(versionsDir, exactMatch, 'bin');
    if (fs.existsSync(binDir)) {
      return binDir;
    }
  }

  // Partial match: find the highest version that starts with the requested prefix
  // e.g. requested "20" matches "v20.11.0"
  const prefix = `v${versionStr}`;
  const matches = installedVersions
    .filter((v) => v.startsWith(prefix) || v.startsWith(versionStr))
    .sort()
    .reverse();

  if (matches.length > 0) {
    const binDir = path.join(versionsDir, matches[0], 'bin');
    if (fs.existsSync(binDir)) {
      return binDir;
    }
  }

  return path.dirname(process.execPath);
}
