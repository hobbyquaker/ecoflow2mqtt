/**
 * Finding the inverter (core B-2) — by asking EcoFlow, because there is nothing to scan.
 *
 * A STREAM Micro never speaks to anything on the LAN: it opens an outbound TLS connection to
 * EcoFlow's broker and talks only to that (R §4.2). No SSDP, no mDNS, no open port, no MAC of its
 * own on the wire once it is behind the router — every network method the core offers would find
 * exactly nothing. What the user has to configure is the serial number printed in the app, so
 * "discovery" here means listing the devices the account owns, which is the core's `cloud` hint.
 *
 * That inverts the usual rule about mandatory options: `--discover` normally drops them, but this
 * scan *is* an account login, so `needs` keeps `--email` and `--password` demanded. `--sn` is the
 * one it fills and stays exempt.
 *
 * The SN is printed in full by `--discover` on purpose. E-2 masks it in logs, `<name>/info` and
 * captures because those get shared; this output exists so the user can copy it into a config.
 */

import {apiHostOf, login, deviceList} from './app/login.js';
import {modelOf} from './mask.js';

/**
 * Log in and list what the account owns, in the shape the core's `cloud` hint expects: `id` is
 * the identity of a candidate, the rest are fields `describe()` prints.
 *
 * Errors are not caught. The core lets a cloud failure propagate precisely so that a wrong
 * password says so, instead of being reported as an empty network the way a silent ssdp search
 * would be.
 *
 * @param {{email: string, password: string, region?: string, apiHost?: string}} config
 * @returns {Promise<Array<{id: string, name?: string, model?: string, online: boolean}>>}
 */
export async function listAccountDevices(config, {fetchImpl = globalThis.fetch} = {}) {
    const host = apiHostOf(config);
    const {token, userId} = await login({
        host,
        email: config.email,
        password: config.password,
        fetchImpl,
    });
    const devices = await deviceList({host, token, userId, fetchImpl});
    return devices.map(({sn, name, productType, online}) => ({
        id: sn,
        ...(name && {name}),
        // not EcoFlow's `model`, which is a bare number we cannot interpret — the serial prefix
        // is what actually names the hardware (`BK01…` → STREAM Microinverter)
        ...(modelOf(sn) && {model: modelOf(sn)}),
        ...(productType !== undefined && {productType}),
        online,
    }));
}

/** Options the scan itself consumes, so `--discover` keeps demanding them. */
export const NEEDS = ['email', 'password'];

/**
 * What `config.js` hands `parseConfig()`: the *kind* of discovery and what it needs, with no
 * callable — the credentials it would run on are the very thing being parsed. That is enough for
 * `--config-schema` (`x-discover: "cloud"`, which is what she reads) and for the `--discover*`
 * options; the core skips a cloud spec without a `list` rather than calling it.
 */
export const DISCOVERY_SHAPE = {cloud: true, needs: NEEDS};

/**
 * The hint that actually scans, built in `index.js` once the config exists. Unlike the network
 * adapters' hints this one closes over the config: the credentials are what the scan runs on.
 */
export function discoveryHint(config, deps = {}) {
    return {
        cloud: {list: () => listAccountDevices(config, deps)},
        needs: NEEDS,
    };
}
