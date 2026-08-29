/**
 * Step 1-2 of the app path (ROADMAP.md §2): log in with the EcoFlow app account and ask for the
 * MQTT credentials the app itself uses. No signature, no OAuth — the password goes base64 encoded
 * (not encrypted) over TLS, exactly like the Android app (R §4.1).
 *
 * Accounts are region bound: an EU account must talk to `api-e.ecoflow.com`, and a wrong region
 * answers "Account doesn't exist or incorrect password" — the same message a real outage returns
 * (tolwi #902). Nothing here ever discards credentials because of an error; the caller retries.
 */

/** Region -> API host. Only `eu` is verified on hardware; `--api-host` overrides any of them. */
export const API_HOSTS = {
    eu: 'api-e.ecoflow.com',
    us: 'api.ecoflow.com',
    global: 'api.ecoflow.com',
    americas: 'api-a.ecoflow.com',
    cn: 'api-cn.ecoflow.com',
};

export const REGIONS = Object.keys(API_HOSTS);

/** Headers the app sends; some EcoFlow endpoints answer differently without them. */
const APP_HEADERS = {
    'content-type': 'application/json',
    lang: 'en_US',
    platform: 'android',
    version: '4.1.2.02',
    'user-agent': 'okhttp/3.14.9',
};

export class EcoflowApiError extends Error {
    constructor(message, {code, status, endpoint} = {}) {
        super(message);
        this.name = 'EcoflowApiError';
        this.code = code;
        this.status = status;
        this.endpoint = endpoint;
    }
}

/** The API host for a config: explicit `--api-host` wins, otherwise the region table. */
export function apiHostOf({apiHost, region} = {}) {
    if (apiHost) {
        return apiHost;
    }
    const host = API_HOSTS[String(region ?? '').toLowerCase()];
    if (!host) {
        throw new EcoflowApiError(`unknown region '${region}' — use --api-host`, {code: 'EREGION'});
    }
    return host;
}

async function postJson({url, body, headers, fetchImpl}) {
    let response;
    try {
        response = await fetchImpl(url, {method: 'POST', headers: {...APP_HEADERS, ...headers}, body});
    } catch (error) {
        throw new EcoflowApiError(`request failed: ${error.message}`, {code: 'ENETWORK', endpoint: url});
    }
    return finish(response, url);
}

async function getJson({url, headers, fetchImpl}) {
    let response;
    try {
        response = await fetchImpl(url, {headers: {...APP_HEADERS, ...headers}});
    } catch (error) {
        throw new EcoflowApiError(`request failed: ${error.message}`, {code: 'ENETWORK', endpoint: url});
    }
    return finish(response, url);
}

async function finish(response, url) {
    let json;
    try {
        json = await response.json();
    } catch {
        throw new EcoflowApiError(`http ${response.status}, no json body`, {
            code: 'EFORMAT',
            status: response.status,
            endpoint: url,
        });
    }
    if (String(json.code) !== '0') {
        throw new EcoflowApiError(json.message || `api error ${json.code}`, {
            code: `E${json.code}`,
            status: response.status,
            endpoint: url,
        });
    }
    return json.data ?? {};
}

/**
 * POST /auth/login — the app account.
 *
 * @returns {Promise<{token: string, userId: string}>}
 */
export async function login({host, email, password, fetchImpl = globalThis.fetch}) {
    const data = await postJson({
        url: `https://${host}/auth/login`,
        fetchImpl,
        body: JSON.stringify({
            email,
            password: Buffer.from(String(password)).toString('base64'),
            scene: 'IOT_APP',
            userType: 'ECOFLOW',
            os: 'android',
            osVersion: '30',
            appVersion: '4.1.2.02',
        }),
    });
    if (!data.token || !data.user?.userId) {
        throw new EcoflowApiError('login succeeded but returned no token', {code: 'EFORMAT'});
    }
    return {token: data.token, userId: String(data.user.userId)};
}

/**
 * GET /iot-auth/app/certification — the broker and the credentials for it.
 *
 * @returns {Promise<{host: string, port: number, protocol: string, username: string, password: string}>}
 */
export async function certification({host, token, userId, fetchImpl = globalThis.fetch}) {
    const data = await getJson({
        url: `https://${host}/iot-auth/app/certification?userId=${encodeURIComponent(userId)}`,
        headers: {authorization: `Bearer ${token}`},
        fetchImpl,
    });
    if (!data.url || !data.certificateAccount || !data.certificatePassword) {
        throw new EcoflowApiError('certification returned no broker credentials', {code: 'EFORMAT'});
    }
    return {
        host: data.url,
        port: Number(data.port) || 8883,
        protocol: data.protocol || 'mqtts',
        username: data.certificateAccount,
        password: data.certificatePassword,
    };
}

/**
 * GET /iot-service/user/device — the devices bound to the account, for `--discover` / `--sn auto`.
 *
 * Verified on the real account (ROADMAP §6.1): `data.bound` is an **object keyed by SN**, not an
 * array, each value `{deviceName, model, productType, online, productSkuId, createTime}`.
 * RESEARCH §4.1 records the shape as a list instead, so both are accepted — the endpoint is
 * unofficial and has changed before, and the cost of tolerating the other shape is four lines.
 *
 * `model` is a number (1 on the STREAM Micro), not a model name, and nothing here knows what it
 * enumerates; it is passed through as EcoFlow sends it. The readable model comes from the serial
 * prefix instead (`modelOf()` in lib/mask.js). `productType` 55 is the STREAM Micro.
 *
 * `online` lags by up to ~15 minutes on EcoFlow's side, so it is reported and never used to drop
 * a device: an inverter that is dark at night is still the one to configure.
 *
 * @returns {Promise<Array<{sn: string, name?: string, model?: string, productType?: number, online: boolean}>>}
 */
export async function deviceList({host, token, userId, fetchImpl = globalThis.fetch}) {
    const data = await getJson({
        url: `https://${host}/iot-service/user/device?userId=${encodeURIComponent(userId)}`,
        headers: {authorization: `Bearer ${token}`},
        fetchImpl,
    });
    const bound = data?.bound ?? data;
    const entries = Array.isArray(bound)
        ? bound.map((entry) => [entry?.sn ?? entry?.deviceSn, entry])
        : Object.entries(bound && typeof bound === 'object' ? bound : {});
    return entries
        .filter(([sn]) => typeof sn === 'string' && sn)
        .map(([sn, entry = {}]) => ({
            sn,
            name: entry.deviceName || undefined,
            model: entry.model || undefined,
            productType: entry.productType,
            online: entry.online === 1 || entry.online === true,
        }));
}

/**
 * Login + certification in one step.
 *
 * @param {{email: string, password: string, region?: string, apiHost?: string, mqttHost?: string}} config
 * @returns {Promise<{userId: string, apiHost: string, broker: object}>}
 */
export async function authenticate(config, {fetchImpl = globalThis.fetch} = {}) {
    const host = apiHostOf(config);
    const {token, userId} = await login({
        host,
        email: config.email,
        password: config.password,
        fetchImpl,
    });
    const broker = await certification({host, token, userId, fetchImpl});
    if (config.mqttHost) {
        broker.host = config.mqttHost; // certification occasionally names the wrong region (R §4.1)
    }
    return {userId, apiHost: host, broker};
}
