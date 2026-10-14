# External project workspaces

The desktop dashboard can combine the main Workspace with cards from other
project repositories. Each project keeps its own `workspace/workspace.json`,
reports, images and shared report resources. Register machine-specific project
paths in the main repository's ignored `.mrmak/workspace-roots.json`.

From a terminal with Node.js available:

```text
node scripts/workspace-roots.mjs add /path/to/project --repo /path/to/main-workspace --label "My project"
```

Use `--init` to create an empty `workspace/` registry in an existing project.
The helper assigns `workspaceId`, a UUID, if the registry has none, preserving
existing cards and other metadata. Author cards using the existing Workspace
authoring workflow. Keep paths relative to the project's `workspace/` folder
and keep reports and their dependencies there, including `workspace/_shared/`
when using the shared styles. The desktop installer already includes the app;
project repositories do not need application source or npm dependencies.

```json
{
  "workspaceId": "b28e1156-63a2-439d-87de-304e746fb628",
  "title": "My project",
  "entities": []
}
```

Generate a fresh UUID for a new independent workspace. Preserve it when moving
or cloning the same workspace, and register only one checkout of that workspace
at a time. Adding its new location updates the existing local registration.
Identical card IDs in different workspaces are scoped by their workspace UUID;
the main workspace retains its existing card IDs and links.

```json
[
  {
    "workspaceId": "b28e1156-63a2-439d-87de-304e746fb628",
    "label": "My project",
    "path": "/absolute/path/to/project"
  }
]
```

The app reads registration changes on the next dashboard refresh. Refocus its
window or wait for the existing 30-second refresh; no restart is required.
Status/category edits and Markdown saves update the owning project. Runtime
source fields and generated report URLs are never written to its manifest.

Missing directories, invalid registries, changed UUIDs and duplicate workspace
UUIDs show an unavailable card without modifying the registration or stopping
other sources. Restore the directory or correct its registration to recover.
To unregister a workspace without deleting its files:

```text
node scripts/workspace-roots.mjs remove /path/to/project --repo /path/to/main-workspace
node scripts/workspace-roots.mjs list --repo /path/to/main-workspace
```

Only owner-registered directories can supply external cards. Report grants are
limited to each project's `workspace/` directory; paths and links cannot escape
it. A manifest cannot register new roots. Registrations stay local; commit the
project's report sources and UUID with the project, and ignore `.mrmak/` in any
repository that you also use as a main Workspace.

This first version loads external workspaces on desktop. Browser Preview and
Mobile Results retain their existing main-workspace behavior. Chat working
folders and skill discovery continue to follow the selected CLI's configuration.
