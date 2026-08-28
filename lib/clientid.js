/**
 * The UUID inside the MQTT client id `ANDROID_<UUID>_<userId>`.
 *
 * EcoFlow's broker filters on that shape (R §4.2) and keeps a session per client id, so the UUID
 * is generated once and then reused for the life of the instance (ROADMAP.md E-6). It lives in
 * the state directory (`$STATE_DIRECTORY` under systemd, `~/.ecoflow2mqtt` otherwise) — it is
 * state, not configuration, and the service user must be able to write it.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

/** Where the client id of an instance is kept when `--state-dir` is not given. */
export function defaultStateDir() {
    return process.env.STATE_DIRECTORY || path.join(os.homedir(), '.ecoflow2mqtt');
}

export function clientIdFile({stateDir, name}) {
    return path.join(stateDir || defaultStateDir(), `${name}.client-id`);
}

/** EcoFlow's client ids use the hex uppercase form without dashes. */
export function newUuid() {
    return crypto.randomUUID().replaceAll('-', '').toUpperCase();
}

/**
 * Read the instance's UUID, creating (and persisting) one on first start. A state directory that
 * cannot be written is a warning, not a failure: the adapter then runs with a fresh UUID per
 * start, which works but leaves stale sessions behind.
 *
 * @returns {string}
 */
export function loadClientUuid({stateDir, name, log = {debug() {}, warn() {}}}) {
    const file = clientIdFile({stateDir, name});
    try {
        const stored = fs.readFileSync(file, 'utf8').trim();
        if (/^[0-9A-F]{32}$/.test(stored)) {
            log.debug(`client id uuid read from ${file}`);
            return stored;
        }
        log.warn(`ignoring malformed client id in ${file}`);
    } catch (error) {
        if (error.code !== 'ENOENT') {
            log.warn(`cannot read ${file}: ${error.message}`);
        }
    }

    const uuid = newUuid();
    try {
        fs.mkdirSync(path.dirname(file), {recursive: true, mode: 0o750});
        fs.writeFileSync(file, `${uuid}\n`, {mode: 0o640});
        log.debug(`client id uuid created in ${file}`);
    } catch (error) {
        log.warn(`cannot persist the client id in ${file}: ${error.message} — using a temporary one`);
    }
    return uuid;
}
