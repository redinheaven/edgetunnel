// <!--GAMFC-->version base on commit 841ed4e9ff121dde0ed6a56ae800c2e6c4f66056, time is 2024-04-16 18:02:38 UTC<!--GAMFC-END-->.
// @ts-ignore
import { connect } from 'cloudflare:sockets';

// How to generate your own UUID:
// [Windows] Press "Win + R", input cmd and run:  Powershell -NoExit -Command "[guid]::NewGuid()"
let userID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';

let proxyIP = '';

// The user name and password do not contain special characters
// Setting the address will ignore proxyIP
// Example:  user:pass@host:port  or  host:port
let socks5Address = '';

// set env SOCKS5_PIPELINE=true to send socks5 greeting/auth/connect in one write,
// save 1~2 RTT, but some socks5 server may not support it
let enableSocksPipeline = false;

// set env DEBUG=true to enable console.log
let enableLog = false;

if (!isValidUUID(userID)) {
	throw new Error('uuid is not valid');
}

let userIDBytes = uuidToBytes(userID);

let parsedSocks5Address = {};
let parsedSocks5Source = '';
let enableSocks = false;

const textDecoder = new TextDecoder();
const textEncoder = new TextEncoder();

// max bytes buffered from websocket before remote socket consume it
const MAX_WS_BUFFERED_BYTES = 16 * 1024 * 1024;

export default {
	/**
	 * @param {import("@cloudflare/workers-types").Request} request
	 * @param {{UUID: string, PROXYIP: string, SOCKS5: string, SOCKS5_PIPELINE: string, DEBUG: string}} env
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
			enableSocksPipeline = env.SOCKS5_PIPELINE === 'true';
			socks5Address = env.SOCKS5 || socks5Address;
			// only parse when socks5Address changed
			if (socks5Address && socks5Address !== parsedSocks5Source) {
				parsedSocks5Source = socks5Address;
				try {
					parsedSocks5Address = socks5AddressParser(socks5Address);
					enableSocks = true;
				} catch (err) {
					/** @type {Error} */ let e = err;
					console.log(e.toString());
					enableSocks = false;
				}
			}
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
	/** @type {((chunk: ArrayBuffer | Uint8Array) => Promise<void>) | null} */
	let dnsWrite = null;

	// ws --> remote
	readableWebSocketStream.pipeTo(new WritableStream({
		async write(chunk, controller) {
			if (dnsWrite) {
				return dnsWrite(chunk);
			}
			if (remoteSocketWrapper.writer) {
				await remoteSocketWrapper.writer.write(chunk);
				return;
			}

			const {
				hasError,
				message,
				addressType,
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

			if (isUDP) {
				dnsWrite = createDNSQueryHandler(webSocket, vlessResponseHeader, log);
				return dnsWrite(rawClientData);
			}
			// wait first write finish, so next chunk can use remoteSocketWrapper.writer
			await handleTCPOutBound(remoteSocketWrapper, addressType, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log);
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

// hosts which direct connect has no incoming data and need connect by socks5 or proxyIP
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
 * @param {number} addressType The remote address type to connect to.
 * @param {string} addressRemote The remote address to connect to.
 * @param {number} portRemote The remote port to connect to.
 * @param {Uint8Array} rawClientData The raw client data to write.
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket The WebSocket to pass the remote socket to.
 * @param {Uint8Array} vlessResponseHeader The VLESS response header.
 * @param {function} log The logging function.
 * @returns {Promise<void>}
 */
async function handleTCPOutBound(remoteSocket, addressType, addressRemote, portRemote, rawClientData, webSocket, vlessResponseHeader, log,) {
	async function connectAndWrite(address, port, socks = false) {
		/** @type {import("@cloudflare/workers-types").Socket} */
		const tcpSocket = socks ? await socks5Connect(addressType, address, port, log)
			: connect({
				hostname: address,
				port: port,
			});
		// keep writer, no need getWriter for every chunk
		const writer = tcpSocket.writable.getWriter();
		remoteSocket.writer = writer;
		log(`connected to ${address}:${port}`);
		await writer.write(rawClientData); // first write, normal is tls client hello
		return tcpSocket;
	}

	const hasFallback = enableSocks || !!proxyIP;

	async function connectByFallback() {
		const tcpSocket = enableSocks
			? await connectAndWrite(addressRemote, portRemote, true)
			: await connectAndWrite(proxyIP, portRemote);
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
		if (hasFallback) {
			markProxyHost(addressRemote, true);
			return connectByFallback();
		}
		const tcpSocket = await connectAndWrite(addressRemote, portRemote);
		// no matter retry success or not, close websocket
		tcpSocket.closed.catch(error => {
			log('retry tcpSocket closed error', error);
		}).finally(() => {
			safeCloseWebSocket(webSocket);
		})
		remoteSocketToWS(tcpSocket, webSocket, vlessResponseHeader, null, log);
	}

	// direct connect failed recently, skip it
	if (hasFallback && isProxyHost(addressRemote)) {
		log(`use ${enableSocks ? 'socks5' : 'proxyIP'} for ${addressRemote}`);
		return connectByFallback();
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
 * @param {{ readable: ReadableStream }} remoteSocket
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
 * DNS over TCP use same 2 byte length prefix as vless udp, so data can write directly.
 * One websocket reuse one tcp connection for all dns query, and not wait dns response.
 *
 * @param {import("@cloudflare/workers-types").WebSocket} webSocket
 * @param {Uint8Array} vlessResponseHeader
 * @param {(string)=> void} log
 * @returns {(udpChunk: ArrayBuffer | Uint8Array) => Promise<void>}
 */
function createDNSQueryHandler(webSocket, vlessResponseHeader, log) {
	// no matter which DNS server client send, we alwasy use hard code one.
	// beacsue someof DNS server is not support DNS over TCP
	const dnsServer = '8.8.4.4'; // change to 1.1.1.1 after cf fix connect own ip bug
	const dnsPort = 53;
	/** @type {Uint8Array | null} */
	let vlessHeader = vlessResponseHeader;
	/** @type {WritableStreamDefaultWriter | null} */
	let dnsWriter = null;

	function openConnection() {
		/** @type {import("@cloudflare/workers-types").Socket} */
		const tcpSocket = connect({
			hostname: dnsServer,
			port: dnsPort,
		});
		log(`connected to ${dnsServer}:${dnsPort}`);
		const writer = tcpSocket.writable.getWriter();
		dnsWriter = writer;
		tcpSocket.readable.pipeTo(new WritableStream({
			write(chunk) {
				if (webSocket.readyState === WS_READY_STATE_OPEN) {
					if (vlessHeader) {
						webSocket.send(concatBytes(vlessHeader, chunk));
						vlessHeader = null;
					} else {
						webSocket.send(chunk);
					}
				}
			},
			close() {
				log(`dns server(${dnsServer}) tcp is close`);
			},
			abort(reason) {
				console.error(`dns server(${dnsServer}) tcp is abort`, reason);
			},
		})).catch((error) => {
			console.error(`dns server(${dnsServer}) tcp has exception`, error.stack || error);
		}).finally(() => {
			// dns server close idle connection, next query will open new one
			if (dnsWriter === writer) {
				dnsWriter = null;
			}
		});
		return writer;
	}

	return async (udpChunk) => {
		try {
			const writer = dnsWriter || openConnection();
			try {
				await writer.write(udpChunk);
			} catch (error) {
				// connection maybe closed by dns server, retry once with new connection
				if (dnsWriter === writer) {
					dnsWriter = null;
				}
				log(`dns write error, reconnect. ${error}`);
				await openConnection().write(udpChunk);
			}
		} catch (error) {
			console.error(
				`handleDNSQuery have exception, error: ${error.message}`
			);
		}
	};
}

/**
 * Read exactly n bytes from reader, keep left data for next read.
 * @param {ReadableStreamDefaultReader} reader
 */
function createByteReader(reader) {
	let buffer = new Uint8Array(0);
	return {
		/**
		 * @param {number} n
		 * @returns {Promise<Uint8Array>}
		 */
		async readExactly(n) {
			while (buffer.byteLength < n) {
				const { value, done } = await reader.read();
				if (done) {
					throw new Error('socks server closed connection');
				}
				buffer = buffer.byteLength ? concatBytes(buffer, value) : toUint8Array(value);
			}
			const result = buffer.subarray(0, n);
			buffer = buffer.subarray(n);
			return result;
		},
		/**
		 * @returns {Uint8Array}
		 */
		left() {
			return buffer;
		},
	};
}

/**
 *
 * @param {number} addressType
 * @param {string} addressRemote
 * @param {number} portRemote
 * @param {function} log The logging function.
 * @returns {Promise<{ readable: ReadableStream, writable: WritableStream, closed: Promise<void> }>}
 */
async function socks5Connect(addressType, addressRemote, portRemote, log) {
	const { username, password, hostname, port } = parsedSocks5Address;
	const useAuth = !!(username && password);
	// Connect to the SOCKS server
	const socket = connect({
		hostname,
		port,
	});
	try {
		return await socks5Handshake(socket, useAuth, username, password, addressType, addressRemote, portRemote, log);
	} catch (error) {
		// handshake fail, close socks connection
		try {
			socket.close();
		} catch (e) {
		}
		throw error;
	}
}

/**
 * @param {import("@cloudflare/workers-types").Socket} socket
 * @param {boolean} useAuth
 * @param {string} username
 * @param {string} password
 * @param {number} addressType
 * @param {string} addressRemote
 * @param {number} portRemote
 * @param {function} log The logging function.
 */
async function socks5Handshake(socket, useAuth, username, password, addressType, addressRemote, portRemote, log) {
	// Request head format (Worker -> Socks Server):
	// +----+----------+----------+
	// |VER | NMETHODS | METHODS  |
	// +----+----------+----------+
	// | 1  |    1     | 1 to 255 |
	// +----+----------+----------+

	// https://en.wikipedia.org/wiki/SOCKS#SOCKS5
	// For METHODS:
	// 0x00 NO AUTHENTICATION REQUIRED
	// 0x02 USERNAME/PASSWORD https://datatracker.ietf.org/doc/html/rfc1929
	// pipeline mode only offer the method we will use, so server reply is predictable
	const socksGreeting = !useAuth
		? new Uint8Array([5, 1, 0])
		: enableSocksPipeline ? new Uint8Array([5, 1, 2]) : new Uint8Array([5, 2, 0, 2]);

	// +----+------+----------+------+----------+
	// |VER | ULEN |  UNAME   | PLEN |  PASSWD  |
	// +----+------+----------+------+----------+
	// | 1  |  1   | 1 to 255 |  1   | 1 to 255 |
	// +----+------+----------+------+----------+
	let authRequest = null;
	if (useAuth) {
		const usernameBytes = textEncoder.encode(username);
		const passwordBytes = textEncoder.encode(password);
		authRequest = concatBytes(
			new Uint8Array([1, usernameBytes.byteLength]),
			usernameBytes,
			new Uint8Array([passwordBytes.byteLength]),
			passwordBytes
		);
	}

	// Request data format (Worker -> Socks Server):
	// +----+-----+-------+------+----------+----------+
	// |VER | CMD |  RSV  | ATYP | DST.ADDR | DST.PORT |
	// +----+-----+-------+------+----------+----------+
	// | 1  |  1  | X'00' |  1   | Variable |    2     |
	// +----+-----+-------+------+----------+----------+
	// ATYP: address type of following address
	// 0x01: IPv4 address
	// 0x03: Domain name
	// 0x04: IPv6 address
	// DST.ADDR: desired destination address
	// DST.PORT: desired destination port in network octet order

	// addressType
	// 1--> ipv4  addressLength =4
	// 2--> domain name
	// 3--> ipv6  addressLength =16
	let DSTADDR;	// DSTADDR = ATYP + DST.ADDR
	switch (addressType) {
		case 1:
			DSTADDR = new Uint8Array(
				[1, ...addressRemote.split('.').map(Number)]
			);
			break;
		case 2: {
			const domainBytes = textEncoder.encode(addressRemote);
			DSTADDR = concatBytes(new Uint8Array([3, domainBytes.byteLength]), domainBytes);
			break;
		}
		case 3:
			DSTADDR = new Uint8Array(
				[4, ...addressRemote.split(':').flatMap(x => {
					const value = parseInt(x, 16);
					return [value >> 8, value & 0xff];
				})]
			);
			break;
		default:
			throw new Error(`invild  addressType is ${addressType}`);
	}
	const socksRequest = concatBytes(
		new Uint8Array([5, 1, 0]),
		DSTADDR,
		new Uint8Array([portRemote >> 8, portRemote & 0xff])
	);

	const writer = socket.writable.getWriter();
	const reader = socket.readable.getReader();
	const byteReader = createByteReader(reader);

	if (enableSocksPipeline) {
		// send all in one write, save RTT
		await writer.write(authRequest ? concatBytes(socksGreeting, authRequest, socksRequest) : concatBytes(socksGreeting, socksRequest));
		log('sent socks greeting and request (pipeline)');
	} else {
		await writer.write(socksGreeting);
		log('sent socks greeting');
	}

	// Response format (Socks Server -> Worker):
	// +----+--------+
	// |VER | METHOD |
	// +----+--------+
	// | 1  |   1    |
	// +----+--------+
	let res = await byteReader.readExactly(2);
	if (res[0] !== 0x05) {
		throw new Error(`socks server version error: ${res[0]} expected: 5`);
	}
	if (res[1] === 0xff) {
		throw new Error('no acceptable methods');
	}

	// if return 0x0502
	if (res[1] === 0x02) {
		log("socks server needs auth");
		if (!authRequest) {
			throw new Error('please provide username/password');
		}
		if (!enableSocksPipeline) {
			await writer.write(authRequest);
		}
		res = await byteReader.readExactly(2);
		// expected 0x0100
		if (res[0] !== 0x01 || res[1] !== 0x00) {
			throw new Error('fail to auth socks server');
		}
	} else if (res[1] !== 0x00) {
		throw new Error(`socks server return unknown method: ${res[1]}`);
	}

	if (!enableSocksPipeline) {
		await writer.write(socksRequest);
		log('sent socks request');
	}

	//  +----+-----+-------+------+----------+----------+
	// |VER | REP |  RSV  | ATYP | BND.ADDR | BND.PORT |
	// +----+-----+-------+------+----------+----------+
	// | 1  |  1  | X'00' |  1   | Variable |    2     |
	// +----+-----+-------+------+----------+----------+
	res = await byteReader.readExactly(4);
	if (res[1] !== 0x00) {
		throw new Error(`fail to open socks connection, reply: ${res[1]}`);
	}
	const bndAddressType = res[3];
	let bndLength = 0;
	switch (bndAddressType) {
		case 1:
			bndLength = 4;
			break;
		case 3:
			bndLength = (await byteReader.readExactly(1))[0];
			break;
		case 4:
			bndLength = 16;
			break;
		default:
			throw new Error(`socks server return unknown address type: ${bndAddressType}`);
	}
	await byteReader.readExactly(bndLength + 2);
	log("socks connection opened");

	writer.releaseLock();
	const left = byteReader.left();
	if (left.byteLength === 0) {
		reader.releaseLock();
		return socket;
	}
	// remote data come with socks reply, keep it
	const readable = new ReadableStream({
		start(controller) {
			controller.enqueue(left);
		},
		async pull(controller) {
			const { value, done } = await reader.read();
			if (done) {
				controller.close();
			} else {
				controller.enqueue(value);
			}
		},
		cancel(reason) {
			return reader.cancel(reason);
		},
	});
	return {
		readable,
		writable: socket.writable,
		closed: socket.closed,
	};
}


/**
 *
 * @param {string} address
 */
function socks5AddressParser(address) {
	let [latter, former] = address.split("@").reverse();
	let username, password, hostname, port;
	if (former) {
		const formers = former.split(":");
		if (formers.length !== 2) {
			throw new Error('Invalid SOCKS address format');
		}
		[username, password] = formers;
	}
	const latters = latter.split(":");
	port = Number(latters.pop());
	if (isNaN(port)) {
		throw new Error('Invalid SOCKS address format');
	}
	hostname = latters.join(":");
	const regex = /^\[.*\]$/;
	if (hostname.includes(":") && !regex.test(hostname)) {
		throw new Error('Invalid SOCKS address format');
	}
	return {
		username,
		password,
		hostname,
		port,
	}
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
