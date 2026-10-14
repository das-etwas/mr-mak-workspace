# Desktop window layout

The window-state plugin already stores the size, position and maximized state of
Chats and Workspace in `.window-state.json` in the application's configuration
directory. Free-floating windows retain that behavior.

On Windows, `.snap-layout.json` additionally records whether each window was
natively snapped. At the next foreground launch the app recreates that Snap
state, then reapplies the saved rectangles. This preserves unequal pane widths
and Windows' shared resize divider. Previously free windows stay free. Hiding
or minimizing a window preserves its last usable Snap state.

Snap restoration is a best-effort Windows 11 adapter. It opens the native
Win+Z flyout and selects a standard layout, avoiding suggested layouts that can
rearrange other apps. It recognizes the current two- and three-column flyouts,
including their separate XAML keyboard and input hosts. This also avoids
FancyZones' optional Win+Arrow override. Only the two Mr. Mak windows are
restored; other applications' layouts are left to Windows.

The adapter waits briefly for foreground ownership, checks held modifiers and
the native popup's identity, and restores the mouse pointer after selection
when it has not moved. If Windows refuses focus, Snap is disabled, or the
flyout structure is unsupported, the saved geometry still applies. Display or
Windows layout changes can prevent an exact restoration.

For native diagnostics, `MRMAK_DEBUG_WINDOW_LAYOUT=1` writes startup decisions
to `.snap-layout.trace.log` beside the layout files. No chat content is logged.
Set `MRMAK_DISABLE_SNAP_RESTORE=1` for geometry-only restoration.

Verification should use an isolated application identity and repository: snap
both windows, change their proportions, quit and reopen, then drag the divider
and check that both windows resize. Repeat with two free windows and with a
maximized window. The existing desktop app and its chats can remain open.
