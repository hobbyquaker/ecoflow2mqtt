/**
 * The persisted UUID of the MQTT client id (ROADMAP E-6): stable across restarts, and a state
 * directory that cannot be written must not stop the adapter.
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {loadClientUuid, clientIdFile, newUuid, defaultStateDir} from '../lib/clientid.js';

function tempDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'ecoflow2mqtt-state-'));
}

const silentLog = {debug() {}, warn() {}};

describe('client id', () => {
    test('the uuid has the shape ecoflow expects (32 hex, upper case)', () => {
        assert.match(newUuid(), /^[0-9A-F]{32}$/);
        assert.notEqual(newUuid(), newUuid());
    });

    test('it is created once and then read back', () => {
        const stateDir = tempDir();
        const first = loadClientUuid({stateDir, name: 'ecoflow', log: silentLog});
        const second = loadClientUuid({stateDir, name: 'ecoflow', log: silentLog});

        assert.equal(first, second, 'stable across restarts');
        assert.equal(fs.readFileSync(clientIdFile({stateDir, name: 'ecoflow'}), 'utf8').trim(), first);
        fs.rmSync(stateDir, {recursive: true, force: true});
    });

    test('instances do not share a client id', () => {
        const stateDir = tempDir();
        assert.notEqual(
            loadClientUuid({stateDir, name: 'balcony', log: silentLog}),
            loadClientUuid({stateDir, name: 'garage', log: silentLog}),
        );
        fs.rmSync(stateDir, {recursive: true, force: true});
    });

    test('a corrupt file is replaced, with a warning', () => {
        const stateDir = tempDir();
        const file = clientIdFile({stateDir, name: 'ecoflow'});
        fs.writeFileSync(file, 'not-a-uuid');
        const warnings = [];
        const uuid = loadClientUuid({stateDir, name: 'ecoflow', log: {...silentLog, warn: (m) => warnings.push(m)}});

        assert.match(uuid, /^[0-9A-F]{32}$/);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0], /malformed/);
        fs.rmSync(stateDir, {recursive: true, force: true});
    });

    test('an unwritable state directory warns but still yields a usable uuid', () => {
        // a file where the directory should be: ENOTDIR for every user, root included, and it
        // fails immediately — a path under /proc makes mkdirSync block forever on Linux
        const dir = tempDir();
        const blocked = path.join(dir, 'not-a-directory');
        fs.writeFileSync(blocked, 'this is a file');

        const warnings = [];
        const uuid = loadClientUuid({
            stateDir: path.join(blocked, 'state'),
            name: 'ecoflow',
            log: {...silentLog, warn: (m) => warnings.push(m)},
        });

        assert.match(uuid, /^[0-9A-F]{32}$/);
        // one warning for the failed read, one for the failed write — both name the path
        assert.match(warnings.at(-1), /temporary/);
        for (const warning of warnings) {
            assert.match(warning, /not-a-directory/);
        }
        fs.rmSync(dir, {recursive: true, force: true});
    });

    test('the default state dir follows systemd, then the home directory', () => {
        const before = process.env.STATE_DIRECTORY;
        process.env.STATE_DIRECTORY = '/var/lib/ecoflow2mqtt/balcony';
        assert.equal(defaultStateDir(), '/var/lib/ecoflow2mqtt/balcony');
        delete process.env.STATE_DIRECTORY;
        assert.equal(defaultStateDir(), path.join(os.homedir(), '.ecoflow2mqtt'));
        if (before !== undefined) {
            process.env.STATE_DIRECTORY = before;
        }
    });
});
