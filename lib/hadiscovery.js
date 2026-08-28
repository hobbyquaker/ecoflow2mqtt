/**
 * Home Assistant MQTT discovery (device-based, HA >= 2024.4) — the device block for the core's
 * `discovery()` hook. Pure: config in, {device, components} out.
 *
 * 0.1.0 announces the three power sensors of ROADMAP.md §1. `state_class: measurement` makes
 * them usable in HA statistics; the energy dashboard wants a kWh counter, which needs the energy
 * report frames (0.2.0, OQ-E3).
 */

import {entity, discoveryId} from 'mqtt-interfaces-core';
import {ITEMS} from './items.js';
import {modelOf} from './mask.js';

export const ADAPTER = 'ecoflow2mqtt';

/**
 * @param {{name: string, sn?: string, jsonPayloads?: boolean}} options
 * @returns {{id: string, device: object, components: object}}
 */
export function discoveryModel({name, sn, jsonPayloads = true}) {
    const id = discoveryId(ADAPTER, name);
    const model = modelOf(sn);
    const components = {};

    for (const item of ITEMS) {
        components[item.item] = entity({
            id,
            name,
            item: item.item,
            platform: 'sensor',
            label: item.label,
            icon: 'mdi:solar-power-variant',
            jsonPayloads,
            extra: {
                dev_cla: item.deviceClass,
                stat_cla: 'measurement',
                unit_of_meas: item.unit,
                sug_dsp_prc: 1,
            },
        });
    }

    return {
        id,
        device: {mf: 'EcoFlow', ...(model && {mdl: model})},
        components,
    };
}
