#!/usr/bin/env node

/**
 * ecoflow2mqtt — EcoFlow micro-inverter to MQTT.
 *
 * Wiring only: the cloud client (lib/app/) emits decoded frames, the item table (lib/items.js)
 * turns them into values, the core publishes them. 0.1.0 publishes PV power and nothing else
 * (ROADMAP.md §1); there are no settable items yet.
 */

import {createAdapter} from 'mqtt-interfaces-core';
import config, {stateDirOf} from './config.js';
import pkg from './package.json' with {type: 'json'};
import {handle as handleInstall} from './lib/install.js';
import {EcoflowClient} from './lib/app/mqtt.js';
import {loadClientUuid} from './lib/clientid.js';
import {createItems} from './lib/items.js';
import {createCapture} from './lib/capture.js';
import {discoveryModel} from './lib/hadiscovery.js';
import {maskSn, modelOf} from './lib/mask.js';
import {apiHostOf} from './lib/app/login.js';

handleInstall(config); // --install / --uninstall never reach the rest

const items = createItems();
/** (cmd_func, cmd_id) pairs already logged, so unknown frames are reported once (E-7) */
const seenFrames = new Set();
let lastFrame = 0;
let lastProductId = null;
let staleTimer = null;
let capture = null;

const adapter = createAdapter({
    pkg,
    config,
    deviceLabel: 'inverter',
    info: () => ({
        sn: maskSn(config.sn),
        model: modelOf(config.sn),
        region: config.region,
        api: apiHostOf(config),
        broker: client?.broker?.host,
        product_id: lastProductId,
        poll: config.poll,
    }),
    discovery: () => discoveryModel({name: config.name, sn: config.sn, jsonPayloads: config.jsonPayloads}),
    onSet: (parts) => {
        throw new Error(`no settable items in ${pkg.version} (read only): set/${parts.join('/')}`);
    },
    onShutdown: async () => {
        clearInterval(staleTimer);
        await capture?.close();
        await client.stop();
    },
});

const {log, pubStatus, setDeviceConnected, publishInfo} = adapter;

const client = new EcoflowClient({
    config,
    log,
    uuid: loadClientUuid({stateDir: stateDirOf(config), name: config.name, log}),
});

if (config.capture) {
    capture = createCapture({dir: config.capture, sn: config.sn, userId: () => client.userId, log});
    client.on('raw', (topic, payload) => capture.write(topic, payload));
}

client.on('frames', (frames) => {
    for (const frame of frames) {
        handleFrame(frame);
    }
});

client.on('close', () => setDeviceConnected(false));

function handleFrame(frame) {
    if (frame.error) {
        log.debug(`inverter < ${frame.name}: undecodable (${frame.error})`);
        return;
    }
    if (!frame.data) {
        // not mapped in this version: log the pair once with its payload so it can be added later
        if (!seenFrames.has(frame.key)) {
            seenFrames.add(frame.key);
            log.debug(
                `inverter < ${frame.name} (${frame.key}), ${frame.pdata.length} bytes: ` +
                    `${frame.pdata.toString('hex')}`,
            );
        }
        return;
    }

    lastFrame = Date.now();
    setDeviceConnected(true);
    if (frame.productId && frame.productId !== lastProductId) {
        // <name>/info is published before the first frame arrives; refresh it once the device is known
        lastProductId = frame.productId;
        publishInfo();
    }

    const updates = items.update(frame.data);
    if (updates.length === 0) {
        return;
    }
    log.debug(`inverter < ${frame.name}: ${updates.map(({item, value}) => `${item}=${value}`).join(' ')}`);
    for (const {item, value} of updates) {
        pubStatus(item, value);
    }
}

/** The device counts as connected while frames keep arriving (E-5) — the cloud's own flag lags. */
function watchStaleness() {
    clearInterval(staleTimer);
    staleTimer = setInterval(() => {
        if (lastFrame === 0 || !client.connected) {
            return;
        }
        const age = (Date.now() - lastFrame) / 1000;
        if (age > config.timeout) {
            log.warn(`no frame from the inverter for ${Math.round(age)} s`);
            setDeviceConnected(false);
        }
    }, 30_000);
    staleTimer.unref?.();
}

log.info(`${pkg.name} ${pkg.version} starting, device ${maskSn(config.sn)} (${modelOf(config.sn) ?? 'unknown model'})`);
adapter.start();
watchStaleness();
client.start();
