// Assembles a self-contained release folder + zip:
//   release/OnPremFootprint-<version>/{server.mjs, app/, start.bat, start.sh, README.txt}
// Requires `vite build` and `vite build -c vite.server.config.ts` to have run (see "npm run package").
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync, copyFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { crc32, deflateRawSync } from 'node:zlib';

const root = process.cwd();
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const name = `OnPremFootprint-${pkg.version}`;
const out = join(root, 'release', name);

for (const f of ['dist/index.html', 'build/server/server.mjs']) {
  if (!existsSync(join(root, f))) throw new Error(`Missing ${f} – run "npm run package"`);
}
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(root, 'build/server/server.mjs'), join(out, 'server.mjs'));
cpSync(join(root, 'dist'), join(out, 'app'), { recursive: true });
const crlf = (s) => s.replace(/\r?\n/g, '\r\n');
writeFileSync(join(out, 'start.bat'), crlf(readFileSync(join(root, 'packaging/start.bat'), 'utf8')));
writeFileSync(join(out, 'start.sh'), readFileSync(join(root, 'packaging/start.sh'), 'utf8').replace(/\r\n/g, '\n'), { mode: 0o755 });
writeFileSync(join(out, 'README.txt'), crlf(readFileSync(join(root, 'packaging/README.txt'), 'utf8').replace('{{VERSION}}', pkg.version)));

// ---- minimal zip writer (deflate, no dependencies) ----
function walk(dir) {
  return readdirSync(dir).flatMap((f) => {
    const p = join(dir, f);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
const files = walk(out);
const locals = [];
const centrals = [];
let offset = 0;
const dosTime = (d) => ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
const dosDate = (d) => (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
const now = new Date();
for (const f of files) {
  const data = readFileSync(f);
  const comp = deflateRawSync(data, { level: 9 });
  const fname = Buffer.from(`${name}/${relative(out, f).split('\\').join('/')}`, 'utf8');
  const crc = crc32(data) >>> 0;
  const isSh = f.endsWith('.sh');
  const lh = Buffer.alloc(30);
  lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
  lh.writeUInt16LE(dosTime(now), 10); lh.writeUInt16LE(dosDate(now), 12); lh.writeUInt32LE(crc, 14);
  lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(fname.length, 26); lh.writeUInt16LE(0, 28);
  const ch = Buffer.alloc(46);
  ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE((3 << 8) | 20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
  ch.writeUInt16LE(dosTime(now), 12); ch.writeUInt16LE(dosDate(now), 14); ch.writeUInt32LE(crc, 16);
  ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(fname.length, 28);
  ch.writeUInt32LE(((isSh ? 0o100755 : 0o100644) << 16) >>> 0, 38); ch.writeUInt32LE(offset, 42);
  locals.push(lh, fname, comp);
  centrals.push(ch, fname);
  offset += lh.length + fname.length + comp.length;
}
const cd = Buffer.concat(centrals);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
const zipPath = join(root, 'release', `${name}.zip`);
writeFileSync(zipPath, Buffer.concat([...locals, cd, end]));
console.log(`\n  Release folder: ${relative(root, out)}\n  Zip:            ${relative(root, zipPath)} (${(statSync(zipPath).size / 1024 / 1024).toFixed(1)} MB)\n`);
