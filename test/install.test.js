import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {SHARED_OPTIONS} from 'mqtt-interfaces-core';

import {unitFile, envFile, envVarName, instanceName, SERVICE, ENV_PREFIX} from '../lib/install.js';

// config.js parses the command line at import time and the credentials are mandatory
process.env.ECOFLOW2MQTT_EMAIL = 'me@example.com';
process.env.ECOFLOW2MQTT_PASSWORD = 'secret';
process.env.ECOFLOW2MQTT_SN = 'BK01ZXXXXXXXXXXX';
const {OPTIONS} = await import('../config.js');
delete process.env.ECOFLOW2MQTT_EMAIL;
delete process.env.ECOFLOW2MQTT_PASSWORD;
delete process.env.ECOFLOW2MQTT_SN;

function argvOf(values) {
    const argv = {...values};
    Object.defineProperty(argv, '$options', {value: {...OPTIONS, ...SHARED_OPTIONS}});
    return argv;
}

describe('install', () => {
    test('the unit is the shared template layout', () => {
        const unit = unitFile('/usr/bin/node /usr/local/lib/node_modules/ecoflow2mqtt/index.js');
        assert.match(unit, /^Description=ecoflow2mqtt %i - EcoFlow micro-inverter to MQTT bridge$/m);
        assert.match(unit, /^Documentation=https:\/\/github\.com\/hobbyquaker\/ecoflow2mqtt$/m);
        assert.match(unit, /^EnvironmentFile=-\/etc\/mqtt-interfaces\/broker\.env$/m);
        assert.match(unit, /^EnvironmentFile=\/etc\/ecoflow2mqtt\/%i\.env$/m);
        assert.match(unit, /^Environment=ECOFLOW2MQTT_NAME=%i$/m);
        assert.match(unit, /^StateDirectory=ecoflow2mqtt\/%i$/m, 'the client id lives there (E-6)');
        assert.match(unit, /^Restart=always$/m);
        assert.match(unit, /^User=ecoflow2mqtt$/m);
    });

    test('the env file carries the credentials as ECOFLOW2MQTT_* variables, never the name', () => {
        const out = envFile(
            argvOf({
                name: 'balcony',
                email: 'me@example.com',
                password: 'secret',
                sn: 'BK01ZXXXXXXXXXXX',
                region: 'eu',
                poll: 60,
                mqttUrl: 'mqtt://broker',
            }),
        );

        assert.match(out, /^ECOFLOW2MQTT_EMAIL=me@example\.com$/m);
        assert.match(out, /^ECOFLOW2MQTT_PASSWORD=secret$/m);
        assert.match(out, /^ECOFLOW2MQTT_SN=BK01ZXXXXXXXXXXX$/m);
        assert.match(out, /^ECOFLOW2MQTT_MQTT_URL=mqtt:\/\/broker$/m);
        assert.equal(/ECOFLOW2MQTT_NAME=/.test(out), false, 'the name comes from the instance');
    });

    test('option names map to environment variables', () => {
        assert.equal(envVarName('sn', ENV_PREFIX), 'ECOFLOW2MQTT_SN');
        assert.equal(envVarName('stream-interval', ENV_PREFIX), 'ECOFLOW2MQTT_STREAM_INTERVAL');
        assert.equal(instanceName('balcony'), 'balcony');
        assert.equal(SERVICE, 'ecoflow2mqtt');
    });
});
