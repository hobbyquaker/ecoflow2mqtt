/**
 * The protobuf layer against the real captures in test/fixtures (STREAM Microinverter,
 * 2026-08-28; format documented in test/fixtures/README.md).
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {decodeFrames, deobfuscate, HeaderMessage, DisplayPropertyUpload} from '../lib/proto/decode.js';
import {encodeGet, encodeEnergyStreamSwitch} from '../lib/proto/encode.js';

const FIXTURES = [
    'stream-micro-run1-app-open.b64',
    'stream-micro-run2-app-closed.b64',
    'stream-micro-run3-passive-8min.b64',
];

/** [{seconds, phase, topic, payload}] of one capture file. */
function readFixture(file) {
    return fs
        .readFileSync(new URL(`./fixtures/${file}`, import.meta.url), 'utf8')
        .trim()
        .split('\n')
        .map((line) => {
            const [seconds, phase, topic, base64] = line.split(' ');
            return {seconds: Number(seconds), phase, topic, payload: Buffer.from(base64, 'base64')};
        });
}

const allFrames = FIXTURES.flatMap((file) =>
    readFixture(file).flatMap((line) => decodeFrames(line.payload).map((frame) => ({...frame, topic: line.topic}))),
);

describe('decode: captured frames', () => {
    test('every captured payload is a HeaderMessage and every frame decodes', () => {
        assert.ok(allFrames.length > 400, `only ${allFrames.length} frames`);
        assert.deepEqual(
            allFrames.filter((frame) => frame.error),
            [],
        );
    });

    test('the command pairs of a STREAM Microinverter', () => {
        const pairs = new Set(allFrames.map((frame) => frame.key));
        // DisplayPropertyUpload, RuntimePropertyUpload and (run 1, app open) ConfigWrite acks
        assert.deepEqual([...pairs].sort(), ['254/18', '254/21', '254/22']);
    });

    test('DisplayPropertyUpload is named, mapped and obfuscated with seq & 0xff', () => {
        const pushed = allFrames.find((frame) => frame.key === '254/21' && frame.encType === 1);
        assert.equal(pushed.name, 'DisplayPropertyUpload');
        assert.equal(pushed.src, 2, 'device -> app');
        assert.equal(pushed.productId, 17409, 'STREAM Microinverter');
        assert.ok(pushed.data, 'decoded');
    });

    test('unmapped pairs come back without data but with their payload', () => {
        const runtime = allFrames.find((frame) => frame.key === '254/22');
        assert.equal(runtime.name, 'RuntimePropertyUpload');
        assert.equal(runtime.data, null);
        assert.ok(runtime.pdata.length > 0);
        assert.equal(runtime.error, null);
    });

    test('the first full frame of run 1 carries both pv inputs', () => {
        const [first] = decodeFrames(readFixture(FIXTURES[0])[0].payload);
        assert.equal(first.key, '254/21');
        assert.equal(Math.round(first.data.powGetPv * 1000) / 1000, 61.823);
        assert.equal(Math.round(first.data.powGetPv2 * 1000) / 1000, 62.576);
        assert.equal(first.data.powGetPvSum, undefined, 'this firmware never sends the sum');
    });

    test('pow_get_pv_sum is absent from every captured frame (ROADMAP E-4)', () => {
        const withSum = allFrames.filter((frame) => frame.data && Object.hasOwn(frame.data, 'powGetPvSum'));
        assert.deepEqual(withSum, []);
    });

    test('incremental frames carry only some fields, full frames all of them', () => {
        const displays = allFrames.filter((frame) => frame.key === '254/21');
        const sizes = displays.map((frame) => Object.keys(frame.data).length);
        assert.ok(Math.min(...sizes) <= 1, 'incrementals may carry nothing we map');
        assert.ok(Math.max(...sizes) >= 6, 'full frames carry both inputs plus volt/amp');
    });

    test('replies on the get_reply topic are not obfuscated', () => {
        const reply = allFrames.find((frame) => frame.topic.includes('get_reply') && frame.key === '254/21');
        assert.equal(reply.encType, 0);
        assert.ok(reply.data.powGetPv > 0);
    });

    test('the serial number is scrubbed in the fixtures (ROADMAP E-2)', () => {
        for (const frame of allFrames) {
            assert.equal(frame.deviceSn, '');
            assert.equal(frame.moduleSn, '');
        }
        for (const file of FIXTURES) {
            for (const line of readFixture(file)) {
                assert.match(line.topic, /BK01ZX{11}|USERID|^\/app\/device\/property\/BK01Z/);
            }
        }
    });
});

describe('decode: mechanics', () => {
    test('deobfuscate is its own inverse and never touches the input', () => {
        const plain = Buffer.from([0, 1, 2, 250, 255]);
        const header = {encType: 1, src: 2, seq: 0x1234};
        const scrambled = deobfuscate(plain, header);
        assert.notDeepEqual([...scrambled], [...plain]);
        assert.deepEqual([...deobfuscate(scrambled, header)], [...plain]);
        assert.deepEqual([...plain], [0, 1, 2, 250, 255], 'input untouched');
    });

    test('frames the app sends (src 32) and enc_type 0 stay plain', () => {
        const plain = Buffer.from([1, 2, 3]);
        assert.deepEqual([...deobfuscate(plain, {encType: 1, src: 32, seq: 9})], [...plain]);
        assert.deepEqual([...deobfuscate(plain, {encType: 0, src: 2, seq: 9})], [...plain]);
    });

    test('several headers in one message are all returned', () => {
        const pdata = DisplayPropertyUpload.encode({powGetPv: 12.5}).finish();
        const payload = HeaderMessage.encode({
            header: [
                {cmdFunc: 254, cmdId: 21, src: 2, encType: 0, pdata},
                {cmdFunc: 254, cmdId: 22, src: 2, encType: 0, pdata: Buffer.from([1])},
            ],
        }).finish();
        const frames = decodeFrames(Buffer.from(payload));
        assert.equal(frames.length, 2);
        assert.equal(frames[0].data.powGetPv, 12.5);
        assert.equal(frames[1].data, null);
    });

    test('a garbled pdata yields an error on that frame, not an exception', () => {
        const payload = HeaderMessage.encode({
            header: [{cmdFunc: 254, cmdId: 21, src: 2, encType: 0, pdata: Buffer.from([0xff, 0xff, 0xff])}],
        }).finish();
        const [frame] = decodeFrames(Buffer.from(payload));
        assert.equal(frame.data, null);
        assert.ok(frame.error);
    });

    test('a payload that is not protobuf throws (the caller ignores it)', () => {
        assert.throws(() => decodeFrames(Buffer.from('{"command":"ping"}')));
    });
});

describe('encode', () => {
    test('the get frame is an empty header src 32 -> dest 32', () => {
        const [frame] = decodeFrames(encodeGet({seq: 4711}));
        assert.equal(frame.src, 32);
        assert.equal(frame.dest, 32);
        assert.equal(frame.seq, 4711);
        assert.equal(frame.pdata.length, 0);
        assert.equal(frame.cmdFunc, 0, 'no command: this is the "give me everything" request');
    });

    test('EnergyStreamSwitch is 96/97 with sw = 1 and carries the serial', () => {
        const [frame] = decodeFrames(encodeEnergyStreamSwitch({sn: 'BK01ZXXXXXXXXXXX', seq: 5}));
        assert.equal(frame.key, '96/97');
        assert.equal(frame.name, 'EnergyStreamSwitch');
        assert.equal(frame.deviceSn, 'BK01ZXXXXXXXXXXX');
        assert.equal(frame.src, 32, 'app -> device, so not obfuscated');
        assert.deepEqual([...frame.pdata], [0x08, 0x01]);
    });
});
