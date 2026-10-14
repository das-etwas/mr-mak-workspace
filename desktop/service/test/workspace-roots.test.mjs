import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rename, symlink, realpath } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { createService } from '../server.mjs';

const execute = promisify(execFile);
const script = fileURLToPath(new URL('../../../scripts/workspace-roots.mjs', import.meta.url));
const card = title => ({ id: 'notes', title, description: 'Project notes', type: 'group', category: 'project', status: 'active', pinned: true, created: '2026-01-01', folder: 'notes', icon: 'image.svg', steps: [{ name: 'Notes', path: 'notes.md' }, { name: 'Reader', path: 'index.html' }] });
async function project(root, title, workspaceId) {
  await mkdir(path.join(root, 'workspace/notes'), { recursive: true });
  await mkdir(path.join(root, 'workspace/_shared'));
  await writeFile(path.join(root, 'workspace/workspace.json'), JSON.stringify({ ...(workspaceId ? { workspaceId } : {}), title, entities: [card(title)], custom: 'preserved' }));
  await writeFile(path.join(root, 'workspace/notes/notes.md'), `# ${title}\n\n![Preview](image.svg)`);
  await writeFile(path.join(root, 'workspace/notes/image.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><rect width="40" height="40" fill="red"/></svg>');
  await writeFile(path.join(root, 'workspace/_shared/report.css'), 'h1{color:rgb(255,0,0)}');
  await writeFile(path.join(root, 'workspace/notes/index.html'), `<html><head><link rel="stylesheet" href="../_shared/report.css"></head><body><h1>${title}</h1><img src="image.svg"></body></html>`);
  return { workspaceId, label: title, path: root };
}
async function fixture(t) {
  const folder = await mkdtemp(path.join(os.tmpdir(), 'mrmak-roots-test-'));
  const hub = path.join(folder, 'hub'), first = path.join(folder, 'first project'), second = path.join(folder, 'second');
  await project(hub, 'Local');
  const roots = [await project(first, 'First project', randomUUID()), await project(second, 'Second project', randomUUID())];
  await mkdir(path.join(hub, '.mrmak'));
  await writeFile(path.join(hub, '.mrmak/workspace-roots.json'), JSON.stringify(roots));
  await mkdir(path.join(hub, 'ui')); await writeFile(path.join(hub, 'ui/index.html'), '<html>Fixture</html>');
  const service = await createService({ repo: hub, uiDir: path.join(hub, 'ui') });
  t.after(() => service.close());
  const headers = { Authorization: `Bearer ${service.token}`, 'Content-Type': 'application/json' };
  const api = (route, data, method = data === undefined ? 'GET' : 'POST') => fetch(`${service.origin}/api${route}`, { method, headers, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  return { folder, hub, roots, service, api };
}

test('roots scope duplicate card IDs, report assets, Markdown previews and metadata writes', async t => {
  const { hub, roots, service, api } = await fixture(t);
  const registry = await (await api('/workspace')).json();
  assert.equal(registry.entities.length, 3);
  assert.equal(registry.entities[0].id, 'notes', 'Legacy local links remain valid');
  assert.equal(new Set(registry.entities.map(item => item.id)).size, 3);
  const first = registry.entities[1], second = registry.entities[2];
  assert.equal(first.id, `${roots[0].workspaceId}:notes`);
  assert.notEqual(first.workspaceBase, second.workspaceBase);
  const previewRoute = `/workspace/entities/${encodeURIComponent(first.id)}/preview`;
  assert.equal((await fetch(`${service.origin}/api${previewRoute}`)).status, 401);
  const preview = await (await api(previewRoute)).json();
  assert.equal(preview.path, await realpath(path.join(roots[0].path, 'workspace/notes/notes.md')));
  assert.equal(await (await fetch(preview.url)).text(), '# First project\n\n![Preview](image.svg)');
  assert.match(await (await fetch(new URL('image.svg', preview.url))).text(), /<svg/);
  assert.match(await (await fetch(`${first.workspaceBase}/_shared/report.css`)).text(), /255,0,0/);
  assert.equal((await api(`/workspace/entities/${encodeURIComponent(first.id)}`, { status: 'done' }, 'PATCH')).status, 200);
  assert.equal(JSON.parse(await readFile(path.join(roots[0].path, 'workspace/workspace.json'), 'utf8')).entities[0].status, 'done');
  assert.equal(JSON.parse(await readFile(path.join(roots[1].path, 'workspace/workspace.json'), 'utf8')).entities[0].status, 'active');
  assert.equal(JSON.parse(await readFile(path.join(hub, 'workspace/workspace.json'), 'utf8')).entities[0].status, 'active');
  const saved = await api('/files/markdown', { path: preview.path, text: '# Updated externally', revision: preview.revision });
  assert.equal(saved.status, 200);
  assert.equal(await readFile(preview.path, 'utf8'), '# Updated externally');
  assert.equal((await service.workspace.read(first.id)).id, first.id);
});

test('missing and malformed roots stay isolated and recover without changing registrations', async t => {
  const { hub, roots, api } = await fixture(t);
  const registration = await readFile(path.join(hub, '.mrmak/workspace-roots.json'), 'utf8');
  await rename(roots[0].path, roots[0].path + '-moved');
  const first = await (await api('/workspace')).json();
  assert.equal(first.entities.filter(item => item.unavailable).length, 1);
  assert.ok(first.entities.some(item => item.title === 'Second project'));
  assert.equal(await readFile(path.join(hub, '.mrmak/workspace-roots.json'), 'utf8'), registration);
  await rename(roots[0].path + '-moved', roots[0].path);
  assert.equal((await (await api('/workspace')).json()).entities.filter(item => item.unavailable).length, 0);
  const file = path.join(roots[0].path, 'workspace/workspace.json'), original = await readFile(file, 'utf8');
  await writeFile(file, '{partial');
  assert.equal((await (await api('/workspace')).json()).entities.filter(item => item.unavailable).length, 1);
  await writeFile(file, original);
  assert.equal((await (await api('/workspace')).json()).entities.length, 3);
  const invalid = JSON.parse(original); delete invalid.entities[0].created;
  await writeFile(file, JSON.stringify(invalid));
  assert.equal((await (await api('/workspace')).json()).entities.filter(item => item.unavailable).length, 1, 'Invalid card data must not crash the dashboard');
});

test('duplicate workspace GUIDs and a changed registered identity are reported', async t => {
  const { hub, roots, api } = await fixture(t);
  const secondFile = path.join(roots[1].path, 'workspace/workspace.json');
  const second = JSON.parse(await readFile(secondFile, 'utf8'));
  second.workspaceId = roots[0].workspaceId;
  await writeFile(secondFile, JSON.stringify(second));
  const result = await (await api('/workspace')).json();
  assert.equal(result.entities.filter(item => item.unavailable).length, 1);
  assert.match(result.entities.find(item => item.unavailable).description, /GUID changed/);
  roots[1].workspaceId = roots[0].workspaceId;
  await writeFile(path.join(hub, '.mrmak/workspace-roots.json'), JSON.stringify(roots));
  const duplicate = await (await api('/workspace')).json();
  assert.match(duplicate.entities.find(item => item.unavailable).description, /same GUID/);
});

test('external report grants reject traversal, escaping links, retargeted roots and unregistering', async t => {
  const { folder, hub, roots, api } = await fixture(t);
  const external = (await (await api('/workspace')).json()).entities[1];
  await writeFile(path.join(roots[0].path, 'private.txt'), 'Outside the report root');
  assert.equal((await fetch(`${external.workspaceBase}/%2e%2e%2fprivate.txt`)).status, 403);
  const outside = path.join(folder, 'outside'); await mkdir(outside);
  await writeFile(path.join(outside, 'private.txt'), 'Outside sentinel');
  await symlink(outside, path.join(roots[0].path, 'workspace/escape'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fetch(`${external.workspaceBase}/escape/private.txt`)).status, 403);
  const workspace = path.join(roots[0].path, 'workspace');
  await rename(workspace, workspace + '-original');
  await symlink(outside, workspace, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal((await fetch(`${external.workspaceBase}/private.txt`)).status, 403);
  await writeFile(path.join(hub, '.mrmak/workspace-roots.json'), '[]');
  await api('/workspace');
  assert.equal((await fetch(`${external.workspaceBase}/private.txt`)).status, 404);
});

test('registration assigns a durable GUID, preserves content and can relocate or remove a source', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'mrmak-register-test-'));
  const hub = path.join(root, 'hub'), projectRoot = path.join(root, 'project');
  await project(hub, 'Local'); await project(projectRoot, 'Project');
  const run = (...args) => execute(process.execPath, [script, ...args], { windowsHide: true });
  await run('add', projectRoot, '--repo', hub);
  const first = JSON.parse(await readFile(path.join(projectRoot, 'workspace/workspace.json'), 'utf8'));
  assert.match(first.workspaceId, /^[a-f\d-]{36}$/);
  assert.equal(first.custom, 'preserved'); assert.equal(first.entities[0].title, 'Project');
  await run('add', projectRoot, '--repo', hub, '--label', 'My project');
  assert.equal(JSON.parse(await readFile(path.join(projectRoot, 'workspace/workspace.json'), 'utf8')).workspaceId, first.workspaceId);
  const moved = projectRoot + '-moved'; await rename(projectRoot, moved);
  await run('add', moved, '--repo', hub);
  const sources = JSON.parse(await readFile(path.join(hub, '.mrmak/workspace-roots.json'), 'utf8'));
  assert.equal(sources.length, 1); assert.equal(sources[0].path, await realpath(moved));
  await run('remove', first.workspaceId, '--repo', hub);
  assert.deepEqual(JSON.parse(await readFile(path.join(hub, '.mrmak/workspace-roots.json'), 'utf8')), []);
  assert.equal(await readFile(path.join(moved, 'workspace/notes/notes.md'), 'utf8'), '# Project\n\n![Preview](image.svg)');
  const empty = path.join(root, 'empty'); await mkdir(empty);
  await run('add', empty, '--repo', hub, '--init', '--label', 'New workspace');
  assert.deepEqual(JSON.parse(await readFile(path.join(empty, 'workspace/workspace.json'), 'utf8')).entities, []);
});
