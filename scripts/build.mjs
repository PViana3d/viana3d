// Monta a pasta dist/ que é publicada no GitHub Pages.
import {cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync} from 'node:fs';
import {execSync} from 'node:child_process';

const out = 'dist';
rmSync(out, {recursive: true, force: true});
mkdirSync(`${out}/vendor`, {recursive: true});

let build = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 8) : '';
if (!build) { try { build = execSync('git rev-parse --short HEAD').toString().trim(); } catch { build = Date.now().toString(36); } }

for (const f of ['app.js', 'styles.css', 'manifest.webmanifest', 'config.js']) cpSync(f, `${out}/${f}`);
cpSync('icons', `${out}/icons`, {recursive: true});
for (const f of ['index.html', 'sw.js']) writeFileSync(`${out}/${f}`, readFileSync(f, 'utf8').replaceAll('__BUILD__', build));

const vendor = {
  'supabase.js': 'node_modules/@supabase/supabase-js/dist/umd/supabase.js',
  'jspdf.umd.min.js': 'node_modules/jspdf/dist/jspdf.umd.min.js',
  'jszip.min.js': 'node_modules/jszip/dist/jszip.min.js'
};
for (const [name, src] of Object.entries(vendor)) {
  if (!existsSync(src)) { console.error(`Falta ${src}. Corra "npm install" primeiro.`); process.exit(1); }
  cpSync(src, `${out}/vendor/${name}`);
}

const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY;
if (url && key) {
  writeFileSync(`${out}/config.js`, `window.APP_CONFIG = ${JSON.stringify({supabaseUrl: url, supabaseAnonKey: key}, null, 2)};\n`);
  console.log('config.js gerado a partir das variáveis do GitHub.');
}
writeFileSync(`${out}/.nojekyll`, '');
console.log(`Pronto: ${out}/ (versão ${build})`);
