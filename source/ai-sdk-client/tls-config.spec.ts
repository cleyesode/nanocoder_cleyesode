import test from 'ava';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type {AIProviderConfig} from '@/types/index';
import {getTlsConnectOptions} from './tls-config.js';

test('getTlsConnectOptions returns empty object when caCertPath is not set', t => {
	const config: AIProviderConfig = {
		name: 'TestProvider',
		type: 'openai',
		models: ['test-model'],
		config: {},
	};

	t.deepEqual(getTlsConnectOptions(config), {});
});

test('getTlsConnectOptions loads CA bundle from caCertPath', t => {
	const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nanocoder-ca-test-'));
	const caPath = path.join(tmpDir, 'ca.pem');
	fs.writeFileSync(caPath, 'test-ca-bundle');

	const config: AIProviderConfig = {
		name: 'TestProvider',
		type: 'openai',
		models: ['test-model'],
		config: {
			caCertPath: caPath,
		},
	};

	try {
		t.deepEqual(getTlsConnectOptions(config), {
			ca: 'test-ca-bundle',
		});
	} finally {
		fs.rmSync(tmpDir, {recursive: true, force: true});
	}
});
