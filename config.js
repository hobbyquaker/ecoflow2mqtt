/**
 * Adapter options on top of the core's parseConfig(): the shared MQTT / name / discovery /
 * maintenance options, ECOFLOW2MQTT_* environment variables and --config-schema come from
 * mqtt-interfaces-core; only the EcoFlow specific options are defined here.
 *
 * Credentials and the serial number are marked `secret: true`: they identify the account and the
 * device, and management UIs mask them (ROADMAP.md E-2). Put them in the instance's env file
 * rather than on the command line, where every process list would show them.
 */

import {parseConfig} from 'mqtt-interfaces-core';
import pkg from './package.json' with {type: 'json'};
import {REGIONS} from './lib/app/login.js';
import {defaultStateDir} from './lib/clientid.js';

export const OPTIONS = {
    email: {
        type: 'string',
        describe: 'ecoflow app account the inverter is bound to',
        demandOption: true,
        secret: true,
    },
    password: {
        type: 'string',
        describe: 'password of the ecoflow app account',
        demandOption: true,
        secret: true,
    },
    sn: {
        type: 'string',
        describe: 'serial number of the inverter (as shown in the app)',
        demandOption: true,
        secret: true,
    },
    region: {
        type: 'string',
        describe: 'region the account was created in (accounts are region bound)',
        choices: REGIONS,
        default: 'eu',
    },
    'api-host': {
        type: 'string',
        describe: 'override the api host derived from --region',
    },
    'mqtt-host': {
        type: 'string',
        describe: 'override the ecoflow broker host returned at login',
    },
    poll: {
        type: 'number',
        describe: 'seconds between full-frame refreshes (0 = passive, only what the device pushes)',
        default: 60,
    },
    'stream-interval': {
        type: 'number',
        describe: 'seconds between energy stream activate frames (0 = off; try 20 if the stream stalls)',
        default: 0,
    },
    timeout: {
        type: 'number',
        describe: 'seconds without a frame before the device counts as disconnected',
        default: 300,
    },
    capture: {
        type: 'string',
        describe: 'directory to append raw frames to, serial number removed (development)',
    },
    'state-dir': {
        type: 'string',
        describe: 'directory for the persisted mqtt client id (default: $STATE_DIRECTORY)',
        default: process.env.STATE_DIRECTORY,
    },
};

/** yargs .check(): value ranges the option types cannot express. */
export function check(argv) {
    if (!(argv.poll >= 0)) {
        throw new Error('--poll must be >= 0 seconds');
    }
    if (argv.poll > 0 && argv.poll < 5) {
        throw new Error('--poll must be 0 or >= 5 seconds');
    }
    if (!(argv.streamInterval >= 0)) {
        throw new Error('--stream-interval must be >= 0 seconds');
    }
    if (!(argv.timeout >= 30)) {
        throw new Error('--timeout must be >= 30 seconds');
    }
    return true;
}

/** The state directory actually used (option, $STATE_DIRECTORY, or ~/.ecoflow2mqtt). */
export function stateDirOf(config) {
    return config.stateDir || defaultStateDir();
}

/** Parse the command line + environment; `overrides` (argv, env, exit, print) are for tests. */
export function parse(overrides = {}) {
    return parseConfig({
        pkg,
        defaults: {name: 'ecoflow'},
        options: OPTIONS,
        check,
        examples: [
            ['$0 --email me@example.com --password secret --sn BK01Z... -u mqtt://broker', 'run in the foreground'],
            ['sudo $0 --install -n balcony', 'install as service ecoflow2mqtt@balcony'],
        ],
        // the core's own epilog (environment variables) plus what is specific to this adapter
        epilog:
            'Every option can also be set via environment variable, e.g. ECOFLOW2MQTT_MQTT_URL, ' +
            'ECOFLOW2MQTT_SN. The unprefixed MQTT_URL, MQTT_USERNAME, MQTT_PASSWORD are used as fallback.\n' +
            'Credentials belong in /etc/ecoflow2mqtt/<name>.env (see --install), not on the command line —\n' +
            'a process list is world readable.\n' +
            'ecoflow2mqtt uses the same unofficial cloud api as the ecoflow app; ecoflow may change it.\n' +
            pkg.homepage,
        ...overrides,
    });
}

export default parse();
