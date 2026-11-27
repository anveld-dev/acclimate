import { cp, lstat, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const inventories = JSON.parse(await readFile(new URL('./starter-files.json', import.meta.url), 'utf8'));

const excluded = new Set(['node_modules', '__pycache__', '.cache', '.local', 'dist', '.DS_Store']);
const privateNames = new Set(['evaluator.json', 'reader.json', 'intent.json', 'attempt.json', 'attempt.python.json', 'ownership.lock', 'job.json', 'handoff.json']);
// The starter's npm settings ship, but only these keys, so a registry token can never ride along.
const npmSettings = new Set(['ignore-scripts', 'audit', 'fund', 'save-exact', 'include']);

async function checkNpmSettings(filename) {
  for (const line of (await readFile(filename, 'utf8')).split('\n')) {
    const setting = line.trim();
    if (!setting || setting.startsWith('#') || setting.startsWith(';')) continue;
    const match = /^([a-z-]+)\s*=\s*[a-z]+$/.exec(setting);
    if (!match || !npmSettings.has(match[1]))
      throw new Error('Private configuration or state must not enter a starter archive');
  }
}

async function checkSource(directory, inventory, omitted, relative = '') {
  const root = await lstat(directory);
  if (root.isSymbolicLink() || !root.isDirectory()) throw new Error('Starter source root is not a regular directory');
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (!relative && omitted.has(entry.name)) continue;
    if (excluded.has(entry.name) || entry.name.endsWith('.pyc')) continue;
    const filename = join(directory, entry.name);
    const publicPath = relative ? `${relative}/${entry.name}` : entry.name;
    const npmrc = publicPath === '.npmrc' && inventory.has(publicPath);
    if ((entry.name.startsWith('.') && !npmrc) || privateNames.has(entry.name.toLowerCase()) || /\.(?:key|pem|lock)$/i.test(entry.name) || /\.origin\.json$/i.test(entry.name))
      throw new Error('Private configuration or state must not enter a starter archive');
    const info = await lstat(filename);
    if (info.isSymbolicLink() || (!info.isDirectory() && !info.isFile()))
      throw new Error('Starter source contains an unsupported filesystem entry');
    if (npmrc) await checkNpmSettings(filename);
    if (info.isDirectory()) await checkSource(filename, inventory, omitted, publicPath);
    else if (!inventory.has(publicPath)) throw new Error('Unreviewed file must not enter a starter archive');
  }
}

async function copyStarter(source, destination, inventory, omitted = new Set()) {
  await checkSource(source, new Set(inventory), omitted);
  for (const filename of inventory) {
    const target = join(destination, filename);
    if (!(await lstat(join(source, filename))).isFile()) throw new Error('Reviewed starter source is missing');
    await mkdir(dirname(target), { recursive: true });
    await cp(join(source, filename), target, { errorOnExist: true, force: false });
  }
}

// A small deterministic USTAR writer avoids platform-specific tar flags and
// excludes host ownership, timestamps, extended attributes and directory order.
async function writeArchive(directory, filename) {
  const chunks = [];
  function field(header, offset, width, value) {
    if (Buffer.byteLength(value) >= width) throw new Error('Starter archive field exceeds USTAR limit');
    header.write(value, offset, width, 'utf8');
  }
  async function walk(path, name) {
    const info = await lstat(path);
    const isDirectory = info.isDirectory();
    const body = isDirectory ? Buffer.alloc(0) : await readFile(path);
    const header = Buffer.alloc(512);
    const archiveName = name + (isDirectory ? '/' : '');
    if (Buffer.byteLength(archiveName) > 99) throw new Error('Starter archive path exceeds USTAR limit');
    field(header, 0, 100, archiveName);
    field(header, 100, 8, (isDirectory || name.endsWith('.sh') ? 0o755 : 0o644).toString(8).padStart(7, '0'));
    field(header, 108, 8, '0000000');
    field(header, 116, 8, '0000000');
    field(header, 124, 12, body.length.toString(8).padStart(11, '0'));
    field(header, 136, 12, '00000000000');
    header.fill(32, 148, 156);
    header[156] = isDirectory ? 53 : 48;
    header.write('ustar\0', 257, 6);
    header.write('00', 263, 2);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
    chunks.push(header, body);
    if (body.length % 512) chunks.push(Buffer.alloc(512 - body.length % 512));
    if (isDirectory)
      for (const child of (await readdir(path)).sort()) await walk(join(path, child), `${name}/${child}`);
  }
  await walk(directory, basename(directory));
  chunks.push(Buffer.alloc(1024));
  await writeFile(filename, gzipSync(Buffer.concat(chunks), { level: 9 }), { flag: 'wx', mode: 0o600 });
}

/** Archives only explicitly inventoried public source files, never a job/journal. */
export async function archiveStarters(root, output, metadata) {
  const workspace = await mkdtemp(join(tmpdir(), 'acclimate-release-starters-'));
  const produced = [];
  try {
    for (const starter of metadata.starters) {
      if (starter.name !== 'native-repository' ||
          basename(starter.file) !== starter.file || !/^acclimate-[a-z-]+-starter-[0-9A-Za-z.+-]+\.tgz$/.test(starter.file))
        throw new Error('Invalid starter artifact identity');
      const dirname = `${starter.name}-starter`;
      const destination = join(workspace, dirname);
      const source = starter.name;
      // Each starter's own tests and qualification notes stay in the repository.
      const omitted = new Set(['QUALIFICATION.md', 'test']);
      await copyStarter(join(root, 'examples', source), destination, inventories[starter.name], omitted);
      const packageFile = join(destination, 'package.json');
      try {
        const manifest = JSON.parse(await readFile(packageFile, 'utf8'));
        if (manifest.dependencies?.['@anveld/sdk']) manifest.dependencies['@anveld/sdk'] = metadata.version;
        manifest.version = metadata.version;
        await writeFile(packageFile, JSON.stringify(manifest, null, 2) + '\n');
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await mkdir(output, { recursive: true, mode: 0o700 });
      await writeArchive(destination, resolve(output, starter.file));
      produced.push({ ...starter, directory: dirname });
    }
    return produced;
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}
