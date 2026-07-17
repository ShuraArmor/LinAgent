/**
 * 把 LinAgent 打包成一个独立可执行文件（免装 Node），基于 Node 20 的
 * SEA（Single Executable Application）。流水线：
 *
 *   1. esbuild  : src/index.ts → dist/bundle.cjs（单文件 CJS，内联版本号）
 *   2. sea      : node --experimental-sea-config → dist/sea-prep.blob
 *   3. copy     : 复制当前 node 可执行 → dist/<name>[.exe]
 *   4. postject : 把 blob 注入到副本里
 *
 * 只面向"当前这台机器的架构/平台"——SEA 产物不跨平台。Windows 产出 .exe。
 *
 *   node scripts/build-exe.mjs
 */
import { build } from 'esbuild';
import { readFileSync, writeFileSync, copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const isWin = process.platform === 'win32';
const exeName = 'linagent' + (isWin ? '.exe' : '');
const innerPath = join(dist, 'inner.mjs');       // esbuild 的 ESM 产物（Ink 需 ESM: TLA）
const bundlePath = join(dist, 'bundle.cjs');      // SEA 入口：CJS stub，动态 import 上面的 ESM
const devtoolsStub = join(dist, 'devtools-stub.js');
const blobPath = join(dist, 'sea-prep.blob');
const seaConfigPath = join(dist, 'sea-config.json');
const exePath = join(dist, exeName);

function log(step, msg) { console.log(`\x1b[36m[${step}]\x1b[0m ${msg}`); }

/** 1. esbuild：打包成单个 CJS 文件，把版本号内联进去。 */
async function bundle() {
  // 只删自己产的文件，不整目录 rm —— 用户可能在 dist/ 里放了 .env 等东西，
  // 整目录 recursive 删会误伤（真踩过：把用户的 dist/.env 干掉了）。
  mkdirSync(dist, { recursive: true });
  for (const f of [innerPath, bundlePath, devtoolsStub, blobPath, seaConfigPath, exePath]) {
    try { rmSync(f, { force: true }); }
    catch (err) {
      if (err?.code === 'EBUSY' || err?.code === 'EPERM') {
        throw new Error(`无法删除 ${f}（被占用）。请先关掉正在运行的 ${exeName}（或其它持有该文件的进程）再重试。`);
      }
      throw err;
    }
  }
  // Ink 只在 dev 动态 import react-devtools-core —— 用空 stub 顶掉，避免打包/运行报错。
  writeFileSync(devtoolsStub, 'export default {};');

  // 1a. 打成 ESM。Ink 的 reconciler 和 yoga 都有 top-level await，CJS 格式不支持 → 必须 ESM。
  await build({
    entryPoints: [join(root, 'src/index.tsx')],
    bundle: true,
    platform: 'node',
    target: 'node20',
    format: 'esm',
    jsx: 'automatic',
    outfile: innerPath,
    alias: { 'react-devtools-core': devtoolsStub },
    define: { __APP_VERSION__: JSON.stringify(pkg.version) },
    // ESM 里没有 require，但部分 CJS 依赖（signal-exit 等）运行时 require 内建模块。
    // 补一个 createRequire —— 必须用 process.execPath，不能用 import.meta.url（data URL 下会炸）。
    banner: { js: "import{createRequire as __cr}from'module';const require=__cr(process.execPath);" },
    logLevel: 'info',
  });
  log('esbuild', `→ ${innerPath}（ESM）`);

  // 1b. 生成 CJS stub 作 SEA 入口。
  //   SEA 用 embedderRunCjs 强制 CJS，顶层 import 语句会 SyntaxError → 必须用动态 import()。
  //   ⚠️ 绝不能用 data URL：import("data:...base64...") 会让 import.meta.url 变成那坨
  //      base64，而 yoga-layout 的 wasm 加载器把 import.meta.url 当脚本路径解析 → 真 TTY
  //      布局时崩（错误栈打印巨长 base64 那个 bug 就是这么来的）。
  //   正解：把 ESM bundle 作为 SEA asset 嵌入，运行时取出写到临时文件，用真实 file:// 路径
  //      import() —— 这样 import.meta.url 是正常路径，yoga 恢复健康。
  writeFileSync(bundlePath,
    `// LinAgent standalone build — do not edit.\n` +
    `const {getAsset}=require('node:sea');\n` +
    `const {writeFileSync,mkdtempSync}=require('node:fs');\n` +
    `const {join}=require('node:path');const os=require('node:os');\n` +
    `const {pathToFileURL}=require('node:url');\n` +
    `const buf=Buffer.from(getAsset('inner.mjs'));\n` +
    `const dir=mkdtempSync(join(os.tmpdir(),'linagent-'));\n` +
    `const file=join(dir,'inner.mjs');\n` +
    `writeFileSync(file,buf);\n` +
    `import(pathToFileURL(file).href).catch(e=>{console.error(e);process.exit(1);});\n`,
  );
  log('esbuild', `→ ${bundlePath}（CJS stub：SEA asset → 临时文件 → import）`);
}

/** 2. 生成 SEA blob。 */
function makeBlob() {
  const cfg = {
    main: bundlePath,
    output: blobPath,
    disableExperimentalSEAWarning: true,
    // 把 ESM bundle 作为资源嵌入 —— stub 运行时用 getAsset('inner.mjs') 取出。
    assets: { 'inner.mjs': innerPath },
  };
  writeFileSync(seaConfigPath, JSON.stringify(cfg, null, 2));
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], { stdio: 'inherit' });
  log('sea', `→ ${blobPath}`);
}

/** 3. 复制当前 node 可执行为待注入的目标。 */
function copyRuntime() {
  copyFileSync(process.execPath, exePath);
  log('copy', `${process.execPath} → ${exePath}`);
}

/**
 * 从 node 二进制里抽出真实的 fuse sentinel。
 * 注意：fuse 的 hash 因 node 版本/构建而异（不是文档里那个固定值），硬编码会
 * 报 "Could not find the sentinel"。二进制里形如 `NODE_SEA_FUSE_<hex>:0`，
 * postject 要的是冒号前那截。
 */
function detectSentinel() {
  const buf = readFileSync(exePath);
  const prefix = Buffer.from('NODE_SEA_FUSE_');
  const at = buf.indexOf(prefix);
  if (at < 0) throw new Error('在 node 二进制里找不到 NODE_SEA_FUSE_ 前缀（该 node 版本可能不支持 SEA）');
  // 从前缀起读到冒号（fuse 状态分隔符）为止。
  let end = at + prefix.length;
  while (end < buf.length && buf[end] !== 0x3a /* ':' */ && buf[end] !== 0x00) end++;
  return buf.toString('latin1', at, end);
}

/** 4. 用 postject 把 blob 注入进副本（Windows 需要 sentinel fuse）。 */
function inject() {
  const sentinel = detectSentinel();
  log('postject', `sentinel = ${sentinel}`);
  const args = [
    'postject', exePath, 'NODE_SEA_BLOB', blobPath,
    '--sentinel-fuse', sentinel,
  ];
  // macOS 还需 --macho-segment-name NODE_SEA；Windows/Linux 不需要。
  if (process.platform === 'darwin') args.push('--macho-segment-name', 'NODE_SEA');
  execFileSync('npx', args, { stdio: 'inherit', shell: isWin });
  log('postject', `注入完成 → ${exePath}`);
}

/** 5. 清掉中间产物，dist/ 只留最终可执行。 */
function cleanup() {
  for (const f of [innerPath, bundlePath, devtoolsStub, blobPath, seaConfigPath]) rmSync(f, { force: true });
  log('clean', '已清理中间产物（bundle.cjs / blob / sea-config.json）');
}

async function main() {
  const t = Date.now();
  await bundle();
  makeBlob();
  copyRuntime();
  inject();
  cleanup();
  console.log(`\n\x1b[32m✓ 独立可执行已生成\x1b[0m: ${exePath}  (${((Date.now() - t) / 1000).toFixed(1)}s)`);
  console.log(`  运行：${isWin ? 'dist\\\\linagent.exe' : './dist/linagent'} --help   （无需安装 Node）`);
}

main().catch((err) => {
  console.error('\x1b[31m构建失败\x1b[0m:', err?.message ?? err);
  process.exit(1);
});
