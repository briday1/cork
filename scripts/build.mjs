import {mkdir, copyFile, cp, rm, access, readFile, writeFile, readdir} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';

const root = fileURLToPath(new URL('../', import.meta.url));
const output = path.join(root, 'dist');
await rm(output, {recursive: true, force: true});
await mkdir(output, {recursive: true});
for (const file of ['index.html', 'styles.css', 'app.js', 'board-core.js', 'categories.txt', 'favicon.svg', '.nojekyll']) {
  await access(path.join(root, file));
  await copyFile(path.join(root, file), path.join(output, file));
}
await cp(path.join(root, 'assets'), path.join(output, 'assets'), {recursive: true});
// Keep every deployed module, stylesheet and photo on the same release.
// GitHub Pages caches static resources, so stable URLs can mix old and new files.
const versionedFiles = ['index.html', 'app.js', 'board-core.js', 'styles.css', ...(await readdir(path.join(root, 'assets'))).map(name => `assets/${name}`)].sort();
const hash = createHash('sha256');
for (const file of versionedFiles) hash.update(file).update('\0').update(await readFile(path.join(root, file)));
const version = hash.digest('hex').slice(0, 12);
const html = (await readFile(path.join(output, 'index.html'), 'utf8'))
  .replace('./styles.css', `./styles.css?v=${version}`)
  .replace('./app.js', `./app.js?v=${version}`);
const app = (await readFile(path.join(output, 'app.js'), 'utf8'))
  .replace("from './board-core.js';", `from './board-core.js?v=${version}';`);
const css = (await readFile(path.join(output, 'styles.css'), 'utf8'))
  .replace(/url\("(\.\/assets\/[^"?]+)"\)/g, `url("$1?v=${version}")`);
await writeFile(path.join(output, 'index.html'), html);
await writeFile(path.join(output, 'app.js'), app);
await writeFile(path.join(output, 'styles.css'), css);
console.log('Static site ready in dist/ (no dependencies or backend required).');
