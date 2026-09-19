import type Gio from 'gi://Gio';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension, gettext as _} from 'resource:///org/gnome/shell/extensions/extension.js';

import {KeybindingManager} from './keybindings.js';
import {QuakeManager} from './quake-manager.js';
import {
    formatMessage,
    parseEntries,
    type QuakeEntry,
    type QuakeEntryTuple,
    type QuakeMonitorTuple,
    type QuakeTopCropTuple,
} from './types.js';

export default class QuakeAnythingExtension extends Extension {
    private _settings: Gio.Settings | null = null;
    private _quake: QuakeManager | null = null;
    private _keys: KeybindingManager | null = null;
    private _boundIds = new Set<string>();

    enable() {
        this.initTranslations();

        this._settings = this.getSettings();
        this._quake = new QuakeManager();
        this._keys = new KeybindingManager();

        this._quake.enable();
        this._keys.enable();

        this._reload();
        this._settings.connectObject(
            'changed::entries', () => this._reload(),
            'changed::top-crops', () => this._reload(),
            'changed::monitors', () => this._reload(),
            this,
        );
    }

    disable() {
        this._settings?.disconnectObject(this);

        this._keys?.disable();
        this._keys = null;

        this._quake?.disable();
        this._quake = null;

        this._boundIds.clear();
        this._settings = null;
    }

    private _reload(): void {
        if (!this._settings || !this._quake || !this._keys)
            return;

        const raw = this._settings.get_value('entries').deep_unpack() as QuakeEntryTuple[];
        const topCrops = this._settings.get_value('top-crops')
            .deep_unpack() as QuakeTopCropTuple[];
        const monitors = this._settings.get_value('monitors')
            .deep_unpack() as QuakeMonitorTuple[];
        const entries = parseEntries(raw, topCrops, monitors);
        this._quake.setEntries(entries);
        this._rebindKeys(entries);
    }

    private _rebindKeys(entries: QuakeEntry[]): void {
        if (!this._keys || !this._quake)
            return;

        const nextIds = new Set(entries.map(e => e.id));
        for (const id of this._boundIds) {
            if (!nextIds.has(id))
                this._keys.unbind(id);
        }
        this._boundIds.clear();

        for (const entry of entries) {
            if (!entry.shortcut) {
                this._keys.unbind(entry.id);
                continue;
            }

            const ok = this._keys.bind(entry.id, entry.shortcut, () => {
                this._quake?.toggle(entry.id);
            });

            if (ok) {
                this._boundIds.add(entry.id);
            } else {
                Main.notify(
                    _('Quake Anything'),
                    formatMessage(
                        _('Shortcut "%s" is already in use and could not be bound.'),
                        entry.shortcut,
                    ),
                );
            }
        }
    }
}
