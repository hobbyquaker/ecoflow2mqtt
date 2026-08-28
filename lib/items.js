/**
 * The item table and the small amount of state behind it.
 *
 * One row per published item (ROADMAP.md E-7: a new reading is a row, not code). `field` is the
 * protobuf field of `DisplayPropertyUpload`, `precision` the decimals the device's float32 values
 * are worth, `measurement` whether the value is a reading (Home Assistant `state_class`) rather
 * than a setting, `category` marks the ones Home Assistant should file under diagnostics.
 *
 * `pv_watts` is the only computed item: the STREAM Microinverter firmware never sends
 * `pow_get_pv_sum`, so the adapter adds the inputs up (E-4).
 */

const SOLAR = 'mdi:solar-power-variant';

/** `grid_connection_sta` (R §4.5). */
export const GRID_STATUS = {
    0: 'invalid',
    1: 'grid_in',
    2: 'offline',
    3: 'feed_grid',
};

export const ITEMS = [
    {item: 'pv1_watts', field: 'powGetPv', label: 'PV 1', unit: 'W', deviceClass: 'power', icon: SOLAR},
    {item: 'pv2_watts', field: 'powGetPv2', label: 'PV 2', unit: 'W', deviceClass: 'power', icon: SOLAR},
    {
        item: 'pv_watts',
        field: 'powGetPvSum',
        label: 'PV total',
        unit: 'W',
        deviceClass: 'power',
        icon: SOLAR,
        computed: true,
    },
    {
        item: 'grid_watts',
        field: 'gridConnectionPower',
        label: 'Grid',
        unit: 'W',
        deviceClass: 'power',
        icon: 'mdi:transmission-tower',
    },
    {
        item: 'grid_status',
        field: 'gridConnectionSta',
        label: 'Grid status',
        map: GRID_STATUS,
        icon: 'mdi:transmission-tower-export',
    },
    {
        item: 'pv1_volts',
        field: 'plugInInfoPvVol',
        label: 'PV 1 voltage',
        unit: 'V',
        deviceClass: 'voltage',
        precision: 2,
        category: 'diagnostic',
    },
    {
        item: 'pv1_amps',
        field: 'plugInInfoPvAmp',
        label: 'PV 1 current',
        unit: 'A',
        deviceClass: 'current',
        precision: 2,
        category: 'diagnostic',
    },
    {
        item: 'pv2_volts',
        field: 'plugInInfoPv2Vol',
        label: 'PV 2 voltage',
        unit: 'V',
        deviceClass: 'voltage',
        precision: 2,
        category: 'diagnostic',
    },
    {
        item: 'pv2_amps',
        field: 'plugInInfoPv2Amp',
        label: 'PV 2 current',
        unit: 'A',
        deviceClass: 'current',
        precision: 2,
        category: 'diagnostic',
    },
    {
        item: 'grid_volts',
        field: 'gridConnectionVol',
        label: 'Grid voltage',
        unit: 'V',
        deviceClass: 'voltage',
        precision: 1,
        category: 'diagnostic',
    },
    {
        item: 'grid_amps',
        field: 'gridConnectionAmp',
        label: 'Grid current',
        unit: 'A',
        deviceClass: 'current',
        precision: 2,
        category: 'diagnostic',
    },
    {
        item: 'grid_hz',
        field: 'gridConnectionFreq',
        label: 'Grid frequency',
        unit: 'Hz',
        deviceClass: 'frequency',
        precision: 2,
        category: 'diagnostic',
    },
    {
        item: 'feed_limit_watts',
        field: 'feedGridModePowLimit',
        label: 'Feed-in limit',
        unit: 'W',
        deviceClass: 'power',
        precision: 0,
        measurement: false,
        category: 'diagnostic',
        icon: 'mdi:speedometer-slow',
    },
    {
        item: 'feed_limit_max_watts',
        field: 'feedGridModePowMax',
        label: 'Feed-in limit maximum',
        unit: 'W',
        deviceClass: 'power',
        precision: 0,
        measurement: false,
        category: 'diagnostic',
        icon: 'mdi:speedometer',
    },
    {
        item: 'wifi_rssi',
        field: 'moduleWifiRssi',
        label: 'Wi-Fi signal',
        unit: 'dBm',
        deviceClass: 'signal_strength',
        precision: 0,
        category: 'diagnostic',
        icon: 'mdi:wifi',
    },
];

/** Round to the decimals a row is worth — the device sends float32, the rest is float64 noise. */
export function round(value, precision = 1) {
    const factor = 10 ** precision;
    return Math.round(value * factor) / factor;
}

/**
 * Turns decoded `DisplayPropertyUpload` payloads into items to publish.
 *
 * Frames are incremental: one carries only what changed, so only the items present in it come
 * back. `pv_watts` follows whenever an input was in the frame and both inputs are known — or
 * directly, should a future firmware ever send `pow_get_pv_sum`.
 *
 * @returns {{update: (data: object) => Array<{item: string, value: number|string}>,
 *   get: (item: string) => number|string|undefined, known: () => object}}
 */
export function createItems() {
    const state = new Map();

    function valueOf(row, raw) {
        if (row.map) {
            return row.map[raw] ?? `unknown_${raw}`;
        }
        return round(raw, row.precision ?? 1);
    }

    /** The PV total for this frame, or undefined when there is nothing new to say. */
    function totalFor(data, published) {
        if (Object.hasOwn(data, 'powGetPvSum')) {
            return round(data.powGetPvSum);
        }
        const inputChanged = published.some(({item}) => item === 'pv1_watts' || item === 'pv2_watts');
        if (inputChanged && state.has('pv1_watts') && state.has('pv2_watts')) {
            return round(state.get('pv1_watts') + state.get('pv2_watts'));
        }
        return undefined;
    }

    function update(data = {}) {
        const out = [];

        // ITEMS order is publish order, and the computed total sits right behind its inputs
        for (const row of ITEMS) {
            const value = row.computed ? totalFor(data, out) : undefined;
            if (row.computed) {
                if (value === undefined) {
                    continue;
                }
            } else if (!Object.hasOwn(data, row.field)) {
                continue;
            }
            const published = row.computed ? value : valueOf(row, data[row.field]);
            state.set(row.item, published);
            out.push({item: row.item, value: published});
        }

        return out;
    }

    return {
        update,
        get: (item) => state.get(item),
        known: () => Object.fromEntries(state),
    };
}
