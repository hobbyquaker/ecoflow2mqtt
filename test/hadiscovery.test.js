import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {discoveryModel, extraFor, ADAPTER} from '../lib/hadiscovery.js';
import {ITEMS} from '../lib/items.js';

describe('home assistant discovery', () => {
    const model = discoveryModel({name: 'balcony', sn: 'BK01ZXXXXXXXXXXX'});

    test('one sensor per item, nothing else (15 in 0.2.0)', () => {
        assert.equal(Object.keys(model.components).length, 15);
        assert.deepEqual(
            Object.keys(model.components),
            ITEMS.map((item) => item.item),
        );
        for (const component of Object.values(model.components)) {
            assert.equal(component.p, 'sensor');
        }
    });

    test('a reading gets a state class, a setting does not', () => {
        assert.equal(model.components.grid_volts.stat_cla, 'measurement');
        assert.equal(model.components.grid_volts.sug_dsp_prc, 1, 'mains voltage: one decimal');
        assert.equal(model.components.pv1_amps.sug_dsp_prc, 2, 'a string current: two');
        assert.equal(model.components.feed_limit_watts.stat_cla, undefined, 'a limit is not a measurement');
        assert.equal(model.components.feed_limit_watts.unit_of_meas, 'W');
    });

    test('the grid status is an enum sensor with its options', () => {
        const status = model.components.grid_status;
        assert.equal(status.dev_cla, 'enum');
        assert.deepEqual(status.options, ['invalid', 'grid_in', 'offline', 'feed_grid']);
        assert.equal(status.unit_of_meas, undefined);
        assert.equal(status.stat_cla, undefined);
    });

    test('volts, amps, hertz, limits and signal are diagnostics; the power values are not', () => {
        const primary = Object.entries(model.components)
            .filter(([, component]) => !component.ent_cat)
            .map(([item]) => item);
        assert.deepEqual(primary, ['pv1_watts', 'pv2_watts', 'pv_watts', 'grid_watts', 'grid_status']);
        for (const item of ['pv1_volts', 'grid_amps', 'grid_hz', 'feed_limit_max_watts', 'wifi_rssi']) {
            assert.equal(model.components[item].ent_cat, 'diagnostic', item);
        }
    });

    test('device classes come from the item table', () => {
        assert.equal(model.components.grid_volts.dev_cla, 'voltage');
        assert.equal(model.components.grid_amps.dev_cla, 'current');
        assert.equal(model.components.grid_hz.dev_cla, 'frequency');
        assert.equal(model.components.wifi_rssi.dev_cla, 'signal_strength');
        // no icon override where the device class already implies one
        assert.equal(model.components.grid_volts.ic, undefined);
        assert.equal(model.components.pv_watts.ic, 'mdi:solar-power-variant');
    });

    test('extraFor is pure and covers every row', () => {
        for (const row of ITEMS) {
            const extra = extraFor(row);
            assert.equal(extra.unit_of_meas, row.unit);
            assert.ok(extra.dev_cla, `${row.item} has a device class`);
        }
    });

    test('the sensors are power measurements in watt', () => {
        const pv = model.components.pv_watts;
        assert.equal(pv.dev_cla, 'power');
        assert.equal(pv.stat_cla, 'measurement');
        assert.equal(pv.unit_of_meas, 'W');
        assert.equal(pv.stat_t, 'balcony/status/pv_watts');
        assert.equal(pv.val_tpl, '{{ value_json.val }}');
        assert.equal(pv.cmd_t, undefined, 'read only in 0.1.0');
        assert.equal(pv.uniq_id, `${ADAPTER}_balcony_pv_watts`);
    });

    test('plain payloads drop the value template', () => {
        const plain = discoveryModel({name: 'balcony', jsonPayloads: false});
        assert.equal(plain.components.pv_watts.val_tpl, undefined);
    });

    test('the device block names the manufacturer and the model from the serial prefix', () => {
        assert.equal(model.device.mf, 'EcoFlow');
        assert.equal(model.device.mdl, 'STREAM Microinverter');
        assert.equal(model.id, `${ADAPTER}_balcony`);
    });

    test('an unknown serial prefix leaves the model out instead of guessing', () => {
        const unknown = discoveryModel({name: 'x', sn: 'ZZ99ZUNKNOWNDEVI'});
        assert.equal(unknown.device.mdl, undefined);
        assert.equal(unknown.device.mf, 'EcoFlow');
    });

    test('the serial number is not part of the announcement (E-2)', () => {
        const json = JSON.stringify(discoveryModel({name: 'x', sn: 'BK01Z11ABCD1234X'}));
        assert.equal(json.includes('BK01Z11ABCD1234X'), false);
    });
});
