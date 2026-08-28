/**
 * Home Assistant MQTT discovery (device-based, HA >= 2024.4) — the device block for the core's
 * `discovery()` hook. Pure: config in, {device, components} out.
 *
 * Every row of the item table becomes a sensor: readings carry `state_class: measurement` so HA
 * keeps statistics for them, settings (the feed-in limits) and the grid status do not. Volts,
 * amps, hertz, the limits and the Wi-Fi signal are marked as diagnostics so the device page keeps
 * the four power values in front.
 *
 * An energy (kWh) sensor for the energy dashboard would need the device's energy counters, which
 * this firmware does not send (ROADMAP.md OQ-E3); a Riemann sum helper on `pv_watts` is the way
 * to get one today.
 */

import {entity, discoveryId} from 'mqtt-interfaces-core';
import {ITEMS, GRID_STATUS} from './items.js';
import {modelOf} from './mask.js';

export const ADAPTER = 'ecoflow2mqtt';

/** The HA attributes a row implies: unit, device class, state class, enum options. */
export function extraFor(row) {
    const extra = {};
    if (row.unit) {
        extra.unit_of_meas = row.unit;
    }
    if (row.deviceClass) {
        extra.dev_cla = row.deviceClass;
    }
    if (row.map) {
        // an enum sensor: HA validates the state against the option list
        extra.dev_cla = 'enum';
        extra.options = Object.values(row.map);
    } else if (row.measurement !== false) {
        extra.stat_cla = 'measurement';
        extra.sug_dsp_prc = row.precision ?? 1;
    }
    return extra;
}

/**
 * @param {{name: string, sn?: string, jsonPayloads?: boolean}} options
 * @returns {{id: string, device: object, components: object}}
 */
export function discoveryModel({name, sn, jsonPayloads = true}) {
    const id = discoveryId(ADAPTER, name);
    const model = modelOf(sn);
    const components = {};

    for (const row of ITEMS) {
        components[row.item] = entity({
            id,
            name,
            item: row.item,
            platform: 'sensor',
            label: row.label,
            icon: row.icon, // no fallback: without one HA picks the icon of the device class
            category: row.category,
            jsonPayloads,
            extra: extraFor(row),
        });
    }

    return {
        id,
        device: {mf: 'EcoFlow', ...(model && {mdl: model})},
        components,
    };
}

export {GRID_STATUS};
