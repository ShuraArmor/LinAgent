/**
 * Skill 系统 —— 渐进式披露（progressive disclosure）+ 可执行脚本。
 *
 * 一个 skill 是磁盘上的 skills/<name>/ 目录，至少包含 SKILL.md：
 *   ---
 *   name: deploy-check
 *   description: 部署前检查清单
 *   script: run.sh
 *   runtime: bash
 *   ---
 *   <完整指令正文>
 *
 * 可选地，同目录下可以有脚本文件（run.sh / main.py / index.js 等）。
 *
 * 核心思想：
 *   1. 启动时只扫 frontmatter，把 `name: description` 列进 system prompt
 *   2. agent 调 load_skill(name) 时读全文 + 脚本内容
 *   3. agent 可以选择通过 bash_exec 执行脚本（走审批门）
 *   4. agent 可以调 create_skill 创建新 skill（含脚本）
 */

import { existsSync, readdirSync, readFileSync, statSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname, extname } from 'node:path';
import { platform } from 'node:os';

/** 当前平台默认的脚本运行时——agent 建 skill 没指定 runtime 时用它，保证脚本在本机能跑。 */
const DEFAULT_RUNTIME = platform() === 'win32' ? 'powershell' : 'bash';

export interface SkillMeta {
  name: string;
  description: string;
  /** SKILL.md 的绝对路径。 */
  path: string;
  /** 是否附带可执行脚本。 */
  hasScript?: boolean;
}

export interface SkillScript {
  /** 脚本文件名（如 run.sh）。 */
  filename: string;
  /** 脚本文件的绝对路径。 */
  filepath: string;
  /** 脚本内容。 */
  content: string;
  /** 运行时（bash / python / node），由 frontmatter 声明或从扩展名推断。 */
  runtime: string;
}

export interface LoadedSkill extends SkillMeta {
  /** frontmatter 之后的正文（完整指令）。 */
  body: string;
  /** 附带的可执行脚本（若有）。 */
  script?: SkillScript;
}

/** parseSkillFile 的返回值。 */
export interface ParsedSkill {
  name?: string;
  description?: string;
  body: string;
  /** frontmatter 里声明的脚本文件名。 */
  scriptFile?: string;
  /** frontmatter 里声明的运行时。 */
  runtime?: string;
}

/** 从文件扩展名推断运行时。 */
function inferRuntime(filename: string): string {
  const ext = extname(filename).toLowerCase();
  switch (ext) {
    case '.sh': case '.bash': return 'bash';
    case '.py': return 'python';
    case '.js': case '.mjs': return 'node';
    case '.ts': case '.mts': return 'tsx';
    case '.ps1': return 'powershell';
    default: return 'bash';
  }
}

/**
 * 解析 SKILL.md：拆出 YAML-ish frontmatter 和正文。
 * frontmatter 用 --- 包裹，必须在文件开头。
 * 支持字段：name, description, script, runtime。
 */
export function parseSkillFile(raw: string): ParsedSkill {
  const m = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) {
    return { body: raw.trim() };
  }
  const [, front, body] = m;
  let name: string | undefined;
  let description: string | undefined;
  let scriptFile: string | undefined;
  let runtime: string | undefined;

  for (const line of front.split(/\r?\n/)) {
    const kv = line.match(/^\s*([A-Za-z_][A-Za-z0-9_-]*)\s*:\s*(.*)$/);
    if (!kv) continue;
    const key = kv[1].toLowerCase();
    let val = kv[2].trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (key === 'name') name = val;
    else if (key === 'description') description = val;
    else if (key === 'script') scriptFile = val;
    else if (key === 'runtime') runtime = val;
  }
  return { name, description, body: body.trim(), scriptFile, runtime };
}

/**
 * Skill 注册表：扫描 skills 目录，收集元信息，按需加载全文和脚本。
 */
export class SkillRegistry {
  private metas = new Map<string, SkillMeta & { scriptFile?: string; runtime?: string }>();
  private mcpLoader: ((name: string) => LoadedSkill | null) | null = null;
  private rootDir: string | null = null;

  constructor(dir?: string) {
    if (dir) {
      this.rootDir = dir;
      this.scan(dir);
    }
  }

  setMCPLoader(loader: (name: string) => LoadedSkill | null): void {
    this.mcpLoader = loader;
  }

  private scan(dir: string): void {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const skillDir = join(dir, name);
      let isDir = false;
      try { isDir = statSync(skillDir).isDirectory(); } catch { continue; }
      if (!isDir) continue;

      const mdPath = join(skillDir, 'SKILL.md');
      if (!existsSync(mdPath)) continue;
      try {
        const raw = readFileSync(mdPath, 'utf8');
        const parsed = parseSkillFile(raw);
        const skillName = parsed.name || name;
        if (!parsed.description) continue;
        if (this.metas.has(skillName)) continue;

        // 检查脚本文件是否真的存在
        let hasScript = false;
        if (parsed.scriptFile) {
          const scriptPath = join(skillDir, parsed.scriptFile);
          hasScript = existsSync(scriptPath);
        }

        this.metas.set(skillName, {
          name: skillName,
          description: parsed.description,
          path: mdPath,
          hasScript,
          scriptFile: parsed.scriptFile,
          runtime: parsed.runtime,
        });
      } catch {
        // 读失败静默跳过
      }
    }
  }

  registerMeta(meta: SkillMeta): void {
    this.metas.set(meta.name, meta);
  }

  list(): SkillMeta[] {
    return Array.from(this.metas.values());
  }

  has(name: string): boolean {
    return this.metas.has(name);
  }

  load(name: string): LoadedSkill {
    const meta = this.metas.get(name);
    if (!meta) throw new Error(`未知 skill: ${name}`);

    // 虚拟 MCP prompt skill
    if (meta.path.startsWith('<mcp:') && this.mcpLoader) {
      const loaded = this.mcpLoader(name);
      if (loaded) return loaded;
      throw new Error(`MCP prompt 加载失败: ${name}`);
    }

    const raw = readFileSync(meta.path, 'utf8');
    const parsed = parseSkillFile(raw);
    const skillDir = dirname(meta.path);

    const result: LoadedSkill = { ...meta, body: parsed.body };

    // 读取脚本文件（若声明了且存在）
    const scriptFilename = parsed.scriptFile || (meta as { scriptFile?: string }).scriptFile;
    if (scriptFilename) {
      const scriptPath = join(skillDir, scriptFilename);
      if (existsSync(scriptPath)) {
        const content = readFileSync(scriptPath, 'utf8');
        const runtime = parsed.runtime || (meta as { runtime?: string }).runtime || inferRuntime(scriptFilename);
        result.script = {
          filename: scriptFilename,
          filepath: scriptPath,
          content,
          runtime,
        };
      }
    }

    return result;
  }

  /**
   * 创建或覆盖一个 skill。
   * @param opts.script 可选的脚本内容
   * @param opts.scriptFilename 脚本文件名（如 run.sh），不传则根据 runtime 推断
   * @param opts.runtime 运行时（bash/python/node/tsx），不传则从文件名推断
   */
  create(
    name: string,
    description: string,
    body: string,
    opts?: { script?: string; scriptFilename?: string; runtime?: string },
  ): { ok: boolean; path?: string; error?: string } {
    if (!this.rootDir) {
      return { ok: false, error: 'skill 注册表没有配置存储目录，无法写入' };
    }
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return { ok: false, error: `skill 名 "${name}" 含非法字符（只允许 a-z 0-9 _ -）` };
    }
    if (!description.trim()) {
      return { ok: false, error: 'description 不能为空' };
    }

    const skillDir = join(this.rootDir, name);
    const mdPath = join(skillDir, 'SKILL.md');

    // 推断脚本文件名。未显式指定 runtime 时，按**当前平台**兜底（Windows→powershell，
    // POSIX→bash），避免默认永远 .sh 在 Windows 上跑不了。兜底 runtime 也会写进
    // frontmatter，让 skill 自描述、下次加载时能被正确识别。
    let scriptFilename = opts?.scriptFilename;
    const runtime = opts?.runtime ?? (opts?.script && !scriptFilename ? DEFAULT_RUNTIME : undefined);
    if (opts?.script && !scriptFilename) {
      const ext = runtime === 'python' ? '.py'
        : runtime === 'node' ? '.js'
        : runtime === 'tsx' ? '.ts'
        : runtime === 'powershell' ? '.ps1'
        : '.sh';
      scriptFilename = `run${ext}`;
    }

    // 拼 SKILL.md
    const frontLines = [`name: ${name}`, `description: ${description}`];
    if (scriptFilename) frontLines.push(`script: ${scriptFilename}`);
    if (runtime) frontLines.push(`runtime: ${runtime}`);
    const content = `---\n${frontLines.join('\n')}\n---\n${body}\n`;

    try {
      mkdirSync(skillDir, { recursive: true });
      writeFileSync(mdPath, content, 'utf8');

      // 写脚本文件
      if (opts?.script && scriptFilename) {
        writeFileSync(join(skillDir, scriptFilename), opts.script, 'utf8');
      }
    } catch (err) {
      return { ok: false, error: `写入失败: ${(err as Error).message}` };
    }

    this.metas.set(name, {
      name, description, path: mdPath,
      hasScript: Boolean(opts?.script),
      scriptFile: scriptFilename,
      runtime,
    });
    return { ok: true, path: mdPath };
  }

  describeForPrompt(): string {
    const items = this.list();
    if (items.length === 0) {
      if (this.rootDir) {
        return '你可以用 create_skill 工具把可复用的指令/流程/知识固化为持久 skill（可附带可执行脚本），之后每次对话都能加载使用。';
      }
      return '';
    }
    const lines = items.map((s) => {
      const tag = s.hasScript ? ' [可执行]' : '';
      return `- ${s.name}: ${s.description}${tag}`;
    });
    return [
      '你还可以按需加载以下 skill（领域指令）。当任务与某个 skill 相关时，',
      '先用 load_skill 工具读取它，再照着执行。也可以用 create_skill 创建新的：',
      ...lines,
    ].join('\n');
  }
}
