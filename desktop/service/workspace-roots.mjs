import path from 'node:path';
import { createHash } from 'node:crypto';
import { readFile, realpath } from 'node:fs/promises';
import { Workspace } from './workspace.mjs';
import { realFile } from './util.mjs';

export const validWorkspaceId = value => typeof value === 'string' && /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i.test(value);
const unavailable = (source, error) => ({
  id: `unavailable:${createHash('sha256').update(String(source.path)).digest('hex').slice(0, 24)}`,
  title: typeof source.label === 'string' && source.label ? source.label : 'Unavailable workspace',
  description: error.code === 'ENOENT' ? 'Its registered directory or workspace manifest could not be found.' : error.message,
  type: 'group', category: 'project', status: 'active', pinned: false,
  created: '1970-01-01', folder: '', steps: [], unavailable: true,
  workspaceLabel: typeof source.label === 'string' && source.label ? source.label : 'External workspace',
  workspacePath: typeof source.path === 'string' ? source.path : undefined,
});

// Owner-managed paths stay in ignored state. Manifests contain portable IDs and
// relative report paths; they cannot register additional filesystem roots.
export class WorkspaceRoots {
  constructor(repo, stateDir, files, changed = () => {}) {
    this.repo = repo; this.files = files; this.changed = changed;
    this.config = path.join(stateDir, 'workspace-roots.json');
    this.primary = new Workspace(repo, changed);
    this.workspaces = new Map([[repo, this.primary]]);
    this.sourceGrants = new Map();
  }
  async catalog() {
    const primary = await this.primary.registry();
    let sources;
    try { sources = JSON.parse(await readFile(this.config, 'utf8')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; sources = []; }
    if (!Array.isArray(sources)) throw new Error('workspace-roots.json must contain an array.');
    const entities = [...primary.entities];
    const records = new Map(primary.entities.map(entity => [entity.id, { entity, workspace: this.primary, workspaceRoot: path.join(this.repo, 'workspace') }]));
    const seenRoots = new Set([await realpath(this.repo)]);
    const seenIds = new Set(validWorkspaceId(primary.workspaceId) ? [primary.workspaceId.toLowerCase()] : []);
    const activeGrants = new Map();
    for (const source of sources) {
      try {
        if (!source || typeof source.path !== 'string' || !path.isAbsolute(source.path)) throw new Error('Register an absolute project directory.');
        if (source.label !== undefined && typeof source.label !== 'string') throw new Error('Workspace labels must be text.');
        if (!validWorkspaceId(source.workspaceId)) throw new Error('Register this workspace with scripts/workspace-roots.mjs to assign its GUID.');
        const root = await realpath(source.path);
        if (seenRoots.has(root)) continue;
        seenRoots.add(root);
        const workspaceRoot = await realpath(path.join(root, 'workspace'));
        await realFile(root, 'workspace/workspace.json');
        await realFile(workspaceRoot, 'workspace.json');
        let workspace = this.workspaces.get(root);
        if (!workspace) { workspace = new Workspace(root, this.changed); this.workspaces.set(root, workspace); }
        const registry = await workspace.registry();
        const id = source.workspaceId.toLowerCase();
        if (!validWorkspaceId(registry.workspaceId) || registry.workspaceId.toLowerCase() !== id) throw new Error('The workspace GUID changed. Check the project and register it again.');
        if (seenIds.has(id)) throw new Error('Another registered workspace has the same GUID. Register only one checkout of each workspace.');
        const cardIds = new Set();
        for (const entity of registry.entities) {
          if (!entity || typeof entity.id !== 'string' || !entity.id || cardIds.has(entity.id) || !Array.isArray(entity.steps)) throw new Error('Workspace cards need unique IDs and a steps array.');
          if (typeof entity.title !== 'string' || typeof entity.folder !== 'string' || !['standalone', 'group'].includes(entity.type) || !['active', 'done', 'archived'].includes(entity.status) || !/^\d{4}-\d{2}-\d{2}$/.test(entity.created) || (entity.updated !== undefined && !/^\d{4}-\d{2}-\d{2}$/.test(entity.updated))) throw new Error('Workspace cards need a title, folder, type, status and dates.');
          if (['description', 'category', 'icon'].some(key => entity[key] !== undefined && typeof entity[key] !== 'string') || entity.steps.some(step => !step || typeof step.name !== 'string' || typeof step.path !== 'string' || !step.path)) throw new Error('Card text and report names/paths must be text.');
          if (registry.title !== undefined && typeof registry.title !== 'string') throw new Error('The workspace title must be text.');
          cardIds.add(entity.id);
          if (records.has(`${id}:${entity.id}`)) throw new Error('This card ID conflicts with another workspace.');
        }
        seenIds.add(id);
        const grant = this.files.grant(workspaceRoot, { pinned: true });
        activeGrants.set(workspaceRoot, grant);
        const workspaceBase = `${this.files.origin}/view/${grant}`;
        for (const entity of registry.entities) {
          const merged = { ...entity, id: `${id}:${entity.id}`, cardId: entity.id, workspaceId: id, workspaceLabel: source.label || registry.title || path.basename(root), workspacePath: source.path, workspaceBase };
          entities.push(merged);
          records.set(merged.id, { entity, merged, workspace, workspaceRoot });
        }
      } catch (error) {
        entities.push(unavailable(source || {}, error));
      }
    }
    for (const [root, grant] of this.sourceGrants) if (!activeGrants.has(root)) { this.files.grants.delete(grant); this.files.pinnedGrants.delete(grant); }
    this.sourceGrants = activeGrants;
    return { registry: sources.length ? { ...primary, entities } : primary, records };
  }
  async registry() { return (await this.catalog()).registry; }
  async resolve(id) {
    const record = (await this.catalog()).records.get(id);
    if (!record) throw Object.assign(new Error('Workspace card is unavailable.'), { status: 404 });
    return record;
  }
  async preview(id, step = 0) {
    const { entity, merged, workspaceRoot } = await this.resolve(id);
    if (!Number.isInteger(step) || !entity.steps?.[step]) throw Object.assign(new Error('Report tab was not found.'), { status: 404 });
    const relative = path.join(entity.folder, entity.steps[step].path.split(/[?#]/)[0]);
    const { file } = await realFile(workspaceRoot, relative);
    const preview = await this.files.preview(file);
    if (merged) preview.url = `${merged.workspaceBase}/${relative.split(path.sep).map(encodeURIComponent).join('/')}`;
    return preview;
  }
  async list({ query = '', date, status } = {}) {
    const { entities } = await this.registry();
    return entities.filter(item => (!query || `${item.id} ${item.title} ${item.description} ${item.workspaceLabel || ''}`.toLowerCase().includes(query.toLowerCase())) && (!date || item.created === date || item.updated === date) && (!status || item.status === status))
      .map(({ id, title, description, status, category, created, updated, pinned, steps, unavailable, workspaceLabel }) => ({ id, title, description, status, category, created, updated, pinned: !!pinned, steps: (steps || []).map(({ name }, index) => ({ name, index })), ...(unavailable ? { unavailable } : {}), ...(workspaceLabel ? { workspaceLabel } : {}) }));
  }
  async read(id, step = 0) {
    const { entity, merged, workspace } = await this.resolve(id);
    return { ...await workspace.read(entity.id, step), ...(merged ? { id: merged.id, workspaceLabel: merged.workspaceLabel } : {}) };
  }
  async update(id, patch) {
    const { entity, merged, workspace } = await this.resolve(id);
    return { ...await workspace.update(entity.id, patch), ...(merged ? { id: merged.id } : {}) };
  }
  async activity(date) {
    const primary = await this.primary.activity(date);
    const { entities } = await this.registry();
    return { ...primary, cards: entities.filter(item => item.workspaceId && (item.created === date || item.updated === date)).map(({ id, title }) => ({ id, title })).concat(primary.cards) };
  }
}
