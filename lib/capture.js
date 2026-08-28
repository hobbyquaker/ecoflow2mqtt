/**
 * `--capture <dir>`: append every frame the cloud sends as one base64 line, so new fields and new
 * firmware can be turned into test fixtures without a device.
 *
 * Everything that identifies the device or the account is removed **here**, not later by hand
 * (ROADMAP.md E-2): the header fields `device_sn` / `module_sn` are replaced before re-encoding,
 * and the serial number and the account's user id are replaced in the topic and in any remaining
 * literal occurrence in the payload. A capture file is therefore safe to attach to an issue.
 *
 * Line format (test/fixtures/README.md): `<epoch ms> <topic> <base64 HeaderMessage>`.
 */

import fs from 'node:fs';
import path from 'node:path';
import {HeaderMessage} from './proto/decode.js';
import {placeholderSn} from './mask.js';

/**
 * @param {{dir: string, sn: string, userId?: string|(() => string), log: object,
 *   now?: () => number}} options `userId` may be a getter: it is only known after login.
 * @returns {{write: (topic: string, payload: Buffer) => void, close: () => Promise<void>, file: string}}
 */
export function createCapture({dir, sn, userId, log, now = () => Date.now()}) {
    const placeholder = placeholderSn(sn);
    const stamp = new Date(now()).toISOString().slice(0, 19).replaceAll(':', '-');
    const file = path.join(dir, `frames-${stamp}.b64`);

    fs.mkdirSync(dir, {recursive: true});
    const stream = fs.createWriteStream(file, {flags: 'a'});
    log.info(`capturing frames to ${file} (serial replaced by ${placeholder})`);

    /** Same-length replacement for the SN, so buffers stay valid wherever it is embedded; the
     * account id only ever appears in topics, where length does not matter. */
    function scrubText(text) {
        let out = String(text);
        if (sn) {
            out = out.replaceAll(sn, placeholder);
        }
        const id = typeof userId === 'function' ? userId() : userId;
        if (id) {
            out = out.replaceAll(String(id), 'USERID');
        }
        return out;
    }

    function scrubPayload(payload) {
        try {
            const message = HeaderMessage.decode(payload);
            let touched = false;
            for (const header of message.header ?? []) {
                if (header.deviceSn) {
                    header.deviceSn = placeholder;
                    touched = true;
                }
                if (header.moduleSn) {
                    header.moduleSn = placeholder;
                    touched = true;
                }
            }
            if (touched) {
                return Buffer.from(HeaderMessage.encode(message).finish());
            }
        } catch {
            // not a HeaderMessage (a JSON ping, a truncated frame): fall through to the text pass
        }
        const text = payload.toString('binary');
        const scrubbed = scrubText(text);
        return scrubbed === text ? payload : Buffer.from(scrubbed, 'binary');
    }

    return {
        file,
        write(topic, payload) {
            try {
                stream.write(`${now()} ${scrubText(topic)} ${scrubPayload(payload).toString('base64')}\n`);
            } catch (error) {
                log.warn(`capture write failed: ${error.message}`);
            }
        },
        /** Resolves once everything written is on disk (shutdown waits for it). */
        close() {
            return new Promise((resolve) => stream.end(resolve));
        },
    };
}
