import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GioUnix from 'gi://GioUnix';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import {gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {
    computeQuakeRect,
    getPointerMonitorIndex,
    isValidRect,
    percentFromRect,
    sanitizeMonitorIndex,
    slideOffsetForSide,
} from './geometry.js';
import {formatMessage, type QuakeEntry} from './types.js';

// Persistent module-level state to remember windows and their geometries
// across disable/enable cycles (such as when the system is suspended).
const PERSISTENT_WINDOWS = new Map<number, string>();
const PERSISTENT_PERCENT = new Map<string, number>();
const PERSISTENT_MONITOR = new Map<string, number>();

const SHOW_ANIM_MS = 240;
const HIDE_ANIM_MS = 280;
const CLAIM_TIMEOUT_MS = 8000;
const FIRST_FRAME_FALLBACK_MS = 750;

interface PendingClaim {
    entryId: string;
    timeoutId: number;
}

interface FirstFrameWatch {
    actor: Clutter.Actor;
    fallbackId: number;
}

interface HideSnapshotState {
    entryId: string;
    visual: Clutter.Actor;
}

interface WindowManagerEffects {
    skipNextEffect(actor: Meta.WindowActor): void;
}

/** Shell 49+: unmaximize with no flags argument. */
function unmaximizeWindow(win: Meta.Window): void {
    if (win.get_maximize_flags() !== 0)
        win.unmaximize();
}

export class QuakeManager {
    private _entries = new Map<string, QuakeEntry>();
    private _windows = new Map<string, Meta.Window>();
    private _livePercent = new Map<string, number>();
    private _lastMonitor = new Map<string, number>();
    private _pending: PendingClaim | null = null;
    private _animating = new Set<string>();
    private _applyingGeometry = new Set<string>();
    private _sourceIds = new Set<number>();
    private _firstFrameWatches = new Map<string, FirstFrameWatch>();
    private _hideSnapshots = new Map<Meta.WindowActor, HideSnapshotState>();

    enable(): void {
        global.display.connectObject(
            'window-created',
            (_d: Meta.Display, win: Meta.Window) => this._onWindowCreated(win),
            'window-entered-monitor',
            (_d: Meta.Display, monitorIndex: number, win: Meta.Window) =>
                this._onEnteredMonitor(monitorIndex, win),
            this,
        );

        // Claim previously spawned windows after suspend/disable
        this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
            const aliveIds = new Set<number>();
            for (const actor of global.get_window_actors()) {
                const win = actor.meta_window;
                if (!win)
                    continue;
                
                const id = win.get_id();
                aliveIds.add(id);

                const entryId = PERSISTENT_WINDOWS.get(id);
                if (entryId && this._entries.has(entryId))
                    this._claimWindow(entryId, win, true);
            }

            // Cleanup any leaked window IDs
            for (const id of PERSISTENT_WINDOWS.keys()) {
                if (!aliveIds.has(id))
                    PERSISTENT_WINDOWS.delete(id);
            }

            return GLib.SOURCE_REMOVE;
        });
    }

    disable(): void {
        global.display.disconnectObject(this);

        this._clearHideSnapshots();
        this._clearPending();
        this._clearSources();
        for (const id of [...this._windows.keys()])
            this._detachWindow(id, false);
        this._entries.clear();
        this._livePercent.clear();
        this._lastMonitor.clear();
        this._applyingGeometry.clear();
        this._animating.clear();
        this._firstFrameWatches.clear();
        this._hideSnapshots.clear();
    }

    setEntries(entries: QuakeEntry[]): void {
        const nextIds = new Set(entries.map(e => e.id));
        for (const id of [...this._entries.keys()]) {
            if (!nextIds.has(id)) {
                this._detachWindow(id, false);
                this._livePercent.delete(id);
                this._lastMonitor.delete(id);
            }
        }

        this._entries.clear();
        for (const entry of entries)
            this._entries.set(entry.id, entry);
    }

    getEntry(id: string): QuakeEntry | undefined {
        return this._entries.get(id);
    }

    toggle(entryId: string): void {
        const entry = this._entries.get(entryId);
        if (!entry)
            return;

        let win = this._windows.get(entryId);
        if (!win || !this._isWindowAlive(win)) {
            this._detachWindow(entryId, true);

            win = this._findExistingWindow(entry);
            if (win) {
                this._claimWindow(entryId, win, true);

                if (this._isVisible(win))
                    this._hide(entryId, win, entry);
                else
                    this._show(entryId, win, entry);
                return;
            }

            this._spawn(entry);
            return;
        }

        if (this._isVisible(win))
            this._hide(entryId, win, entry);
        else
            this._show(entryId, win, entry);
    }

    private _isWindowAlive(win: Meta.Window | null | undefined): boolean {
        if (!win)
            return false;
        try {
            return win.get_compositor_private() != null;
        } catch {
            return false;
        }
    }

    private _spawn(entry: QuakeEntry): void {
        const app = this._resolveApp(entry.appId);
        if (!app) {
            Main.notify(
                _('Quake Anything'),
                formatMessage(_('Could not find app: %s'), entry.appId),
            );
            return;
        }

        this._clearPending();
        const timeoutId = this._timeoutAdd(GLib.PRIORITY_DEFAULT, CLAIM_TIMEOUT_MS, () => {
            if (this._pending?.entryId === entry.id) {
                Main.notify(
                    _('Quake Anything'),
                    formatMessage(_('Timed out waiting for %s'), entry.appId),
                );
                this._pending = null;
            }
            return GLib.SOURCE_REMOVE;
        });
        this._pending = {
            entryId: entry.id,
            timeoutId,
        };

        try {
            if (app.can_open_new_window()) {
                app.open_new_window(-1);
            } else {
                const workspace = global.workspace_manager.get_active_workspace_index();
                app.launch(global.get_current_time(), workspace, Shell.AppLaunchGpu.APP_PREF);
            }
        } catch (e) {
            this._clearPending();
            Main.notify(
                _('Quake Anything'),
                formatMessage(_('Failed to launch %s'), entry.appId),
            );
            console.error('[quake-anything] launch failed', e);
        }
    }

    private _onWindowCreated(win: Meta.Window): void {
        const pending = this._pending;
        if (!pending)
            return;

        this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (!this._pending || this._pending.entryId !== pending.entryId)
                return GLib.SOURCE_REMOVE;
            if (!this._isWindowAlive(win))
                return GLib.SOURCE_REMOVE;

            if (!this._windowMatchesPending(win, pending.entryId)) {
                this._timeoutAdd(GLib.PRIORITY_DEFAULT, 100, () => {
                    if (!this._pending || this._pending.entryId !== pending.entryId)
                        return GLib.SOURCE_REMOVE;
                    if (!this._isWindowAlive(win))
                        return GLib.SOURCE_REMOVE;
                    if (this._windowMatchesPending(win, pending.entryId))
                        this._claimWindow(pending.entryId, win);
                    return GLib.SOURCE_REMOVE;
                });
                return GLib.SOURCE_REMOVE;
            }

            this._claimWindow(pending.entryId, win);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _windowMatchesPending(win: Meta.Window, entryId: string): boolean {
        const entry = this._entries.get(entryId);
        return !!entry && this._windowMatchesEntry(win, entry);
    }

    private _windowMatchesEntry(win: Meta.Window, entry: QuakeEntry): boolean {
        if (this._windowMatchesTrackedApp(win, entry.appId))
            return true;

        const startupWmClass = this._getStartupWmClass(entry.appId);
        if (startupWmClass && this._windowMatchesWmClass(win, startupWmClass))
            return true;

        const webAppIdentity = this._getWebAppClassIdentity(entry.appId);
        return !!webAppIdentity && this._windowMatchesWebAppIdentity(win, webAppIdentity);
    }

    private _windowMatchesTrackedApp(win: Meta.Window, appId: string): boolean {
        const tracker = Shell.WindowTracker.get_default();
        const app = tracker.get_window_app(win);
        if (!app)
            return false;

        return this._normalizeAppId(app.get_id()) === this._normalizeAppId(appId);
    }

    private _getStartupWmClass(appId: string): string | null {
        const raw = appId.trim();
        const desktopId = raw.endsWith('.desktop') ? raw : `${raw}.desktop`;
        const info = GioUnix.DesktopAppInfo.new(desktopId);
        return info?.get_startup_wm_class() ?? null;
    }

    private _windowMatchesWmClass(win: Meta.Window, startupWmClass: string): boolean {
        const expected = startupWmClass.trim().toLowerCase();
        if (!expected)
            return false;

        return [win.get_wm_class(), win.get_wm_class_instance()]
            .some(value => value?.trim().toLowerCase() === expected);
    }

    private _getWebAppClassIdentity(
        appId: string,
    ): {token: string; profile: string | null} | null {
        const raw = appId.trim();
        const desktopId = raw.endsWith('.desktop') ? raw : `${raw}.desktop`;
        const commandLine = GioUnix.DesktopAppInfo.new(desktopId)?.get_commandline();
        if (!commandLine)
            return null;

        const appMatch = commandLine.match(
            /(?:^|\s)--app=(?:"([^"]+)"|'([^']+)'|(\S+))/,
        );
        const appUrl = appMatch?.[1] ?? appMatch?.[2] ?? appMatch?.[3];
        if (!appUrl)
            return null;

        const urlMatch = appUrl.match(
            /^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)([^?#]*)/i,
        );
        if (!urlMatch)
            return null;

        const host = urlMatch[1].replace(/:\d+$/, '').toLowerCase();
        const path = urlMatch[2] || '/';

        // Chromium derives URL-app names from "{host}_{path}" and sanitizes
        // path separators for the WM class. For example:
        // https://chatgpt.com -> chatgpt.com_/ -> chatgpt.com__
        const token = `${host}_${path}`
            .replace(/[/\\]/g, '_')
            .toLowerCase();

        const profileMatch = commandLine.match(
            /(?:^|\s)--profile-directory=(?:"([^"]+)"|'([^']+)'|(\S+))/,
        );
        const profile = profileMatch?.[1] ?? profileMatch?.[2] ?? profileMatch?.[3] ?? null;

        return {token, profile};
    }

    private _windowMatchesWebAppIdentity(
        win: Meta.Window,
        identity: {token: string; profile: string | null},
    ): boolean {
        const suffix = identity.profile
            ? `${identity.token}-${identity.profile.toLowerCase()}`
            : identity.token;

        return [win.get_wm_class(), win.get_wm_class_instance()]
            .some(value => {
                const normalized = value?.trim().toLowerCase();
                return !!normalized && (
                    normalized === suffix ||
                    normalized.endsWith(`-${suffix}`) ||
                    (!identity.profile && normalized.includes(`-${identity.token}`))
                );
            });
    }

    private _findExistingWindow(entry: QuakeEntry): Meta.Window | undefined {
        const windows = global.get_window_actors()
            .map(actor => actor.meta_window)
            .filter((win): win is Meta.Window => !!win && this._isWindowAlive(win));

        // Prefer explicit StartupWMClass when the desktop file and the actual
        // window agree on it.
        const startupWmClass = this._getStartupWmClass(entry.appId);
        if (startupWmClass) {
            const wmClassMatch = windows.find(win =>
                this._windowMatchesWmClass(win, startupWmClass));
            if (wmClassMatch)
                return wmClassMatch;
        }

        // Chrome/Chromium URL apps launched with --app=<URL> can expose a
        // site-derived WM class instead of the desktop file's StartupWMClass.
        const webAppIdentity = this._getWebAppClassIdentity(entry.appId);
        if (webAppIdentity) {
            const webAppMatch = windows.find(win =>
                this._windowMatchesWebAppIdentity(win, webAppIdentity));
            if (webAppMatch)
                return webAppMatch;
        }

        // For regular apps, only recover automatically when there is a single
        // matching window so we do not accidentally claim an unrelated window.
        const trackedMatches = windows.filter(win =>
            this._windowMatchesTrackedApp(win, entry.appId));
        return trackedMatches.length === 1 ? trackedMatches[0] : undefined;
    }

    private _claimWindow(entryId: string, win: Meta.Window, isRestore = false): void {
        const entry = this._entries.get(entryId);
        if (!entry || !this._isWindowAlive(win))
            return;

        this._clearPending();

        const existing = this._windows.get(entryId);
        if (existing && existing !== win)
            this._detachWindow(entryId, false);

        this._windows.set(entryId, win);
        PERSISTENT_WINDOWS.set(win.get_id(), entryId);

        if (!isRestore) {
            this._livePercent.delete(entryId);
            this._lastMonitor.delete(entryId);
        }

        win.connectObject('unmanaged', () => {
            PERSISTENT_WINDOWS.delete(win.get_id());
            PERSISTENT_PERCENT.delete(entryId);
            PERSISTENT_MONITOR.delete(entryId);
            if (this._windows.get(entryId) === win)
                this._detachWindow(entryId, true);
        }, this);

        if (isRestore) {
            const percent = PERSISTENT_PERCENT.get(entryId);
            if (percent !== undefined)
                this._livePercent.set(entryId, percent);
            const mon = PERSISTENT_MONITOR.get(entryId);
            if (mon !== undefined)
                this._lastMonitor.set(entryId, mon);
            
            if (this._isVisible(win))
                this._applyQuakeGeometry(entryId, win, entry, false);
            return;
        }

        const place = () => {
            this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                if (this._windows.get(entryId) !== win || !this._isWindowAlive(win))
                    return GLib.SOURCE_REMOVE;
                this._applyQuakeGeometry(entryId, win, entry, true);
                this._show(entryId, win, entry);
                return GLib.SOURCE_REMOVE;
            });
        };

        const actor = this._isWindowAlive(win)
            ? win.get_compositor_private() as Clutter.Actor | null
            : null;

        if (actor) {
            this._clearFirstFrameWatch(entryId);
            actor.connectObject('first-frame', () => {
                this._clearFirstFrameWatch(entryId);
                place();
            }, this);
            const fallbackId = this._timeoutAdd(
                GLib.PRIORITY_DEFAULT,
                FIRST_FRAME_FALLBACK_MS,
                () => {
                    const watch = this._firstFrameWatches.get(entryId);
                    if (!watch || watch.fallbackId !== fallbackId)
                        return GLib.SOURCE_REMOVE;
                    this._clearFirstFrameWatch(entryId);
                    place();
                    return GLib.SOURCE_REMOVE;
                },
            );
            this._firstFrameWatches.set(entryId, { actor, fallbackId });
        } else {
            this._timeoutAdd(GLib.PRIORITY_DEFAULT, 100, () => {
                place();
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _detachWindow(entryId: string, resetSessionState: boolean): void {
        const win = this._windows.get(entryId);
        win?.disconnectObject(this);
        this._clearFirstFrameWatch(entryId);

        this._animating.delete(entryId);
        if (win && this._isWindowAlive(win)) {
            const actor = win.get_compositor_private() as Meta.WindowActor | null;
            if (actor) {
                this._clearHideSnapshot(actor);
                actor.remove_all_transitions();
                actor.set_translation(0, 0, 0);
                actor.set_scale(1, 1);
                actor.set_opacity(255);
                actor.set_pivot_point(0, 0);
            }
        }

        this._windows.delete(entryId);
        this._applyingGeometry.delete(entryId);
        if (resetSessionState) {
            this._livePercent.delete(entryId);
            this._lastMonitor.delete(entryId);
        }
    }

    private _clearFirstFrameWatch(entryId: string): void {
        const watch = this._firstFrameWatches.get(entryId);
        this._firstFrameWatches.delete(entryId);
        if (!watch)
            return;
        if (watch.fallbackId)
            this._removeSource(watch.fallbackId);
        watch.actor.disconnectObject(this);
    }

    private _entryIdForWindow(win: Meta.Window): string | null {
        for (const [id, owned] of this._windows) {
            if (owned === win)
                return id;
        }
        return null;
    }

    private _onEnteredMonitor(monitorIndex: number, win: Meta.Window): void {
        const entryId = this._entryIdForWindow(win);
        if (!entryId)
            return;
        if (this._applyingGeometry.has(entryId) || this._animating.has(entryId))
            return;
        if (!this._isWindowAlive(win))
            return;

        const entry = this._entries.get(entryId);
        if (!entry)
            return;

        const safeIndex = sanitizeMonitorIndex(monitorIndex);
        if (win.minimized || !this._isVisible(win)) {
            this._lastMonitor.set(entryId, safeIndex);
            PERSISTENT_MONITOR.set(entryId, safeIndex);
            return;
        }

        const previous = this._lastMonitor.get(entryId);
        this._lastMonitor.set(entryId, safeIndex);
        PERSISTENT_MONITOR.set(entryId, safeIndex);
        if (previous === safeIndex)
            return;

        this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
            if (this._windows.get(entryId) !== win || !this._isWindowAlive(win))
                return GLib.SOURCE_REMOVE;
            this._applyQuakeGeometry(entryId, win, entry, false);
            return GLib.SOURCE_REMOVE;
        });
    }

    private _effectivePercent(entryId: string, entry: QuakeEntry): number {
        return this._livePercent.get(entryId) ?? entry.sizePercent;
    }

    private _rememberQuakePercent(entryId: string, win: Meta.Window, entry: QuakeEntry): void {
        if (!this._isWindowAlive(win))
            return;

        const frame = win.get_frame_rect();
        const monitor = sanitizeMonitorIndex(win.get_monitor());
        const percent = percentFromRect(
            entry.side,
            { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
            monitor,
        );
        this._livePercent.set(entryId, percent);
        this._lastMonitor.set(entryId, monitor);
        PERSISTENT_PERCENT.set(entryId, percent);
        PERSISTENT_MONITOR.set(entryId, monitor);
    }

    private _applyQuakeGeometry(
        entryId: string,
        win: Meta.Window,
        entry: QuakeEntry,
        usePointerMonitor: boolean,
    ): void {
        if (!this._isWindowAlive(win))
            return;

        const percent = this._effectivePercent(entryId, entry);
        const rawMonitor = usePointerMonitor
            ? getPointerMonitorIndex()
            : win.get_monitor();
        const monitor = sanitizeMonitorIndex(rawMonitor);
        const rect = computeQuakeRect(entry.side, percent, monitor);
        if (!isValidRect(rect)) {
            console.error('[quake-anything] refusing invalid quake rect', rect);
            return;
        }

        this._applyingGeometry.add(entryId);
        try {
            unmaximizeWindow(win);

            if (sanitizeMonitorIndex(win.get_monitor()) !== monitor)
                win.move_to_monitor(monitor);

            const workspace = global.workspace_manager.get_active_workspace();
            if (!win.located_on_workspace(workspace))
                win.change_workspace(workspace);

            win.move_resize_frame(false, rect.x, rect.y, rect.width, rect.height);
            this._lastMonitor.set(entryId, monitor);
            PERSISTENT_MONITOR.set(entryId, monitor);
            if (!this._livePercent.has(entryId)) {
                this._livePercent.set(entryId, percent);
                PERSISTENT_PERCENT.set(entryId, percent);
            }
        } finally {
            this._idleAdd(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._applyingGeometry.delete(entryId);
                return GLib.SOURCE_REMOVE;
            });
        }
    }

    private _isVisible(win: Meta.Window): boolean {
        if (!this._isWindowAlive(win))
            return false;
        if (win.minimized)
            return false;
        const actor = win.get_compositor_private() as Clutter.Actor | null;
        return !!(actor && actor.visible);
    }

    private _show(entryId: string, win: Meta.Window, entry: QuakeEntry): void {
        if (this._animating.has(entryId))
            return;
        if (!this._isWindowAlive(win)) {
            this._detachWindow(entryId, true);
            return;
        }

        const actor = win.get_compositor_private() as Meta.WindowActor | null;

        if (actor) {
            actor.remove_all_transitions();
            actor.set_translation(0, 0, 0);
            actor.set_scale(1, 1);
            actor.set_opacity(0);
            actor.set_pivot_point(0, 0);
        }

        if (win.minimized) {
            if (actor) {
                (Main.wm as unknown as WindowManagerEffects)
                    .skipNextEffect(actor);
            }
            win.unminimize();
        }

        this._applyQuakeGeometry(entryId, win, entry, false);

        if (!this._isWindowAlive(win)) {
            this._detachWindow(entryId, true);
            return;
        }

        if (!actor) {
            win.activate(global.get_current_time());
            return;
        }

        const rect = computeQuakeRect(
            entry.side,
            this._effectivePercent(entryId, entry),
            sanitizeMonitorIndex(win.get_monitor()),
        );
        if (!isValidRect(rect)) {
            actor.set_opacity(255);
            win.activate(global.get_current_time());
            return;
        }

        const offset = slideOffsetForSide(entry.side, rect);
        const bufferRect = win.get_buffer_rect();

        // skipNextEffect() completes unminimize without running Shell's normal
        // actor-position animation. Sync the compositor actor explicitly to
        // Mutter's authoritative buffer geometry before our slide-in starts.
        actor.set_position(bufferRect.x, bufferRect.y);
        actor.set_size(bufferRect.width, bufferRect.height);
        actor.set_translation(offset.x, offset.y, 0);
        actor.set_opacity(255);
        win.activate(global.get_current_time());

        this._animating.add(entryId);
        // GJS/Clutter expects GObject property names here. The bundled
        // TypeScript typings expose camelCase aliases instead, hence the cast.
        actor.ease({
            translation_x: 0,
            translation_y: 0,
            duration: SHOW_ANIM_MS,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                this._animating.delete(entryId);
            },
        } as any);
    }

    private _hide(entryId: string, win: Meta.Window, entry: QuakeEntry): void {
        if (this._animating.has(entryId))
            return;
        if (!this._isWindowAlive(win)) {
            this._detachWindow(entryId, true);
            return;
        }

        this._rememberQuakePercent(entryId, win, entry);

        const actor = win.get_compositor_private() as Meta.WindowActor | null;
        if (!actor) {
            win.minimize();
            return;
        }

        const rect = computeQuakeRect(
            entry.side,
            this._effectivePercent(entryId, entry),
            sanitizeMonitorIndex(win.get_monitor()),
        );
        if (!isValidRect(rect)) {
            win.minimize();
            return;
        }

        const offset = slideOffsetForSide(entry.side, rect);

        // Meta.Window geometry is authoritative. Meta.WindowActor can briefly
        // retain stale coordinates across unminimize/geometry synchronization.
        const bufferRect = win.get_buffer_rect();
        const snapshotRect = {
            x: bufferRect.x,
            y: bufferRect.y,
            width: bufferRect.width,
            height: bufferRect.height,
        };

        try {
            const content = actor.paint_to_content(null);
            const parent = actor.get_parent();

            if (!content || !parent)
                throw new Error('snapshot content or parent unavailable');

            const visual = new Clutter.Actor({
                x: snapshotRect.x,
                y: snapshotRect.y,
                width: snapshotRect.width,
                height: snapshotRect.height,
                reactive: false,
            });
            visual.set_content(content);
            parent.add_child(visual);

            this._hideSnapshots.set(actor, {entryId, visual});
            this._animating.add(entryId);

            // Keep the real window mapped but invisible while the independent
            // snapshot performs the whole visual transition. Only after the
            // snapshot reaches the edge do we ask Mutter to minimize, with its
            // native effect explicitly skipped.
            actor.set_opacity(0);

            // Clutter.ease() uses GObject property names at runtime.
            visual.ease({
                translation_x: offset.x,
                translation_y: offset.y,
                duration: HIDE_ANIM_MS,
                mode: Clutter.AnimationMode.EASE_IN_OUT_CUBIC,
                onStopped: () => {
                    if (this._windows.get(entryId) === win && this._isWindowAlive(win)) {
                        (Main.wm as unknown as WindowManagerEffects)
                            .skipNextEffect(actor);
                        win.minimize();
                    }

                    this._clearHideSnapshot(actor);
                },
            } as any);
        } catch (e) {
            console.warn('[quake-anything] hide snapshot failed; minimizing without animation', e);
            actor.set_opacity(255);
            (Main.wm as unknown as WindowManagerEffects)
                .skipNextEffect(actor);
            win.minimize();
        }
    }

    private _clearHideSnapshot(actor: Meta.WindowActor): void {
        const state = this._hideSnapshots.get(actor);
        if (!state)
            return;

        this._hideSnapshots.delete(actor);
        this._animating.delete(state.entryId);

        state.visual.remove_all_transitions();
        state.visual.destroy();

        actor.set_translation(0, 0, 0);
        actor.set_scale(1, 1);
        actor.set_opacity(255);
        actor.set_pivot_point(0, 0);
    }

    private _clearHideSnapshots(): void {
        for (const actor of [...this._hideSnapshots.keys()])
            this._clearHideSnapshot(actor);
    }

    private _resolveApp(appId: string): Shell.App | null {
        const context = Shell.AppSystem.get_default();
        const raw = appId.trim();
        const candidates = [
            raw,
            raw.endsWith('.desktop') ? raw : `${raw}.desktop`,
            raw.replace(/\.desktop$/i, ''),
        ];

        for (const id of candidates) {
            const app = context.lookup_app(id);
            if (app)
                return app;
        }

        const desktopId = raw.endsWith('.desktop') ? raw : `${raw}.desktop`;
        const info = GioUnix.DesktopAppInfo.new(desktopId);
        if (info) {
            const id = info.get_id();
            if (id) {
                const app = context.lookup_app(id);
                if (app)
                    return app;
            }
        }
        return null;
    }

    private _normalizeAppId(appId: string): string {
        return appId.trim().replace(/\.desktop$/i, '').toLowerCase();
    }

    private _idleAdd(priority: number, callback: () => boolean): number {
        let sourceId = 0;
        sourceId = GLib.idle_add(priority, () => {
            this._sourceIds.delete(sourceId);
            return callback();
        });
        this._sourceIds.add(sourceId);
        return sourceId;
    }

    private _timeoutAdd(priority: number, intervalMs: number, callback: () => boolean): number {
        let sourceId = 0;
        sourceId = GLib.timeout_add(priority, intervalMs, () => {
            this._sourceIds.delete(sourceId);
            return callback();
        });
        this._sourceIds.add(sourceId);
        return sourceId;
    }

    private _removeSource(sourceId: number): void {
        if (!this._sourceIds.has(sourceId))
            return;
        this._sourceIds.delete(sourceId);
        GLib.Source.remove(sourceId);
    }

    private _clearSources(): void {
        for (const sourceId of this._sourceIds)
            GLib.Source.remove(sourceId);
        this._sourceIds.clear();
    }

    private _clearPending(): void {
        if (this._pending?.timeoutId)
            this._removeSource(this._pending.timeoutId);
        this._pending = null;
    }
}
