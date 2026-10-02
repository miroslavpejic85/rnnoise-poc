'use strict';

const RNNOISE_FRAME_SIZE = 480;
const SHIFT_16_BIT_NR = 32768;

// Handle WASM module initialization
class WasmModuleInitializer {
    constructor(messagePort) {
        this.messagePort = messagePort;
        this.Module = null;
    }

    async initSyncModule(jsContent) {
        try {
            if (!jsContent) throw new Error('Missing sync module JS content');

            const createFunction = new Function(jsContent + '; return createRNNWasmModuleSync;')();
            this.Module = await createFunction();

            if (this.Module.ready) {
                await this.Module.ready;
            }

            console.log('Sync module initialized, checking properties...');
            console.log('Module keys:', Object.keys(this.Module));
            console.log('Has HEAPF32:', !!this.Module.HEAPF32);
            console.log('Has _malloc:', typeof this.Module._malloc === 'function');
            console.log('Has _rnnoise_create:', typeof this.Module._rnnoise_create === 'function');

            return this.Module;
        } catch (error) {
            console.error('Sync module initialization error:', error);
            throw error;
        }
    }

    getModule() {
        return this.Module;
    }
}

// Handle RNNoise context and buffer management
class RNNoiseContextManager {
    constructor(module) {
        this.module = module;
        this.rnnoiseContext = null;
        this.wasmPcmInput = null;
        this.wasmPcmInputF32Index = null;
        this.setupWasm();
    }

    setupWasm() {
        this.wasmPcmInput = this.module._malloc(RNNOISE_FRAME_SIZE * 4);
        this.wasmPcmInputF32Index = this.wasmPcmInput >> 2;
        if (!this.wasmPcmInput) throw new Error('Failed to allocate WASM buffer');

        this.rnnoiseContext = this.module._rnnoise_create(0);
        if (!this.rnnoiseContext) {
            this.destroy();
            throw new Error('Failed to create RNNoise context');
        }

        console.log('WASM setup complete:', {
            wasmPcmInput: this.wasmPcmInput,
            rnnoiseContext: this.rnnoiseContext,
            heapF32Available: !!this.module.HEAPF32,
        });
    }

    processFrame(frameBuffer, processedBuffer, messagePort) {
        if (!this.rnnoiseContext || !this.module || !this.module.HEAPF32) return;

        try {
            for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
                this.module.HEAPF32[this.wasmPcmInputF32Index + i] = frameBuffer[i] * SHIFT_16_BIT_NR;
            }

            const vadScore = this.module._rnnoise_process_frame(
                this.rnnoiseContext,
                this.wasmPcmInput,
                this.wasmPcmInput
            );

            for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
                processedBuffer[i] = this.module.HEAPF32[this.wasmPcmInputF32Index + i] / SHIFT_16_BIT_NR;
            }

            messagePort.postMessage({
                type: 'vad',
                probability: vadScore,
                isSpeech: vadScore > 0.5,
            });
        } catch (error) {
            console.error('Frame processing failed:', error);
            for (let i = 0; i < RNNOISE_FRAME_SIZE; i++) {
                processedBuffer[i] = frameBuffer[i];
            }
        }
    }

    reset() {
        this.module._rnnoise_init(this.rnnoiseContext, 0);
    }

    destroy() {
        if (this.wasmPcmInput && this.module?._free) {
            this.module._free(this.wasmPcmInput);
            this.wasmPcmInput = null;
        }
        if (this.rnnoiseContext && this.module?._rnnoise_destroy) {
            this.module._rnnoise_destroy(this.rnnoiseContext);
            this.rnnoiseContext = null;
        }
    }
}

// Handle audio frame buffering
class AudioFrameBuffer {
    constructor() {
        this.frameBuffer = new Float32Array(RNNOISE_FRAME_SIZE);
        this.bufferIndex = 0;
        this.hasProcessedFrame = false;
        this.processedBuffer = new Float32Array(RNNOISE_FRAME_SIZE);
        this.processedIndex = 0;
    }

    reset() {
        this.frameBuffer.fill(0);
        this.processedBuffer.fill(0);
        this.bufferIndex = 0;
        this.hasProcessedFrame = false;
        this.processedIndex = 0;
    }

    addSample(sample) {
        this.frameBuffer[this.bufferIndex++] = sample;
        return this.bufferIndex === RNNOISE_FRAME_SIZE;
    }

    resetBuffer() {
        this.bufferIndex = 0;
        this.hasProcessedFrame = true;
        this.processedIndex = 0;
    }

    getProcessedSample() {
        return this.processedBuffer[this.processedIndex++];
    }

    getFrameBuffer() {
        return this.frameBuffer;
    }

    getProcessedBuffer() {
        return this.processedBuffer;
    }

    hasProcessed() {
        return this.hasProcessedFrame;
    }
}

// Handle only volume analysis
class VolumeAnalyzer {
    calculateVolume(input, output, messagePort) {
        const originalVolume = Math.sqrt(input.reduce((sum, v) => sum + v * v, 0) / input.length);
        const processedVolume = Math.sqrt(output.reduce((sum, v) => sum + v * v, 0) / output.length);

        messagePort.postMessage({
            type: 'volume',
            original: originalVolume,
            processed: processedVolume,
        });
    }
}

// Handle UI updates and interactions
class RNNoiseProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.initialized = false;
        this.initializing = false;
        this.enabled = false;
        this._destroyed = false;
        this.sampleRate = sampleRate;
        if (this.sampleRate !== 48000) throw new Error('RNNoise requires a 48000Hz audio context');

        console.log('AudioWorklet processor initialized with sample rate:', this.sampleRate);

        this.wasmInitializer = new WasmModuleInitializer(this.port);
        this.contextManager = null;
        this.frameBuffer = new AudioFrameBuffer();
        this.volumeAnalyzer = new VolumeAnalyzer();

        this.setupMessageHandler();
        this.port.postMessage({ type: 'request-wasm' });
    }

    setupMessageHandler() {
        this.port.onmessage = async (event) => {
            if (this._destroyed) return;
            const { type, jsContent, enabled } = event.data;
            switch (type) {
                case 'sync-module':
                    if (this.initialized || this.initializing) return;
                    this.initializing = true;
                    try {
                        const module = await this.wasmInitializer.initSyncModule(jsContent);
                        if (this._destroyed) return;
                        this.contextManager = new RNNoiseContextManager(module);
                        this.initialized = true;
                        this.port.postMessage({ type: 'wasm-ready' });
                    } catch (error) {
                        console.error('Failed to initialize sync module:', error);
                        this.port.postMessage({ type: 'wasm-error', error: error.message });
                    } finally {
                        this.initializing = false;
                    }
                    break;
                case 'enable':
                    if (this.enabled !== Boolean(enabled)) {
                        this.frameBuffer.reset();
                        this.contextManager?.reset();
                        this.enabled = Boolean(enabled);
                    }
                    break;
            }
        };
    }

    process(inputs, outputs, parameters) {
        if (this._destroyed) return false;
        const input = inputs[0]?.[0];
        const output = outputs[0]?.[0];
        if (!input || !output) return true;

        if (!this.initialized || !this.enabled) {
            output.set(input);
            this.volumeAnalyzer.calculateVolume(input, output, this.port);
            return true;
        }

        for (let i = 0; i < input.length; i++) {
            const isFrameReady = this.frameBuffer.addSample(input[i]);

            if (isFrameReady) {
                this.contextManager.processFrame(
                    this.frameBuffer.getFrameBuffer(),
                    this.frameBuffer.getProcessedBuffer(),
                    this.port
                );
                this.frameBuffer.resetBuffer();
            }

            output[i] = this.frameBuffer.hasProcessed() ? this.frameBuffer.getProcessedSample() : input[i];
        }

        this.volumeAnalyzer.calculateVolume(input, output, this.port);
        return true;
    }

    destroy() {
        if (this._destroyed) return;

        if (this.contextManager) {
            this.contextManager.destroy();
            this.contextManager = null;
        }

        this._destroyed = true;
    }
}

// Register the processor with the AudioWorklet global scope
registerProcessor('noise-suppression-processor', RNNoiseProcessor);
