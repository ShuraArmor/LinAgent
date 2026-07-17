import { ToolRegistry } from './registry.ts';
import { calculatorTool } from './calculator.ts';
import { searchTool } from './search.ts';
import { weatherTool } from './weather.ts';
import { todoTool } from './todo.ts';
import { memoryTool } from './memory.ts';
import { fsReadTool, fsListTool, fsWriteTool, fsDeleteTool } from './fs.ts';
import { bashExecTool } from './bash.ts';

export { ToolRegistry } from './registry.ts';
export { calculatorTool } from './calculator.ts';
export { searchTool } from './search.ts';
export { weatherTool } from './weather.ts';
export { todoTool } from './todo.ts';
export { memoryTool } from './memory.ts';
export {
  fsReadTool, fsListTool, fsWriteTool, fsDeleteTool,
  setSandboxRoot, getSandboxRoot,
} from './fs.ts';
export { bashExecTool } from './bash.ts';

/** 需要审批的高影响工具名单；由 Agent 的 approval gate 参考。 */
export const RISKY_TOOLS = new Set<string>(['fs_write', 'fs_delete', 'bash_exec', 'run_workflow']);

export function buildDefaultRegistry(): ToolRegistry {
  const reg = new ToolRegistry();
  reg.register(calculatorTool);
  reg.register(searchTool);
  reg.register(weatherTool);
  reg.register(todoTool);
  reg.register(memoryTool);
  reg.register(fsReadTool);
  reg.register(fsListTool);
  reg.register(fsWriteTool);
  reg.register(fsDeleteTool);
  reg.register(bashExecTool);
  return reg;
}
