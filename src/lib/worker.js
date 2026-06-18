const _decoder_memfs_path = "audio";
let _decoder = undefined;
let _streamContext = null;

class WasmAudioStreamReader {
  constructor(config) {
    this.url = config.url;
    this.fileOrBlob = config.fileOrBlob;
    this.size = config.size;
    this.position = 0;
    
    if (this.fileOrBlob) {
      this.readerSync = new FileReaderSync();
    }
  }

  getSize() {
    return this.size;
  }

  seek(offset, whence) {
    let newPosition = this.position;
    if (whence === 0) {
      newPosition = offset;
    } else if (whence === 1) {
      newPosition = this.position + offset;
    } else if (whence === 2) {
      newPosition = this.size + offset;
    }
    
    if (newPosition < 0) newPosition = 0;
    if (newPosition > this.size) newPosition = this.size;
    
    this.position = newPosition;
    return this.position;
  }

  readSync(bufSize) {
    if (this.position >= this.size) {
      return null;
    }
    
    const bytesToRead = Math.min(bufSize, this.size - this.position);
    if (bytesToRead <= 0) {
      return null;
    }
    
    let chunk;
    if (this.fileOrBlob) {
      const slice = this.fileOrBlob.slice(this.position, this.position + bytesToRead);
      try {
        const arrayBuffer = this.readerSync.readAsArrayBuffer(slice);
        chunk = new Uint8Array(arrayBuffer);
      } catch (err) {
        console.error("FileReaderSync error:", err);
        return null;
      }
    } else if (this.url) {
      const xhr = new XMLHttpRequest();
      xhr.open("GET", this.url, false);
      xhr.responseType = "arraybuffer";
      
      const start = this.position;
      const end = this.position + bytesToRead - 1;
      xhr.setRequestHeader("Range", `bytes=${start}-${end}`);
      
      try {
        xhr.send();
        if (xhr.status === 200 || xhr.status === 206) {
          let responseBytes = new Uint8Array(xhr.response);
          if (xhr.status === 200) {
            chunk = responseBytes.subarray(this.position, this.position + bytesToRead);
          } else {
            chunk = responseBytes;
          }
        } else {
          console.error(`Sync XHR failed with status ${xhr.status}`);
          return null;
        }
      } catch (err) {
        console.error("Sync XHR error:", err);
        return null;
      }
    }
    
    if (chunk) {
      this.position += chunk.length;
    }
    return chunk;
  }
}

function throwError(type, error) {
  throw new Error(`${type}: ${error}`);
}

function initializeDecoder(messageType, wasm, fileData, streamConfig) {
  if (_decoder) {
    throwError(messageType, "decoder is already initialized");
  }
  return Module({ locateFile: () => wasm }).then((m) => {
    _decoder = m;
    
    let path;
    if (streamConfig) {
      const reader = new WasmAudioStreamReader(streamConfig);
      const opaque = _decoder.createStreamContext();
      
      globalThis.wasmAudioStreams = globalThis.wasmAudioStreams || new Map();
      globalThis.wasmAudioStreams.set(opaque, reader);
      _streamContext = opaque;
      
      path = `stream:${opaque}`;
    } else {
      _decoder.FS.writeFile(_decoder_memfs_path, new Int8Array(fileData));
      path = _decoder_memfs_path;
    }
    
    const {
      status: { status, error },
      sampleRate,
      channelCount,
      encoding,
      duration,
    } = _decoder.getProperties(path);
    
    if (status < 0) {
      if (streamConfig) {
        globalThis.wasmAudioStreams.delete(_streamContext);
        _decoder.destroyStreamContext(_streamContext);
        _streamContext = null;
      } else {
        _decoder.FS.unlink(_decoder_memfs_path);
      }
      throwError(messageType, error);
    }
    return {
      sampleRate,
      channelCount,
      encoding,
      duration,
    };
  });
}

function decodeAudio(messageType, start = 0, duration = -1, options = {}) {
  if (!_decoder) {
    throwError(messageType, "decoder is not initialized");
  }
  const decodeOptions = {
    multiChannel: options.multiChannel ?? false,
  };
  const path = _streamContext ? `stream:${_streamContext}` : _decoder_memfs_path;
  const {
    status: { status, error },
    samples: vector,
  } = _decoder.decodeAudio(path, start, duration, decodeOptions);
  if (status < 0) {
    vector.delete();
    throw `decodeAudioData error: ${error}`;
  }
  const samples = new Float32Array(vector.size());
  for (let i = 0; i < samples.length; i++) {
    samples[i] = vector.get(i);
  }
  vector.delete();
  return samples;
}

onmessage = function (e) {
  const { type } = e.data;
  switch (type) {
    case "initialize": {
      const { wasm, fileData, streamConfig } = e.data;
      initializeDecoder(type, wasm, fileData, streamConfig)
        .then(({ sampleRate, channelCount, encoding, duration }) =>
          postMessage({ type, sampleRate, channelCount, encoding, duration })
        )
        .catch((err) => postMessage({ type: "initializeError", error: err }));
      break;
    }
    case "decode": {
      const { id, start, duration, options } = e.data;
      try {
        const samples = decodeAudio(type, start, duration, options);
        postMessage({ type, id, samples: samples.buffer }, [samples.buffer]);
      } catch (err) {
        postMessage({ type: "decodeError", id, error: err });
      }
      break;
    }
    case "dispose":
      if (_decoder) {
        if (_streamContext) {
          globalThis.wasmAudioStreams.delete(_streamContext);
          _decoder.destroyStreamContext(_streamContext);
          _streamContext = null;
        } else {
          _decoder.FS.unlink(_decoder_memfs_path);
        }
      }
      break;
    default:
      throwError(type, "unsupported decoder operation");
      break;
  }
};
