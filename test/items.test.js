/**
 * The item table: which values a frame produces, and how the PV total is built (ROADMAP E-4).
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {createItems, ITEMS, GRID_STATUS, round} from '../lib/items.js';
import {decodeFrames} from '../lib/proto/decode.js';

describe('items', () => {
    test('the table: power up front, the rest as diagnostics', () => {
        assert.deepEqual(
            ITEMS.map((item) => item.item),
            [
                'pv1_watts',
                'pv2_watts',
                'pv_watts',
                'grid_watts',
                'grid_status',
                'pv1_volts',
                'pv1_amps',
                'pv2_volts',
                'pv2_amps',
                'grid_volts',
                'grid_amps',
                'grid_hz',
                'feed_limit_watts',
                'feed_limit_max_watts',
                'wifi_rssi',
            ],
        );
        for (const row of ITEMS) {
            assert.ok(row.label, `${row.item} has a label`);
            assert.ok(row.field, `${row.item} has a protobuf field`);
            assert.ok(row.unit || row.map, `${row.item} has a unit or is an enum`);
        }
        // the four power values are the primary entities, everything else is diagnostic
        const primary = ITEMS.filter((row) => !row.category).map((row) => row.item);
        assert.deepEqual(primary, ['pv1_watts', 'pv2_watts', 'pv_watts', 'grid_watts', 'grid_status']);
    });

    test('values are rounded to the decimals the row is worth', () => {
        assert.equal(round(61.823001861572266), 61.8);
        assert.equal(round(1.8869999647140503, 2), 1.89);
        assert.equal(round(-59.4, 0), -59);
        assert.equal(round(0), 0);
        assert.equal(round(-0.04), -0);
    });

    test('a full frame yields both inputs and their sum', () => {
        const items = createItems();
        const out = items.update({powGetPv: 61.823001861572266, powGetPv2: 62.57600021362305});
        assert.deepEqual(out, [
            {item: 'pv1_watts', value: 61.8},
            {item: 'pv2_watts', value: 62.6},
            {item: 'pv_watts', value: 124.4},
        ]);
    });

    test('the whole item set of a full frame, in publish order', () => {
        const items = createItems();
        const out = items.update({
            powGetPv: 48.144,
            powGetPv2: 47.955,
            gridConnectionPower: 96.1,
            gridConnectionSta: 3,
            plugInInfoPvVol: 33.58,
            plugInInfoPvAmp: 1.433,
            plugInInfoPv2Vol: 32.9,
            plugInInfoPv2Amp: 1.457,
            gridConnectionVol: 236.6,
            gridConnectionAmp: 0.4,
            gridConnectionFreq: 50.029998,
            feedGridModePowLimit: 600,
            feedGridModePowMax: 600,
            moduleWifiRssi: -59,
        });

        assert.deepEqual(out, [
            {item: 'pv1_watts', value: 48.1},
            {item: 'pv2_watts', value: 48},
            {item: 'pv_watts', value: 96.1},
            {item: 'grid_watts', value: 96.1},
            {item: 'grid_status', value: 'feed_grid'},
            {item: 'pv1_volts', value: 33.58},
            {item: 'pv1_amps', value: 1.43},
            {item: 'pv2_volts', value: 32.9},
            {item: 'pv2_amps', value: 1.46},
            {item: 'grid_volts', value: 236.6},
            {item: 'grid_amps', value: 0.4},
            {item: 'grid_hz', value: 50.03},
            {item: 'feed_limit_watts', value: 600},
            {item: 'feed_limit_max_watts', value: 600},
            {item: 'wifi_rssi', value: -59},
        ]);
    });

    test('the grid status is a name, an unexpected code stays visible', () => {
        const items = createItems();
        assert.deepEqual(items.update({gridConnectionSta: 0}), [{item: 'grid_status', value: 'invalid'}]);
        assert.deepEqual(items.update({gridConnectionSta: 2}), [{item: 'grid_status', value: 'offline'}]);
        assert.deepEqual(items.update({gridConnectionSta: 9}), [{item: 'grid_status', value: 'unknown_9'}]);
        assert.deepEqual(Object.values(GRID_STATUS), ['invalid', 'grid_in', 'offline', 'feed_grid']);
    });

    test('an incremental frame yields only what it carries, plus the recomputed total', () => {
        const items = createItems();
        items.update({powGetPv: 60, powGetPv2: 40});
        const out = items.update({powGetPv: 50});
        assert.deepEqual(out, [
            {item: 'pv1_watts', value: 50},
            {item: 'pv_watts', value: 90},
        ]);
        assert.equal(items.get('pv2_watts'), 40, 'the other input keeps its value');
    });

    test('a frame with nothing we map yields nothing', () => {
        const items = createItems();
        items.update({powGetPv: 10, powGetPv2: 10});
        assert.deepEqual(items.update({displayPropertyFullUploadPeriod: 120000}), []);
        assert.deepEqual(items.update({}), []);
    });

    test('a frame without a pv input does not re-publish the total', () => {
        const items = createItems();
        items.update({powGetPv: 10, powGetPv2: 10});
        assert.deepEqual(items.update({moduleWifiRssi: -60}), [{item: 'wifi_rssi', value: -60}]);
    });

    test('the total waits until both inputs are known', () => {
        const items = createItems();
        assert.deepEqual(items.update({powGetPv: 30}), [{item: 'pv1_watts', value: 30}]);
        assert.equal(items.get('pv_watts'), undefined);
        assert.deepEqual(items.update({powGetPv2: 20}), [
            {item: 'pv2_watts', value: 20},
            {item: 'pv_watts', value: 50},
        ]);
    });

    test('a device-sent sum wins over the computed one', () => {
        const items = createItems();
        const out = items.update({powGetPv: 30, powGetPv2: 20, powGetPvSum: 49.5});
        assert.deepEqual(out.at(-1), {item: 'pv_watts', value: 49.5});
        assert.equal(out.filter((update) => update.item === 'pv_watts').length, 1, 'published once');
    });

    test('zero is a value, not a missing field (night, one string disconnected)', () => {
        const items = createItems();
        const out = items.update({powGetPv: 0, powGetPv2: 0});
        assert.deepEqual(out, [
            {item: 'pv1_watts', value: 0},
            {item: 'pv2_watts', value: 0},
            {item: 'pv_watts', value: 0},
        ]);
    });

    test('replaying a whole capture keeps the total consistent with the inputs', () => {
        const items = createItems();
        const lines = fs
            .readFileSync(new URL('./fixtures/stream-micro-run3-passive-8min.b64', import.meta.url), 'utf8')
            .trim()
            .split('\n');

        let published = 0;
        for (const line of lines) {
            for (const frame of decodeFrames(Buffer.from(line.split(' ')[3], 'base64'))) {
                if (!frame.data) {
                    continue;
                }
                for (const {item, value} of items.update(frame.data)) {
                    published++;
                    if (item === 'grid_status') {
                        assert.equal(value, 'feed_grid', 'the device was feeding all along');
                        continue;
                    }
                    assert.equal(typeof value, 'number');
                    assert.ok(Number.isFinite(value), `${item} = ${value}`);
                    const min = item === 'wifi_rssi' ? -100 : 0;
                    assert.ok(value >= min && value < 5000, `${item} = ${value} out of range`);
                }
            }
        }

        assert.ok(published > 50, `only ${published} updates in 8 minutes`);
        const total = items.get('pv1_watts') + items.get('pv2_watts');
        assert.equal(items.get('pv_watts'), round(total));
        // every row of the table was seen at least once in eight minutes of real frames
        for (const row of ITEMS) {
            assert.notEqual(items.get(row.item), undefined, `${row.item} never arrived`);
        }
        // the grid takes what the panels make, minus a little conversion loss
        assert.ok(items.get('grid_watts') <= items.get('pv_watts') + 1, 'grid <= pv');
        assert.ok(items.get('grid_volts') > 200 && items.get('grid_volts') < 260, 'european mains');
        assert.ok(items.get('grid_hz') > 49 && items.get('grid_hz') < 51, 'european mains');
    });
});
