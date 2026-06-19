#include "audio-decode.h"
#include <emscripten/bind.h>
#include <emscripten.h>
#include <limits>
#include <cmath>

/*
 * Reads the samples from a frame and puts them into the destination vector.
 * Samples will be stored as floats in the range of -1 to 1.
 * If the frame has multiple channels, and multiChannel is false, samples will be averaged across all channels.
 */
template <typename SampleType>
void read_samples(AVFrame* frame, std::vector<float>& dest, bool is_planar, bool multiChannel, int start_sample_offset, int num_samples_to_copy) {
  // use a midpoint offset between min/max for unsigned integer types
  SampleType min_numeric = std::numeric_limits<SampleType>::min();
  SampleType max_numeric = std::numeric_limits<SampleType>::max();
  SampleType zero_sample = min_numeric == 0 ? max_numeric / 2 + 1 : 0;

  for (int i = start_sample_offset; i < start_sample_offset + num_samples_to_copy; i++) {
    float sample = 0.0f;
    for (int j = 0; j < frame->channels; j++) {
      float channelSample = is_planar
        ? (
          static_cast<float>(reinterpret_cast<SampleType*>(frame->extended_data[j])[i] - zero_sample) /
          static_cast<float>(max_numeric - zero_sample)
        )
        : (
          static_cast<float>(reinterpret_cast<SampleType*>(frame->data[0])[i * frame->channels + j] - zero_sample) /
          static_cast<float>(max_numeric - zero_sample)
        );

      if (multiChannel) {
        dest.push_back(channelSample);
      } else {
        sample += channelSample;
      }
    }

    if (!multiChannel) {
      sample /= frame->channels;
      dest.push_back(sample);
    }
  }
}

template <>
void read_samples<float>(AVFrame* frame, std::vector<float>& dest, bool is_planar, bool multiChannel, int start_sample_offset, int num_samples_to_copy) {
#ifndef NDEBUG
    EM_ASM({
      console.log("[DEBUG] Entering read_samples<float>: start_offset =", $0, "num_samples =", $1, "nb_samples =", $2, "is_planar =", $3, "channels =", $4);
    }, start_sample_offset, num_samples_to_copy, frame->nb_samples, is_planar, frame->channels);
#endif
    for (int i = start_sample_offset; i < start_sample_offset + num_samples_to_copy; i++) {
      float sample = 0.0f;
      for (int j = 0; j < frame->channels; j++) {
        float channelSample = is_planar
          ? reinterpret_cast<float*>(frame->extended_data[j])[i]
          : reinterpret_cast<float*>(frame->data[0])[i * frame->channels + j];

        if (multiChannel) {
          dest.push_back(channelSample);
        } else {
          sample += channelSample;
        }
      }
      if (!multiChannel) {
        sample /= frame->channels;
        dest.push_back(sample);
      }
    }
}

int read_samples(AVFrame* frame, AVSampleFormat format, std::vector<float>& dest, bool multiChannel, int start_sample_offset, int num_samples_to_copy) {
  bool is_planar = av_sample_fmt_is_planar(format);

  switch (format) {
    case AV_SAMPLE_FMT_U8:
    case AV_SAMPLE_FMT_U8P:
      read_samples<uint8_t>(frame, dest, is_planar, multiChannel, start_sample_offset, num_samples_to_copy);
      return 0;
    case AV_SAMPLE_FMT_S16:
    case AV_SAMPLE_FMT_S16P:
      read_samples<int16_t>(frame, dest, is_planar, multiChannel, start_sample_offset, num_samples_to_copy);
      return 0;
    case AV_SAMPLE_FMT_S32:
    case AV_SAMPLE_FMT_S32P:
      read_samples<int32_t>(frame, dest, is_planar, multiChannel, start_sample_offset, num_samples_to_copy);
      return 0;
    case AV_SAMPLE_FMT_FLT:
    case AV_SAMPLE_FMT_FLTP:
      read_samples<float>(frame, dest, is_planar, multiChannel, start_sample_offset, num_samples_to_copy);
      return 0;
    default:
      return -1;
  }
}

EM_JS(int, js_read_packet, (void* opaque, uint8_t* buf, int buf_size), {
  const stream = globalThis.wasmAudioStreams ? globalThis.wasmAudioStreams.get(Number(opaque)) : null;
  if (!stream) return -1;
  const bytes = stream.readSync(buf_size);
  if (!bytes || bytes.length === 0) return 0;
  HEAPU8.set(bytes, buf);
  return bytes.length;
});

EM_JS(double, js_seek, (void* opaque, double offset, int whence), {
  const stream = globalThis.wasmAudioStreams ? globalThis.wasmAudioStreams.get(Number(opaque)) : null;
  if (!stream) return -1;
  if (whence & 0x10000) {
    return stream.getSize();
  }
  return stream.seek(offset, whence);
});

static int read_packet_callback(void* opaque, uint8_t* buf, int buf_size) {
  return js_read_packet(opaque, buf, buf_size);
}

static int64_t seek_callback(void* opaque, int64_t offset, int whence) {
  return static_cast<int64_t>(js_seek(opaque, static_cast<double>(offset), whence));
}

uint32_t create_stream_context() {
  char* ptr = new char;
  return reinterpret_cast<uint32_t>(ptr);
}

void destroy_stream_context(uint32_t ctx_addr) {
  char* ptr = reinterpret_cast<char*>(ctx_addr);
  delete ptr;
}

std::string get_error_str(int status) {
  char errbuf[AV_ERROR_MAX_STRING_SIZE];
  av_make_error_string(errbuf, AV_ERROR_MAX_STRING_SIZE, status);
  return std::string(errbuf);
}

Status open_audio_stream(const std::string& path, AVFormatContext*& format, AVCodecContext*& codec, int& audio_stream_index) {
  Status status;
  format = avformat_alloc_context();
  if (!format) {
    status.status = -1;
    status.error = "avformat_alloc_context failed";
    return status;
  }

  if (path.rfind("stream:", 0) == 0) {
    std::string addr_str = path.substr(7);
    void* opaque = reinterpret_cast<void*>(std::stoull(addr_str));

    const int io_buffer_size = 32768;
    uint8_t* io_buffer = static_cast<uint8_t*>(av_malloc(io_buffer_size));
    if (!io_buffer) {
      status.status = -1;
      status.error = "av_malloc for AVIOContext buffer failed";
      return status;
    }

    AVIOContext* io_context = avio_alloc_context(
      io_buffer,
      io_buffer_size,
      0, // read-only
      opaque,
      read_packet_callback,
      nullptr,
      seek_callback
    );

    if (!io_context) {
      av_free(io_buffer);
      status.status = -1;
      status.error = "avio_alloc_context failed";
      return status;
    }

    format->pb = io_context;

    if ((status.status = avformat_open_input(&format, nullptr, nullptr, nullptr)) != 0) {
      status.error = "avformat_open_input (stream): " + get_error_str(status.status);
      return status;
    }
  } else {
    if ((status.status = avformat_open_input(&format, path.c_str(), nullptr, nullptr)) != 0) {
      status.error = "avformat_open_input: " + get_error_str(status.status);
      return status;
    }
  }

  if ((status.status = avformat_find_stream_info(format, nullptr)) < 0) {
    status.error = "avformat_find_stream_info: " + get_error_str(status.status);
    return status;
  }
  AVCodec* decoder;
  if ((audio_stream_index = av_find_best_stream(format, AVMEDIA_TYPE_AUDIO, -1, -1, &decoder, -1)) < 0) {
    status.status = audio_stream_index;
    status.error = "av_find_best_stream: Failed to locate audio stream";
    return status;
  }
  codec = avcodec_alloc_context3(decoder);
  if (!codec) {
    status.status = -1;
    status.error = "avcodec_alloc_context3: Failed to allocate decoder";
    return status;
  }
  if ((status.status = avcodec_parameters_to_context(codec, format->streams[audio_stream_index]->codecpar)) < 0) {
    status.error = "avcodec_parameters_to_context: " + get_error_str(status.status);
    return status;
  }
  if ((status.status = avcodec_open2(codec, decoder, nullptr)) < 0) {
    status.error = "avcodec_open2: " + get_error_str(status.status);
    return status;
  }

  return status;
}

void close_audio_stream(AVFormatContext* format, AVCodecContext* codec, AVFrame* frame, AVPacket* packet) {
  if (format) {
    bool is_custom = (format->flags & AVFMT_FLAG_CUSTOM_IO);
    AVIOContext* pb = format->pb;
    avformat_close_input(&format);
    if (is_custom && pb) {
      av_freep(&pb->buffer);
      avio_context_free(&pb);
    }
  }
  if (codec) {
    avcodec_free_context(&codec);
  }
  if (packet) {
    av_packet_free(&packet);
  }
  if (frame) {
    av_frame_free(&frame);
  }
}

AudioProperties get_properties(const std::string& path) {
  av_log_set_level(AV_LOG_ERROR);

  Status status;
  AVFormatContext* format = nullptr;
  AVCodecContext* codec = nullptr;
  int audio_stream_index;

  status = open_audio_stream(path, format, codec, audio_stream_index);
  if (status.status < 0) {
    close_audio_stream(format, codec, nullptr, nullptr);
    return { status };
  }
  AudioProperties properties = {
    status,
    avcodec_get_name(codec->codec_id),
    codec->sample_rate,
    codec->channels,
    format->duration / static_cast<float>(AV_TIME_BASE)
  };

  close_audio_stream(format, codec, nullptr, nullptr);
  return properties;
}

DecodeAudioResult decode_audio(const std::string& path, float start = 0, float duration = -1, DecodeAudioOptions options = {}) {
#ifndef NDEBUG
  EM_ASM({
    console.log("[DEBUG] decode_audio start: start =", $0, "duration =", $1);
  }, start, duration);
#endif
  av_log_set_level(AV_LOG_ERROR);

  Status status;
  AVFormatContext* format = nullptr;
  AVCodecContext* codec = nullptr;
  int audio_stream_index = -1;

  status = open_audio_stream(path, format, codec, audio_stream_index);
#ifndef NDEBUG
  EM_ASM({
    console.log("[DEBUG] open_audio_stream status =", $0);
  }, status.status);
#endif
  if (status.status < 0) {
    close_audio_stream(format, codec, nullptr, nullptr);
    // check if vector is undefined/null in js
    return { status };
  }

  // seek to start timestamp
  AVStream* stream = format->streams[audio_stream_index];
#ifndef NDEBUG
  EM_ASM({
    console.log("[DEBUG] format->duration =", $0, "stream->time_base =", $1, "/", $2, "codec->sample_rate =", $3);
  }, (double)format->duration, stream->time_base.num, stream->time_base.den, codec->sample_rate);
#endif
  int64_t start_timestamp = av_rescale(start, stream->time_base.den, stream->time_base.num);
  int64_t max_timestamp = av_rescale(format->duration / static_cast<float>(AV_TIME_BASE), stream->time_base.den, stream->time_base.num);
#ifndef NDEBUG
  EM_ASM({
    console.log("[DEBUG] start_timestamp =", $0, "max_timestamp =", $1);
  }, (double)start_timestamp, (double)max_timestamp);
#endif
  if ((status.status = av_seek_frame(format, audio_stream_index, std::min(start_timestamp, max_timestamp), AVSEEK_FLAG_ANY)) < 0) {
    close_audio_stream(format, codec, nullptr, nullptr);
    status.error = "av_seek_frame: " + get_error_str(status.status) + ". timestamp: " + std::to_string(start);
    return { status };
  }
#ifndef NDEBUG
  EM_ASM({
    console.log("[DEBUG] av_seek_frame success");
  });
#endif

  AVPacket* packet = av_packet_alloc();
  AVFrame* frame = av_frame_alloc();
#ifndef NDEBUG
  EM_ASM({
    console.log("[DEBUG] packet and frame allocated: packet =", $0, "frame =", $1);
  }, (double)(uintptr_t)packet, (double)(uintptr_t)frame);
#endif
  if (!packet || !frame) {
    close_audio_stream(format, codec, frame, packet);
    status.status = -1;
    status.error = "av_packet_alloc/av_frame_alloc: Failed to allocate decoder frame";
    return { status };
  }

  // decode loop
  std::vector<float> samples;

  int64_t target_sample = std::round(start * codec->sample_rate);
  int64_t samples_to_decode = std::round(duration * codec->sample_rate);
  int64_t total_samples_decoded = 0;

  bool first_frame = true;
  int64_t next_write_sample = target_sample;

#ifndef NDEBUG
  EM_ASM({
    console.log("[DEBUG] target_sample =", $0, "samples_to_decode =", $1);
  }, (double)target_sample, (double)samples_to_decode);
#endif

  while ((status.status = av_read_frame(format, packet)) >= 0) {
    if (packet->stream_index == audio_stream_index) {
      // send compressed packet to decoder
      status.status = avcodec_send_packet(codec, packet);
      if (status.status == AVERROR(EAGAIN) || status.status == AVERROR_EOF) {
        continue;
      } else if (status.status < 0) {
        close_audio_stream(format, codec, frame, packet);
        status.error = "avcodec_send_packet: " + get_error_str(status.status);
        return { status };
      }

      // receive uncompressed frame from decoder
      while ((status.status = avcodec_receive_frame(codec, frame)) >= 0) {
        if (status.status == AVERROR(EAGAIN) || status.status == AVERROR_EOF) {
          break;
        } else if (status.status < 0) {
          close_audio_stream(format, codec, frame, packet);
          status.error = "avcodec_receive_frame: " + get_error_str(status.status);
          return { status };
        }

        // Calculate presentation timestamp in samples
        int64_t frame_start_sample;
        if (frame->pts != AV_NOPTS_VALUE) {
          double tb = av_q2d(stream->time_base);
          frame_start_sample = std::round(frame->pts * tb * codec->sample_rate);
#ifndef NDEBUG
          EM_ASM({
            console.log("[DEBUG] frame->pts =", $0, "stream->time_base =", $1, "/", $2, "tb =", $3, "sample_rate =", $4, "-> frame_start_sample =", $5, "next_write =", $6, "target =", $7);
          }, (double)frame->pts, stream->time_base.num, stream->time_base.den, tb, codec->sample_rate, (double)frame_start_sample, (double)next_write_sample, (double)target_sample);
#endif
        } else {
          frame_start_sample = next_write_sample;
#ifndef NDEBUG
          EM_ASM({
            console.log("[DEBUG] frame->pts=AV_NOPTS_VALUE -> frame_start_sample =", $0);
          }, (double)frame_start_sample);
#endif
        }

        if (first_frame) {
          first_frame = false;
          if (frame_start_sample > target_sample) {
            int64_t gap = frame_start_sample - target_sample;
            int64_t pad_samples = std::min(gap, samples_to_decode);
#ifndef NDEBUG
            EM_ASM({
              console.log("[DEBUG] Padding initial gap of", $0, "samples");
            }, (double)pad_samples);
#endif
            samples.resize(pad_samples * codec->channels, 0.0f);
            next_write_sample = target_sample + pad_samples;
            total_samples_decoded = pad_samples;
          }
        }

        // Check if we need to pad a gap between frames
        if (frame_start_sample > next_write_sample) {
          int64_t gap = frame_start_sample - next_write_sample;
          int64_t pad_samples = std::min(gap, samples_to_decode - total_samples_decoded);
          if (pad_samples > 0) {
            samples.resize((total_samples_decoded + pad_samples) * codec->channels, 0.0f);
            next_write_sample += pad_samples;
            total_samples_decoded += pad_samples;
          }
        }

        // Check if the frame is completely before our next write position
        if (frame_start_sample + frame->nb_samples <= next_write_sample) {
#ifndef NDEBUG
          EM_ASM({
            console.log("[DEBUG] Frame before next write sample: frame_start =", $0, "nb_samples =", $1, "next_write =", $2);
          }, (double)frame_start_sample, frame->nb_samples, (double)next_write_sample);
#endif
          av_frame_unref(frame);
          continue;
        }

        // Determine offset and length to copy
        int64_t frame_offset = next_write_sample - frame_start_sample;
        if (frame_offset < 0) frame_offset = 0;

        int64_t samples_available = frame->nb_samples - frame_offset;
        int64_t samples_needed = samples_to_decode - total_samples_decoded;
        int64_t samples_to_copy = std::min(samples_available, samples_needed);

#ifndef NDEBUG
        EM_ASM({
          console.log("[DEBUG] Copying: frame_offset =", $0, "samples_available =", $1, "samples_needed =", $2, "samples_to_copy =", $3, "nb_samples =", $4);
        }, (double)frame_offset, (double)samples_available, (double)samples_needed, (double)samples_to_copy, frame->nb_samples);
#endif

        if (samples_to_copy > 0) {
          read_samples(frame, codec->sample_fmt, samples, options.multiChannel, frame_offset, samples_to_copy);
          next_write_sample += samples_to_copy;
          total_samples_decoded += samples_to_copy;
        }

        av_frame_unref(frame);

        if (total_samples_decoded >= samples_to_decode) {
          break;
        }
      }

      av_packet_unref(packet);

      if (total_samples_decoded >= samples_to_decode) {
        break;
      }
    }
  }

  // If we reached EOF and still need more samples, pad the rest with zeros
  if (total_samples_decoded < samples_to_decode) {
    int64_t pad_samples = samples_to_decode - total_samples_decoded;
    samples.resize((total_samples_decoded + pad_samples) * codec->channels, 0.0f);
  }

  // cleanup
  close_audio_stream(format, codec, frame, packet);

  // success
  status.status = 0;

  return { status, samples };
}

EMSCRIPTEN_BINDINGS(my_module) {
  emscripten::value_object<Status>("Status")
    .field("status", &Status::status)
    .field("error", &Status::error);
  emscripten::value_object<AudioProperties>("AudioProperties")
    .field("status", &AudioProperties::status)
    .field("encoding", &AudioProperties::encoding)
    .field("sampleRate", &AudioProperties::sample_rate)
    .field("channelCount", &AudioProperties::channels)
    .field("duration", &AudioProperties::duration);
  emscripten::value_object<DecodeAudioResult>("DecodeAudioResult")
    .field("status", &DecodeAudioResult::status)
    .field("samples", &DecodeAudioResult::samples);
  emscripten::value_object<DecodeAudioOptions>("DecodeAudioOptions")
    .field("multiChannel", &DecodeAudioOptions::multiChannel);
  emscripten::function("getProperties", &get_properties);
  emscripten::function("decodeAudio", &decode_audio);
  emscripten::function("createStreamContext", &create_stream_context);
  emscripten::function("destroyStreamContext", &destroy_stream_context);
  emscripten::register_vector<float>("vector<float>");
}
