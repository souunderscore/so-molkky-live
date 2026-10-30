// Deploy the browser UI separately; keep the legacy GAS application intact.
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..'), out = path.join(root, 'dist');
fs.rmSync(out, { recursive:true, force:true });
fs.mkdirSync(out, { recursive:true });
for (const name of ['index.html','app.css','client.js','ui.js']) fs.copyFileSync(path.join(root, 'pages', name), path.join(out, name));
fs.cpSync(path.join(root, 'pages', 'icons'), path.join(out, 'icons'), { recursive:true });
fs.writeFileSync(path.join(out, '.nojekyll'), '');
process.stdout.write('Built dist/index.html, client.js, ui.js\n');
