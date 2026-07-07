import type { Tool } from '../types.ts';

/**
 * load_skill —— 渐进式披露的第二步。
 *
 * system prompt 里只列了每个 skill 的 name + description。当 agent 判断某个 skill
 * 跟当前任务相关时，调这个工具把该 skill 的完整指令读进上下文，然后照着做。
 */
export const loadSkillTool: Tool = {
  name: 'load_skill',
  description:
    '加载一个 skill 的完整指令。当任务与 system prompt 里列出的某个 skill 相关时，' +
    '先用它读取完整指令再执行。参数 name 是 skill 名。',
  parameters: {
    type: 'object',
    properties: {
      name: { type: 'string', description: '要加载的 skill 名（见 system prompt 里的 skill 清单）。' },
    },
    required: ['name'],
    additionalProperties: false,
  },
  handler(args, ctx) {
    if (!ctx.skills) {
      throw new Error('load_skill 被调用，但 agent 没有配置 skill 注册表');
    }
    const name = String(args.name).trim();
    const available = ctx.skills.names();
    if (!available.includes(name)) {
      return {
        ok: false,
        error: `未知 skill "${name}"。可用: ${available.join(', ') || '(无)'}`,
      };
    }
    const skill = ctx.skills.load(name);
    const result: Record<string, unknown> = {
      ok: true,
      name: skill.name,
      description: skill.description,
      instructions: skill.body,
    };
    if (skill.script) {
      result.script = {
        filename: skill.script.filename,
        filepath: skill.script.filepath,
        runtime: skill.script.runtime,
        content: skill.script.content,
        hint: `可通过 bash_exec 执行此脚本。运行命令示例: ${skill.script.runtime} "${skill.script.filepath}"`,
      };
    }
    return result;
  },
};

/**
 * list_skills —— 让 LLM 主动查询当前可用的 skill 列表。
 *
 * system prompt 里也有这份清单，但在长对话中 system prompt 可能被压缩截断。
 * LLM 可以随时调这个工具拿到最新的、完整的可用 skill。
 */
export const listSkillsTool: Tool = {
  name: 'list_skills',
  description:
    '列出当前可用的所有 skill（名称 + 简介）。如果不确定有哪些 skill 可以加载，先调这个。',
  parameters: {
    type: 'object',
    properties: {},
    additionalProperties: false,
  },
  handler(_args, ctx) {
    if (!ctx.skills) {
      return { ok: true, skills: [], note: '当前未配置 skill 注册表' };
    }
    const skills = ctx.skills.list();
    if (skills.length === 0) {
      return { ok: true, skills: [], note: '暂无可用 skill' };
    }
    return { ok: true, skills };
  },
};

/**
 * create_skill —— 让 agent 把可复用的知识/流程固化为持久 skill。
 *
 * 场景：对话中发现某段指令、工作流或领域知识值得跨会话复用时，
 * agent 可以直接调此工具创建一个 skill。下次启动就能在 system prompt 里看到它。
 * 支持附带可执行脚本——创建后 agent 可通过 bash_exec 运行脚本。
 */
export const createSkillTool: Tool = {
  name: 'create_skill',
  description:
    '创建一个新的 skill（持久领域指令，可附带可执行脚本）。当你发现某段指令、步骤或领域知识值得跨会话复用时，' +
    '用此工具固化下来。支持 script 字段附带 bash/python/node 脚本。',
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'skill 的唯一标识（只允许 a-z、0-9、- 和 _），如 "code-review"、"deploy-check"。',
      },
      description: {
        type: 'string',
        description: '一句话描述该 skill 的用途（展示在 system prompt 里帮决定要不要加载）。',
      },
      body: {
        type: 'string',
        description: 'skill 的完整指令正文（Markdown 格式）。描述何时使用、步骤、注意事项。',
      },
      script: {
        type: 'string',
        description: '可选：附带的可执行脚本内容。创建后可通过 bash_exec 运行。',
      },
      script_filename: {
        type: 'string',
        description: '可选：脚本文件名（如 run.sh、main.py）。不传则按 runtime 推断。',
      },
      runtime: {
        type: 'string',
        description: '可选：脚本运行时（bash / python / node / tsx）。不传则从文件名扩展名推断。',
      },
    },
    required: ['name', 'description', 'body'],
    additionalProperties: false,
  },
  handler(args, ctx) {
    if (!ctx.skills) {
      throw new Error('create_skill 被调用，但 agent 没有配置 skill 注册表');
    }
    const name = String(args.name).trim();
    const description = String(args.description).trim();
    const body = String(args.body).trim();

    if (!name) return { ok: false, error: 'name 不能为空' };
    if (!description) return { ok: false, error: 'description 不能为空' };
    if (!body) return { ok: false, error: 'body 不能为空' };

    const script = args.script ? String(args.script) : undefined;
    const scriptFilename = args.script_filename ? String(args.script_filename) : undefined;
    const runtime = args.runtime ? String(args.runtime) : undefined;

    return ctx.skills.create(name, description, body, { script, scriptFilename, runtime });
  },
};
