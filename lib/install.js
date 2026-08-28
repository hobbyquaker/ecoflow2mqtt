/**
 * --install / --uninstall: systemd template service ecoflow2mqtt@<name>, one instance per
 * inverter (mqtt-interfaces-core installer): /etc/ecoflow2mqtt/<name>.env (mode 600 — it holds
 * the account credentials and the serial), /var/lib/ecoflow2mqtt/<name>/ for the persisted mqtt
 * client id, system user ecoflow2mqtt, optional shared /etc/mqtt-interfaces/broker.env.
 */

import {createInstaller} from 'mqtt-interfaces-core';

export const SERVICE = 'ecoflow2mqtt';
export const ENV_PREFIX = 'ECOFLOW2MQTT';

const installer = createInstaller({
    service: SERVICE,
    envPrefix: ENV_PREFIX,
    description: `${SERVICE} %i - EcoFlow micro-inverter to MQTT bridge`,
    documentation: 'https://github.com/hobbyquaker/ecoflow2mqtt',
});

export const {unitFile, envFile, installService, uninstallService, handle, CONF_DIR, STATE_DIR} = installer;
export {envVarName, instanceName} from 'mqtt-interfaces-core';
