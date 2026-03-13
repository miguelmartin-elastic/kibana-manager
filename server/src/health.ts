import http from 'http';
import { KibanaHealth } from './types';

export function checkKibanaHealth(port: number): Promise<KibanaHealth> {
  return new Promise((resolve) => {
    const options: http.RequestOptions = {
      hostname: 'localhost',
      port,
      path: '/api/status',
      method: 'GET',
      headers: {
        'kbn-xsrf': 'true',
      },
      timeout: 2000,
    };

    const req = http.request(options, (res) => {
      let data = '';

      res.on('data', (chunk) => {
        data += chunk;
      });

      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          const status: string =
            json?.status?.overall?.level ??
            json?.status?.overall?.state ??
            json?.status?.core?.overall?.level ??
            'unknown';
          const version: string | null = json?.version?.number ?? null;
          resolve({ up: true, status, version });
        } catch {
          resolve({ up: true, status: 'unknown', version: null });
        }
      });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ up: false, status: 'timeout', version: null });
    });

    req.on('error', () => {
      resolve({ up: false, status: 'down', version: null });
    });

    req.end();
  });
}
