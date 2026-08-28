/**
 * `--capture`: the frames it writes must not identify the device (ROADMAP E-2). This test is the
 * guard against a capture attached to an issue leaking a serial number.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {createCapture} from '../lib/capture.js';
import {decodeFrames, HeaderMessage} from '../lib/proto/decode.js';
import {maskSn, placeholderSn, modelOf} from '../lib/mask.js';

const SN = 'BK01Z11ABCD1234X'; // 16 characters, same shape as a real one
const silentLog = {debug() {}, info() {}, warn() {}, error() {}};

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ecoflow2mqtt-test-'));
}

function frameWithSn(sn) {
    return Buffer.from(
        HeaderMessage.encode({
            header: [{cmdFunc: 254, cmdId: 21, src: 2, encType: 0, seq: 1, deviceSn: sn, moduleSn: sn}],
        }).finish(),
    );
}

describe('mask', () => {
    test('a masked serial keeps the family prefix and two characters', () => {
        assert.equal(maskSn(SN), 'BK01Z…4X');
        assert.equal(maskSn(''), '');
        assert.equal(maskSn('SHORT'), '…');
    });

    test('the capture placeholder keeps the length, so buffers stay valid', () => {
        assert.equal(placeholderSn(SN), 'BK01ZXXXXXXXXXXX');
        assert.equal(placeholderSn(SN).length, SN.length);
    });

    test('the model comes from the prefix', () => {
        assert.equal(modelOf(SN), 'STREAM Microinverter');
        assert.equal(modelOf('N011ZSOMETHING12'), 'STREAM Microinverter');
        assert.equal(modelOf('HW51ZSOMETHING12'), 'PowerStream');
        assert.equal(modelOf('XX99ZSOMETHING12'), undefined);
        assert.equal(modelOf(undefined), undefined);
    });
});

describe('capture', () => {
    test('the serial disappears from topic, headers and file', async () => {
        const dir = tempDir();
        const capture = createCapture({dir, sn: SN, log: silentLog});
        capture.write(`/app/device/property/${SN}`, frameWithSn(SN));
        await capture.close();

        const content = fs.readFileSync(capture.file, 'utf8');
        assert.equal(content.includes(SN), false, 'no serial anywhere in the file');
        assert.match(content, /BK01ZXXXXXXXXXXX/);

        const [, topic, base64] = content.trim().split(' ');
        assert.equal(topic, '/app/device/property/BK01ZXXXXXXXXXXX');
        const [frame] = decodeFrames(Buffer.from(base64, 'base64'));
        assert.equal(frame.deviceSn, 'BK01ZXXXXXXXXXXX');
        assert.equal(frame.moduleSn, 'BK01ZXXXXXXXXXXX');
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('the account id disappears from the topics too (E-2)', async () => {
        const dir = tempDir();
        const userId = '1000000000000000001';
        const capture = createCapture({dir, sn: SN, userId: () => userId, log: silentLog});
        capture.write(`/app/${userId}/${SN}/thing/property/get_reply`, frameWithSn(SN));
        await capture.close();

        const content = fs.readFileSync(capture.file, 'utf8');
        assert.equal(content.includes(userId), false, 'no account id in the file');
        assert.equal(content.split(' ')[1], '/app/USERID/BK01ZXXXXXXXXXXX/thing/property/get_reply');
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('the payload survives the scrubbing', async () => {
        const dir = tempDir();
        const capture = createCapture({dir, sn: SN, log: silentLog});
        const pdata = Buffer.from([1, 2, 3, 4]);
        capture.write(
            'topic',
            Buffer.from(HeaderMessage.encode({header: [{cmdFunc: 254, cmdId: 21, deviceSn: SN, pdata}]}).finish()),
        );
        await capture.close();

        const base64 = fs.readFileSync(capture.file, 'utf8').trim().split(' ')[2];
        const [frame] = decodeFrames(Buffer.from(base64, 'base64'));
        assert.deepEqual([...frame.pdata], [1, 2, 3, 4]);
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('a payload that is not protobuf is still scrubbed', async () => {
        const dir = tempDir();
        const capture = createCapture({dir, sn: SN, log: silentLog});
        capture.write('topic', Buffer.from(JSON.stringify({sn: SN, command: 'ping'})));
        await capture.close();

        const line = fs.readFileSync(capture.file, 'utf8');
        assert.equal(line.includes(SN), false);
        const decoded = Buffer.from(line.trim().split(' ')[2], 'base64').toString();
        assert.equal(JSON.parse(decoded).sn, 'BK01ZXXXXXXXXXXX');
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('the file name carries the start time, appending never overwrites', async () => {
        const dir = tempDir();
        const capture = createCapture({dir, sn: SN, log: silentLog, now: () => Date.UTC(2026, 7, 28, 12, 34, 56)});
        assert.match(path.basename(capture.file), /^frames-2026-08-28T12-34-56\.b64$/);
        await capture.close();
        fs.rmSync(dir, {recursive: true, force: true});
    });
});
