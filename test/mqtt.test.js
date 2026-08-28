/**
 * The cloud client: what it subscribes to, what it publishes, which frames it forwards, and how
 * it behaves when the cloud says no (ROADMAP §2 step 3-8). No network — mqtt.connect and
 * authenticate are injected.
 */

import {test, describe, beforeEach} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';

import {EcoflowClient} from '../lib/app/mqtt.js';
import {decodeFrames, HeaderMessage, DisplayPropertyUpload} from '../lib/proto/decode.js';

const SN = 'BK01ZXXXXXXXXXXX';
const USER_ID = '1000000000000000001';

const silentLog = {debug() {}, info() {}, warn() {}, error() {}};

class FakeClient extends EventEmitter {
    constructor() {
        super();
        this.connected = false;
        this.subscribed = [];
        this.published = [];
        this.ended = false;
    }

    subscribe(topic, options, callback) {
        this.subscribed.push(topic);
        callback?.(null);
    }

    publish(topic, payload, options, callback) {
        this.published.push({topic, payload});
        callback?.(null);
    }

    end(force, options, callback) {
        this.ended = true;
        this.connected = false;
        (typeof options === 'function' ? options : callback)?.();
    }

    /** what mqtt.js does on a successful connack */
    goOnline() {
        this.connected = true;
        this.emit('connect');
    }
}

function makeClient({config = {}, authResult, authError} = {}) {
    const fake = new FakeClient();
    const calls = {authenticate: 0, connect: []};
    const client = new EcoflowClient({
        config: {sn: SN, poll: 60, streamInterval: 0, region: 'eu', ...config},
        log: silentLog,
        uuid: 'DEADBEEF00000000DEADBEEF00000000',
        authenticate: async () => {
            calls.authenticate++;
            if (authError) {
                throw authError;
            }
            return (
                authResult ?? {
                    userId: USER_ID,
                    apiHost: 'api-e.ecoflow.com',
                    broker: {
                        host: 'mqtt-e.ecoflow.com',
                        port: 8883,
                        protocol: 'mqtts',
                        username: 'app-account',
                        password: 'cert-password',
                    },
                }
            );
        },
        connect: (url, options) => {
            calls.connect.push({url, options});
            return fake;
        },
    });
    return {client, fake, calls};
}

/** A DisplayPropertyUpload as the device pushes it (obfuscated, src 2). */
function pushFrame(data, {seq = 0x33, deviceSn = ''} = {}) {
    const plain = Buffer.from(DisplayPropertyUpload.encode(data).finish());
    const pdata = Buffer.from(plain.map((byte) => byte ^ (seq & 0xff)));
    return Buffer.from(
        HeaderMessage.encode({
            header: [{cmdFunc: 254, cmdId: 21, src: 2, dest: 32, encType: 1, seq, pdata, deviceSn}],
        }).finish(),
    );
}

describe('EcoflowClient', () => {
    let started;

    beforeEach(() => {
        started = null;
    });

    test('connects with the client id the broker expects and subscribes to the device topics', async () => {
        const {client, fake, calls} = makeClient();
        await client.start();
        fake.goOnline();

        assert.equal(calls.connect[0].url, 'mqtts://mqtt-e.ecoflow.com:8883');
        assert.equal(calls.connect[0].options.clientId, `ANDROID_DEADBEEF00000000DEADBEEF00000000_${USER_ID}`);
        assert.equal(calls.connect[0].options.username, 'app-account');
        assert.deepEqual(fake.subscribed, [
            `/app/device/property/${SN}`,
            `/app/${USER_ID}/${SN}/thing/property/get_reply`,
        ]);
        await client.stop();
    });

    test('publishes a get on connect and forwards decoded frames', async () => {
        const {client, fake} = makeClient();
        const frames = [];
        client.on('frames', (list) => frames.push(...list));
        await client.start();
        fake.goOnline();

        assert.equal(fake.published.length, 1, 'one full-frame refresh right after connect');
        assert.equal(fake.published[0].topic, `/app/${USER_ID}/${SN}/thing/property/get`);
        const [get] = decodeFrames(fake.published[0].payload);
        assert.equal(get.src, 32);
        assert.equal(get.dest, 32);

        fake.emit('message', `/app/device/property/${SN}`, pushFrame({powGetPv: 12.5, powGetPv2: 7.5}));
        assert.equal(frames.length, 1);
        assert.equal(frames[0].data.powGetPv, 12.5);
        await client.stop();
    });

    test('--poll 0 means passive: no get at all', async () => {
        const {client, fake} = makeClient({config: {poll: 0}});
        await client.start();
        fake.goOnline();
        assert.deepEqual(fake.published, []);
        await client.stop();
    });

    test('--stream-interval sends the EnergyStreamSwitch frame', async () => {
        const {client, fake} = makeClient({config: {poll: 0, streamInterval: 20}});
        await client.start();
        fake.goOnline();

        assert.equal(fake.published.length, 1);
        assert.equal(fake.published[0].topic, `/app/${USER_ID}/${SN}/thing/property/set`);
        const [frame] = decodeFrames(fake.published[0].payload);
        assert.equal(frame.key, '96/97');
        await client.stop();
    });

    test('frames of another device on the same account are dropped', async () => {
        const {client, fake} = makeClient();
        const frames = [];
        client.on('frames', (list) => frames.push(...list));
        await client.start();
        fake.goOnline();

        fake.emit('message', '/app/device/property/other', pushFrame({powGetPv: 1}, {deviceSn: 'BK01ZOTHERDEVICE'}));
        assert.deepEqual(frames, []);

        fake.emit('message', `/app/device/property/${SN}`, pushFrame({powGetPv: 2}, {deviceSn: SN}));
        assert.equal(frames.length, 1);
        await client.stop();
    });

    test('a payload that is not protobuf is ignored, not thrown', async () => {
        const {client, fake} = makeClient();
        const frames = [];
        client.on('frames', (list) => frames.push(...list));
        await client.start();
        fake.goOnline();

        assert.doesNotThrow(() => fake.emit('message', 'x', Buffer.from('{"command":"ping"}')));
        assert.deepEqual(frames, []);
        await client.stop();
    });

    test('the raw event carries every payload for --capture', async () => {
        const {client, fake} = makeClient();
        const raw = [];
        client.on('raw', (topic, payload) => raw.push({topic, payload}));
        await client.start();
        fake.goOnline();

        fake.emit('message', 'some/topic', Buffer.from('not protobuf'));
        assert.equal(raw.length, 1);
        assert.equal(raw[0].topic, 'some/topic');
        await client.stop();
    });

    test('rejected credentials trigger a fresh login, not a crash', async () => {
        const {client, fake, calls} = makeClient();
        await client.start();
        fake.goOnline();
        assert.equal(calls.authenticate, 1);

        const error = new Error('Connection refused: Not authorized');
        error.code = 5;
        fake.emit('error', error);

        assert.ok(fake.ended, 'the rejected client is torn down');
        assert.equal(client.client, null, 'and not used again');
        await client.stop();
    });

    test('a failed login is retried, and start() does not reject', async () => {
        const {client, calls} = makeClient({authError: Object.assign(new Error('down'), {code: 'ENETWORK'})});
        await assert.doesNotReject(() => client.start());
        assert.equal(calls.authenticate, 1);
        assert.equal(client.connected, false);
        await client.stop();
    });

    test('stop() closes the connection and stops the timers', async () => {
        const {client, fake} = makeClient();
        await client.start();
        fake.goOnline();
        await client.stop();

        assert.equal(fake.ended, true);
        assert.equal(client.timers.length, 0);
        assert.equal(started, null);
    });
});
