/** Run from frontend: node scripts/audit-ui-components.mjs */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";
const frontend = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.join(frontend, "src");
const walk = d => fs.readdirSync(d, { withFileTypes: true }).flatMap(e => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
const files = walk(src).filter(f => /\.tsx?$/.test(f) && !/\.test\./.test(f));
const graph = new Map(), native = new Map(), nativeBusiness = new Map();
const rel = f => path.relative(src, f).split(path.sep).join("/");
for (const file of files) {
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true), deps = [];
  function visit(n) {
    if ((ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) && n.moduleSpecifier && ts.isStringLiteral(n.moduleSpecifier)) {
      const spec = n.moduleSpecifier.text;
      const base = spec.startsWith("@/") ? path.join(src, spec.slice(2)) : spec.startsWith(".") ? path.resolve(path.dirname(file), spec) : null;
      if (base) { const target = [base, `${base}.tsx`, `${base}.ts`, path.join(base, "index.tsx"), path.join(base, "index.ts")].find(f => files.includes(f)); if (target) deps.push(target); }
    }
    if (ts.isJsxOpeningElement(n) || ts.isJsxSelfClosingElement(n)) {
      const name = n.tagName.getText(source);
      if (["button", "input", "textarea", "select", "table", "details", "dialog"].includes(name) && !rel(file).startsWith("app/design/")) {
        const item = native.get(name) ?? { count: 0, files: new Set() }; item.count++; item.files.add(file); native.set(name, item);
        if (!rel(file).startsWith("components/ui/")) { const key = `${rel(file)} · ${name}`; nativeBusiness.set(key, (nativeBusiness.get(key) ?? 0) + 1); }
      }
    }
    ts.forEachChild(n, visit);
  }
  visit(source); graph.set(file, deps);
}
const reachable = new Set();
function reach(file) { if (reachable.has(file)) return; reachable.add(file); for (const dep of graph.get(file) ?? []) reach(dep); }
reach(path.join(src, "app/design/DesignGallery.tsx")); reach(path.join(src, "app/layout.tsx"));
const components = files.filter(f => rel(f).startsWith("components/") && f.endsWith(".tsx")).sort();
const primitives = components.filter(f => rel(f).startsWith("components/ui/"));
let report = `# BotCord 组件使用清单\n\n由 \`cd frontend && node scripts/audit-ui-components.mjs\` 生成。扫描非测试 TS/TSX 静态 import、re-export 和 JSX，不计动态拼装的组件名。\n\n共 ${files.filter(f => f.endsWith(".tsx")).length} 个 TSX 文件、${components.length} 个组件模块，其中 UI 组件库 ${primitives.length} 个模块。\n\n“预览可达”表示从 /design 或根布局的 ConfirmDialog / Toaster 宿主可达，不代表全部业务状态均已演示。生产引用不包含 /design；兼容导出也算引用。\n\n## 原生元素存量（不含预览页）\n\nUI 原语内部、消息编辑器和业务交互中的原生元素是合法实现；这些计数不能直接等同于违规数量。\n\n| 元素 | 出现次数 | 文件数 |\n|---|---:|---:|\n`;
for (const [name, item] of [...native].sort()) report += `| ${name} | ${item.count} | ${item.files.size} |\n`;
report += "\n## 业务界面原生控件例外\n\n业务接口中的 button/input/textarea/select/table/dialog/details 由 ui-migration.test.ts 防止回退。隐藏原生文件选择器保留浏览器文件访问语义；布局容器、文本链接、图解与专业消息结构不按原生控件违规计数。\n\n| 文件与元素 | 数量 |\n|---|---:|\n";
for (const [key, count] of [...nativeBusiness].sort()) report += `| ${key} | ${count} |\n`;
for (const [title, subset] of [["组件库", primitives], ["业务与页面组合组件", components.filter(f => !primitives.includes(f))]]) {
  report += `\n## ${title}\n\n| 模块 | 生产引用文件数 | 预览可达 |\n|---|---:|---|\n`;
  for (const file of subset) {
    const users = [...graph].filter(([caller, deps]) => !rel(caller).startsWith("app/design/") && deps.includes(file)).length;
    report += `| [${rel(file)}](../../../frontend/src/${rel(file)}) | ${users} | ${reachable.has(file) ? "是" : "否"} |\n`;
  }
}
fs.writeFileSync(path.resolve(frontend, "../docs/brand/botcord-vi/COMPONENT-INVENTORY.md"), report);
console.log(`${components.length} component modules; ${primitives.length} UI modules; ${primitives.filter(f => reachable.has(f)).length} reachable in gallery`);
