import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';

await mkdir('dist/vendor', { recursive: true });
await copyFile('node_modules/mediabunny/dist/bundles/mediabunny.mjs', 'dist/vendor/mediabunny.mjs');
await copyFile('node_modules/mediabunny/LICENSE', 'dist/vendor/MEDIABUNNY-LICENSE.txt');
for (const file of ['dist/app.js', 'dist/media.js', 'dist/editor-utils.js']) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
}
const html = await readFile('dist/index.html', 'utf8');
if (!html.includes('lang="ko"')) throw new Error('Korean document language missing');
console.log('Static application ready in dist/');
