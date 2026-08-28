/**
 * Protobuf layer: MQTT payload -> frames.
 *
 * A payload is a `HeaderMessage` with one or more `Header`s; each header carries a `pdata` blob
 * that belongs to the message identified by `(cmd_func, cmd_id)`. STREAM devices obfuscate pdata
 * by XORing every byte with `seq & 0xFF` (`enc_type == 1`, device -> app direction, `src != 32`).
 *
 * The `.proto` files are vendored text and parsed at runtime (ROADMAP.md E-7): a new firmware
 * field is a line in `bk_series.proto`, not a code change. Unknown `(cmd_func, cmd_id)` pairs are
 * returned as frames without `data` so the caller can log them once and carry on.
 */

import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import protobuf from 'protobufjs';

const dir = path.dirname(fileURLToPath(import.meta.url));

const root = new protobuf.Root();
for (const file of ['header.proto', 'bk_series.proto']) {
    protobuf.parse(fs.readFileSync(path.join(dir, file), 'utf8'), root);
}

export const HeaderMessage = root.lookupType('HeaderMessage');
export const DisplayPropertyUpload = root.lookupType('DisplayPropertyUpload');
export const EnergyStreamSwitch = root.lookupType('EnergyStreamSwitch');

/** `${cmd_func}/${cmd_id}` -> message. Everything else is returned undecoded. */
export const MESSAGES = {
    '254/21': {name: 'DisplayPropertyUpload', type: DisplayPropertyUpload},
};

/** Names of the frames we know of but do not decode — for readable debug logs (R §4.5). */
export const FRAME_NAMES = {
    '254/17': 'ConfigWrite',
    '254/18': 'ConfigWriteAck',
    '254/19': 'ConfigRead',
    '254/20': 'ConfigReadAck',
    '254/21': 'DisplayPropertyUpload',
    '254/22': 'RuntimePropertyUpload',
    '254/32': 'BatchEnergyTotalReport',
    '32/2': 'CMSHeartBeatReport',
    '32/50': 'BMSHeartBeatReport',
    '96/97': 'EnergyStreamSwitch',
};

/**
 * Undo the XOR obfuscation. STREAM devices XOR every pdata byte with the low byte of `seq`;
 * frames the app sends (`src == 32`) and replies with `enc_type == 0` are plain.
 *
 * @param {Buffer|Uint8Array} pdata
 * @param {{encType?: number, src?: number, seq?: number}} header
 * @returns {Buffer} a new buffer, never the input
 */
export function deobfuscate(pdata, {encType = 0, src = 0, seq = 0} = {}) {
    const buffer = Buffer.from(pdata ?? []);
    if (encType !== 1 || src === 32) {
        return buffer;
    }
    const key = seq & 0xff;
    for (const [index, byte] of buffer.entries()) {
        buffer[index] = byte ^ key;
    }
    return buffer;
}

/**
 * Decode one MQTT payload.
 *
 * Throws only when the outer envelope is not a `HeaderMessage` (a JSON ping, a truncated frame) —
 * a payload whose inner pdata is garbled yields a frame with `error` set, so one bad message
 * cannot take the stream down.
 *
 * @param {Buffer} payload
 * @returns {Array<{cmdFunc: number, cmdId: number, key: string, name: string, seq: number,
 *   src: number, dest: number, encType: number, productId: number, version: number,
 *   deviceSn: string, moduleSn: string, code: string, pdata: Buffer, data: object|null,
 *   error: string|null}>}
 */
export function decodeFrames(payload) {
    const message = HeaderMessage.decode(payload);
    return (message.header ?? []).map((header) => {
        const cmdFunc = header.cmdFunc ?? 0;
        const cmdId = header.cmdId ?? 0;
        const key = `${cmdFunc}/${cmdId}`;
        const pdata = deobfuscate(header.pdata, header);
        const frame = {
            cmdFunc,
            cmdId,
            key,
            name: FRAME_NAMES[key] ?? `unknown ${key}`,
            seq: header.seq ?? 0,
            src: header.src ?? 0,
            dest: header.dest ?? 0,
            encType: header.encType ?? 0,
            productId: header.productId ?? 0,
            version: header.version ?? 0,
            deviceSn: header.deviceSn ?? '',
            moduleSn: header.moduleSn ?? '',
            code: header.code ?? '',
            pdata,
            data: null,
            error: null,
        };
        const known = MESSAGES[key];
        if (!known || pdata.length === 0) {
            return frame;
        }
        try {
            frame.data = known.type.toObject(known.type.decode(pdata));
        } catch (error) {
            frame.error = error.message;
        }
        return frame;
    });
}
