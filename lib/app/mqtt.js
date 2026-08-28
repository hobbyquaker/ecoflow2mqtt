/**
 * Step 3-6 of the app path (ROADMAP.md §2): the client on EcoFlow's own MQTT broker.
 *
 * It authenticates, connects with the client id the broker expects (`ANDROID_<UUID>_<userId>`,
 * the UUID persisted so reconnects do not pile up sessions — E-6), subscribes to the device's
 * property topic and emits decoded frames. A protobuf get every `--poll` seconds pulls a full
 * frame; it is a refresh, not a keep-alive (E-9).
 *
 * An unreachable cloud is normal operation for a daemon: everything retries with backoff, and
 * credentials are never discarded because of an error (R §4.1).
 */

import {EventEmitter} from 'node:events';
import mqtt from 'mqtt';
import {decodeFrames} from '../proto/decode.js';
import {encodeGet, encodeEnergyStreamSwitch} from '../proto/encode.js';
import {authenticate as defaultAuthenticate} from './login.js';
import {maskSn} from '../mask.js';

const MIN_BACKOFF = 10_000;
const MAX_BACKOFF = 300_000;
/** connack return codes that mean "these credentials are not (or no longer) valid" */
const AUTH_ERRORS = new Set([4, 5]);

export class EcoflowClient extends EventEmitter {
    /**
     * @param {object} options
     * @param {object} options.config parsed config (email, password, sn, region, poll, ...)
     * @param {object} options.log core logger
     * @param {string} options.uuid stable UUID for the client id (lib/clientid.js)
     * @param {Function} [options.authenticate] injected for tests
     * @param {Function} [options.connect] injected for tests (mqtt.connect)
     */
    constructor({config, log, uuid, authenticate = defaultAuthenticate, connect = mqtt.connect}) {
        super();
        this.config = config;
        this.log = log;
        this.uuid = uuid;
        this.authenticate = authenticate;
        this.connectImpl = connect;

        this.client = null;
        this.userId = null;
        this.broker = null;
        this.stopped = false;
        this.backoff = MIN_BACKOFF;
        this.timers = [];
        this.retryTimer = null;
        this.lastAuthError = null;
    }

    get connected() {
        return Boolean(this.client?.connected);
    }

    /** Topics of this instance's device; the SN is masked in everything we log. */
    topics() {
        const {sn} = this.config;
        return {
            property: `/app/device/property/${sn}`,
            get: `/app/${this.userId}/${sn}/thing/property/get`,
            getReply: `/app/${this.userId}/${sn}/thing/property/get_reply`,
            set: `/app/${this.userId}/${sn}/thing/property/set`,
            setReply: `/app/${this.userId}/${sn}/thing/property/set_reply`,
        };
    }

    start() {
        this.stopped = false;
        return this.#run();
    }

    async stop() {
        this.stopped = true;
        this.#clearTimers();
        clearTimeout(this.retryTimer);
        const {client} = this;
        this.client = null;
        if (client) {
            await new Promise((resolve) => client.end(false, {}, resolve));
        }
    }

    /** Authenticate, then connect. Any failure schedules a retry — the daemon never gives up. */
    async #run() {
        if (this.stopped) {
            return;
        }
        try {
            const {userId, broker, apiHost} = await this.authenticate(this.config);
            this.userId = userId;
            this.broker = broker;
            this.lastAuthError = null;
            this.log.info(`ecoflow api ${apiHost}: logged in, broker ${broker.host}:${broker.port}`);
            this.#connect();
        } catch (error) {
            this.#authFailed(error);
        }
    }

    /**
     * Log an authentication failure once at error level, repeats at debug — a wrong password and
     * an EcoFlow outage are indistinguishable here (R §4.1), so this never stops the adapter.
     */
    #authFailed(error) {
        const message = `ecoflow login failed: ${error.message} (${error.code ?? 'no code'})`;
        if (this.lastAuthError === message) {
            this.log.debug(message);
        } else {
            this.log.error(`${message} — check --email / --password / --region, or the cloud is down`);
            this.lastAuthError = message;
        }
        this.#retry();
    }

    #retry() {
        if (this.stopped) {
            return;
        }
        const delay = this.backoff;
        this.backoff = Math.min(this.backoff * 2, MAX_BACKOFF);
        this.log.debug(`ecoflow: retrying in ${Math.round(delay / 1000)} s`);
        clearTimeout(this.retryTimer);
        this.retryTimer = setTimeout(() => this.#run(), delay);
        this.retryTimer.unref?.();
    }

    #connect() {
        const {broker, config} = this;
        const url = `${broker.protocol}://${broker.host}:${broker.port}`;
        const clientId = `ANDROID_${this.uuid}_${this.userId}`;
        this.log.debug(`ecoflow > connecting to ${url} as ${clientId}`);

        const client = this.connectImpl(url, {
            clientId,
            username: broker.username,
            password: broker.password,
            protocolVersion: 4,
            clean: true,
            keepalive: 30,
            reconnectPeriod: MIN_BACKOFF,
            connectTimeout: 30_000,
        });
        this.client = client;

        client.on('connect', () => {
            this.backoff = MIN_BACKOFF;
            this.log.info(`ecoflow broker ${broker.host} connected, device ${maskSn(config.sn)}`);
            this.#subscribe();
            this.#startTimers();
            this.emit('connect');
        });

        client.on('message', (topic, payload) => this.#onMessage(topic, payload));

        client.on('error', (error) => {
            const code = error?.code;
            this.log.warn(`ecoflow broker error: ${error.message}`);
            if (AUTH_ERRORS.has(code)) {
                // credentials rejected: certification again, then keep trying
                this.log.warn('ecoflow broker rejected the credentials, re-authenticating');
                this.#restart();
            }
        });

        client.on('close', () => {
            this.#clearTimers();
            this.log.debug('ecoflow broker connection closed');
            this.emit('close');
        });

        client.on('reconnect', () => this.log.debug('ecoflow broker reconnecting'));
    }

    /** Tear the client down and start over at step 1 (login), after a backoff. */
    #restart() {
        const {client} = this;
        this.client = null;
        this.#clearTimers();
        client?.end(true);
        this.#retry();
    }

    #subscribe() {
        const topics = this.topics();
        for (const topic of [topics.property, topics.getReply]) {
            this.client.subscribe(topic, {qos: 1}, (error) => {
                if (error) {
                    this.log.warn(`ecoflow subscribe ${this.#safe(topic)} failed: ${error.message}`);
                } else {
                    this.log.debug(`ecoflow < subscribed ${this.#safe(topic)}`);
                }
            });
        }
    }

    #startTimers() {
        this.#clearTimers();
        const {poll, streamInterval} = this.config;
        if (poll > 0) {
            this.requestFullFrame();
            this.timers.push(setInterval(() => this.requestFullFrame(), poll * 1000));
        }
        if (streamInterval > 0) {
            this.activateStream();
            this.timers.push(setInterval(() => this.activateStream(), streamInterval * 1000));
        }
        for (const timer of this.timers) {
            timer.unref?.();
        }
    }

    #clearTimers() {
        for (const timer of this.timers) {
            clearInterval(timer);
        }
        this.timers = [];
    }

    /** Ask for a full DisplayPropertyUpload (arrives on the get_reply topic). */
    requestFullFrame() {
        if (!this.connected) {
            return;
        }
        const topic = this.topics().get;
        this.log.debug(`ecoflow > get ${this.#safe(topic)}`);
        this.client.publish(topic, encodeGet(), {qos: 1}, (error) => {
            if (error) {
                this.log.warn(`ecoflow get failed: ${error.message}`);
            }
        });
    }

    /** EnergyStreamSwitch — only when `--stream-interval` is set (E-9). */
    activateStream() {
        if (!this.connected) {
            return;
        }
        const topic = this.topics().set;
        this.log.debug(`ecoflow > EnergyStreamSwitch ${this.#safe(topic)}`);
        this.client.publish(topic, encodeEnergyStreamSwitch({sn: this.config.sn}), {qos: 1}, (error) => {
            if (error) {
                this.log.warn(`ecoflow EnergyStreamSwitch failed: ${error.message}`);
            }
        });
    }

    #onMessage(topic, payload) {
        this.emit('raw', topic, payload);
        let frames;
        try {
            frames = decodeFrames(payload);
        } catch (error) {
            this.log.debug(`ecoflow < ${this.#safe(topic)}: not a protobuf frame (${error.message}), ignored`);
            return;
        }
        const mine = frames.filter((frame) => !frame.deviceSn || frame.deviceSn === this.config.sn);
        if (mine.length > 0) {
            this.emit('frames', mine, topic);
        }
    }

    /** A topic with the serial masked — safe for info/warn level. */
    #safe(topic) {
        return this.config.sn ? topic.replaceAll(this.config.sn, maskSn(this.config.sn)) : topic;
    }
}
