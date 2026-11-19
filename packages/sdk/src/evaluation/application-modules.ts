import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import type { ApplicationAdapter } from './application.js';
import { AppSetupError } from './errors.js';
export { AppSetupError } from './errors.js';


/** Node caches both an entry and its imports for the lifetime of the process. Keep
 * their original bytes/edges so a later load cannot describe a different grader. */
const modules = new Map<
  string,
  { file: string; loaded?: string; sealed?: boolean; children: Set<string>; packages: Set<string> }
>();
const declaredBuilds = new Map<string, string>();
let observing = false;

const digestFile = (file: string) => createHash('sha256').update(readFileSync(file)).digest('hex');

function restart(): never {
  throw new AppSetupError(
    'The installed application or a dependency changed or was already loaded outside this evaluator. Restart the evaluator process before comparing.',
  );
}

function track(url: string) {
  if (!modules.has(url))
    modules.set(url, { file: fileURLToPath(url), children: new Set(), packages: new Set() });
}

function observeImports() {
  if (observing) return;
  registerHooks({
    resolve(specifier, context, next) {
      const parent = context.parentURL ? modules.get(context.parentURL) : undefined;
      if (!parent) return next(specifier, context);
      const resolveImport = () => {
        try {
          return next(specifier, context);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND') throw error;
          // NodeNext emits .js/.mjs/.cjs specifiers for TS sources. Prefer actual
          // emitted files, then use their TS source counterpart in a TS module.
          if (
            /\.[cm]?ts$/.test(parent.file) &&
            /^\.{1,2}\//.test(specifier) &&
            /\.[cm]?js$/.test(specifier)
          ) {
            try {
              return next(specifier.replace(/js$/, 'ts'), context);
            } catch (sourceError) {
              if ((sourceError as NodeJS.ErrnoException).code !== 'ERR_MODULE_NOT_FOUND')
                throw sourceError;
            }
          }
          const label = /^(?!\/)[\w@./-]{1,180}$/.test(specifier) ? ' ' + specifier : '';
          throw new AppSetupError(
            'Cannot resolve import' +
              label +
              '. Install the dependency or compile your app and select its emitted entry with --app PATH.',
            { code: 'application.import_failed', field: specifier.slice(0, 180), cause: error },
          );
        }
      };
      const resolved = resolveImport();
      if (!parent.sealed && resolved.url.startsWith('file:')) {
        const parts = fileURLToPath(resolved.url).split(sep);
        const packageIndex = parts.lastIndexOf('node_modules');
        const bare = /^[a-zA-Z0-9@_]/.test(specifier) && !specifier.includes(':');
        if (bare || packageIndex !== -1) {
          const names = bare ? specifier.split('/') : parts.slice(packageIndex + 1);
          parent.packages.add(names.slice(0, names[0].startsWith('@') ? 2 : 1).join('/'));
        } else {
          track(resolved.url);
          parent.children.add(resolved.url);
        }
      }
      return resolved;
    },
    load(url, context, next) {
      const entry = modules.get(url);
      if (!entry) return next(url, context);
      const original = digestFile(entry.file);
      const result = next(url, context);
      if (digestFile(entry.file) !== original) restart();
      entry.loaded = original;
      return result;
    },
  });
  observing = true;
}

export async function importInstalledApplication(filename: string) {
  observeImports();
  const url = pathToFileURL(filename).href;
  track(url);
  let adapter: ApplicationAdapter;
  try {
    adapter = await import(url);
  } catch (error) {
    if (error instanceof AppSetupError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ACCLIMATE_NATIVE_CONFIG_MISSING')
      throw new AppSetupError('Create native.json beside the native starter’s application.mjs, then rerun describe.', {
        code: 'application.import_failed',
        cause: error,
      });
    if (code === 'ACCLIMATE_NATIVE_TEST_NOT_PROTECTED')
      throw new AppSetupError('Update native.json so every testFiles entry is in sourceFiles and outside resultFiles, then rerun describe.', {
        code: 'application.import_failed',
        cause: error,
      });
    const hint =
      code === 'ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX'
        ? 'The TypeScript syntax requires compilation. Compile the module and select its emitted entry with --app PATH.'
        : 'Fix the error your module threw while loading, or select a compiled entry with --app PATH.';
    // Name the exception the application threw, including its own code such as
    // native.control_path, so the cause is visible without a debugger.
    const name = error instanceof Error ? error.name : typeof error;
    const detail = String(error instanceof Error ? error.message : error)
      .split('\n')[0]
      .slice(0, 500);
    throw new AppSetupError(
      `Could not import the application module: ${name}${typeof code === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(code) ? ` [${code}]` : ''}: ${detail}`,
      { code: 'application.import_failed', field: filename, hint, cause: error },
    );
  }
  const seen = new Set<string>();
  const packages = new Set<string>();
  const files: Record<string, string> = Object.create(null);
  const visit = (key: string) => {
    if (seen.has(key)) return;
    seen.add(key);
    const entry = modules.get(key)!;
    if (!entry.loaded || digestFile(entry.file) !== entry.loaded) restart();
    entry.sealed = true;
    if (entry.file !== filename) files[relative(dirname(filename), entry.file)] = entry.loaded;
    for (const name of entry.packages) packages.add(name);
    for (const child of entry.children) visit(child);
  };
  visit(url);
  return {
    adapter,
    installedAdapter: 'sha256:' + modules.get(url)!.loaded,
    imports: files,
    packages: [...packages].sort(),
  };
}

export function bindResidentBuild(filename: string, identity: string) {
  const prior = declaredBuilds.get(filename);
  if (prior !== undefined && prior !== identity) restart();
  declaredBuilds.set(filename, identity);
}
