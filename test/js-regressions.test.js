const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const source = (name) => readFileSync(path.join(__dirname, '../src/js', name), 'utf8');
const quietConsole = { log() {}, warn() {}, error() {} };

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((onResolve, onReject) => {
        resolve = onResolve;
        reject = onReject;
    });
    return { promise, resolve, reject };
}

function loadApp(options = {}) {
    const contexts = [];
    const tracks = [];
    const elements = {};
    const makeStream = () => {
        const track = {
            stopped: false,
            stop() {
                this.stopped = true;
            },
        };
        tracks.push(track);
        return { getTracks: () => [track] };
    };
    const makeNode = () => ({ connect() {}, disconnect() {} });
    const sandbox = {
        console: quietConsole,
        AudioContext: class {
            constructor(settings) {
                assert.equal(settings.sampleRate, 48000);
                this.sampleRate = options.sampleRate ?? 48000;
                this.state = 'running';
                this.audioWorklet = { addModule: options.addModule ?? (async () => {}) };
                contexts.push(this);
            }
            resume() {
                return Promise.resolve();
            }
            close() {
                this.state = 'closed';
                return Promise.resolve();
            }
            createMediaStreamSource() {
                return makeNode();
            }
            createMediaStreamDestination() {
                return { ...makeNode(), stream: {} };
            }
        },
        AudioWorkletNode: class {
            constructor() {
                Object.assign(this, makeNode());
                this.messages = [];
                this.port = { postMessage: (message) => this.messages.push(message) };
            }
        },
        navigator: {
            mediaDevices: { getUserMedia: options.getUserMedia ?? (async () => makeStream()) },
        },
        fetch: options.fetch,
        document: {
            getElementById(id) {
                return (elements[id] ??= {
                    listeners: {},
                    addEventListener(type, listener) {
                        this.listeners[type] = listener;
                    },
                    pause() {},
                    play: options.play ?? (async () => {}),
                    attributes: {},
                    setAttribute(name, value) {
                        this.attributes[name] = value;
                    },
                    style: {},
                    classList: { add() {}, remove() {}, toggle() {} },
                    textContent: '',
                    scrollHeight: 0,
                });
            },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(source('node-processor.js') + '; globalThis.app = processor;', sandbox);
    return { app: sandbox.app, contexts, tracks, elements, makeStream };
}

function loadWorklet(sampleRate = 48000) {
    const messages = [];
    const sandbox = {
        console: quietConsole,
        sampleRate,
        AudioWorkletProcessor: class {
            constructor() {
                this.port = { postMessage: (message) => messages.push(message) };
            }
        },
        registerProcessor(name, processor) {
            sandbox.Processor = processor;
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(source('noise-suppression-processor.js'), sandbox);
    return { create: () => new sandbox.Processor(), messages };
}

test('concurrent starts create one session and stop releases its resources', async () => {
    const { app, contexts, tracks, elements } = loadApp();
    await Promise.all([app.startProcessing(), app.startProcessing()]);
    assert.equal(contexts.length, 1);
    assert.equal(tracks.length, 1);
    assert.equal(app.isProcessing, true);
    app.stopProcessing();
    assert.equal(contexts[0].state, 'closed');
    assert.equal(tracks[0].stopped, true);
    assert.equal(elements.audioElement.srcObject, null);
    assert.equal(elements.startBtn.disabled, false);
});

test('session controls expose accessible live, filter, and stopped states', async () => {
    const { app, elements } = loadApp();
    await app.startProcessing();
    assert.equal(elements.startBtn.textContent, 'Stop microphone');
    assert.equal(elements.sessionState.textContent, 'Microphone live');
    assert.equal(elements.toggleBtn.disabled, true);
    assert.equal(elements.toggleBtn.attributes['aria-checked'], 'false');
    app.messageHandler.handleMessage({ data: { type: 'wasm-ready' } });
    assert.equal(elements.toggleBtn.disabled, false);
    elements.toggleBtn.listeners.click();
    assert.equal(elements.toggleBtn.attributes['aria-checked'], 'true');
    assert.equal(elements.toggleLabel.textContent, 'On');
    assert.equal(elements.filterState.textContent, 'Noise suppression on');
    assert.equal(app.workletNode.messages[0].enabled, true);
    elements.toggleBtn.listeners.click();
    assert.equal(elements.toggleBtn.attributes['aria-checked'], 'false');
    assert.equal(elements.toggleLabel.textContent, 'Off');
    assert.equal(app.workletNode.messages[1].enabled, false);
    app.stopProcessing();
    assert.equal(elements.startBtn.textContent, 'Start microphone');
    assert.equal(elements.sessionState.textContent, 'Microphone inactive');
    assert.equal(elements.toggleBtn.disabled, true);
    assert.equal(elements.toggleBtn.attributes['aria-checked'], 'false');
    assert.equal(elements.inputVolume.style.width, '0%');
    assert.equal(elements.outputMeter.attributes['aria-valuenow'], '-60');
});

test('level meters show clamped decibels and reset after stopping', async () => {
    const { app, elements } = loadApp();
    await app.startProcessing();
    app.uiManager.updateVolumeBar('inputVolume', 0.1);
    assert.equal(elements.inputLevel.textContent, '-20 dB');
    assert.equal(elements.inputMeter.attributes['aria-valuenow'], '-20');
    app.uiManager.updateVolumeBar('outputVolume', 2);
    assert.equal(elements.outputLevel.textContent, '0 dB');
    assert.equal(elements.outputVolume.style.width, '100%');
    app.stopProcessing();
    assert.equal(elements.inputLevel.textContent, '-60 dB');
    assert.equal(elements.outputVolume.style.width, '0%');
});

test('starting state is visible while microphone permission is pending', async () => {
    const permission = deferred();
    const { app, elements } = loadApp({ getUserMedia: () => permission.promise });
    const starting = app.startProcessing();
    assert.equal(elements.startBtn.disabled, true);
    assert.equal(elements.startBtn.textContent, 'Starting microphone...');
    permission.reject(new Error('permission denied'));
    await starting;
    assert.equal(elements.startBtn.textContent, 'Start microphone');
    assert.equal(elements.startBtn.disabled, false);
    assert.equal(elements.status.className, 'status error');
    assert.match(elements.status.textContent, /permission denied/);
});

test('noise suppression waits for readiness and repeated mode selection is idempotent', async () => {
    const { app, elements } = loadApp();
    await app.startProcessing();
    app.setNoiseSuppression(true);
    assert.equal(app.noiseSuppressionEnabled, false);
    assert.equal(app.workletNode.messages.length, 0);
    app.messageHandler.handleMessage({ data: { type: 'wasm-ready' } });
    app.setNoiseSuppression(true);
    app.setNoiseSuppression(true);
    assert.equal(app.workletNode.messages.length, 1);
    assert.equal(elements.toggleLabel.textContent, 'On');
    app.setNoiseSuppression(false);
    assert.equal(elements.toggleBtn.attributes['aria-checked'], 'false');
    assert.equal(elements.toggleLabel.textContent, 'Off');
    app.stopProcessing();
    assert.equal(app.filterReady, false);
});

test('native audio preview starts automatically and stop releases its stream', async () => {
    let plays = 0;
    const { app, elements } = loadApp({
        play: async () => {
            plays++;
        },
    });
    await app.startProcessing();
    assert.equal(plays, 1);
    assert.equal(elements.audioElement.muted, false);
    assert.equal(elements.audioElement.volume, 0.5);
    assert.equal(elements.audioElement.srcObject, app.destinationNode.stream);
    assert.equal(elements.audioPreview.style.display, 'block');
    app.stopProcessing();
    assert.equal(elements.audioElement.srcObject, null);
    assert.equal(elements.audioPreview.style.display, 'none');
    await app.startProcessing();
    assert.equal(plays, 2);
    app.stopProcessing();
});

test('native audio preview playback failure leaves processing active and offers Play retry', async () => {
    const { app, elements } = loadApp({
        play: async () => {
            throw new Error('autoplay blocked');
        },
    });
    await app.startProcessing();
    await new Promise(setImmediate);
    assert.equal(app.isProcessing, true);
    assert.match(elements.status.textContent, /Press Play in the audio preview to retry/);
    assert.equal(elements.audioPreview.style.display, 'block');
    app.stopProcessing();
});

test('a late preview playback failure cannot update a restarted session', async () => {
    const playback = deferred();
    let attempts = 0;
    const { app, elements } = loadApp({ play: () => (++attempts === 1 ? playback.promise : Promise.resolve()) });
    await app.startProcessing();
    assert.equal(elements.startBtn.disabled, false);
    app.stopProcessing();
    await app.startProcessing();
    const status = elements.status.textContent;
    playback.reject(new Error('stale playback error'));
    await new Promise(setImmediate);
    assert.equal(elements.status.textContent, status);
    app.stopProcessing();
});

test('original audio passes through and reports levels before WASM is ready', () => {
    const { create, messages } = loadWorklet();
    const processor = create();
    const input = new Float32Array(128).fill(0.1);
    input[0] = 1.1;
    const output = new Float32Array(128);
    processor.process([[input]], [[output]]);
    assert.deepEqual(output, input);
    const volume = messages.find((message) => message.type === 'volume');
    assert.equal(volume.original, volume.processed);
    assert.equal(volume.original > 0, true);
});

test('activity logs speech transitions instead of every frame and stays bounded', () => {
    const { app, elements } = loadApp();
    const speech = { data: { type: 'vad', isSpeech: true, probability: 0.95 } };
    app.messageHandler.handleMessage(speech);
    app.messageHandler.handleMessage(speech);
    assert.equal(elements.status.textContent.match(/Speech detected/g).length, 1);
    app.messageHandler.handleMessage({ data: { type: 'vad', isSpeech: false } });
    app.messageHandler.handleMessage(speech);
    assert.equal(elements.status.textContent.match(/Speech detected/g).length, 2);
    app.stopProcessing();
    assert.equal(app.messageHandler.isSpeech, false);
    for (let index = 0; index < 150; index++) {
        app.uiManager.updateStatus(`Event ${index}`);
    }
    assert.equal(elements.status.textContent.split('\n').length, 100);
    assert.equal(elements.status.textContent.includes('Event 49\n'), false);
    assert.equal(elements.status.textContent.endsWith('Event 149'), true);
});

test('worklet load failure stops the microphone and closes the audio context', async () => {
    const { app, contexts, tracks, elements } = loadApp({
        addModule: async () => {
            throw new Error('module failed');
        },
    });
    await app.startProcessing();
    assert.equal(contexts[0].state, 'closed');
    assert.equal(tracks[0].stopped, true);
    assert.equal(app.isProcessing, false);
    assert.equal(app.isStarting, false);
    assert.equal(elements.startBtn.disabled, false);
});

test('microphone rejection releases the context', async () => {
    const { app, contexts } = loadApp({
        getUserMedia: async () => {
            throw new Error('permission denied');
        },
    });
    await app.startProcessing();
    assert.equal(contexts[0].state, 'closed');
    assert.equal(app.isStarting, false);
});

test('an unsupported context rate fails safely before microphone acquisition', async () => {
    const { app, contexts, tracks } = loadApp({ sampleRate: 44100 });
    await app.startProcessing();
    assert.equal(contexts[0].state, 'closed');
    assert.equal(tracks.length, 0);
    assert.equal(app.isProcessing, false);
});

test('late microphone permission from a cancelled start cannot overwrite a new session', async () => {
    const permission = deferred();
    let requests = 0;
    const environment = loadApp({
        getUserMedia: () => (++requests === 1 ? permission.promise : Promise.resolve(environment.makeStream())),
    });
    const cancelledStart = environment.app.startProcessing();
    environment.app.stopProcessing();
    await environment.app.startProcessing();
    const currentStream = environment.app.mediaStream;
    const lateStream = environment.makeStream();
    permission.resolve(lateStream);
    await cancelledStart;
    assert.equal(lateStream.getTracks()[0].stopped, true);
    assert.equal(environment.app.mediaStream, currentStream);
    assert.equal(environment.app.isProcessing, true);
    environment.app.stopProcessing();
});

test('stopping while the worklet module loads prevents a late startup', async () => {
    const moduleLoad = deferred();
    const { app, tracks, contexts } = loadApp({ addModule: () => moduleLoad.promise });
    const starting = app.startProcessing();
    await Promise.resolve();
    app.stopProcessing();
    moduleLoad.resolve();
    await starting;
    assert.equal(app.workletNode, null);
    assert.equal(app.isProcessing, false);
    assert.equal(tracks[0].stopped, true);
    assert.equal(contexts[0].state, 'closed');
});

test('a late WASM response is discarded instead of being sent to a restarted session', async () => {
    const response = deferred();
    const { app } = loadApp({ fetch: () => response.promise });
    await app.startProcessing();
    const oldWorklet = app.workletNode;
    const loading = app.wasmLoader.loadWasmBuffer(oldWorklet);
    app.stopProcessing();
    await app.startProcessing();
    response.resolve({ ok: true, text: async () => 'module content' });
    await loading;
    assert.equal(oldWorklet.messages.length, 0);
    assert.equal(app.workletNode.messages.length, 0);
    app.stopProcessing();
});

test('worklet rejects rates other than 48 kHz', () => {
    assert.throws(loadWorklet(44100).create, /48000Hz/);
});

test('actual WASM initializes once, produces finite audio, and resets on toggles', async () => {
    const { create, messages } = loadWorklet();
    const processor = create();
    const initialization = { data: { type: 'sync-module', jsContent: source('rnnoise-sync.js') } };
    await Promise.all([processor.port.onmessage(initialization), processor.port.onmessage(initialization)]);
    assert.equal(processor.initialized, true);
    assert.equal(messages.filter((message) => message.type === 'wasm-ready').length, 1);
    const manager = processor.contextManager;
    await processor.port.onmessage(initialization);
    assert.equal(processor.contextManager, manager);
    await processor.port.onmessage({ data: { type: 'enable', enabled: true } });
    const input = new Float32Array(128).fill(0.1);
    const output = new Float32Array(128);
    for (let block = 0; block < 100; block++) {
        processor.process([[input]], [[output]]);
        assert.equal(output.every(Number.isFinite), true);
    }
    await processor.port.onmessage({ data: { type: 'enable', enabled: false } });
    assert.equal(processor.frameBuffer.bufferIndex, 0);
    assert.equal(processor.frameBuffer.hasProcessed(), false);
    await processor.port.onmessage({ data: { type: 'enable', enabled: true } });
    input.fill(0.9);
    processor.process([[input]], [[output]]);
    assert.equal(output[0], input[0]);
    assert.equal(processor.frameBuffer.bufferIndex, 128);
    processor.destroy();
    assert.equal(processor.process([[input]], [[output]]), false);
});

test('context creation failure frees the allocated buffer and reports an error, not readiness', async () => {
    const { create, messages } = loadWorklet();
    const processor = create();
    let freed = false;
    processor.wasmInitializer.initSyncModule = async () => ({
        _malloc: () => 4,
        _rnnoise_create: () => 0,
        _free: () => {
            freed = true;
        },
    });
    await processor.port.onmessage({ data: { type: 'sync-module', jsContent: 'mock' } });
    assert.equal(freed, true);
    assert.equal(processor.initialized, false);
    assert.equal(
        messages.some((message) => message.type === 'wasm-ready'),
        false
    );
    assert.equal(
        messages.some((message) => message.type === 'wasm-error'),
        true
    );
});
