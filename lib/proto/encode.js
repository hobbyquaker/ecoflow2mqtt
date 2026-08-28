/**
 * The two frames ecoflow2mqtt sends. Both are what the EcoFlow app sends, replayed byte for byte
 * (R §4.4, §4.5) — 0.1.0 has no `set` items, so nothing here changes the device's configuration.
 */

import {HeaderMessage, EnergyStreamSwitch} from './decode.js';

/** protobuf seq is a uint32; the app uses a millisecond timestamp. */
function nextSeq(now = Date.now()) {
    return now % 0xffffffff;
}

/**
 * "Give me everything": an empty header `src 32 -> dest 32`. The device answers with a full
 * DisplayPropertyUpload on `.../thing/property/get_reply`. Not a keep-alive (ROADMAP.md E-9), a
 * full-frame refresh.
 *
 * @returns {Buffer}
 */
export function encodeGet({seq = nextSeq()} = {}) {
    return Buffer.from(HeaderMessage.encode({header: [{src: 32, dest: 32, seq, from: 'ios'}]}).finish());
}

/**
 * `EnergyStreamSwitch {1: 1}` (cmd_func 96 / cmd_id 97) — the app's "activate stream" frame for
 * the STREAM family. Off by default (`--stream-interval 0`); kept for the case that the cloud
 * starts throttling a passive subscriber (OQ-E1).
 *
 * @param {{sn: string, seq?: number}} options
 * @returns {Buffer}
 */
export function encodeEnergyStreamSwitch({sn, seq = nextSeq()}) {
    const pdata = EnergyStreamSwitch.encode({sw: 1}).finish();
    return Buffer.from(
        HeaderMessage.encode({
            header: [
                {
                    pdata,
                    src: 32,
                    dest: 53,
                    dSrc: 1,
                    dDest: 1,
                    checkType: 3,
                    cmdFunc: 96,
                    cmdId: 97,
                    dataLen: pdata.length,
                    needAck: 1,
                    seq,
                    version: 19,
                    payloadVer: 1,
                    from: 'ios',
                    deviceSn: sn,
                },
            ],
        }).finish(),
    );
}
