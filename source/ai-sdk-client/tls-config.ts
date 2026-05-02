import {readFileSync} from 'node:fs';
import type {ConnectionOptions} from 'node:tls';
import type {AIProviderConfig} from '@/types/index';

export function getTlsConnectOptions(
	providerConfig: AIProviderConfig,
): Partial<ConnectionOptions> {
	const caCertPath = providerConfig.config.caCertPath?.trim();
	if (!caCertPath) {
		return {};
	}

	return {
		ca: readFileSync(caCertPath, 'utf8'),
	};
}
