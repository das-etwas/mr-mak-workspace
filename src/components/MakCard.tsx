import type { WorkspaceEntity } from '../types'
import { entityHash } from '../lib/route'
import { categoryIcon } from '../lib/categories'
import { workspaceUrl } from '../lib/workspace'
import { EntityStatusButton } from './EntityControls'
import { Icon } from '../desktop/Icons'

/**
 * The design-system card: glass surface over the aura, gradient edge
 * (pink→purple; amber when pinned), glow + lift on hover. Building
 * block of the home grid; mirrored as `.mak-card` in
 * scripts/shared/report_style.py for generated reports.
 */
export default function MakCard({ entity }: { entity: WorkspaceEntity }) {
  const steps = entity.steps.length
  return (
    <div className="entity-card-wrap" data-card={entity.id}>
    <a
      href={entityHash(entity.id)}
      className={`mak-card entity-card${entity.pinned ? ' pinned' : ''}`}
      data-entity={entity.id}
    >
      <div className="card-top">
        <span className="chip">
          <span aria-hidden="true">{categoryIcon(entity.category)}</span>
          {entity.category || 'other'}
        </span>
        {entity.pinned && <span className="chip chip-pin">pinned</span>}
        {entity.unavailable && <span className="chip">Unavailable</span>}
        {entity.workspacePath && (
          <span
            className="card-workspace-source"
            title={`External workspace\n${entity.workspacePath}`}
            aria-label={`External workspace: ${entity.workspacePath}`}
          >
            <Icon name="external" size={14} />
          </span>
        )}
      </div>

      <div className="card-project-title">
        {entity.icon && <img className="card-project-icon" src={workspaceUrl(entity, `${entity.folder}/${entity.icon}`)} width="48" height="48" alt="" loading="lazy" decoding="async" />}
        <h3 className="card-title">{entity.title}</h3>
      </div>

      {entity.description && <p className="card-desc">{entity.description}</p>}
      {entity.workspaceLabel && <p className="card-desc">{entity.workspaceLabel}</p>}

      <div className="card-foot">
        <span>
          {entity.unavailable ? 'Folder unavailable' : `${steps} step${steps === 1 ? '' : 's'}`}
        </span>
        <span>·</span>
        <span>{entity.updated ?? entity.created}</span>
        <span className="card-open" aria-hidden="true">
          open →
        </span>
      </div>
    </a>
    <EntityStatusButton entity={entity} />
    </div>
  )
}
