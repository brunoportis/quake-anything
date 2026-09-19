export type QuakeSide = 'top' | 'bottom' | 'left' | 'right';

export interface QuakeEntry {
    id: string;
    appId: string;
    side: QuakeSide;
    shortcut: string;
    sizePercent: number;
    topCrop: number;
    monitorIndex: number | null;
}

/** GVariant unpack shape for entries key: a(ssssi) */
export type QuakeEntryTuple = [string, string, string, string, number];
export type QuakeTopCropTuple = [string, number];
export type QuakeMonitorTuple = [string, number];

export function isQuakeSide(value: string): value is QuakeSide {
    return value === 'top' || value === 'bottom' || value === 'left' || value === 'right';
}

export function parseEntries(
    raw: QuakeEntryTuple[],
    topCrops: QuakeTopCropTuple[] = [],
    monitors: QuakeMonitorTuple[] = [],
): QuakeEntry[] {
    const cropById = new Map<string, number>();
    for (const tuple of topCrops) {
        if (!Array.isArray(tuple) || tuple.length < 2)
            continue;
        const [id, rawCrop] = tuple;
        if (!id)
            continue;
        const crop = Math.round(Number(rawCrop));
        cropById.set(
            id,
            Math.min(160, Math.max(0, Number.isFinite(crop) ? crop : 0)),
        );
    }

    const monitorById = new Map<string, number>();
    for (const tuple of monitors) {
        if (!Array.isArray(tuple) || tuple.length < 2)
            continue;
        const [id, rawMonitor] = tuple;
        if (!id)
            continue;
        const monitorIndex = Math.round(Number(rawMonitor));
        if (Number.isFinite(monitorIndex) && monitorIndex >= 0)
            monitorById.set(id, monitorIndex);
    }

    const entries: QuakeEntry[] = [];
    for (const tuple of raw) {
        if (!Array.isArray(tuple) || tuple.length < 5)
            continue;
        const [id, appId, side, shortcut, sizePercent] = tuple;
        if (!id || !appId || !isQuakeSide(side))
            continue;
        const percent = Math.round(Number(sizePercent));
        entries.push({
            id,
            appId,
            side,
            shortcut: shortcut ?? '',
            sizePercent: Math.min(90, Math.max(10, Number.isFinite(percent) ? percent : 40)),
            topCrop: cropById.get(id) ?? 0,
            monitorIndex: monitorById.get(id) ?? null,
        });
    }
    return entries;
}

export function entriesToTuples(entries: QuakeEntry[]): QuakeEntryTuple[] {
    return entries.map(e => [
        e.id,
        e.appId,
        e.side,
        e.shortcut,
        e.sizePercent,
    ]);
}

export function entriesToTopCropTuples(entries: QuakeEntry[]): QuakeTopCropTuple[] {
    return entries
        .filter(e => e.topCrop > 0)
        .map(e => [e.id, e.topCrop]);
}

export function entriesToMonitorTuples(entries: QuakeEntry[]): QuakeMonitorTuple[] {
    return entries
        .filter((e): e is QuakeEntry & {monitorIndex: number} => e.monitorIndex !== null)
        .map(e => [e.id, e.monitorIndex]);
}

export function createEntryId(): string {
    return `entry-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e6).toString(36)}`;
}

/** Replace `%s` placeholders left-to-right (translator-friendly printf-style). */
export function formatMessage(template: string, ...args: string[]): string {
    let i = 0;
    return template.replace(/%s/g, () => args[i++] ?? '');
}
