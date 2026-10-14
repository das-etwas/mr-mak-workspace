// Run from an agent terminal. Only explicit registration writes a workspace GUID;
// ordinary app startup never changes project manifests.
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, realpath, stat } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { validWorkspaceId } from '../desktop/service/workspace-roots.mjs';
import { realFile, saveJson } from '../desktop/service/util.mjs';

const { values, positionals } = parseArgs({ allowPositionals: true, options: { repo: { type: 'string' }, label: { type: 'string' }, init: { type: 'boolean' } } });
const [command, target] = positionals;
if (!['add', 'remove', 'list'].includes(command) || positionals.length > 2 || (command !== 'list' && !target)) throw new Error('Usage: node scripts/workspace-roots.mjs add|remove <project> --repo <hub> [--init] [--label <name>], or list --repo <hub>');
const hub = await realpath(path.resolve(values.repo || process.cwd()));
await realFile(hub, 'workspace/workspace.json');
const state = path.join(hub, '.mrmak'), config = path.join(state, 'workspace-roots.json');
let sources;
try { sources = JSON.parse(await readFile(config, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; sources = []; }
if (!Array.isArray(sources)) throw new Error('workspace-roots.json must contain an array.');
if (command === 'list') console.log(JSON.stringify(sources, null, 2));
else if (command === 'remove') {
  const requested = path.resolve(target);
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  await saveJson(config, sources.filter(source => source.workspaceId !== target && key(source.path) !== key(requested)));
  console.log('Removed the local registration; project files were preserved.');
} else {
  const root = await realpath(path.resolve(target));
  if (!(await stat(root)).isDirectory()) throw new Error('Select an existing project directory.');
  if (path.relative(hub, root) === '') throw new Error('The main workspace is already included.');
  const folder = path.join(root, 'workspace');
  if (values.init) await mkdir(folder, { recursive: true });
  let registry;
  try {
    const { file } = await realFile(folder, 'workspace.json');
    await realFile(root, 'workspace/workspace.json');
    registry = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (error.code !== 'ENOENT' || !values.init) throw error;
    // Check the directory before creating files through an escaping junction.
    await realFile(root, 'workspace');
    registry = { title: values.label || path.basename(root), entities: [] };
  }
  if (!Array.isArray(registry.entities)) throw new Error('The workspace needs an entities array.');
  if (registry.workspaceId !== undefined && !validWorkspaceId(registry.workspaceId)) throw new Error('The existing workspaceId must be a UUID.');
  if (!registry.workspaceId) { registry.workspaceId = randomUUID(); await saveJson(path.join(folder, 'workspace.json'), registry); }
  const workspaceId = registry.workspaceId.toLowerCase();
  const label = values.label || (typeof registry.title === 'string' && registry.title) || path.basename(root);
  const entry = { workspaceId, label, path: root };
  const key = value => process.platform === 'win32' ? value.toLowerCase() : value;
  sources = sources.filter(source => source.workspaceId?.toLowerCase() !== workspaceId && key(source.path) !== key(root));
  await saveJson(config, [...sources, entry]);
  console.log(JSON.stringify(entry, null, 2));
}
