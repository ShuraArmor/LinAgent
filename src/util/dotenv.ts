import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';

export function loadDotEnv(path = '.env'): void {
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return;
  const text = readFileSync(full, 'utf8');
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq < 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}
