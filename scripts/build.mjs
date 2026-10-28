// Monta o pacote que o Raspberry Pi descarrega:
//   dist/web/              → páginas da aplicação (servidas pelo PocketBase em pb_public)
//   dist/viana3d-pi.zip    → pb_public + pb_migrations + pb_hooks + scripts do Pi + versões
import {cpSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync} from 'node:fs';
import {join, relative} from 'node:path';
import {execSync} from 'node:child_process';
import JSZip from 'jszip';

const out = 'dist', web = `${out}/web`;
rmSync(out, {recursive: true, force: true});
mkdirSync(`${web}/vendor`, {recursive: true});

let build = process.env.GITHUB_SHA ? process.env.GITHUB_SHA.slice(0, 8) : '';
if (!build) { try { build = execSync('git rev-parse --short HEAD').toString().trim(); } catch { build = Date.now().toString(36); } }

for (const f of ['app.js', 'styles.css', 'manifest.webmanifest', 'config.js']) cpSync(f, `${web}/${f}`);
cpSync('icons', `${web}/icons`, {recursive: true});
for (const f of ['index.html', 'sw.js']) writeFileSync(`${web}/${f}`, readFileSync(f, 'utf8').replaceAll('__BUILD__', build));

const vendor = {
  'pocketbase.umd.js': 'node_modules/pocketbase/dist/pocketbase.umd.js',
  'jspdf.umd.min.js': 'node_modules/jspdf/dist/jspdf.umd.min.js',
  'jszip.min.js': 'node_modules/jszip/dist/jszip.min.js'
};
for (const [name, src] of Object.entries(vendor)) {
  if (!existsSync(src)) { console.error(`Falta ${src}. Corra "npm install" primeiro.`); process.exit(1); }
  cpSync(src, `${web}/vendor/${name}`);
}

// pacote para o Raspberry Pi
const zip = new JSZip();
const addDir = (dir, prefix, mode) => {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) addDir(p, `${prefix}/${name}`, mode);
    else zip.file(`${prefix}/${name}`, readFileSync(p), mode ? {unixPermissions: mode} : {});
  }
};
addDir(web, 'pb_public');
addDir('pb/pb_migrations', 'pb_migrations');
addDir('pb/pb_hooks', 'pb_hooks');
addDir('pi', 'pi', 0o755);
zip.file('BUILD', build + '\n');
const buf = await zip.generateAsync({type: 'nodebuffer', compression: 'DEFLATE', platform: 'UNIX'});
writeFileSync(`${out}/viana3d-pi.zip`, buf);
console.log(`Pronto: ${out}/viana3d-pi.zip (versão ${build}, ${(buf.length / 1024).toFixed(0)} KB)`);
