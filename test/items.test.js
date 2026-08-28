/**
 * The item table: which values a frame produces, and how the PV total is built (ROADMAP E-4).
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {createItems, ITEMS, round} from '../lib/items.js';
import {decodeFrames} from '../lib/proto/decode.js';

describe('items', () => {
    test('the table is the three power items of 0.1.0', () => {
        assert.deepEqual(
            ITEMS.map((item) => item.item),
            ['pv1_watts', 'pv2_watts', 'pv_watts'],
        );
        for (const item of ITEMS) {
            assert.equal(item.unit, 'W');
            assert.equal(item.deviceClass, 'power');
        }
    });

    test('watts are rounded to one decimal (float32 noise)', () => {
        assert.equal(round(61.823001861572266), 61.8);
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
        assert.deepEqual(items.update({plugInInfoPvVol: 33.8}), []);
        assert.deepEqual(items.update({}), []);
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
                    assert.equal(typeof value, 'number');
                    assert.ok(Number.isFinite(value), `${item} = ${value}`);
                    assert.ok(value >= 0 && value < 5000, `${item} = ${value} out of range`);
                }
            }
        }

        assert.ok(published > 50, `only ${published} updates in 8 minutes`);
        const total = items.get('pv1_watts') + items.get('pv2_watts');
        assert.equal(items.get('pv_watts'), round(total));
    });
});
