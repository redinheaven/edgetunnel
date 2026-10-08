// Run worker logic in Node.js with mocked cloudflare:sockets / WebSocketPair / fetch.
// Usage: npm test
import { readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const tick = (ms = 5) => new Promise(r => setTimeout(r, ms));

// ---- mocks ----
class MockWS {
	constructor() { this.readyState = 1; this.sent = []; this.listeners = {}; }
	accept() {}
	addEventListener(t, f) { (this.listeners[t] ||= []).push(f); }
	emit(t, e) { (this.listeners[t] || []).forEach(f => f(e)); }
	send(d) { this.sent.push(Buffer.from(d instanceof ArrayBuffer ? new Uint8Array(d) : d)); }
	close() { this.readyState = 3; }
}
globalThis.WebSocketPair = class { constructor() { const s = new MockWS(); this[0] = new MockWS(); this[1] = s; } };
globalThis.Response = class { constructor(b, i) { this.body = b; this.init = i; } };

const connections = [];
// behavior(conn) decides what remote does
let behavior = () => {};
function connect({ hostname, port }) {
	let readCtl;
	const received = [];
	const readable = new ReadableStream({ start(c) { readCtl = c; } });
	let closedResolve;
	const closed = new Promise(r => closedResolve = r);
	const conn = {
		hostname, port, received, readCtl,
		push(d) { readCtl.enqueue(new Uint8Array(d)); },
		end() { readCtl.close(); closedResolve(); },
		onData: null,
	};
	conn.readCtl = readCtl;
	const writable = new WritableStream({
		write(chunk) { const b = Buffer.from(chunk instanceof ArrayBuffer ? new Uint8Array(chunk) : chunk); received.push(b); conn.onData && conn.onData(b); },
	});
	conns_push(conn);
	behavior(conn);
	return { readable, writable, closed, close() { conn.closedByUs = true; } };
}
function conns_push(c) { connections.push(c); }
globalThis.__mock = { connect };

async function load(file) {
	let src = readFileSync(file, 'utf8').replace(/import \{ connect \} from 'cloudflare:sockets';/, 'const { connect } = globalThis.__mock;');
	return (await import('data:text/javascript,' + encodeURIComponent(src) + `//${Math.random()}`)).default;
}

const UUID = 'd342d11e-d424-4583-b36e-524ab1f0afa4';
const uuidBytes = Buffer.from(UUID.replace(/-/g, ''), 'hex');
function header({ cmd = 1, port = 443, atype = 2, addr = 'example.com' }) {
	let a;
	if (atype === 1) a = Buffer.from([1, ...addr.split('.').map(Number)]);
	else if (atype === 2) a = Buffer.concat([Buffer.from([2, Buffer.byteLength(addr)]), Buffer.from(addr)]);
	else a = Buffer.concat([Buffer.from([3]), Buffer.from(addr, 'hex')]);
	return Buffer.concat([Buffer.from([0]), uuidBytes, Buffer.from([0, cmd, port >> 8, port & 0xff]), a]);
}
const ab = (b) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);

async function open(worker, env = {}) {
	const req = { headers: new Map([['Upgrade', 'websocket']]), url: 'https://x/' };
	req.headers.get = Map.prototype.get.bind(req.headers);
	let ws;
	const OrigPair = globalThis.WebSocketPair;
	globalThis.WebSocketPair = class extends OrigPair { constructor() { super(); ws = this[1]; } };
	await worker.fetch(req, env, {});
	globalThis.WebSocketPair = OrigPair;
	return ws;
}

// ---- vless tests ----
async function run(file) {
	console.log(`# ${file}`);
	const worker = await load(new URL(file, import.meta.url));
	const isSocks = file.includes('socks');

	// 1. TCP basic + ordering + writer reuse
	connections.length = 0;
	behavior = (c) => { c.onData = (b) => { if (b.toString() === 'hello') c.push(Buffer.from('world')); }; };
	let ws = await open(worker, { UUID });
	ws.emit('message', { data: ab(Buffer.concat([header({}), Buffer.from('hello')])) });
	ws.emit('message', { data: ab(Buffer.from('a')) });
	ws.emit('message', { data: ab(Buffer.from('b')) });
	await tick(20);
	assert.equal(connections.length, 1);
	assert.equal(connections[0].hostname, 'example.com');
	assert.deepEqual(connections[0].received.map(String), ['hello', 'a', 'b']);
	connections[0].push(Buffer.from('more'));
	await tick();
	assert.deepEqual(ws.sent.map(b => b.toString('hex')), [Buffer.concat([Buffer.from([0, 0]), Buffer.from('world')]).toString('hex'), Buffer.from('more').toString('hex')]);
	console.log('ok tcp basic');

	// 2. invalid user
	connections.length = 0;
	ws = await open(worker, { UUID: 'd342d11e-d424-4583-b36e-524ab1f0afa5' });
	ws.emit('message', { data: ab(Buffer.concat([header({}), Buffer.from('x')])) });
	await tick();
	assert.equal(connections.length, 0);
	assert.equal(ws.readyState, 3);
	console.log('ok invalid user');

	// 3. ipv4 / ipv6 parsing
	connections.length = 0;
	behavior = () => {};
	ws = await open(worker, { UUID });
	ws.emit('message', { data: ab(Buffer.concat([header({ atype: 1, addr: '1.2.3.4', port: 80 }), Buffer.from('x')])) });
	await tick();
	assert.equal(connections[0].hostname, '1.2.3.4');
	assert.equal(connections[0].port, 80);
	ws = await open(worker, { UUID });
	ws.emit('message', { data: ab(Buffer.concat([header({ atype: 3, addr: '20010db8000000000000000000000001' }), Buffer.from('x')])) });
	await tick();
	assert.equal(connections[1].hostname, '2001:db8:0:0:0:0:0:1');
	console.log('ok ip parse');

	// 4. early data via sec-websocket-protocol
	connections.length = 0;
	{
		const req = { headers: new Map([['Upgrade', 'websocket'], ['sec-websocket-protocol', Buffer.concat([header({}), Buffer.from('ed')]).toString('base64url')]]), url: 'https://x/' };
		req.headers.get = Map.prototype.get.bind(req.headers);
		await worker.fetch(req, { UUID }, {});
		await tick();
		assert.deepEqual(connections[0].received.map(String), ['ed']);
	}
	console.log('ok early data');

	// 5. retry with proxyIP + cache
	connections.length = 0;
	behavior = (c) => {
		if (c.hostname === 'cf.com') setTimeout(() => c.end(), 1);
		else c.onData = () => c.push(Buffer.from('ok'));
	};
	ws = await open(worker, { UUID, PROXYIP: 'proxy.ip' });
	ws.emit('message', { data: ab(Buffer.concat([header({ addr: 'cf.com' }), Buffer.from('hi')])) });
	await tick(30);
	assert.deepEqual(connections.map(c => c.hostname), ['cf.com', 'proxy.ip']);
	assert.equal(ws.sent[0].toString(), '\0\0ok');
	ws = await open(worker, { UUID, PROXYIP: 'proxy.ip' });
	ws.emit('message', { data: ab(Buffer.concat([header({ addr: 'cf.com' }), Buffer.from('hi')])) });
	await tick(30);
	assert.deepEqual(connections.map(c => c.hostname), ['cf.com', 'proxy.ip', 'proxy.ip']);
	assert.equal(ws.sent[0].toString(), '\0\0ok');
	console.log('ok proxyIP retry + cache');

	// 6. DNS
	const q1 = Buffer.from('query-one'), q2 = Buffer.from('q2');
	const frame = (q) => Buffer.concat([Buffer.from([q.length >> 8, q.length & 0xff]), q]);
	if (!isSocks) {
		const calls = [];
		globalThis.fetch = async (url, init) => {
			const body = Buffer.from(init.body);
			calls.push(body.toString());
			// first query slower, check parallel
			await tick(body.toString() === 'query-one' ? 30 : 1);
			const r = Buffer.from('resp-' + body.toString());
			return { arrayBuffer: async () => ab(r) };
		};
		ws = await open(worker, { UUID });
		const all = Buffer.concat([header({ cmd: 2, port: 53, atype: 1, addr: '8.8.8.8' }), frame(q1), frame(q2)]);
		// split second frame across two messages
		const cut = all.length - 1;
		ws.emit('message', { data: ab(all.subarray(0, cut)) });
		ws.emit('message', { data: ab(all.subarray(cut)) });
		await tick(60);
		assert.deepEqual(calls, ['query-one', 'q2']);
		assert.equal(ws.sent.length, 2);
		// q2 respond first because parallel, and header in first one
		assert.equal(ws.sent[0].toString('hex'), Buffer.concat([Buffer.from([0, 0]), frame(Buffer.from('resp-q2'))]).toString('hex'));
		assert.equal(ws.sent[1].toString('hex'), frame(Buffer.from('resp-query-one')).toString('hex'));
		console.log('ok doh parallel + split');
	} else {
		connections.length = 0;
		behavior = (c) => { c.onData = (b) => c.push(Buffer.from('r:' + b.subarray(2).toString())); };
		ws = await open(worker, { UUID });
		ws.emit('message', { data: ab(Buffer.concat([header({ cmd: 2, port: 53, atype: 1, addr: '8.8.8.8' }), frame(q1)])) });
		ws.emit('message', { data: ab(frame(q2)) });
		await tick(20);
		assert.equal(connections.length, 1);
		assert.equal(connections[0].hostname, '8.8.4.4');
		assert.deepEqual(ws.sent.map(String), ['\0\0r:query-one', 'r:q2']);
		// dns server close, next query reconnect
		connections[0].end();
		await tick();
		ws.emit('message', { data: ab(frame(Buffer.from('q3'))) });
		await tick(20);
		assert.equal(connections.length, 2);
		assert.equal(ws.sent.at(-1).toString(), 'r:q3');
		console.log('ok dns tcp reuse + reconnect');
	}

	// 7. socks5
	if (isSocks) {
		for (const pipeline of [false, true]) {
			for (const auth of [false, true]) {
				connections.length = 0;
				// fake socks5 server; replies in single chunk with remote data appended to test leftover
				behavior = (c) => {
					if (c.hostname !== 'socks.host') { setTimeout(() => c.end(), 1); return; }
					let buf = Buffer.alloc(0); let stage = 0;
					c.onData = (b) => {
						buf = Buffer.concat([buf, b]);
						for (;;) {
							if (stage === 0) {
								if (buf.length < 2 || buf.length < 2 + buf[1]) return;
								const methods = [...buf.subarray(2, 2 + buf[1])];
								buf = buf.subarray(2 + buf[1]);
								const m = auth ? 2 : 0;
								assert.ok(methods.includes(m));
								c.push([5, m]); stage = auth ? 1 : 2; continue;
							}
							if (stage === 1) {
								if (buf.length < 2) return;
								const ul = buf[1]; if (buf.length < 3 + ul) return; const pl = buf[2 + ul]; if (buf.length < 3 + ul + pl) return;
								assert.equal(buf.subarray(2, 2 + ul).toString(), 'user');
								assert.equal(buf.subarray(3 + ul, 3 + ul + pl).toString(), 'pässwd');
								buf = buf.subarray(3 + ul + pl); c.push([1, 0]); stage = 2; continue;
							}
							if (stage === 2) {
								if (buf.length < 5) return;
								const at = buf[3]; const len = at === 1 ? 4 : at === 4 ? 16 : 1 + buf[4];
								if (buf.length < 4 + len + 2) return;
								c.target = buf.subarray(3, 4 + len).toString('hex');
								buf = buf.subarray(4 + len + 2);
								// reply with domain bnd addr + server-first data
								c.push(Buffer.concat([Buffer.from([5, 0, 0, 3, 3]), Buffer.from('abc'), Buffer.from([0, 80]), Buffer.from('BANNER')]));
								stage = 3; continue;
							}
							if (stage === 3) { if (buf.length) { c.data = (c.data || '') + buf.toString(); buf = Buffer.alloc(0); } return; }
						}
					};
				};
				const env = { UUID, SOCKS5: auth ? 'user:pässwd@socks.host:1080' : 'socks.host:1080', SOCKS5_PIPELINE: String(pipeline) };
				ws = await open(worker, env);
				ws.emit('message', { data: ab(Buffer.concat([header({ addr: 'needsocks' + auth + pipeline + '.com' }), Buffer.from('hi')])) });
				await tick(40);
				assert.deepEqual(connections.map(c => c.hostname), ['needsocks' + auth + pipeline + '.com', 'socks.host']);
				assert.equal(connections[1].data, 'hi');
				assert.equal(ws.sent[0].toString(), '\0\0BANNER');
				ws.emit('message', { data: ab(Buffer.from('next')) });
				await tick();
				assert.equal(connections[1].data, 'hinext');
				console.log(`ok socks5 pipeline=${pipeline} auth=${auth}`);
			}
		}
		// ipv6 target through cache path
		connections.length = 0;
		ws = await open(worker, { UUID, SOCKS5: 'user:pässwd@socks.host:1080' });
		ws.emit('message', { data: ab(Buffer.concat([header({ atype: 3, addr: '20010db8000000000000000000000001' }), Buffer.from('hi')])) });
		await tick(40);
		assert.equal(connections[1].target, '04' + '20010db8000000000000000000000001');
		console.log('ok socks5 ipv6');
	}
}

for (const file of ['../src/worker-vless.js', '../src/worker-with-socks5-experimental.js']) {
	await run(file);
}
console.log('ALL PASS');
