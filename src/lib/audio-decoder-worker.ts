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

function getUrlContentLength(url: string): Promise<number> {
  return fetch(url, { method: "HEAD" })
    .then((response) => {
      const len = response.headers.get("content-length");
      if (len) return parseInt(len, 10);
      throw new Error("No content-length header");
    })
    .catch(() => {
      // Fallback to GET with Range: bytes=0-0
      return fetch(url, { headers: { Range: "bytes=0-0" } }).then((response) => {
        const contentRange = response.headers.get("content-range");
        if (contentRange) {
          const parts = contentRange.split("/");
          if (parts.length === 2) {
            return parseInt(parts[1], 10);
          }
        }
        const len = response.headers.get("content-length");
        if (len) return parseInt(len, 10);
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
        fileData ? [fileData] : []
      );
    };

    // Determine if we should stream
    let shouldStream = !!options.stream;
    const isUrl = typeof fileOrBufferOrUrl === "string";
    const isConfig =
      fileOrBufferOrUrl &&
      typeof fileOrBufferOrUrl === "object" &&
      !("byteLength" in fileOrBufferOrUrl) &&
      !("size" in fileOrBufferOrUrl && (fileOrBufferOrUrl instanceof Blob));

    if (isUrl || isConfig) {
      shouldStream = true;
    }

    if (shouldStream) {
      if (isConfig) {
        initWorker(undefined, fileOrBufferOrUrl as WasmAudioStreamConfig);
      } else if (isUrl) {
        getUrlContentLength(fileOrBufferOrUrl as string)
          .then((size) => {
            initWorker(undefined, { url: fileOrBufferOrUrl as string, size });
          })
          .catch((err) => reject(err));
      } else if (fileOrBufferOrUrl instanceof Blob) {
        initWorker(undefined, {
          fileOrBlob: fileOrBufferOrUrl,
          size: fileOrBufferOrUrl.size,
        });
      } else {
        reject("Invalid audio source for streaming");
      }
    } else {
      // Standard mode - load full buffer
      readBuffer(fileOrBufferOrUrl as Blob | ArrayBuffer)
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
