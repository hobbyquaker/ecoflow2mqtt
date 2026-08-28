import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {discoveryModel, ADAPTER} from '../lib/hadiscovery.js';
import {ITEMS} from '../lib/items.js';

describe('home assistant discovery', () => {
    const model = discoveryModel({name: 'balcony', sn: 'BK01ZXXXXXXXXXXX'});

    test('one sensor per item, nothing else', () => {
        assert.deepEqual(
            Object.keys(model.components),
            ITEMS.map((item) => item.item),
        );
        for (const component of Object.values(model.components)) {
            assert.equal(component.p, 'sensor');
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
