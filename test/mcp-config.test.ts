import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMCPConfig } from '../src/mcp/config.ts';
import { resetLinagentHomeCache } from '../src/storage.ts';

describe('MCP config', () => {
  let testDir: string;

  beforeEach(() => {
    testDir = join(tmpdir(), `mcp-config-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    resetLinagentHomeCache();
  });

  afterEach(() => {
    try { rmSync(testDir, { recursive: true }); } catch { /* noop */ }
    resetLinagentHomeCache();
    delete process.env.LINAGENT_HOME;
  });

  it('returns empty map when no config file exists', () => {
    const config = loadMCPConfig(testDir);
    assert.equal(config.size, 0);
  });

  it('loads stdio config from .linagent/mcp.json', () => {
    const linagentDir = join(testDir, '.linagent');
    mkdirSync(linagentDir, { recursive: true });
    writeFileSync(join(linagentDir, 'mcp.json'), JSON.stringify({
      myserver: { command: 'node', args: ['server.js'] },
    }));

    const config = loadMCPConfig(testDir);
    assert.equal(config.size, 1);
    const entry = config.get('myserver')!;
    assert.equal((entry as { command: string }).command, 'node');
  });

  it('loads sse config', () => {
    const linagentDir = join(testDir, '.linagent');
    mkdirSync(linagentDir, { recursive: true });
    writeFileSync(join(linagentDir, 'mcp.json'), JSON.stringify({
      remote: { transport: 'sse', url: 'http://localhost:8080/mcp' },
    }));

    const config = loadMCPConfig(testDir);
    const entry = config.get('remote')!;
    assert.equal(entry.transport, 'sse');
    assert.equal((entry as { url: string }).url, 'http://localhost:8080/mcp');
  });

  it('filters disabled servers', () => {
    const linagentDir = join(testDir, '.linagent');
    mkdirSync(linagentDir, { recursive: true });
    writeFileSync(join(linagentDir, 'mcp.json'), JSON.stringify({
      active: { command: 'node', args: ['a.js'] },
      disabled: { command: 'node', args: ['b.js'], enabled: false },
    }));

    const config = loadMCPConfig(testDir);
    assert.equal(config.size, 1);
    assert(config.has('active'));
    assert(!config.has('disabled'));
  });

  it('throws on missing command for stdio', () => {
    const linagentDir = join(testDir, '.linagent');
    mkdirSync(linagentDir, { recursive: true });
    writeFileSync(join(linagentDir, 'mcp.json'), JSON.stringify({
      bad: { args: ['something'] },
    }));

    assert.throws(() => loadMCPConfig(testDir), /缺少 command/);
  });

  it('throws on missing url for sse', () => {
    const linagentDir = join(testDir, '.linagent');
    mkdirSync(linagentDir, { recursive: true });
    writeFileSync(join(linagentDir, 'mcp.json'), JSON.stringify({
      bad: { transport: 'sse' },
    }));

    assert.throws(() => loadMCPConfig(testDir), /缺少 url/);
  });

  it('throws on invalid transport', () => {
    const linagentDir = join(testDir, '.linagent');
    mkdirSync(linagentDir, { recursive: true });
    writeFileSync(join(linagentDir, 'mcp.json'), JSON.stringify({
      bad: { transport: 'websocket', command: 'ws' },
    }));

    assert.throws(() => loadMCPConfig(testDir), /transport 值无效/);
  });

  it('throws on invalid JSON', () => {
    const linagentDir = join(testDir, '.linagent');
    mkdirSync(linagentDir, { recursive: true });
    writeFileSync(join(linagentDir, 'mcp.json'), '{not valid json');

    assert.throws(() => loadMCPConfig(testDir), /解析失败/);
  });

  it('falls back to linagentHome global config', () => {
    // Set LINAGENT_HOME to a temp dir, put mcp.json there
    const homeDir = join(testDir, 'global-home');
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(homeDir, 'mcp.json'), JSON.stringify({
      global: { command: 'node', args: ['global.js'] },
    }));
    process.env.LINAGENT_HOME = homeDir;
    resetLinagentHomeCache();

    // cwd has no .linagent/mcp.json → should fall through to home
    const emptyDir = join(testDir, 'empty');
    mkdirSync(emptyDir, { recursive: true });

    const config = loadMCPConfig(emptyDir);
    assert.equal(config.size, 1);
    assert(config.has('global'));
  });

  it('local .linagent/mcp.json takes precedence over global', () => {
    // Global
    const homeDir = join(testDir, 'global-home');
    mkdirSync(homeDir, { recursive: true });
    writeFileSync(join(homeDir, 'mcp.json'), JSON.stringify({
      global: { command: 'node', args: ['global.js'] },
    }));
    process.env.LINAGENT_HOME = homeDir;
    resetLinagentHomeCache();

    // Local
    const localDir = join(testDir, 'project');
    mkdirSync(join(localDir, '.linagent'), { recursive: true });
    writeFileSync(join(localDir, '.linagent', 'mcp.json'), JSON.stringify({
      local: { command: 'node', args: ['local.js'] },
    }));

    const config = loadMCPConfig(localDir);
    assert.equal(config.size, 1);
    assert(config.has('local'));
    assert(!config.has('global'));
  });
});
