// Renomeia variáveis LOCAIS (dentro de funções) com um nome dado, via serviço de linguagem do TypeScript.
const ts = require("typescript"), fs = require("fs"), path = require("path");
const file = path.resolve(__dirname, "../web/main.ts");
const [from, to] = process.argv.slice(2);
let text = fs.readFileSync(file, "utf8");
const host = { getScriptFileNames: () => [file], getScriptVersion: () => "1", getScriptSnapshot: f => fs.existsSync(f) ? ts.ScriptSnapshot.fromString(f === file ? text : fs.readFileSync(f, "utf8")) : undefined,
  getCurrentDirectory: () => path.dirname(file), getCompilationSettings: () => ({ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, lib: ["lib.es2022.d.ts", "lib.dom.d.ts"] }),
  getDefaultLibFileName: o => ts.getDefaultLibFilePath(o), fileExists: ts.sys.fileExists, readFile: ts.sys.readFile, readDirectory: ts.sys.readDirectory };
const ls = ts.createLanguageService(host), sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2022, true);
const starts = [];
(function walk(n, depth) {
  if (depth > 0 && (ts.isVariableDeclaration(n) || ts.isBindingElement(n)) && ts.isIdentifier(n.name) && n.name.text === from) starts.push(n.name.getStart(sf));
  ts.forEachChild(n, c => walk(c, depth + (ts.isFunctionLike(n) ? 1 : 0)));
})(sf, 0);
const edits = [];
for (const s of starts) for (const l of ls.findRenameLocations(file, s, false, false, { providePrefixAndSuffixTextForRename: true }) || [])
  edits.push({ start: l.textSpan.start, end: l.textSpan.start + l.textSpan.length, text: `${l.prefixText || ""}${to}${l.suffixText || ""}` });
const uniq = [...new Map(edits.map(e => [e.start, e])).values()].sort((a, b) => b.start - a.start);
for (const e of uniq) text = text.slice(0, e.start) + e.text + text.slice(e.end);
fs.writeFileSync(file, text);
console.log(`${starts.length} declarações locais '${from}' → '${to}', ${uniq.length} edições`);
