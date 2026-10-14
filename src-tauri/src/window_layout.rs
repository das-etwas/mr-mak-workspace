//! The window-state plugin owns geometry; this companion restores shell Snap state.
//! Only our own HWNDs are touched. Windows shortcuts require foreground ownership.
use std::{collections::BTreeMap, fs, path::PathBuf, sync::{Arc, Mutex, atomic::{AtomicBool, Ordering}}, thread, time::Duration};
use tauri::Manager;
use windows_sys::Win32::{Foundation::{HWND, RECT, POINT}, Graphics::Gdi::{GetMonitorInfoW, MonitorFromWindow, MONITORINFO, MONITOR_DEFAULTTONEAREST},
    UI::{HiDpi::GetDpiForWindow, Input::KeyboardAndMouse::*, WindowsAndMessaging::*}};

struct Inner {
    windows: Vec<(String, usize)>,
    file: PathBuf,
    snapped: Mutex<BTreeMap<String, bool>>,
    dirty: AtomicBool,
    stopped: AtomicBool,
}
pub struct WindowLayout(Arc<Inner>);
impl WindowLayout {
    pub fn start(app: &tauri::AppHandle) -> Result<Self, Box<dyn std::error::Error>> {
        let file = app.path().app_config_dir()?.join(".snap-layout.json");
        let saved: BTreeMap<String, bool> = fs::read(&file).ok().and_then(|bytes| serde_json::from_slice(&bytes).ok()).unwrap_or_default();
        let mut windows = Vec::new();
        for label in ["chats", "workspace"] {
            if let Some(window) = app.get_webview_window(label) { windows.push((label.to_owned(), window.hwnd()?.0 as usize)); }
        }
        let inner = Arc::new(Inner { windows, file, snapped: Mutex::new(saved.clone()), dirty: AtomicBool::new(false), stopped: AtomicBool::new(false) });
        let worker = inner.clone();
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(250));
            unsafe { restore(&worker, &saved); }
            while !worker.stopped.load(Ordering::Relaxed) {
                worker.save();
                thread::sleep(Duration::from_millis(300));
            }
        });
        Ok(Self(inner))
    }
    pub fn shutdown(&self) {
        self.0.stopped.store(true, Ordering::Relaxed);
        self.0.save();
    }
}
impl Drop for WindowLayout { fn drop(&mut self) { self.0.stopped.store(true, Ordering::Relaxed); } }
impl Inner {
    fn trace(&self, text: &str) {
        if std::env::var_os("MRMAK_DEBUG_WINDOW_LAYOUT").is_some() {
            use std::io::Write;
            if let Ok(mut file) = fs::OpenOptions::new().create(true).append(true).open(self.file.with_extension("trace.log")) { let _ = writeln!(file, "{text}"); }
        }
    }
    fn save(&self) {
        let mut saved = self.snapped.lock().unwrap();
        let mut changed = false;
        for (label, handle) in &self.windows {
            let hwnd = *handle as HWND;
            // Hiding or minimizing does not replace the last usable layout.
            if unsafe { IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 } { continue; }
            let snapped = unsafe { IsWindowArranged(hwnd) != 0 };
            if saved.get(label) != Some(&snapped) { saved.insert(label.clone(), snapped); changed = true; }
        }
        if changed { self.dirty.store(true, Ordering::Relaxed); }
        if self.dirty.load(Ordering::Relaxed) || !self.file.is_file() {
            if let Ok(bytes) = serde_json::to_vec_pretty(&*saved) {
                let temporary = self.file.with_extension("json.tmp");
                if fs::write(&temporary, bytes).is_ok() && fs::rename(temporary, &self.file).is_ok() { self.dirty.store(false, Ordering::Relaxed); }
            }
        }
    }
}

fn user_holds_keys() -> bool {
    [VK_SHIFT, VK_CONTROL, VK_MENU, VK_LWIN, VK_RWIN, VK_LBUTTON, VK_RBUTTON].iter().any(|key| unsafe { GetAsyncKeyState(*key as i32) < 0 })
}
unsafe fn chord(direction: u16) -> bool {
    let key = |vk, flags| INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
    let inputs = [key(VK_LWIN, 0), key(direction, 0), key(direction, KEYEVENTF_KEYUP), key(VK_LWIN, KEYEVENTF_KEYUP)];
    let sent = SendInput(4, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    if sent > 0 && sent < 4 {
        let release = [key(direction, KEYEVENTF_KEYUP), key(VK_LWIN, KEYEVENTF_KEYUP)];
        SendInput(2, release.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    }
    sent == 4
}
struct SnapFlyout(HWND);
impl Drop for SnapFlyout {
    fn drop(&mut self) { unsafe {
        // Cancel only the flyout opened by this operation, if it remains active.
        if GetForegroundWindow() == self.0 && !user_holds_keys() {
            let key = |flags| INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: VK_ESCAPE, wScan: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
            let inputs = [key(0), key(KEYEVENTF_KEYUP)];
            SendInput(2, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
        }
    } }
}
unsafe fn snap_menu(hwnd: HWND, left: bool, quarter: Option<bool>, inner: &Inner) -> bool {
    let stopped = &inner.stopped;
    inner.trace(&format!("Snap menu target={hwnd:?} foreground={:?} held={}", GetForegroundWindow(), user_holds_keys()));
    if stopped.load(Ordering::Relaxed) || GetForegroundWindow() != hwnd || user_holds_keys() || !chord(0x5A) { return false; } // Win+Z, unaffected by FancyZones Win+Arrow overrides.
    let mut menu = std::ptr::null_mut();
    for _ in 0..30 {
        if stopped.load(Ordering::Relaxed) || user_holds_keys() { return false; }
        let candidate = GetForegroundWindow();
        let mut class = [0u16; 80];
        let count = GetClassNameW(candidate, class.as_mut_ptr(), class.len() as i32);
        if count > 0 && String::from_utf16_lossy(&class[..count as usize]) == "XamlExplorerHostIslandWindow" { menu = candidate; break; }
        thread::sleep(Duration::from_millis(25));
    }
    if menu.is_null() { inner.trace("No eligible flyout"); return false; }
    let _flyout = SnapFlyout(menu);
    thread::sleep(Duration::from_millis(150));
    let mut bounds: RECT = std::mem::zeroed();
    if GetWindowRect(menu, &mut bounds) == 0 { return false; }
    let scale = GetDpiForWindow(menu) as f64 / 96.0;
    if scale <= 0.0 { return false; }
    let width = (bounds.right - bounds.left) as f64 / scale;
    let height = (bounds.bottom - bounds.top) as f64 / scale;
    let columns = ((width - 14.0) / 110.0).round() as i32;
    let rows = ((height - 16.0) / 76.0).round() as i32;
    inner.trace(&format!("Flyout {width}x{height}, rows={rows} columns={columns}"));
    // The current Windows 11 flyout keeps standard templates in its last two
    // rows; suggested layouts above them can rearrange unrelated apps. Only
    // recognized flyout dimensions are eligible for this best-effort adapter.
    if !(2..=3).contains(&columns) || !(2..=3).contains(&rows)
        || (width - (columns * 110 + 14) as f64).abs() > 4.0 || (height - (rows * 76 + 16) as f64).abs() > 4.0 { return false; }
    let x = if left { 37 } else { 88 };
    let (x, y) = if let Some(top) = quarter { (x + 110, (rows - 1) * 76 + if top { 32 } else { 64 }) } else { (x, (rows - 2) * 76 + 48) };
    let point = POINT { x: bounds.left + (x as f64 * scale).round() as i32, y: bounds.top + (y as f64 * scale).round() as i32 };
    let hit = GetAncestor(WindowFromPoint(point), GA_ROOT);
    let mut popup_class = [0u16; 80];
    let class_length = GetClassNameW(hit, popup_class.as_mut_ptr(), popup_class.len() as i32);
    let mut menu_process = 0; let mut hit_process = 0;
    GetWindowThreadProcessId(menu, &mut menu_process); GetWindowThreadProcessId(hit, &mut hit_process);
    // XAML's keyboard-focus island and its mouse-input popup are separate HWNDs.
    let popup_host = class_length > 0 && String::from_utf16_lossy(&popup_class[..class_length as usize]) == "Xaml_WindowedPopupClass"
        && menu_process != 0 && menu_process == hit_process;
    inner.trace(&format!("Click {},{}, popup_host={popup_host}, menu={menu:?} foreground={:?} hit={hit:?}", point.x, point.y, GetForegroundWindow()));
    if GetForegroundWindow() != menu || (hit != menu && !popup_host) || user_holds_keys() { return false; }
    let mut previous: POINT = std::mem::zeroed();
    if GetCursorPos(&mut previous) == 0 { return false; }
    let screen_width = GetSystemMetrics(SM_CXVIRTUALSCREEN); let screen_height = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    if screen_width <= 1 || screen_height <= 1 { return false; }
    let mouse = |flags, dx, dy| INPUT { r#type: INPUT_MOUSE, Anonymous: INPUT_0 { mi: MOUSEINPUT { dx, dy, mouseData: 0, dwFlags: flags, time: 0, dwExtraInfo: 0 } } };
    let dx = ((point.x - GetSystemMetrics(SM_XVIRTUALSCREEN)) as i64 * 65535 / (screen_width - 1) as i64) as i32;
    let dy = ((point.y - GetSystemMetrics(SM_YVIRTUALSCREEN)) as i64 * 65535 / (screen_height - 1) as i64) as i32;
    let inputs = [mouse(MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_VIRTUALDESK, dx, dy), mouse(MOUSEEVENTF_LEFTDOWN, 0, 0), mouse(MOUSEEVENTF_LEFTUP, 0, 0)];
    let count = SendInput(3, inputs.as_ptr(), std::mem::size_of::<INPUT>() as i32);
    if count == 2 { let release = mouse(MOUSEEVENTF_LEFTUP, 0, 0); SendInput(1, &release, std::mem::size_of::<INPUT>() as i32); }
    let sent = count == 3;
    thread::sleep(Duration::from_millis(150));
    let mut current: POINT = std::mem::zeroed();
    if GetCursorPos(&mut current) != 0 && (current.x - point.x).abs() <= 1 && (current.y - point.y).abs() <= 1 { SetCursorPos(previous.x, previous.y); }
    thread::sleep(Duration::from_millis(300));
    inner.trace(&format!("Selection sent={sent} arranged={}", IsWindowArranged(hwnd)));
    sent && IsWindowArranged(hwnd) != 0
}
unsafe fn restore(inner: &Inner, saved: &BTreeMap<String, bool>) {
    let mut plans = Vec::new();
    for (label, handle) in &inner.windows {
        let hwnd = *handle as HWND;
        if saved.get(label) != Some(&true) || IsWindowVisible(hwnd) == 0 || IsIconic(hwnd) != 0 || IsZoomed(hwnd) != 0 { continue; }
        let mut rect: RECT = std::mem::zeroed();
        let mut monitor: MONITORINFO = std::mem::zeroed(); monitor.cbSize = std::mem::size_of::<MONITORINFO>() as u32;
        if GetWindowRect(hwnd, &mut rect) != 0 && GetMonitorInfoW(MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST), &mut monitor) != 0 {
            plans.push((hwnd, rect, monitor.rcWork));
        }
    }
    inner.trace(&format!("Restore {} planned windows, held={}", plans.len(), user_holds_keys()));
    if plans.is_empty() || user_holds_keys() { return; }
    // Native initialization may still be finishing. Wait briefly for a normal
    // foreground launch; do not seize focus from another app in the background.
    let mut active = false;
    for _ in 0..120 {
        if inner.stopped.load(Ordering::Relaxed) { return; }
        if user_holds_keys() { thread::sleep(Duration::from_millis(25)); continue; }
        if inner.windows.iter().any(|(_, handle)| *handle as HWND == GetForegroundWindow()) { active = true; break; }
        thread::sleep(Duration::from_millis(25));
    }
    if !active { inner.trace("No foreground ownership"); return; }
    let mut restored = Vec::new();
    for (hwnd, rect, area) in plans {
        if inner.stopped.load(Ordering::Relaxed) || user_holds_keys() || IsWindow(hwnd) == 0 { break; }
        SetForegroundWindow(hwnd);
        thread::sleep(Duration::from_millis(100));
        if GetForegroundWindow() != hwnd || user_holds_keys() { break; }
        let left = rect.left + rect.right <= area.left + area.right;
        let quarter = ((rect.bottom - rect.top) * 4 < (area.bottom - area.top) * 3).then_some(rect.top + rect.bottom <= area.top + area.bottom);
        if !snap_menu(hwnd, left, quarter, inner) { break; }
        restored.push((hwnd, rect));
    }
    // Positioning an already snapped window preserves its shell arrangement.
    // Restore the plugin's exact rectangles instead of imposing a 50/50 split.
    for (hwnd, rect) in restored {
        if inner.stopped.load(Ordering::Relaxed) || IsWindow(hwnd) == 0 { break; }
        SetWindowPos(hwnd, std::ptr::null_mut(), rect.left, rect.top, rect.right - rect.left, rect.bottom - rect.top, SWP_NOZORDER | SWP_NOACTIVATE);
    }
}
