/**
 * The item table and the small amount of state behind it.
 *
 * 0.1.0 publishes PV power only (ROADMAP.md §1): `pv1_watts`, `pv2_watts` straight from the
 * device, `pv_watts` as their sum — the STREAM Microinverter firmware never sends
 * `pow_get_pv_sum` (E-4). Later readings are rows in ITEMS, not new code (E-7).
 */

/** One row per published item; `field` is the protobuf field of DisplayPropertyUpload. */
export const ITEMS = [
    {item: 'pv1_watts', field: 'powGetPv', label: 'PV 1', unit: 'W', deviceClass: 'power'},
    {item: 'pv2_watts', field: 'powGetPv2', label: 'PV 2', unit: 'W', deviceClass: 'power'},
    {item: 'pv_watts', field: 'powGetPvSum', label: 'PV total', unit: 'W', deviceClass: 'power', computed: true},
];

/** Watts with one decimal — the device sends float32, the rest is float64 noise. */
export function round(value) {
    return Math.round(value * 10) / 10;
}

/**
 * Turns decoded DisplayPropertyUpload payloads into items to publish.
 *
 * Frames are incremental: a frame carries only what changed, so only the items present in it are
 * returned. `pv_watts` follows whenever an input was in the frame and both inputs are known —
 * or directly, should a future firmware ever send `pow_get_pv_sum`.
 *
 * @returns {{update: (data: object) => Array<{item: string, value: number}>,
 *   get: (item: string) => number|undefined, known: () => object}}
 */
export function createItems() {
    const state = new Map();

    function update(data = {}) {
        const out = [];
        for (const {item, field, computed} of ITEMS) {
            if (computed || !Object.hasOwn(data, field)) {
                continue;
            }
            const value = round(data[field]);
            state.set(item, value);
            out.push({item, value});
        }

        if (Object.hasOwn(data, 'powGetPvSum')) {
            const value = round(data.powGetPvSum);
            state.set('pv_watts', value);
            out.push({item: 'pv_watts', value});
        } else if (out.length > 0 && state.has('pv1_watts') && state.has('pv2_watts')) {
            const value = round(state.get('pv1_watts') + state.get('pv2_watts'));
            state.set('pv_watts', value);
            out.push({item: 'pv_watts', value});
        }

        return out;
    }

    return {
        update,
        get: (item) => state.get(item),
        known: () => Object.fromEntries(state),
    };
}
