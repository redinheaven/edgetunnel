// <!--GAMFC-->version base on commit 841ed4e9ff121dde0ed6a56ae800c2e6c4f66056, time is 2024-04-16 18:02:37 UTC<!--GAMFC-END-->.
// @ts-ignore
import { connect } from 'cloudflare:sockets';

// How to generate your own UUID:
// [Windows] Press "Win + R", input cmd and run:  Powershell -NoExit -Command "[guid]::NewGuid()"
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

let proxyIP = '';

// set env DEBUG=true to enable console.log
let enableLog = false;

if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

let userIDBytes = uuidToBytes(userID);

const textDecoder = new TextDecoder();

// max bytes buffered from websocket before remote socket consume it
const MAX_WS_BUFFERED_BYTES = 16 * 1024 * 1024;

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string, DEBUG: string}} env
	 * @param {import("@cloudflare/workers-types").ExecutionContext} ctx
	 * @returns {Promise<Response>}
	 */
	async fetch(request, env, ctx) {
		try {
			const uuid = env.UUID || userID;
			if (uuid !== userID) {
				userID = uuid;
				userIDBytes = uuidToBytes(userID);
			}
			proxyIP = env.PROXYIP || proxyIP;
			enableLog = env.DEBUG === 'true';
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				const url = new URL(request.url);
				switch (url.pathname) {
					case '/':
						return new Response(JSON.stringify(request.cf), { status: 200 });
					case `/${userID}`: {
						const vlessConfig = getVLESSConfig(userID, request.headers.get('Host'));
						return new Response(`${vlessConfig}`, {
							status: 200,
							headers: {
								"Content-Type": "text/plain;charset=utf-8",
							}
						});
					}
					default:
						return new Response('Not found', { status: 404 });
				}
			} else {
				return await vlessOverWSHandler(request);
			}
		} catch (err) {
			/** @type {Error} */ let e = err;
			return new Response(e.toString());
		}
	},
};




/**
 *
 * @param {import("@cloudflare/workers-types").Request} request
 */
async function vlessOverWSHandler(request) {

	/** @type {import("@cloudflare/workers-types").WebSocket[]} */
	// @ts-ignore
	const webSocketPair = new WebSocketPair();
	const [client, webSocket] = Object.values(webSocketPair);

	webSocket.accept();

	let logPrefix = '';
	const log = (/** @type {string} */ info, /** @type {string | undefined} */ event) => {
		if (!enableLog) {
			return;
		}
		console.log(`[${logPrefix}] ${info}`, event || '');
	};
	const earlyDataHeader = request.headers.get('sec-websocket-protocol') || '';

	const readableWebSocketStream = makeReadableWebSocketStream(webSocket, earlyDataHeader, log);

	/** @type {{ writer: WritableStreamDefaultWriter | null }} */
	const remoteSocketWrapper = {
		writer: null,
	};
	/** @type {((chunk: ArrayBuffer | Uint8Array) => void) | null} */
	let udpStreamWrite = null;

	// ws --> remote
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (udpStreamWrite) {
				return udpStreamWrite(chunk);
			}
			if (remoteSocketWrapper.writer) {
				await remoteSocketWrapper.writer.write(chunk);
				return;
			}

			const {
				hasError,
				message,
				portRemote = 443,
				addressRemote = '',
				rawDataIndex = 0,
				vlessVersion = 0,
				isUDP,
			} = processVlessHeader(chunk, userIDBytes);
			if (enableLog) {
				logPrefix = `${addressRemote}:${portRemote}--${Math.random()} ${isUDP ? 'udp' : 'tcp'}`;
			}
			if (hasError) {
				// controller.error(message);
				throw new Error(message); // cf seems has bug, controller.error will not end stream
			}
			// if UDP but port not DNS port, close it
			if (isUDP && portRemote !== 53) {
				// controller.error('UDP proxy only enable for DNS which is port 53');
				throw new Error('UDP proxy only enable for DNS which is port 53'); // cf seems has bug, controller.error will not end stream
			}
			// ["version", "附加信息长度 N"]
			const vlessResponseHeader = new Uint8Array([vlessVersion, 0]);
			const rawClientData = toUint8Array(chunk).subarray(rawDataIndex);

			// TODO: support udp here when cf runtime has udp support
			if (isUDP) {
				udpStreamWrite = handleUDPOutBound(webSocket, vlessResponseHeader, log);
				udpStreamWrite(rawClientData);
				return;
			}
			// wait first write finish, so next chunk can use remoteSocketWrapper.writer
			await handleTCPOutBound(remoteSocketWrapper, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
		},
		close() {
			log(`readableWebSocketStream is close`);
		},
		abort(reason) {
			log(`readableWebSocketStream is abort`, JSON.stringify(reason));
		},
	})).catch((err) => {
		log('readableWebSocketStream pipeTo error', err);
	});

	return new Response(null, {
		status: 101,
		// @ts-ignore
		webSocket: client,
	});
}

// hosts which direct connect has no incoming data and need connect by proxyIP
const PROXY_HOST_TTL = 10 * 60 * 1000;
const PROXY_HOST_MAX = 1000;
/** @type {Map<string, number>} */
const proxyHostCache = new Map();

/**
 * @param {string} host
 */
function isProxyHost(host) {
	const expireAt = proxyHostCache.get(host);
	if (expireAt === undefined) {
		return false;
	}
	if (expireAt < Date.now()) {
		proxyHostCache.delete(host);
		return false;
	}
	return true;
}

/**
 * @param {string} host
 * @param {boolean} useProxy
 */
function markProxyHost(host, useProxy) {
	proxyHostCache.delete(host);
	if (!useProxy) {
		return;
	}
	if (proxyHostCache.size >= PROXY_HOST_MAX) {
		// Map keep insert order, delete oldest one
		proxyHostCache.delete(proxyHostCache.keys().next().value);
	}
	proxyHostCache.set(host, Date.now() + PROXY_HOST_TTL);
}

/**
 * Handles outbound TCP connections.
 * Resolve after first write finish.
 *
 * @param {{ writer: WritableStreamDefaultWriter | null }} remoteSocket
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>}
 */
async function handleTCPOutBound(remoteSocket, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log,) {
	async function connectAndWrite(address, port) {
		/** @type {import("@cloudflare/workers-types").Socket} */
		const tcpSocket = connect({
			hostname: address,
			port: port,
		});
		// keep writer, no need getWriter for every chunk
		const writer = tcpSocket.writable.getWriter();
		remoteSocket.writer = writer;
		log(`connected to ${address}:${port}`);
		await writer.write(rawClientData); // first write, nomal is tls client hello
		return tcpSocket;
	}

	async function connectByProxyIP() {
		const tcpSocket = await connectAndWrite(proxyIP, portRemote);
		// no matter retry success or not, close websocket
		tcpSocket.closed.catch(error => {
			log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log).then((hasIncomingData) => {
			// fallback also has no data, no need keep it
			if (!hasIncomingData) {
				markProxyHost(addressRemote, false);
			}
		});
	}

	// if the cf connect tcp socket have no incoming data, we retry to redirect ip
	async function retry() {
		if (proxyIP) {
			markProxyHost(addressRemote, true);
			return connectByProxyIP();
		}
		const tcpSocket = await connectAndWrite(addressRemote, portRemote)
		// no matter retry success or not, close websocket
		tcpSocket.closed.catch(error => {
			log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	// direct connect failed recently, skip it
	if (proxyIP && isProxyHost(addressRemote)) {
		log(`use proxyIP for ${addressRemote}`);
		return connectByProxyIP();
	}

	const tcpSocket = await connectAndWrite(addressRemote, portRemote);

	// when remoteSocket is ready, pass to websocket
	// remote--> ws
	remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, retry, log);
}

/**
 *
 * @param {import("@cloudflare/workers-types").WebSocket} webSocketServer
 * @param {string} earlyDataHeader for ws 0rtt
 * @param {(info: string)=> void} log for ws 0rtt
 */
function makeReadableWebSocketStream(webSocketServer, earlyDataHeader, log) {
	let readableStreamCancel = false;
	const stream = new ReadableStream({
		start(controller) {
			webSocketServer.addEventListener('message', (event) => {
				if (readableStreamCancel) {
					return;
				}
				const message = event.data;
				controller.enqueue(message);
				// ws can not stop read, so close it if remote is too slow
				if (controller.desiredSize !== null && controller.desiredSize < -MAX_WS_BUFFERED_BYTES) {
					log('webSocket buffered data too large, close it');
					readableStreamCancel = true;
					controller.error(new Error('webSocket buffered data too large'));
					safeCloseWebSocket(webSocketServer);
				}
			});

			// The event means that the client closed the client -> server stream.
			// However, the server -> client stream is still open until you call close() on the server side.
			// The WebSocket protocol says that a separate close message must be sent in each direction to fully close the socket.
			webSocketServer.addEventListener('close', () => {
				// client send close, need close server
				// if stream is cancel, skip controller.close
				safeCloseWebSocket(webSocketServer);
				if (readableStreamCancel) {
					return;
				}
				controller.close();
			}
			);
			webSocketServer.addEventListener('error', (err) => {
				log('webSocketServer has error');
				controller.error(err);
			}
			);
			// for ws 0rtt
			const { earlyData, error } = base64ToArrayBuffer(earlyDataHeader);
			if (error) {
				controller.error(error);
			} else if (earlyData) {
				controller.enqueue(earlyData);
			}
		},

		pull(controller) {
			// if ws can stop read if stream is full, we can implement backpressure
			// https://streams.spec.whatwg.org/#example-rs-push-backpressure
		},
		cancel(reason) {
			// 1. pipe WritableStream has error, this cancel will called, so ws handle server close into here
			// 2. if readableStream is cancel, all controller.close/enqueue need skip,
			// 3. but from testing controller.error still work even if readableStream is cancel
			if (readableStreamCancel) {
				return;
			}
			log(`ReadableStream was canceled, due to ${reason}`)
			readableStreamCancel = true;
			safeCloseWebSocket(webSocketServer);
		}
	}, {
		highWaterMark: 0,
		size(chunk) {
			return chunk.byteLength || chunk.length || 0;
		},
	});

	return stream;

}

// https://xtls.github.io/development/protocols/vless.html
// https://github.com/zizifn/excalidraw-backup/blob/main/v2ray-protocol.excalidraw

/**
 *
 * @param {ArrayBuffer | Uint8Array} vlessBuffer
 * @param {Uint8Array} userIDBytes
 * @returns
 */
function processVlessHeader(
	vlessBuffer,
	userIDBytes
) {
	if (vlessBuffer.byteLength < 24) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}
	const bytes = toUint8Array(vlessBuffer);
	const dataView = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
	const version = bytes[0];
	let isUDP = false;
	for (let i = 0; i < 16; i++) {
		if (bytes[1 + i] !== userIDBytes[i]) {
			return {
				hasError: true,
				message: 'invalid user',
			};
		}
	}

	const optLength = bytes[17];
	//skip opt for now

	const command = bytes[18 + optLength];

	// 0x01 TCP
	// 0x02 UDP
	// 0x03 MUX
	if (command === 1) {
	} else if (command === 2) {
		isUDP = true;
	} else {
		return {
			hasError: true,
			message: `command ${command} is not support, command 01-tcp,02-udp,03-mux`,
		};
	}
	const portIndex = 18 + optLength + 1;
	if (portIndex + 3 > bytes.byteLength) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}
	// port is big-Endian in raw data etc 80 == 0x005d
	const portRemote = dataView.getUint16(portIndex);

	let addressIndex = portIndex + 2;

	// 1--> ipv4  addressLength =4
	// 2--> domain name addressLength=addressBuffer[1]
	// 3--> ipv6  addressLength =16
	const addressType = bytes[addressIndex];
	let addressLength = 0;
	let addressValueIndex = addressIndex + 1;
	let addressValue = '';
	switch (addressType) {
		case 1:
			addressLength = 4;
			break;
		case 2:
			addressLength = bytes[addressValueIndex] || 0;
			addressValueIndex += 1;
			break;
		case 3:
			addressLength = 16;
			break;
		default:
			return {
				hasError: true,
				message: `invild  addressType is ${addressType}`,
			};
	}
	if (addressValueIndex + addressLength > bytes.byteLength) {
		return {
			hasError: true,
			message: 'invalid data',
		};
	}
	switch (addressType) {
		case 1:
			addressValue = bytes.subarray(addressValueIndex, addressValueIndex + 4).join('.');
			break;
		case 2:
			addressValue = textDecoder.decode(
				bytes.subarray(addressValueIndex, addressValueIndex + addressLength)
			);
			break;
		case 3: {
			// 2001:0db8:85a3:0000:0000:8a2e:0370:7334
			const ipv6 = [];
			for (let i = 0; i < 8; i++) {
				ipv6.push(dataView.getUint16(addressValueIndex + i * 2).toString(16));
			}
			addressValue = ipv6.join(':');
			// seems no need add [] for ipv6
			break;
		}
	}
	if (!addressValue) {
		return {
			hasError: true,
			message: `addressValue is empty, addressType is ${addressType}`,
		};
	}

	return {
		hasError: false,
		addressRemote: addressValue,
		addressType,
		portRemote,
		rawDataIndex: addressValueIndex + addressLength,
		vlessVersion: version,
		isUDP,
	};
}


/**
 *
 * @param {import("@cloudflare/workers-types").Socket} remoteSocket
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket
 * @param {Uint8Array} vlessResponseHeader
 * @param {(() => Promise<void>) | null} retry
 * @param {*} log
 * @returns {Promise<boolean>} remoteSocket has incoming data or not
 */
async function remoteSocketToWS(remoteSocket, webSocket, vlessResponseHeader, retry, log) {
	// remote--> ws
	/** @type {Uint8Array | null} */
	let vlessHeader = vlessResponseHeader;
	let hasIncomingData = false; // check if remoteSocket has incoming data
	await remoteSocket.readable
		.pipeTo(
			new WritableStream({
				/**
				 *
				 * @param {Uint8Array} chunk
				 * @param {*} controller
				 */
				write(chunk, controller) {
					hasIncomingData = true;
					if (webSocket.readyState !== WS_READY_STATE_OPEN) {
						controller.error(
							'webSocket.readyState is not open, maybe close'
						);
						return;
					}
					if (vlessHeader) {
						webSocket.send(concatBytes(vlessHeader, chunk));
						vlessHeader = null;
					} else {
						// seems no need rate limit this, CF seems fix this??..
						webSocket.send(chunk);
					}
				},
				close() {
					log(`remoteConnection!.readable is close with hasIncomingData is ${hasIncomingData}`);
					// safeCloseWebSocket(webSocket); // no need server close websocket frist for some case will casue HTTP ERR_CONTENT_LENGTH_MISMATCH issue, client will send close event anyway.
				},
				abort(reason) {
					console.error(`remoteConnection!.readable abort`, reason);
				},
			})
		)
		.catch((error) => {
			console.error(
				`remoteSocketToWS has exception `,
				error.stack || error
			);
			safeCloseWebSocket(webSocket);
		});

	// seems is cf connect socket have error,
	// 1. Socket.closed will have error
	// 2. Socket.readable will be close without any data coming
	if (hasIncomingData === false && retry) {
		log(`retry`)
		retry().catch((error) => {
			console.error(`retry has exception `, error.stack || error);
			safeCloseWebSocket(webSocket);
		});
	}
	return hasIncomingData;
}

/**
 *
 * @param {string} base64Str
 * @returns
 */
function base64ToArrayBuffer(base64Str) {
	if (!base64Str) {
		return { error: null };
	}
	try {
		// go use modified Base64 for URL rfc4648 which js atob not support
		base64Str = base64Str.replace(/-/g, '+').replace(/_/g, '/');
		const decode = atob(base64Str);
		const arryBuffer = new Uint8Array(decode.length);
		for (let i = 0; i < decode.length; i++) {
			arryBuffer[i] = decode.charCodeAt(i);
		}
		return { earlyData: arryBuffer.buffer, error: null };
	} catch (error) {
		return { error };
	}
}

/**
 * This is not real UUID validation
 * @param {string} uuid
 */
function isValidUUID(uuid) {
	const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[4][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
	return uuidRegex.test(uuid);
}

/**
 * @param {string} uuid
 * @returns {Uint8Array}
 */
function uuidToBytes(uuid) {
	const hex = uuid.replace(/-/g, '');
	const bytes = new Uint8Array(16);
	for (let i = 0; i < 16; i++) {
		bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
	}
	return bytes;
}

/**
 * @param {ArrayBuffer | Uint8Array} data
 * @returns {Uint8Array}
 */
function toUint8Array(data) {
	return data instanceof Uint8Array ? data : new Uint8Array(data);
}

/**
 * @param {...(ArrayBuffer | Uint8Array)} arrays
 * @returns {Uint8Array}
 */
function concatBytes(...arrays) {
	let length = 0;
	for (const array of arrays) {
		length += array.byteLength;
	}
	const result = new Uint8Array(length);
	let offset = 0;
	for (const array of arrays) {
		result.set(toUint8Array(array), offset);
		offset += array.byteLength;
	}
	return result;
}

const WS_READY_STATE_OPEN = 1;
const WS_READY_STATE_CLOSING = 2;
/**
 * Normally, WebSocket will not has exceptions when close.
 * @param {import("@cloudflare/workers-types").WebSocket} socket
 */
function safeCloseWebSocket(socket) {
	try {
		if (socket.readyState === WS_READY_STATE_OPEN || socket.readyState === WS_READY_STATE_CLOSING) {
			socket.close();
		}
	} catch (error) {
		console.error('safeCloseWebSocket error', error);
	}
}

/**
 *
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket
 * @param {Uint8Array} vlessResponseHeader
 * @param {(string)=> void} log
 * @returns {(chunk: ArrayBuffer | Uint8Array) => void}
 */
function handleUDPOutBound(webSocket, vlessResponseHeader, log) {

	let isVlessHeaderSent = false;
	/** @type {Uint8Array} udp data left from last websocket message */
	let pending = new Uint8Array(0);

	/**
	 * every dns query run in parallel, dns response has id, so order is not matter
	 * @param {Uint8Array} udpData
	 */
	async function queryDNS(udpData) {
		try {
			const resp = await fetch('https://1.1.1.1/dns-query',
				{
					method: 'POST',
					headers: {
						'content-type': 'application/dns-message',
					},
					body: udpData,
				})
			const dnsQueryResult = await resp.arrayBuffer();
			const udpSize = dnsQueryResult.byteLength;
			const udpSizeBuffer = new Uint8Array([(udpSize >> 8) & 0xff, udpSize & 0xff]);
			if (webSocket.readyState === WS_READY_STATE_OPEN) {
				log(`doh success and dns message length is ${udpSize}`);
				if (isVlessHeaderSent) {
					webSocket.send(concatBytes(udpSizeBuffer, dnsQueryResult));
				} else {
					webSocket.send(concatBytes(vlessResponseHeader, udpSizeBuffer, dnsQueryResult));
					isVlessHeaderSent = true;
				}
			}
		} catch (error) {
			log('dns udp has error' + error);
		}
	}

	return (chunk) => {
		// udp message 2 byte is the the length of udp data
		// one udp packet maybe split into two websocket message
		const data = pending.byteLength ? concatBytes(pending, chunk) : toUint8Array(chunk);
		let index = 0;
		while (index + 2 <= data.byteLength) {
			const udpPakcetLength = (data[index] << 8) | data[index + 1];
			if (index + 2 + udpPakcetLength > data.byteLength) {
				break;
			}
			queryDNS(data.slice(index + 2, index + 2 + udpPakcetLength));
			index = index + 2 + udpPakcetLength;
		}
		pending = data.slice(index);
	};
}

/**
 *
 * @param {string} userID
 * @param {string | null} hostName
 * @returns {string}
 */
function getVLESSConfig(userID, hostName) {
	const vlessMain = `vless://${userID}@${hostName}:443?encryption=none&security=tls&sni=${hostName}&fp=randomized&type=ws&host=${hostName}&path=%2F%3Fed%3D2048#${hostName}`
	return `
################################################################
v2ray
---------------------------------------------------------------
${vlessMain}
---------------------------------------------------------------
################################################################
clash-meta
---------------------------------------------------------------
- type: vless
  name: ${hostName}
  server: ${hostName}
  port: 443
  uuid: ${userID}
  network: ws
  tls: true
  udp: false
  sni: ${hostName}
  client-fingerprint: chrome
  ws-opts:
    path: "/?ed=2048"
    headers:
      host: ${hostName}
---------------------------------------------------------------
################################################################
`;
}

