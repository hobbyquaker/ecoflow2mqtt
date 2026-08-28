/**
 * The entry point up to (and excluding) the broker/cloud connection: --help, --config-schema and
 * option validation all exit inside config.js. No network is touched.
 */
import {test, describe} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import pkg from '../package.json' with {type: 'json'};

const INDEX = new URL('../index.js', import.meta.url).pathname;

function run(args) {
    // strip every adapter / broker variable of the surrounding shell
    const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => !key.startsWith('ECOFLOW2MQTT_') && !key.startsWith('MQTT_')),
    );
    const result = spawnSync(process.execPath, [INDEX, ...args], {env, encoding: 'utf8', timeout: 20_000});
    return {code: result.status, out: result.stdout, err: result.stderr};
}

describe('cli', () => {
    test('--config-schema prints valid JSON and exits 0', () => {
        const result = run(['--config-schema']);
        assert.equal(result.code, 0, result.err);
        const schema = JSON.parse(result.out);
        assert.equal(schema.title, 'ecoflow2mqtt');
        assert.equal(schema['x-adapter'].version, pkg.version);
        assert.deepEqual(schema.required, ['email', 'password', 'sn']);
        assert.equal(schema.properties.password['x-secret'], true);
        assert.equal(schema.properties.sn['x-secret'], true);
        assert.equal(schema.properties.poll['x-env'], 'ECOFLOW2MQTT_POLL');
    });

    test('--help lists the adapter and the shared options', () => {
        const result = run(['--help']);
        assert.equal(result.code, 0, result.err);
        for (const option of [
            '--email',
            '--password',
            '--sn',
            '--region',
            '--api-host',
            '--mqtt-host',
            '--poll',
            '--stream-interval',
            '--timeout',
            '--capture',
            '--state-dir',
            '--mqtt-url',
            '--json-payloads',
            '--install',
            '--config-schema',
        ]) {
            assert.match(result.out, new RegExp(option.replaceAll('-', '\\-')), option);
        }
        // yargs wraps the epilog at the terminal width, so match without the line breaks
        assert.match(result.out.replaceAll('\n', ''), /ECOFLOW2MQTT_MQTT_URL/);
    });

    test('--version', () => {
        const result = run(['--version']);
        assert.equal(result.code, 0);
        assert.equal(result.out.trim(), pkg.version);
    });

    test('validation failures exit 1 with a reason', () => {
        assert.match(run([]).err, /Missing required argument/);
        assert.equal(run([]).code, 1);

        const required = ['--email', 'e@x.y', '--password', 'p', '--sn', 'BK01ZXXXXXXXXXXX'];
        assert.match(run([...required, '--poll', '2']).err, /poll/);
        assert.match(run([...required, '--timeout', '5']).err, /timeout/);
        assert.match(run([...required, '--region', 'mars']).err, /region/);
        assert.match(run([...required, '--bogus']).err, /Unknown argument/);
    });

    test('the help text warns that this is the unofficial app api', () => {
        assert.match(run(['--help']).out.replaceAll('\n', ''), /unofficial cloud api/i);
    });
});
