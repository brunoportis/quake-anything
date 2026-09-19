import type { QuakeSide } from './types.js';

export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

/** Clamp/validate a monitor index; fall back to current monitor if invalid. */
export function sanitizeMonitorIndex(monitorIndex: number): number {
    const display = global.display;
    const n = display.get_n_monitors();
    if (n <= 0)
        return 0;
    if (Number.isInteger(monitorIndex) && monitorIndex >= 0 && monitorIndex < n)
        return monitorIndex;
    const current = display.get_current_monitor();
    if (Number.isInteger(current) && current >= 0 && current < n)
        return current;
    return 0;
}

export function isValidRect(rect: Rect): boolean {
    return (
        Number.isFinite(rect.x) &&
        Number.isFinite(rect.y) &&
        Number.isFinite(rect.width) &&
        Number.isFinite(rect.height) &&
        rect.width > 0 &&
        rect.height > 0
    );
}

export function getPointerMonitorIndex(): number {
    // Mutter already tracks the monitor containing the pointer. Prefer its
    // authoritative index instead of re-deriving it from pointer coordinates
    // and monitor geometry, which can disagree in mixed-scale layouts.
    return sanitizeMonitorIndex(global.display.get_current_monitor());
}

export function getWorkAreaForMonitor(monitorIndex: number): Rect {
    const index = sanitizeMonitorIndex(monitorIndex);
    const workspace = global.workspace_manager.get_active_workspace();
    const area = workspace.get_work_area_for_monitor(index);
    return {
        x: area.x,
        y: area.y,
        width: area.width,
        height: area.height,
    };
}

export function computeQuakeRect(
    side: QuakeSide,
    percent: number,
    monitorIndex: number,
): Rect {
    const work = getWorkAreaForMonitor(monitorIndex);
    const p = Math.min(90, Math.max(10, percent)) / 100;

    switch (side) {
    case 'top':
        return {
            x: work.x,
            y: work.y,
            width: work.width,
            height: Math.round(work.height * p),
        };
    case 'bottom': {
        const height = Math.round(work.height * p);
        return {
            x: work.x,
            y: work.y + work.height - height,
            width: work.width,
            height,
        };
    }
    case 'left':
        return {
            x: work.x,
            y: work.y,
            width: Math.round(work.width * p),
            height: work.height,
        };
    case 'right': {
        const width = Math.round(work.width * p);
        return {
            x: work.x + work.width - width,
            y: work.y,
            width,
            height: work.height,
        };
    }
    }
}

export function percentFromRect(
    side: QuakeSide,
    rect: Rect,
    monitorIndex: number,
): number {
    const work = getWorkAreaForMonitor(monitorIndex);
    let ratio: number;
    if (side === 'top' || side === 'bottom')
        ratio = work.height > 0 ? rect.height / work.height : 0.4;
    else
        ratio = work.width > 0 ? rect.width / work.width : 0.4;

    return Math.min(90, Math.max(10, Math.round(ratio * 100)));
}

export function slideOffsetForSide(side: QuakeSide, rect: Rect): { x: number; y: number } {
    switch (side) {
    case 'top':
        return { x: 0, y: -rect.height };
    case 'bottom':
        return { x: 0, y: rect.height };
    case 'left':
        return { x: -rect.width, y: 0 };
    case 'right':
        return { x: rect.width, y: 0 };
    }
}
