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

1. `Click Start Audio Processing`
2. `Toggle RNNoise` to enable/disable noise suppression
3. `Monitor` volume bars and status

## Requirements

- [Node.js (Download)](https://nodejs.org/en/download/)
- Modern browser with AudioWorklet support
- Microphone permission
- HTTPS or localhost
