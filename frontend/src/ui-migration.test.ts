import fs from "node:fs";
import path from "node:path";
import ts from "typescript";
import { expect, it } from "vitest";

const src = path.resolve(process.cwd(), "src");
const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => entry.isDirectory() ? walk(path.join(dir, entry.name)) : [path.join(dir, entry.name)]);

it("keeps business interfaces on shared UI controls while allowing the hidden browser file picker", () => {
  const violations: string[] = [];
  for (const file of walk(src).filter((file) => file.endsWith(".tsx") && !file.includes(".test.") && !/[\\/]components[\\/]ui[\\/]|[\\/]app[\\/](design|api)[\\/]/.test(file))) {
    const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    function visit(node: ts.Node) {
      if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
        const name = node.tagName.getText(source);
        const attr = (key: string) => node.attributes.properties.find((a): a is ts.JsxAttribute => ts.isJsxAttribute(a) && a.name.getText(source) === key)?.initializer;
        const type = attr("type"), classes = attr("className");
        const hiddenFilePicker = name === "input" && type && ts.isStringLiteral(type) && type.text === "file" && classes && ts.isStringLiteral(classes) && classes.text.split(/\s+/).includes("hidden");
        if (["button", "input", "textarea", "select", "table", "dialog", "details"].includes(name) && !hiddenFilePicker) {
          const line = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
          violations.push(`${path.relative(src, file)}:${line} <${name}> must use a shared UI primitive`);
        }
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  expect(violations).toEqual([]);
});
