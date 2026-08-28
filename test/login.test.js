/**
 * Login and certification against a mocked fetch: the request the EcoFlow app makes, and the
 * error mapping — an outage must not look like "wrong credentials, give up" (R §4.1).
 */

import {test, describe} from 'node:test';
import assert from 'node:assert/strict';

import {API_HOSTS, apiHostOf, login, certification, authenticate, EcoflowApiError} from '../lib/app/login.js';

/** A fetch that answers with the given bodies and records the calls. */
function mockFetch(responses) {
    const calls = [];
    const queue = [...responses];
    return {
        calls,
        fetchImpl: async (url, options = {}) => {
            calls.push({url, options});
            const next = queue.shift();
            if (next instanceof Error) {
                throw next;
            }
            return {
                status: next.status ?? 200,
                json: async () => {
                    if (next.body === undefined) {
                        throw new Error('not json');
                    }
                    return next.body;
                },
            };
        },
    };
}

// EcoFlow's user ids are 19 digits — they only survive as strings
const USER_ID = '1000000000000000001';
const OK_LOGIN = {body: {code: '0', data: {token: 'jwt-token', user: {userId: USER_ID}}}};
const OK_CERT = {
    body: {
        code: '0',
        data: {
            url: 'mqtt-e.ecoflow.com',
            port: '8883',
            protocol: 'mqtts',
            certificateAccount: 'app-account',
            certificatePassword: 'cert-password',
        },
    },
};

describe('region hosts', () => {
    test('eu is the verified default, --api-host wins', () => {
        assert.equal(API_HOSTS.eu, 'api-e.ecoflow.com');
        assert.equal(apiHostOf({region: 'eu'}), 'api-e.ecoflow.com');
        assert.equal(apiHostOf({region: 'us'}), 'api.ecoflow.com');
        assert.equal(apiHostOf({region: 'eu', apiHost: 'api-x.example.com'}), 'api-x.example.com');
    });

    test('an unknown region is a config error naming the way out', () => {
        assert.throws(() => apiHostOf({region: 'mars'}), /unknown region 'mars' — use --api-host/);
    });
});

describe('login', () => {
    test('sends what the app sends: base64 password, IOT_APP scene', async () => {
        const {fetchImpl, calls} = mockFetch([OK_LOGIN]);
        const result = await login({
            host: 'api-e.ecoflow.com',
            email: 'me@example.com',
            password: 'pässword',
            fetchImpl,
        });

        assert.equal(result.token, 'jwt-token');
        assert.equal(result.userId, USER_ID, '19 digits, exact');
        const [call] = calls;
        assert.equal(call.url, 'https://api-e.ecoflow.com/auth/login');
        assert.equal(call.options.method, 'POST');
        const body = JSON.parse(call.options.body);
        assert.equal(body.email, 'me@example.com');
        assert.equal(Buffer.from(body.password, 'base64').toString(), 'pässword');
        assert.equal(body.scene, 'IOT_APP');
        assert.equal(body.userType, 'ECOFLOW');
        assert.equal(call.options.headers.lang, 'en_US');
    });

    test('an api error carries code and message and never says "wrong password"', async () => {
        const {fetchImpl} = mockFetch([{body: {code: '7', message: "Account doesn't exist or incorrect password"}}]);
        await assert.rejects(
            () => login({host: 'h', email: 'e', password: 'p', fetchImpl}),
            (error) => {
                assert.ok(error instanceof EcoflowApiError);
                assert.equal(error.code, 'E7');
                assert.match(error.message, /Account doesn't exist/);
                return true;
            },
        );
    });

    test('a network failure is retryable, not fatal', async () => {
        const {fetchImpl} = mockFetch([new Error('getaddrinfo ENOTFOUND')]);
        await assert.rejects(() => login({host: 'h', email: 'e', password: 'p', fetchImpl}), /ENETWORK|request failed/);
    });

    test('a 200 without a token is a format error', async () => {
        const {fetchImpl} = mockFetch([{body: {code: '0', data: {}}}]);
        await assert.rejects(() => login({host: 'h', email: 'e', password: 'p', fetchImpl}), /no token/);
    });
});

describe('certification', () => {
    test('returns the broker credentials and passes the bearer token', async () => {
        const {fetchImpl, calls} = mockFetch([OK_CERT]);
        const broker = await certification({host: 'api-e.ecoflow.com', token: 'jwt', userId: '42', fetchImpl});

        assert.deepEqual(broker, {
            host: 'mqtt-e.ecoflow.com',
            port: 8883,
            protocol: 'mqtts',
            username: 'app-account',
            password: 'cert-password',
        });
        assert.equal(calls[0].url, 'https://api-e.ecoflow.com/iot-auth/app/certification?userId=42');
        assert.equal(calls[0].options.headers.authorization, 'Bearer jwt');
    });

    test('missing credentials are a format error', async () => {
        const {fetchImpl} = mockFetch([{body: {code: '0', data: {url: 'mqtt-e.ecoflow.com'}}}]);
        await assert.rejects(() => certification({host: 'h', token: 't', userId: '1', fetchImpl}), /no broker/);
    });
});

describe('authenticate', () => {
    test('login + certification in one step', async () => {
        const {fetchImpl} = mockFetch([OK_LOGIN, OK_CERT]);
        const result = await authenticate({email: 'e', password: 'p', region: 'eu'}, {fetchImpl});
        assert.equal(result.apiHost, 'api-e.ecoflow.com');
        assert.equal(result.broker.host, 'mqtt-e.ecoflow.com');
        assert.ok(result.userId);
    });

    test('--mqtt-host overrides the broker the cloud names (wrong-region bug)', async () => {
        const {fetchImpl} = mockFetch([OK_LOGIN, OK_CERT]);
        const result = await authenticate(
            {email: 'e', password: 'p', region: 'eu', mqttHost: 'mqtt.ecoflow.com'},
            {fetchImpl},
        );
        assert.equal(result.broker.host, 'mqtt.ecoflow.com');
        assert.equal(result.broker.username, 'app-account', 'credentials unchanged');
    });
});
