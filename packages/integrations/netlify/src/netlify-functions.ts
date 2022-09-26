import { polyfill } from '@astrojs/webapi';
import type { Handler } from '@netlify/functions';
import { SSRManifest } from 'astro';
import { App } from 'astro/app';

polyfill(globalThis, {
	exclude: 'window document',
});

export interface Args {
	binaryMediaTypes?: string[];
}

function parseContentType(header?: string) {
	return header?.split(';')[0] ?? '';
}

const clientAddressSymbol = Symbol.for('astro.clientAddress');

export const createExports = (manifest: SSRManifest, args: Args) => {
	const app = new App(manifest);

	const binaryMediaTypes = args.binaryMediaTypes ?? [];
	const knownBinaryMediaTypes = new Set([
		'audio/3gpp',
		'audio/3gpp2',
		'audio/aac',
		'audio/midi',
		'audio/mpeg',
		'audio/ogg',
		'audio/opus',
		'audio/wav',
		'audio/webm',
		'audio/x-midi',
		'image/avif',
		'image/bmp',
		'image/gif',
		'image/vnd.microsoft.icon',
		'image/heif',
		'image/jpeg',
		'image/png',
		'image/svg+xml',
		'image/tiff',
		'image/webp',
		'video/3gpp',
		'video/3gpp2',
		'video/mp2t',
		'video/mp4',
		'video/mpeg',
		'video/ogg',
		'video/x-msvideo',
		'video/webm',
		...binaryMediaTypes,
	]);

	const handler: Handler = async (event) => {
		const { httpMethod, headers, rawUrl, body: requestBody, isBase64Encoded } = event;
		const init: RequestInit = {
			method: httpMethod,
			headers: new Headers(headers as any),
		};
		// Attach the event body the the request, with proper encoding.
		if (httpMethod !== 'GET' && httpMethod !== 'HEAD') {
			const encoding = isBase64Encoded ? 'base64' : 'utf-8';
			init.body =
				typeof requestBody === 'string' ? Buffer.from(requestBody, encoding) : requestBody;
		}
		const request = new Request(rawUrl, init);

		let routeData = app.match(request, { matchNotFound: true });

		if (!routeData) {
			return {
				statusCode: 404,
				body: 'Not found',
			};
		}

		const ip = headers['x-nf-client-connection-ip'];
		Reflect.set(request, clientAddressSymbol, ip);

		const response: Response = await app.render(request, routeData);
		const responseHeaders = Object.fromEntries(response.headers.entries());

		const responseContentType = parseContentType(responseHeaders['content-type']);
		const responseIsBase64Encoded = knownBinaryMediaTypes.has(responseContentType);

		let responseBody: string;
		if (responseIsBase64Encoded) {
			const ab = await response.arrayBuffer();
			responseBody = Buffer.from(ab).toString('base64');
		} else {
			responseBody = await response.text();
		}

		const fnResponse: any = {
			statusCode: response.status,
			headers: responseHeaders,
			body: responseBody,
			isBase64Encoded: responseIsBase64Encoded,
		};

		// Special-case set-cookie which has to be set an different way :/
		// The fetch API does not have a way to get multiples of a single header, but instead concatenates
		// them. There are non-standard ways to do it, and node-fetch gives us headers.raw()
		// See https://github.com/whatwg/fetch/issues/973 for discussion
		if (response.headers.has('set-cookie') && 'raw' in response.headers) {
			// Node fetch allows you to get the raw headers, which includes multiples of the same type.
			// This is needed because Set-Cookie *must* be called for each cookie, and can't be
			// concatenated together.
			type HeadersWithRaw = Headers & {
				raw: () => Record<string, string[]>;
			};

			const rawPacked = (response.headers as HeadersWithRaw).raw();
			if ('set-cookie' in rawPacked) {
				fnResponse.multiValueHeaders = {
					'set-cookie': rawPacked['set-cookie'],
				};
			}
		}

		// Apply cookies set via Astro.cookies.set/delete
		if(app.setCookieHeaders) {
			const setCookieHeaders = Array.from(app.setCookieHeaders(response));
			fnResponse.multiValueHeaders = fnResponse.multiValueHeaders || {};
			if(!fnResponse.multiValueHeaders['set-cookie']) {
				fnResponse.multiValueHeaders['set-cookie'] = [];
			}
			fnResponse.multiValueHeaders['set-cookie'].push(...setCookieHeaders);
		}

		return fnResponse;
	};

	return { handler };
};
