import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const rootDir = path.resolve(__dirname, '..');
const targets = [
  path.join(rootDir, 'public', 'index.html'),
];

const sourceScriptPattern = /<script type="text\/plain" data-precompile-src="([^"]+)">([\s\S]*?)<\/script>/g;

async function writeCompiledFile(outputPath, compiled) {
  try {
    const handle = await fs.open(outputPath, 'r+');
    try {
      await handle.writeFile(compiled, 'utf8');
      await handle.truncate(Buffer.byteLength(compiled, 'utf8'));
    } finally {
      await handle.close();
    }
  } catch (err) {
    if (err?.code !== 'ENOENT') throw err;
    await fs.writeFile(outputPath, compiled, 'utf8');
  }
}

async function compileHtml(filePath) {
  const html = await fs.readFile(filePath, 'utf8');
  const matches = [...html.matchAll(sourceScriptPattern)];
  if (!matches.length) return;

  await Promise.all(
    matches.map(async ([, outputRelativePath, source]) => {
      const outputPath = path.resolve(path.dirname(filePath), outputRelativePath);
      const compiled = ts.transpileModule(source.trimStart(), {
        compilerOptions: {
          target: ts.ScriptTarget.ES2020,
          module: ts.ModuleKind.None,
          jsx: ts.JsxEmit.React,
          jsxFactory: 'React.createElement',
          jsxFragmentFactory: 'React.Fragment',
          removeComments: false,
        },
        fileName: path.basename(outputPath).replace(/\.js$/i, '.jsx'),
      }).outputText;

      await writeCompiledFile(outputPath, compiled);
    })
  );
}

await Promise.all(targets.map(compileHtml));
