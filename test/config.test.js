import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {configSchema} from 'mqtt-interfaces-core';
import pkg from '../package.json' with {type: 'json'};

// config.js parses the command line at import time and email/password/sn are mandatory
process.env.ECOFLOW2MQTT_EMAIL = 'me@example.com';
process.env.ECOFLOW2MQTT_PASSWORD = 'secret';
process.env.ECOFLOW2MQTT_SN = 'BK01ZXXXXXXXXXXX';
const {OPTIONS, parse, check, stateDirOf} = await import('../config.js');
delete process.env.ECOFLOW2MQTT_EMAIL;
delete process.env.ECOFLOW2MQTT_PASSWORD;
delete process.env.ECOFLOW2MQTT_SN;

const REQUIRED = ['--email', 'me@example.com', '--password', 'secret', '--sn', 'BK01ZXXXXXXXXXXX'];

/** Parse an explicit argv against an explicit environment (no leakage from the shell). */
function parseWith(argv, env = {}) {
    return parse({argv, env});
}

describe('config', () => {
    test('defaults', () => {
        const config = parseWith(REQUIRED);
        assert.equal(config.email, 'me@example.com');
        assert.equal(config.sn, 'BK01ZXXXXXXXXXXX');
        assert.equal(config.name, 'ecoflow');
        assert.equal(config.region, 'eu');
        assert.equal(config.poll, 60);
        assert.equal(config.streamInterval, 0, 'EnergyStreamSwitch off (E-9)');
        assert.equal(config.timeout, 300);
        assert.equal(config.capture, undefined);
        // shared defaults from the core
        assert.equal(config.mqttUrl, 'mqtt://localhost');
        assert.equal(config.jsonPayloads, true);
        assert.equal(config.haDiscovery, true);
    });

    test('credentials come from the environment', () => {
        const config = parseWith(['--name', 'balcony'], {
            ECOFLOW2MQTT_EMAIL: 'env@example.com',
            ECOFLOW2MQTT_PASSWORD: 'env-secret',
            ECOFLOW2MQTT_SN: 'BK01ZENVENVENVEN',
            ECOFLOW2MQTT_POLL: '30',
        });
        assert.equal(config.email, 'env@example.com');
        assert.equal(config.sn, 'BK01ZENVENVENVEN');
        assert.equal(config.poll, 30);
        assert.equal(config.name, 'balcony');
    });

    test('the command line wins over the environment', () => {
        const config = parseWith([...REQUIRED, '--region', 'us'], {ECOFLOW2MQTT_REGION: 'eu'});
        assert.equal(config.region, 'us');
    });

    test('the region choices are the hosts login.js knows', async () => {
        const {API_HOSTS} = await import('../lib/app/login.js');
        assert.deepEqual(OPTIONS.region.choices, Object.keys(API_HOSTS));
    });

    test('check() rejects values the types cannot express', () => {
        assert.equal(check({poll: 60, streamInterval: 0, timeout: 300}), true);
        assert.equal(check({poll: 0, streamInterval: 20, timeout: 30}), true);
        assert.throws(() => check({poll: -1, streamInterval: 0, timeout: 300}), /--poll/);
        assert.throws(() => check({poll: 2, streamInterval: 0, timeout: 300}), /--poll must be 0 or >= 5/);
        assert.throws(() => check({poll: 60, streamInterval: -5, timeout: 300}), /--stream-interval/);
        assert.throws(() => check({poll: 60, streamInterval: 0, timeout: 5}), /--timeout/);
    });

    test('the state dir falls back to $STATE_DIRECTORY, then the home directory', () => {
        assert.equal(stateDirOf({stateDir: '/data'}), '/data');
        assert.match(stateDirOf({}), /ecoflow2mqtt/);
    });
});

describe('config schema', () => {
    const schema = configSchema({pkg, envPrefix: 'ECOFLOW2MQTT', options: OPTIONS, defaults: {name: 'ecoflow'}});

    test('every credential is marked secret so uis mask it (E-2)', () => {
        for (const option of ['email', 'password', 'sn']) {
            assert.equal(schema.properties[option]['x-secret'], true, option);
        }
        assert.equal(schema.properties.region['x-secret'], undefined);
    });

    test('the required options are the ones without a sensible default', () => {
        for (const option of ['email', 'password', 'sn']) {
            assert.ok(schema.required.includes(option), option);
        }
    });

    test('options carry their environment variable and the region enum', () => {
        assert.equal(schema.properties.sn['x-env'], 'ECOFLOW2MQTT_SN');
        assert.deepEqual(schema.properties.region.enum, ['eu', 'us', 'global', 'americas', 'cn']);
    });
});
