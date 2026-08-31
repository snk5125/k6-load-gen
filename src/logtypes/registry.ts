import type { LogTypeDef } from './types.ts';
import { jsonApp } from './definitions/json-app.ts';
import { auditd } from './definitions/auditd.ts';
import { nginxAccess } from './definitions/nginx-access.ts';

export const LOG_TYPES: Record<string, LogTypeDef> = {
  [jsonApp.name]: jsonApp,
  [auditd.name]: auditd,
  [nginxAccess.name]: nginxAccess,
};

export function getLogType(name: string): LogTypeDef {
  const def = LOG_TYPES[name];
  if (!def) {
    throw new Error(
      `unknown log type "${name}"; available: ${Object.keys(LOG_TYPES).join(', ')}`,
    );
  }
  return def;
}
