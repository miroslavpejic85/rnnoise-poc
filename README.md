# RNNoise Audio Noise Suppression POC

![noise](./src/assets/noise.png)

Real-time audio noise suppression using RNNoise WebAssembly and AudioWorklet.

Based on: https://github.com/xiph/rnnoise

## Quick Start

```bash
npm install
npm start
```

Open http://localhost:8888

## Usage

1. Use headphones to avoid microphone feedback, then select **Start microphone** and allow microphone access.
2. Audio preview starts automatically. If the browser blocks playback, press **Play** in the preview.
3. The filter starts off. Turn the **RNNoise filter** switch on once it is ready to suppress background noise, or off to hear unfiltered audio.
4. Monitor input/output levels (dBFS) and status. Use the audio preview's native playback and volume controls.
5. Select **Stop microphone** to release the microphone and end the session.

## Requirements

- [Node.js (Download)](https://nodejs.org/en/download/)
- Modern browser with AudioWorklet support
- Microphone permission
- HTTPS or localhost
