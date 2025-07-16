'use strict';

// Handle UI updates and interactions
class UIManager {
    constructor(elements) {
        this.elements = elements;
    }

    updateStatus(message, type = 'info') {
        const timestamp = new Date().toLocaleTimeString();

        if (!this.elements.status) {
            console.log(`[${timestamp}] ${message}`);
            return;
        }

        this.elements.status.textContent += `\n[${timestamp}] ${message}`;
        this.elements.status.className = `status ${type}`;
        this.elements.status.scrollTop = this.elements.status.scrollHeight;
    }

    updateUI(isProcessing, noiseSuppressionEnabled) {
        this.elements.startBtn.textContent = isProcessing ? '🛑 Stop Processing' : '🎤 Start Audio Processing';
        this.elements.toggleBtn.disabled = !isProcessing;

        if (noiseSuppressionEnabled) {
            this.elements.toggleBtn.textContent = '🔊 RNNoise: ON';
            this.elements.toggleBtn.classList.add('active');
        } else {
            this.elements.toggleBtn.textContent = '🔇 RNNoise: OFF';
            this.elements.toggleBtn.classList.remove('active');
        }
    }

    updateVolumeBar(elementId, volume) {
        const bar = document.getElementById(elementId);
        if (bar) {
            const minDb = -60;
            const maxDb = 0;
            const db = 20 * Math.log10(Math.max(volume, 1e-6));
            const normalized = Math.max(0, Math.min(1, (db - minDb) / (maxDb - minDb)));
            const percentage = normalized * 100;
            bar.style.width = `${percentage}%`;
        }
    }

    showAudioPreview(stream) {
        this.elements.audioElement.srcObject = stream;
        this.elements.audioElement.volume = 0.5;
        this.elements.audioPreview.style.display = 'block';
    }

    hideAudioPreview() {
        this.elements.audioPreview.style.display = 'none';
    }
}

// Handle audio worklet message processing
class MessageHandler {
    constructor(uiManager, wasmLoader) {
        this.uiManager = uiManager;
        this.wasmLoader = wasmLoader;
    }

    handleMessage(event) {
        if (event.data.type === 'request-wasm') {
            this.wasmLoader.loadWasmBuffer();
        } else if (event.data.type === 'wasm-ready') {
            this.uiManager.updateStatus('✅ RNNoise WASM initialized successfully', 'success');
        } else if (event.data.type === 'wasm-error') {
            this.uiManager.updateStatus('❌ RNNoise WASM error: ' + event.data.error, 'error');
        } else if (event.data.type === 'vad') {
            if (event.data.isSpeech) {
                this.uiManager.updateStatus(`🗣️ Speech detected (VAD: ${event.data.probability.toFixed(2)})`, 'info');
            }
        } else if (event.data.type === 'volume') {
            this.uiManager.updateVolumeBar('inputVolume', event.data.original);
            this.uiManager.updateVolumeBar('outputVolume', event.data.processed);
        }
    }
}

// Handle WASM module loading
class WasmLoader {
    constructor(uiManager, getWorkletNode) {
        this.uiManager = uiManager;
        this.getWorkletNode = getWorkletNode;
    }

    async loadWasmBuffer() {
        try {
            this.uiManager.updateStatus('📦 Loading RNNoise sync module...', 'info');

            const jsResponse = await fetch('../js/rnnoise-sync.js');

            if (!jsResponse.ok) {
                throw new Error('Failed to load rnnoise-sync.js');
            }

            const jsContent = await jsResponse.text();
            this.uiManager.updateStatus('📦 Sending sync module to worklet...', 'info');

            this.getWorkletNode().port.postMessage({
                type: 'sync-module',
                jsContent: jsContent,
            });

            this.uiManager.updateStatus('📦 Sync module sent to worklet', 'info');
        } catch (error) {
            this.uiManager.updateStatus('❌ Failed to load sync module: ' + error.message, 'error');
            console.error('Sync module loading error:', error);
        }
    }
}

// Main class to handle audio processing and UI interactions
class RNNoiseProcessor {
    constructor() {
        this.audioContext = null;
        this.workletNode = null;
        this.mediaStream = null;
        this.sourceNode = null;
        this.destinationNode = null;
        this.isProcessing = false;
        this.noiseSuppressionEnabled = false;

        this.initializeUI();
        this.initializeDependencies();
    }

    initializeUI() {
        this.elements = {
            startBtn: document.getElementById('startBtn'),
            toggleBtn: document.getElementById('toggleBtn'),
            status: document.getElementById('status'),
            audioPreview: document.getElementById('audioPreview'),
            audioElement: document.getElementById('audioElement'),
        };

        this.elements.startBtn.addEventListener('click', () => this.toggleProcessing());
        this.elements.toggleBtn.addEventListener('click', () => this.toggleNoiseSuppression());
    }

    initializeDependencies() {
        this.uiManager = new UIManager(this.elements);
        this.wasmLoader = new WasmLoader(this.uiManager, () => this.workletNode);
        this.messageHandler = new MessageHandler(this.uiManager, this.wasmLoader);
    }

    async toggleProcessing() {
        if (this.isProcessing) {
            this.stopProcessing();
        } else {
            await this.startProcessing();
        }
    }

    async startProcessing() {
        try {
            this.uiManager.updateStatus('🎤 Starting audio processing...', 'info');

            this.audioContext = new AudioContext();
            const sampleRate = this.audioContext.sampleRate;
            this.uiManager.updateStatus(`🎵 Audio context created with sample rate: ${sampleRate}Hz`, 'info');

            this.mediaStream = await navigator.mediaDevices.getUserMedia({ audio: true });

            await this.audioContext.audioWorklet.addModule('../js/noise-suppression-processor.js');

            this.workletNode = new AudioWorkletNode(this.audioContext, 'noise-suppression-processor', {
                numberOfInputs: 1,
                numberOfOutputs: 1,
                outputChannelCount: [1],
            });

            this.workletNode.port.onmessage = (event) => this.messageHandler.handleMessage(event);

            this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);
            this.destinationNode = this.audioContext.createMediaStreamDestination();

            this.sourceNode.connect(this.workletNode);
            this.workletNode.connect(this.destinationNode);

            this.uiManager.showAudioPreview(this.destinationNode.stream);

            this.isProcessing = true;
            this.uiManager.updateUI(this.isProcessing, this.noiseSuppressionEnabled);
            this.uiManager.updateStatus('🎤 Audio processing started', 'success');
        } catch (error) {
            this.uiManager.updateStatus('❌ Error: ' + error.message, 'error');
        }
    }

    stopProcessing() {
        if (this.mediaStream) {
            this.mediaStream.getTracks().forEach((track) => track.stop());
            this.mediaStream = null;
        }

        if (this.audioContext && this.audioContext.state !== 'closed') {
            this.audioContext.close();
            this.audioContext = null;
        }

        this.workletNode = null;
        this.sourceNode = null;
        this.destinationNode = null;
        this.isProcessing = false;
        this.noiseSuppressionEnabled = false;

        this.uiManager.updateUI(this.isProcessing, this.noiseSuppressionEnabled);
        this.uiManager.hideAudioPreview();
        this.uiManager.updateStatus('🛑 Audio processing stopped', 'info');
    }

    toggleNoiseSuppression() {
        this.noiseSuppressionEnabled = !this.noiseSuppressionEnabled;

        if (this.workletNode) {
            this.workletNode.port.postMessage({
                type: 'enable',
                enabled: this.noiseSuppressionEnabled,
            });
        }

        this.noiseSuppressionEnabled
            ? this.uiManager.updateStatus('🔊 RNNoise enabled - background noise will be suppressed', 'success')
            : this.uiManager.updateStatus('🔇 RNNoise disabled - audio passes through unchanged', 'info');

        if (!this.noiseSuppressionEnabled) {
            this.uiManager.updateVolumeBar('inputVolume', 0);
            this.uiManager.updateVolumeBar('outputVolume', 0);
        }

        this.uiManager.updateUI(this.isProcessing, this.noiseSuppressionEnabled);
    }
}

// Initialize the application
const processor = new RNNoiseProcessor();
