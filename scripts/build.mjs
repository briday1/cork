import {mkdir, copyFile, cp, rm, access} from 'node:fs/promises';
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
console.log('Static site ready in dist/ (no dependencies or backend required).');
