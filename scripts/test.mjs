/**
 * 跨平台测试 runner。
 *
 * 为什么需要它：npm 脚本 `tsx --test test/*.test.ts` 依赖 shell 展开 glob。
 * POSIX 的 /bin/sh 会展开，但 Windows 的 cmd.exe 不展开——会把 `*.test.ts`
 * 当字面文件名传给 node，报 "Could not find ...\*.test.ts"。而 node 20 的
 * --test 又不原生支持 glob（node 21+ 才支持）。所以这里自己列目录、把文件
 * 逐个传给 tsx --test，三系统行为一致、零额外依赖（只用 node 内置模块）。
 */
import { readdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const testDir = join(root, 'test');

const files = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .sort()
  .map((f) => join('test', f));

if (files.length === 0) {
  console.error('没有找到任何 *.test.ts 测试文件');
  process.exit(1);
}

// 透传命令行额外参数（如 --test-name-pattern）到 tsx。
const extra = process.argv.slice(2);
// Windows 上 tsx 是 tsx.cmd，用 shell:true 让 node 自己找到正确的可执行文件。
const child = spawn('tsx', ['--test', ...extra, ...files], {
  cwd: root,
  stdio: 'inherit',
  shell: true,
});
child.on('exit', (code) => process.exit(code ?? 1));
