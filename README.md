# audio-file-decoder
[![npm version](https://img.shields.io/npm/v/audio-file-decoder.svg)](https://npmjs.org/package/audio-file-decoder "View this project on npm")

## About
A library for decoding audio files, including support for decoding specific timestamp ranges within files. Written with FFmpeg and compiled to WebAssembly via Emscripten. Intended for use in browser environments only.

The following audio file formats are supported:
* MP3
* WAV
* FLAC
* AAC/M4A
* OGG

### Why?
[WebAudio](https://developer.mozilla.org/en-US/docs/Web/API/BaseAudioContext/decodeAudioData) currently provides `decodeAudioData` as a means to access raw samples from audio files in a faster than realtime manner. It only supports decoding entire audio files however which can take *huge* amounts of memory. For example, a 10 minute audio file with a sample rate of 44100 Hz, floating point samples, and stereo channels will occupy 44100 Hz * 600 seconds * 4 bytes * 2 channels = ~212 MB of memory when decoded.

The [WebCodecs](https://github.com/WICG/web-codecs) proposal is planning to address this oversight (see [here](https://github.com/WICG/web-codecs/issues/28) for more info) but until adoption by browsers this can be used as a more memory-friendly alternative to WebAudio's current implementation.

### Caveats/Notes
* Files still need be stored in memory for access since the filesystem is sandboxed.
* Multiple channels are automatically downmixed into a single channel via sample averaging. Decoded audio is also **NOT** resampled, whereas `decodeAudioData` will automatically resample to the sample rate of its `AudioContext`.
* Sample position accuracy may be slightly off when decoding timestamp ranges due to timestamp precision and how FFmpeg's seek behaves. FFmpeg tries to seek to the closest frame possible for timestamps which may introduce an error of a few frames, where each frame contains a fixed (e.g 1024 samples) or dynamic number of samples depending on the audio file encoding.
* Performance is about ~2x slower than Chromium's implementation of `decodeAudioData`. Chromium's implementation also uses FFmpeg for decoding, but is able to run natively with threading and native optimizations enabled, while this library has them disabled for WebAssembly compatibility.

## Usage / API
### Getting Started
```bash
npm install --save audio-file-decoder
```

### Synchronous Decoding
An example of synchronous audio file decoding in ES6:
```ts
import { getAudioDecoder } from 'audio-file-decoder';
import DecodeAudioWasm from 'audio-file-decoder/decode-audio.wasm'; // path to wasm asset

// either a File object or an ArrayBuffer representing the audio file
const fileOrArrayBuffer = ...;

getAudioDecoder(DecodeAudioWasm, fileOrArrayBuffer)
  .then(decoder => {
    const sampleRate = decoder.sampleRate; // the sample rate of the audio file (e.g 44100)
    const channelCount = decoder.channelCount; // the number of channels in the audio file (e.g 2 if stereo)
    const encoding = decoder.encoding; // the encoding of the audio file as a string (e.g pcm_s16le)
    const duration = decoder.duration; // the duration of the audio file in seconds (e.g 5.43)

    // samples are returned as a Float32Array
    let samples;

    // decode entire audio file
    samples = decoder.decodeAudioData();

    // decode from 5.5 seconds to the end of the file
    samples = decoder.decodeAudioData(5.5, -1);

    // decode from 30 seconds for a duration of 60 seconds
    samples = decoder.decodeAudioData(30, 60);

    // decode with options
    const options: DecodeAudioOptions = {
      multiChannel: true,
    };
    samples = decoder.decodeAudioData(0, -1, options);

    // ALWAYS dispose once finished to free resources
    decoder.dispose();
  });
```

### Asynchronous Decoding
An example of asynchronous audio file decoding in ES6:
```ts
import { getAudioDecoderWorker } from 'audio-file-decoder';
import DecodeAudioWasm from 'audio-file-decoder/decode-audio.wasm'; // path to wasm asset

// either a File object or an ArrayBuffer representing the audio file
const fileOrArrayBuffer = ...;

let audioDecoder;
getAudioDecoderWorker(DecodeAudioWasm, fileOrArrayBuffer)
  .then(decoder => {
    const sampleRate = decoder.sampleRate; // the sample rate of the audio file (e.g 44100)
    const channelCount = decoder.channelCount; // the number of channels in the audio file (e.g 2 if stereo)
    const encoding = decoder.encoding; // the encoding of the audio file as a string (e.g pcm_s16le)
    const duration = decoder.duration; // the duration of the audio file in seconds (e.g 5.43)

    audioDecoder = decoder;

    const options: DecodeAudioOptions = {
      multiChannel: false,
    };

    // decode from 15 seconds for a duration of 45 seconds, with options
    return decoder.getAudioData(15, 45, options);
  })
  .then(samples => {
    // samples are returned as a Float32Array
    console.log(samples);

    // ALWAYS dispose once finished to free resources
    audioDecoder.dispose();
  });
```

### Additional Options
You can pass additional options when decoding audio data. Currently supported options are listed below:
```ts
interface DecodeAudioOptions {
  // whether to decode multiple channels. defaults to false.
  // if set to true, the resulting array will contain samples interleaved from each channel.
  // - using the channel count, samples can be accessed using samples[sample * channelCount + channel]
  // if set to false, the resulting will contain downmixed samples averaged from each channel.
  // - samples can be accessed using samples[sample]
  multiChannel?: boolean;
}
```

### Importing WASM Assets

The `getAudioDecoder` and `getAudioDecoderWorker` factory functions expect a path to the WASM file. The package includes the WASM file at `audio-file-decoder/decode-audio.wasm` which can be imported directly.

#### Modern Bundlers (Vite, Webpack 5+, etc.)

With modern bundlers that support WASM imports, you can import the WASM file directly:

```ts
import { getAudioDecoder, getAudioDecoderWorker } from 'audio-file-decoder';
import DecodeAudioWasm from 'audio-file-decoder/decode-audio.wasm';

// The bundler will handle the WASM file automatically
getAudioDecoder(DecodeAudioWasm, myAudioFile);
getAudioDecoderWorker(DecodeAudioWasm, myAudioFile);
```

**Vite:** Works out of the box with `?url` suffix:
```ts
import DecodeAudioWasm from 'audio-file-decoder/decode-audio.wasm?url';
```

**Webpack 5+:** Configure in `webpack.config.js`:
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

#### Manual Copy (No Bundler)

If not using a bundler, copy the WASM file from the package to your public directory:

```bash
# The WASM file is located at:
cp node_modules/audio-file-decoder/dist/decode-audio.wasm public/

# Your app structure:
public/
  index.html
  decode-audio.wasm
```

Then pass the relative path:
```ts
import { getAudioDecoder } from 'audio-file-decoder';

// Pass the relative path from your app's origin
getAudioDecoder('/decode-audio.wasm', myAudioFile);
```

## Building
The build steps below have been tested on Ubuntu 20.04.1 LTS.

First clone the repo, then navigate to the repo directory and run the following commands:
```bash
# install necessary build tools
sudo apt-get update -qq
sudo apt-get install -y autoconf automake build-essential cmake git pkg-config wget libtool

# grab emscripten sdk which is needed to compile ffmpeg
# built with emsdk 3.0.0 (upgrade at your own risk!)
git clone https://github.com/emscripten-core/emsdk.git
./emsdk/emsdk install 3.0.0
./emsdk/emsdk activate 3.0.0

# set emscripten environment variables
# this needs to be invoked when you start a new terminal
source ./emsdk/emsdk_env.sh

# install npm deps, sync/download ffmpeg + deps, then build ffmpeg
# will only need to be run once unless you plan on making changes to how ffmpeg/dependencies are compiled
npm install && npm run sync && npm run build-deps

# build the wasm module and the library
# basic workflow when making changes to the wasm module/js library
npm run build-wasm && npm run build
```

Commands for the WebAssembly module, which can be useful if modifying or extending the C++ wrapper around FFmpeg:
```bash
# build the WebAssembly module - output is located at src/wasm
npm run build-wasm

# removes the wasm output
npm run clean-wasm
```

Commands for FFmpeg and dependencies, which can be useful if modifying the compilation of FFmpeg and its dependencies:
```bash
# downloads FFmpeg and its dependencies - output is located at deps/src
npm run sync

# removes FFmpeg and its dependencies 
npm run unsync

# builds FFmpeg and its dependencies - output is located at deps/dist/ffmpeg
npm run build-deps

# cleans the FFmpeg dist output
npm run clean-deps
```

## Contributing
Contributions are welcome! Feel free to submit issues or PRs for any bugs or feature requests.

## License
Licensed under LGPL v2.1 or later. See the [license file](./LICENSE) for more info.