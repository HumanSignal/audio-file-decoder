# @humansignal/audio-file-decoder

[![npm version](https://img.shields.io/npm/v/@humansignal/audio-file-decoder.svg)](https://npmjs.org/package/@humansignal/audio-file-decoder "View this project on npm")

A high-performance library for decoding audio files and timestamp ranges in browser environments. Powered by FFmpeg and compiled to WebAssembly via Emscripten.

---

## Key Features

- **Standard Decoding**: Decodes entire audio files or specific timestamp ranges synchronously or asynchronously (via Web Workers).
- **Streaming Mode**: Built to handle extremely large audio files (e.g., >24 hours) by dynamically requesting byte ranges over the network without buffering the entire file in memory.
- **2MB Range Cache**: Minimizes network overhead in streaming mode by batch-fetching 2MB chunks and satisfying subsequent decodes from memory.
- **PTS-Aligned Sample Accuracy**: Leverages frame Presentation Timestamps (PTS) to guarantee sample-accurate waveform alignment, automatically padding gaps or discarding offsets.
- **Multi-Channel Support**: Supports returning interleaved multi-channel samples or auto-downmixing to mono.
- **Dynamic URL Refreshing**: Automatically handles expiring presigned URLs (e.g., AWS S3, GCS) by allowing hot-swapping of the stream URL in-flight without interrupting active decoders.
- **Production Optimized**: Statically built with Emscripten `-O3` and `-DNDEBUG` optimizations to suppress debug prints and reduce the worker bundle size by **30%**.

---

## Supported Formats

- **MP3** (via `libmp3lame`)
- **WAV** (PCM 8/16/24/32-bit, Float 32-bit)
- **FLAC**
- **AAC / M4A**
- **OGG / Vorbis / Opus** (via `libopus`)

---

## Installation

```bash
npm install @humansignal/audio-file-decoder
```

---

## Usage / API

### 1. Standard Synchronous Decoder
Loads the entire file array buffer into WebAssembly memory. Useful for quick synchronous operations on smaller files.

```ts
import { getAudioDecoder } from '@humansignal/audio-file-decoder';
import decodeWasmUrl from '@humansignal/audio-file-decoder/decode-audio.wasm?url';

const fileOrArrayBuffer = await fetch('audio.mp3').then(r => r.arrayBuffer());

const decoder = await getAudioDecoder(decodeWasmUrl, fileOrArrayBuffer);

console.log({
  sampleRate: decoder.sampleRate,
  channelCount: decoder.channelCount,
  encoding: decoder.encoding,
  duration: decoder.duration // In seconds
});

// Decode the first 10 seconds (returns interleaved Float32Array)
const samples = decoder.decodeAudioData(0, 10, { multiChannel: true });

// Always dispose to free WASM heap resources
decoder.dispose();
```

---

### 2. Asynchronous Worker Decoder (Standard)
Runs the decoder inside a background Web Worker, keeping the main UI thread completely responsive.

```ts
import { getAudioDecoderWorker } from '@humansignal/audio-file-decoder';
import decodeWasmUrl from '@humansignal/audio-file-decoder/decode-audio.wasm?url';

const worker = await getAudioDecoderWorker(decodeWasmUrl, audioFileBlob, { stream: false });

// Decode a 30-second range asynchronously
const samples = await worker.decodeAudioData(60, 30, { multiChannel: false });

worker.dispose();
```

---

### 3. Asynchronous Worker Decoder (Streaming Mode)
Enables streaming chunk retrieval for large files. Instead of loading the full file, it uses HTTP `Range` requests in the worker.

```ts
import { getAudioDecoderWorker } from '@humansignal/audio-file-decoder';
import decodeWasmUrl from '@humansignal/audio-file-decoder/decode-audio.wasm?url';

// Passes a URL instead of a file/buffer to automatically enable streaming
const worker = await getAudioDecoderWorker(decodeWasmUrl, 'https://example.com/long-podcast.mp3', {
  stream: true
});

// Decodes a slice. The worker only downloads the bytes needed for this range.
const samples = await worker.decodeAudioData(3600, 10);
```

---

### 4. Dynamic URL Refreshing (Presigned URL Expiration)
When loading files from S3 or proxy redirectors, signed URLs expire. The worker will propagate an `HTTP_STATUS_403` or `HTTP_STATUS_401` error which can be caught in the main thread to refresh the URL dynamically.

```ts
import { getAudioDecoderWorker } from '@humansignal/audio-file-decoder';
import decodeWasmUrl from '@humansignal/audio-file-decoder/decode-audio.wasm?url';

const originalUrl = '/api/media/redirect-to-s3';

const worker = await getAudioDecoderWorker(decodeWasmUrl, originalUrl, { stream: true });

async function safeDecode(start: number, duration: number) {
  try {
    return await worker.decodeAudioData(start, duration);
  } catch (err: any) {
    const isExpired = err?.message?.includes("HTTP_STATUS_403") || err?.message?.includes("HTTP_STATUS_401");
    
    if (isExpired) {
      console.warn("Presigned URL expired. Refreshing...");
      
      // Fetch the redirect URL again to get a fresh presigned URL
      const response = await fetch(originalUrl);
      if (response.body) {
        response.body.cancel().catch(() => {});
      }
      const freshPresignedUrl = response.url;
      
      // Push the fresh URL to the worker in-place
      worker.updateUrl(freshPresignedUrl);
      
      // Retry the decode request
      return await worker.decodeAudioData(start, duration);
    }
    throw err;
  }
}
```

---

## Configuration Options

### `DecodeAudioOptions`
Passed to `decodeAudioData`:
```ts
interface DecodeAudioOptions {
  // Whether to preserve multiple channels.
  // - If true: returns interleaved samples: [L0, R0, L1, R1, ...]
  // - If false (default): downmixes to mono by averaging all channel samples
  multiChannel?: boolean;
}
```

### `WasmAudioStreamConfig`
Can be passed to `getAudioDecoderWorker` as the source parameter instead of a string to provide advanced details:
```ts
interface WasmAudioStreamConfig {
  url?: string;         // The stream URL
  originalUrl?: string; // The redirect anchor URL (if refreshing)
  fileOrBlob?: Blob;    // Local file handle (falls back to local FileReaderSync streaming)
  size: number;         // Total size of the file in bytes (avoids initial fetch)
}
```

---

## Bundler Integration

### Vite
Import the WASM file with the `?url` query suffix:
```ts
import decodeWasmUrl from '@humansignal/audio-file-decoder/decode-audio.wasm?url';
```

### Webpack 5
Enable WebAssembly experiments in your `webpack.config.js`:
```js
module.exports = {
  experiments: {
    asyncWebAssembly: true,
  },
  module: {
    rules: [
      {
        test: /\.wasm$/,
        type: 'asset/resource',
      }
    ]
  }
};
```

---

## Local Development & Contribution

### 1. Build Requirements
- Docker (recommended for containerized building)
- Or, local Emscripten SDK (v2.0.1) and PKG_CONFIG dependencies.

### 2. Building WASM & JS
To compile the C++ FFmpeg code and package the Javascript bundles:

```bash
# Build the WebAssembly binaries and JS bundles inside Docker (handles Emscripten)
./docker-build.sh quick

# Extract the compiled artifacts to the local ./dist folder
./docker-build.sh artifacts
```

### 3. Local Development Integration (`bun link` / `npm link`)
To test edits instantly in a local consuming project (e.g. `hs-platform`) without manually copying files:

1. Register this package globally:
   ```bash
   # Inside /code/audio-file-decoder
   bun link
   ```
2. Link it in your consumer project:
   ```bash
   # Inside the web app folder of your project
   bun link @humansignal/audio-file-decoder
   ```
3. Now, whenever you run `./docker-build.sh quick`, the changes will immediately reflect in the consumer app.

### 4. Build Configuration (Debug vs. Release)
By default, builds compile in optimized **Release** mode (`-O3 -DNDEBUG`), removing debug symbols and removing console log overhead.

If you need to debug the C++ core or Web Worker:
```bash
# Compile a debug build with -g and -O0
DEBUG=1 ./docker-build.sh quick
```

---

## License
Licensed under LGPL v2.1 or later. See the [LICENSE](./LICENSE) file for details.