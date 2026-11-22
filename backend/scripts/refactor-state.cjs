// Ferramenta de refatoração (uso único): move as variáveis de estado de nível de módulo de web/main.ts
// para um objeto `st`, usando o serviço de linguagem do TypeScript (só referências reais, nunca texto em strings).
const ts = require("typescript");
const fs = require("fs");
const path = require("path");
const file = path.resolve(__dirname, "../web/main.ts");
let text = fs.readFileSync(file, "utf8");
const names = process.argv.slice(2);

const host = {
  getScriptFileNames: () => [file], getScriptVersion: () => "1",
  getScriptSnapshot: f => (fs.existsSync(f) ? ts.ScriptSnapshot.fromString(f === file ? text : fs.readFileSync(f, "utf8")) : undefined),
  getCurrentDirectory: () => path.dirname(file), getCompilationSettings: () => ({ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"] }),
  getDefaultLibFileName: o => ts.getDefaultLibFilePath(o), fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory,
};
const ls = ts.createLanguageService(host);
const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
const decls = [];
for (const stmt of sf.statements) {
  if (!ts.isVariableStatement(stmt) || !(stmt.declarationList.flags & ts.NodeFlags.Let)) continue;
  for (const d of stmt.declarationList.declarations) if (ts.isIdentifier(d.name) && names.includes(d.name.text)) decls.push({ stmt, d });
}
const edits = [];
const stateFields = [];
for (const { stmt, d } of decls) {
  const name = d.name.text;
  const locs = ls.findRenameLocations(file, d.name.getStart(sf), false, false, { providePrefixAndSuffixTextForRename: true }) || [];
  for (const l of locs) {
    if (l.textSpan.start === d.name.getStart(sf)) continue; // a própria declaração sai inteira
    const pre = l.prefixText || "", suf = l.suffixText || "";
    edits.push({ start: l.textSpan.start, end: l.textSpan.start + l.textSpan.length, text: `${pre}st.${name}${suf}`.replace(`${name}: st.${name}`, `${name}: st.${name}`) });
  }
  const type = d.type ? d.type.getText(sf) : null;
  const init = d.initializer ? d.initializer.getText(sf) : "undefined";
  stateFields.push(`  ${name}: ${init}${type ? ` as ${type}` : ""},`);
  if (stmt.declarationList.declarations.length === 1) edits.push({ start: stmt.getFullStart(), end: stmt.getEnd(), text: "" });
  else throw new Error(`declaração múltipla: ${stmt.getText(sf).slice(0, 80)} — trate à mão`);
}
edits.sort((a, b) => b.start - a.start);
for (const e of edits) text = text.slice(0, e.start) + e.text + text.slice(e.end);
fs.writeFileSync(file, text);
console.log(`movidas ${decls.length} variáveis, ${edits.length} edições`);
console.log(stateFields.join("\n"));
