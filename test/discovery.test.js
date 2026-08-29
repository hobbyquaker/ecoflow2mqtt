/**
 * Discovery (core B-2) against a mocked fetch. There is no network scan to test here — the
 * inverter is only reachable through EcoFlow — so what matters is the account listing, the two
 * response shapes the notes disagree about, and that a failed login stays a failure.
 *
 * Every serial in this file is the placeholder `BK01ZXXXXXXXXXXX` (E-2): no real device or
 * account identifier enters the repository.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {deviceList} from '../lib/app/login.js';
import {listAccountDevices, discoveryHint, DISCOVERY_SHAPE, NEEDS} from '../lib/discovery.js';

function mockFetch(responses) {
    const calls = [];
    const queue = [...responses];
    return {
        calls,
        fetchImpl: async (url, options = {}) => {
            calls.push({url, options});
            const next = queue.shift();
            if (next instanceof Error) {
                throw next;
            }
            return {
                status: next.status ?? 200,
                json: async () => {
                    if (next.body === undefined) {
                        throw new Error('not json');
                    }
                    return next.body;
                },
            };
        },
    };
}

const USER_ID = '1000000000000000001';
const SN = 'BK01ZXXXXXXXXXXX';
const SN2 = 'BK01ZYYYYYYYYYYY';
const OK_LOGIN = {body: {code: '0', data: {token: 'jwt-token', user: {userId: USER_ID}}}};

/** The shape verified on the real account (ROADMAP §6.1): an object keyed by SN. */
const BOUND_OBJECT = {
    body: {
        code: '0',
        data: {
            bound: {
                [SN]: {deviceName: 'Balcony', productType: 55, online: 1, productSkuId: 1},
            },
        },
    },
};

describe('deviceList', () => {
    test('data.bound keyed by serial — the shape the real account returns', async () => {
        const {fetchImpl, calls} = mockFetch([BOUND_OBJECT]);
        const devices = await deviceList({host: 'api-e.ecoflow.com', token: 'jwt-token', userId: USER_ID, fetchImpl});
        assert.deepEqual(devices, [{sn: SN, name: 'Balcony', model: undefined, productType: 55, online: true}]);
        assert.match(calls[0].url, /^https:\/\/api-e\.ecoflow\.com\/iot-service\/user\/device\?userId=/);
        assert.equal(calls[0].options.headers.authorization, 'Bearer jwt-token');
    });

    test('a plain list is accepted too — the notes disagree and the endpoint is unofficial', async () => {
        const {fetchImpl} = mockFetch([{body: {code: '0', data: [{sn: SN, deviceName: 'Balcony', online: 1}]}}]);
        const devices = await deviceList({host: 'h', token: 't', userId: USER_ID, fetchImpl});
        assert.equal(devices.length, 1);
        assert.equal(devices[0].sn, SN);
        assert.equal(devices[0].online, true);
    });

    test('online is normalised, and a device that is off is still listed', async () => {
        const {fetchImpl} = mockFetch([{body: {code: '0', data: {bound: {[SN]: {online: 0}, [SN2]: {online: true}}}}}]);
        const devices = await deviceList({host: 'h', token: 't', userId: USER_ID, fetchImpl});
        assert.deepEqual(
            devices.map((d) => [d.sn, d.online]),
            [
                [SN, false],
                [SN2, true],
            ],
            'an inverter dark at night is still the one to configure',
        );
    });

    test('an account with no devices is an empty list, not an error', async () => {
        const {fetchImpl} = mockFetch([{body: {code: '0', data: {bound: {}}}}]);
        assert.deepEqual(await deviceList({host: 'h', token: 't', userId: USER_ID, fetchImpl}), []);
    });

    test('entries without a serial are dropped', async () => {
        const {fetchImpl} = mockFetch([{body: {code: '0', data: [{deviceName: 'nameless'}, {sn: SN}]}}]);
        const devices = await deviceList({host: 'h', token: 't', userId: USER_ID, fetchImpl});
        assert.deepEqual(
            devices.map((d) => d.sn),
            [SN],
        );
    });
});

describe('listAccountDevices', () => {
    test('logs in, then lists — id is the serial the core keys candidates by', async () => {
        const {fetchImpl, calls} = mockFetch([OK_LOGIN, BOUND_OBJECT]);
        const found = await listAccountDevices(
            {email: 'me@example.com', password: 'secret', region: 'eu'},
            {fetchImpl},
        );
        assert.deepEqual(found, [
            {id: SN, name: 'Balcony', model: 'STREAM Microinverter', productType: 55, online: true},
        ]);
        assert.match(calls[0].url, /\/auth\/login$/);
        assert.match(calls[1].url, /\/iot-service\/user\/device/);
    });

    test('a wrong password propagates — the core turns it into a message, not "nothing found"', async () => {
        const {fetchImpl} = mockFetch([{body: {code: '7', message: "Account doesn't exist or incorrect password"}}]);
        await assert.rejects(
            listAccountDevices({email: 'me@example.com', password: 'wrong', region: 'eu'}, {fetchImpl}),
            /incorrect password/,
        );
    });

    test('the model comes from the serial prefix, not EcoFlow’s numeric `model` field', async () => {
        // the api sends `model: 1`, which names nothing we can interpret (ROADMAP §6.1)
        const {fetchImpl} = mockFetch([
            OK_LOGIN,
            {body: {code: '0', data: {bound: {[SN]: {deviceName: 'Balcony', model: 1, online: 1}}}}},
        ]);
        const [device] = await listAccountDevices({email: 'a', password: 'b', region: 'eu'}, {fetchImpl});
        assert.equal(device.model, 'STREAM Microinverter');
    });

    test('an unknown serial prefix simply has no model', async () => {
        const {fetchImpl} = mockFetch([
            OK_LOGIN,
            {body: {code: '0', data: {bound: {ZZ99UNKNOWNSERIAL: {deviceName: 'Mystery', online: 1}}}}},
        ]);
        const [device] = await listAccountDevices({email: 'a', password: 'b', region: 'eu'}, {fetchImpl});
        assert.equal(Object.hasOwn(device, 'model'), false);
        assert.equal(device.id, 'ZZ99UNKNOWNSERIAL');
    });

    test('an unknown region fails before any request is made', async () => {
        const {fetchImpl, calls} = mockFetch([]);
        await assert.rejects(
            listAccountDevices({email: 'me@example.com', password: 'x', region: 'mars'}, {fetchImpl}),
            /unknown region 'mars'/,
        );
        assert.equal(calls.length, 0);
    });
});

describe('the hint', () => {
    test('the shape config.js passes declares the kind without a callable', () => {
        // the credentials it would run on are the very thing being parsed
        assert.equal(DISCOVERY_SHAPE.cloud, true);
        assert.deepEqual(DISCOVERY_SHAPE.needs, ['email', 'password']);
        assert.equal(typeof DISCOVERY_SHAPE.cloud, 'boolean', 'nothing for the core to call');
    });

    test('the real hint carries a list() and the same needs', async () => {
        const {fetchImpl} = mockFetch([OK_LOGIN, BOUND_OBJECT]);
        const hint = discoveryHint({email: 'me@example.com', password: 'secret', region: 'eu'}, {fetchImpl});
        assert.deepEqual(hint.needs, NEEDS);
        assert.equal(typeof hint.cloud.list, 'function');
        assert.deepEqual(
            (await hint.cloud.list()).map((d) => d.id),
            [SN],
        );
    });

    test('needs names the credentials, never the option the scan fills', () => {
        assert.deepEqual(NEEDS, ['email', 'password']);
        assert.equal(NEEDS.includes('sn'), false);
    });

    test('no network method is declared — there is nothing on the LAN to scan', () => {
        const hint = discoveryHint({email: 'a', password: 'b'});
        for (const key of ['ssdp', 'mdns', 'udp', 'ports', 'oui', 'serial']) {
            assert.equal(hint[key], undefined, `${key} must not be declared`);
        }
    });
});
