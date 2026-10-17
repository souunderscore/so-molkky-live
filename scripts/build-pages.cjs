// Index.html remains the shared source; deploy only dist/, never GAS files or tests.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'dist');
fs.rmSync(out, { recursive:true, force:true });
fs.mkdirSync(out, { recursive:true });
let html = fs.readFileSync(path.join(root, 'Index.html'), 'utf8');
html = html.replace('<base target="_top">', '')
  .replace('<title>Live Scheduler v0.6</title>', '<title>Live Scheduler · Pages</title>')
  .replace('VERSION 0.6', 'PAGES 0.7')
  .replace('YouTube API・Google Apps Script を使用。', 'YouTube API を使用。下書き・テンプレートはこのブラウザに保存します。')
  .replace('（既存バージョンで確認済み）', '（GAS版で確認済み。移行版は実機確認が必要）')
  .replace('<script>\n', '<script src="client.js"></script>\n<script>\n')
  .replace('</body>', '<script src="ui.js"></script></body>');
fs.writeFileSync(path.join(out, 'index.html'), html);
for (const name of ['client.js','ui.js']) fs.copyFileSync(path.join(root, 'pages', name), path.join(out, name));
fs.writeFileSync(path.join(out, '.nojekyll'), '');
process.stdout.write('Built dist/index.html, client.js, ui.js\n');
