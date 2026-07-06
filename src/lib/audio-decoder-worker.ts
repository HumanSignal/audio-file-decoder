// @ts-ignore
import DecodeAudioWorker from "web-worker:../wasm/decode-audio-worker";
import { DecodeAudioOptions, WasmAudioStreamConfig } from "./types";
import { readBuffer } from "./utils";

enum AudioDecoderMessageType {
  Initialize = "initialize",
  InitializeError = "initializeError",
  Decode = "decode",
  DecodeError = "decodeError",
  Dispose = "dispose",
}

function dataURIToBlob(dataURI: string): Blob {
  const parts = dataURI.split(",");
  const header = parts[0];
  const data = parts[1];
  const mimeString = header.split(":")[1].split(";")[0];

  let byteString;
  if (header.indexOf("base64") >= 0) {
    byteString = atob(data);
  } else {
    byteString = decodeURIComponent(data);
  }

  const ab = new ArrayBuffer(byteString.length);
  const ia = new Uint8Array(ab);
  for (let i = 0; i < byteString.length; i++) {
    ia[i] = byteString.charCodeAt(i);
  }
  return new Blob([ab], { type: mimeString });
}

function getUrlContentLength(url: string): Promise<{ size: number; finalUrl: string }> {
  // Try fetching with Range: bytes=0-0 first to optimize bandwidth
  return fetch(url, {
    headers: {
      Range: "bytes=0-0",
    },
  }).then((response) => {
    if (!response.ok) {
      throw new Error(`GET request failed with status: ${response.status}`);
    }
    const contentRange = response.headers.get("content-range");
    const len = response.headers.get("content-length");
    let size = 0;

    if (contentRange) {
      const match = contentRange.match(/\/(\d+)$/);
      if (match) {
        size = parseInt(match[1], 10);
      }
    }

    if (size <= 0 && len) {
      size = parseInt(len, 10);
    }
    
    // Cancel the body stream immediately to prevent downloading the file content
    if (response.body) {
      response.body.cancel().catch(() => {
        // ignore errors on cancel
      });
    }
    
    if (size > 1) {
      return { size, finalUrl: response.url };
    }

    // Fallback: If Content-Range is not exposed via CORS and size is 1 or less,
    // make a lightweight HEAD request directly to the final S3/GCS URL.
    // S3/GCS permits HEAD on GET-presigned URLs, which retrieves the headers (including safelisted Content-Length) without a body.
    console.warn("getUrlContentLength: Content-Range header not accessible via CORS. Falling back to HEAD request on final URL to retrieve size.");
    return fetch(response.url, { method: "HEAD" }).then((headResponse) => {
      if (!headResponse.ok) {
        throw new Error(`HEAD fallback failed with status: ${headResponse.status}`);
      }
      const headLen = headResponse.headers.get("content-length");
      let headSize = 0;
      if (headLen) {
        headSize = parseInt(headLen, 10);
      }

      if (headSize > 0) {
        return { size: headSize, finalUrl: response.url };
      }
      throw new Error("Unable to determine audio file size for streaming");
    });
  });
}

/**
 * Creates an AudioDecoderWorker for the given audio file or stream.
 * Make sure to call dispose() when no longer needed to free its resources.
 * @param {string} wasm - a path or inlined version to/of decode-audio.wasm
 * @param {File | Blob | ArrayBuffer | string | WasmAudioStreamConfig} fileOrBufferOrUrl - the audio source
 * @param {object} options - options to control streaming
 * @returns Promise
 */
function getAudioDecoderWorker(
  wasm: string,
  fileOrBufferOrUrl: File | Blob | ArrayBuffer | string | WasmAudioStreamConfig,
  options: { stream?: boolean } = {}
): Promise<AudioDecoderWorker> {
  const worker = new DecodeAudioWorker();
  return new Promise<AudioDecoderWorker>((resolve, reject) => {
    let source = fileOrBufferOrUrl;

    if (typeof source === "string" && source.startsWith("data:")) {
      try {
        source = dataURIToBlob(source);
      } catch (err) {
        reject(`Failed to parse data URI: ${err}`);
        return;
      }
    }

    if (typeof source === "string") {
      try {
        source = new URL(source, window.location.href).href;
      } catch (err) {
        // Ignore and keep original
      }
    }

    const initWorker = (fileData?: ArrayBuffer, streamConfig?: WasmAudioStreamConfig) => {
      worker.onmessage = (e: MessageEvent) => {
        const { type, sampleRate, channelCount, encoding, duration, error } =
          e.data;
        if (type === AudioDecoderMessageType.Initialize) {
          resolve(
            new AudioDecoderWorker(worker, {
              sampleRate,
              channelCount,
              encoding,
              duration,
            })
          );
        } else if (type === AudioDecoderMessageType.InitializeError) {
          reject(error);
        } else {
          reject("Failed to initialize decoder worker");
        }
      };
      worker.onerror = (err: ErrorEvent) =>
        reject(`Failed to initialize decoder worker: ${err.message}`);

      // initialize decoder thread
      const wasmUrl = new URL(wasm, window.location.origin).href;
      worker.postMessage(
        {
          type: AudioDecoderMessageType.Initialize,
          wasm: wasmUrl,
          fileData,
          streamConfig,
        },
        (fileData instanceof ArrayBuffer) ? [fileData] : []
      );
    };

    // Determine if we should stream
    let shouldStream = !!options.stream;
    const isUrl = typeof source === "string";
    const isConfig =
      source &&
      typeof source === "object" &&
      !("byteLength" in source) &&
      !("size" in source && (source instanceof Blob));

    if (isUrl || isConfig) {
      shouldStream = true;
    }

    if (shouldStream) {
      if (isConfig) {
        initWorker(undefined, source as WasmAudioStreamConfig);
      } else if (isUrl) {
        getUrlContentLength(source as string)
          .then(({ size, finalUrl }) => {
            initWorker(undefined, { url: finalUrl, size });
          })
          .catch((err) => reject(err));
      } else if (source instanceof Blob) {
        initWorker(undefined, {
          fileOrBlob: source,
          size: source.size,
        });
      } else {
        reject("Invalid audio source for streaming");
      }
    } else {
      // Standard mode - load full buffer
      readBuffer(source as Blob | ArrayBuffer)
        .then((fileData) => initWorker(fileData))
        .catch((err) => reject(err));
    }
  });
}

interface AudioFileProperties {
  sampleRate: number;
  channelCount: number;
  encoding: string;
  duration: number;
}

/**
 * A disposable class for decoding an audio file asynchronously.
 * Should only be instantiated with the getAudioDecoderWorker() factory function.
 * Make sure to call dispose() when no longer needed to free its resources.
 */
class AudioDecoderWorker {
  private _worker: Worker;
  private _properties: AudioFileProperties;

  constructor(worker: Worker, properties: AudioFileProperties) {
    this._worker = worker;
    this._properties = properties;
  }

  get sampleRate(): number {
    return this._properties.sampleRate;
  }

  get channelCount(): number {
    return this._properties.channelCount;
  }

  get encoding(): string {
    return this._properties.encoding;
  }

  get duration(): number {
    return this._properties.duration;
  }

  /**
   * Decodes audio asynchronously from the currently loaded file.
   * @param {number} start=0 - the timestamp in seconds to start decoding at.
   * @param {number} duration=-1 - the length in seconds to decode, or -1 to decode until the end of the file.
   * @param {DecodeAudioOptions} options={} - additional options for decoding.
   * @returns Float32Array
   */
  decodeAudioData(
    start = 0,
    duration = -1,
    options: DecodeAudioOptions = {}
  ): Promise<Float32Array> {
    return new Promise<Float32Array>((resolve, reject) => {
      const requestId = Date.now() + Math.random();
      const onDecode = (e: MessageEvent) => {
        const { type, id, samples, error } = e.data;
        if (type === AudioDecoderMessageType.Decode && id === requestId) {
          this._worker.removeEventListener("message", onDecode);
          resolve(new Float32Array(samples));
        } else if (
          type === AudioDecoderMessageType.DecodeError &&
          id === requestId
        ) {
          this._worker.removeEventListener("message", onDecode);
          reject(error);
        }
      };

      this._worker.addEventListener("message", onDecode);
      this._worker.postMessage({
        type: AudioDecoderMessageType.Decode,
        id: requestId,
        start,
        duration,
        options,
      });
    });
  }

  /**
   * Updates the stream URL dynamically.
   * @param {string} url - the new URL to use.
   */
  updateUrl(url: string) {
    this._worker.postMessage({
      type: "updateUrl",
      url,
    });
  }

  /**
   * Disposes the AudioDecoder and frees its resources.
   * Must be called after the decoder is no longer needed.
   */
  dispose() {
    this._worker.postMessage({ type: AudioDecoderMessageType.Dispose });
    this._worker.terminate();
  }
}

export { getAudioDecoderWorker, AudioDecoderWorker };

export default getAudioDecoderWorker;
