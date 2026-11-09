'use strict';

// Release bundles from https://github.com/Vanilagy/mediabunny/releases/tag/v1.61.6
// Media stays in this worker.
importScripts('vendor/mediabunny.min.js');
const {
  Input, BlobSource, MP4, QTFF, WEBM, Output, Mp4OutputFormat, BufferTarget,
  CanvasSink, CanvasSource, AudioSampleSink, AudioSampleSource, AudioSample,
  Quality, canEncodeVideo, canEncodeAudio
} = Mediabunny;

const fps = 24;
const sampleRate = 48000;
const maxFrames = 5 * 60 * fps;

function openClip(file) {
  return new Input({ formats: [MP4, QTFF, WEBM], source: new BlobSource(file) });
}

async function getClipInfo(file) {
  const input = openClip(file);
  try {
    const track = await input.getPrimaryVideoTrack();
    if (!track || !(await track.canDecode())) throw Error('No video track this browser can decode.');
    const [start, end, width, height, audio] = await Promise.all([
      track.getFirstTimestamp(), track.computeDuration(),
      track.getDisplayWidth(), track.getDisplayHeight(), input.getPrimaryAudioTrack()
    ]);
    const frames = Math.round((end - start) * fps);
    if (!Number.isFinite(frames) || frames < 1) throw Error('Could not read the clip duration.');
    return { frames, width, height, audio: Boolean(audio) };
  } catch (error) {
    throw Error(file.name + ': ' + error.message);
  } finally {
    input.dispose();
  }
}

async function writeVideo(track, canvas, source, start, frameCount, offset, progress) {
  const sink = new CanvasSink(track, {
    width: canvas.width, height: canvas.height, fit: 'contain', poolSize: 2
  });
  const context = canvas.getContext('2d', { alpha: false });
  const timestamps = Array.from({ length: frameCount }, (_, index) => start + index / fps);
  let index = 0;
  for await (const frame of sink.canvasesAtTimestamps(timestamps)) {
    if (frame) context.drawImage(frame.canvas, 0, 0);
    else if (index === 0) throw Error('The first video frame could not be decoded.');
    await source.add((offset + index) / fps, 1 / fps);
    index++;
    if ((offset + index) % fps === 0) progress(offset + index);
  }
}

async function appendPcm(source, data, timestamp) {
  const sample = new AudioSample({
    format: 'f32', data, sampleRate, numberOfChannels: 2, timestamp
  });
  try {
    await source.add(sample);
  } finally {
    sample.close();
  }
}

async function writeSilence(source, from, to, timelineStart) {
  for (let position = from; position < to; position += 4096) {
    const length = Math.min(4096, to - position);
    await appendPcm(source, new Float32Array(length * 2), timelineStart + position / sampleRate);
  }
}

async function writeAudio(track, source, start, frames, offset) {
  const samplesPerFrame = sampleRate / fps;
  // Leave room for AAC priming and packet padding at the five-minute boundary.
  const length = Math.max(0, Math.min(frames * samplesPerFrame, (maxFrames - offset) * samplesPerFrame - 4096));
  const duration = length / sampleRate;
  const timelineStart = offset / fps;
  let cursor = 0;
  if (track) {
    if (!(await track.canDecode())) throw Error('This browser cannot decode the clip audio.');
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples(start, start + duration)) {
      try {
        const sourceStart = (sample.timestamp - start) * sampleRate;
        const begin = Math.max(cursor, Math.round(sourceStart));
        const end = Math.min(length, Math.round(sourceStart + sample.duration * sampleRate));
        if (end <= begin) continue;
        await writeSilence(source, cursor, begin, timelineStart);

        const left = new Float32Array(sample.numberOfFrames);
        const right = sample.numberOfChannels > 1 ? new Float32Array(sample.numberOfFrames) : left;
        sample.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
        if (right !== left) sample.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
        const stereo = new Float32Array((end - begin) * 2);
        for (let index = begin; index < end; index++) {
          const inputIndex = Math.max(0, Math.min(left.length - 1, (index - sourceStart) * sample.sampleRate / sampleRate));
          const first = Math.floor(inputIndex);
          const second = Math.min(left.length - 1, first + 1);
          const fraction = inputIndex - first;
          const targetIndex = (index - begin) * 2;
          stereo[targetIndex] = left[first] + (left[second] - left[first]) * fraction;
          stereo[targetIndex + 1] = right[first] + (right[second] - right[first]) * fraction;
        }
        await appendPcm(source, stereo, timelineStart + begin / sampleRate);
        cursor = end;
      } finally {
        sample.close();
      }
    }
  }
  await writeSilence(source, cursor, length, timelineStart);
}

async function encodeSequence(clips, portrait) {
  const totalFrames = clips.reduce((sum, clip) => sum + clip.frames, 0);
  if (!totalFrames || totalFrames > maxFrames) throw Error('Sequence length must be 5 minutes or less.');
  const width = portrait ? 540 : 960;
  const height = portrait ? 960 : 540;
  const bitrate = 2_000_000;
  if (!(await canEncodeVideo('avc', { width, height, bitrate }))) {
    throw Error('This browser cannot encode H.264 MP4. Try opening Studio in Safari or Chrome.');
  }
  const target = new BufferTarget();
  const output = new Output({ target, format: new Mp4OutputFormat({ fastStart: 'in-memory' }) });
  const canvas = new OffscreenCanvas(width, height);
  const video = new CanvasSource(canvas, {
    codec: 'avc', quality: new Quality({ bitrate }), keyFrameInterval: 2
  });
  output.addVideoTrack(video, { frameRate: fps });
  let audio;
  if (clips.some(clip => clip.audio)) {
    if (!(await canEncodeAudio('aac', { sampleRate, numberOfChannels: 2, bitrate: 128000 }))) {
      importScripts('vendor/mediabunny-aac-encoder.min.js');
      MediabunnyAacEncoder.registerAacEncoder();
    }
    audio = new AudioSampleSource({ codec: 'aac', quality: new Quality({ bitrate: 128000 }) });
    output.addAudioTrack(audio);
  }
  await output.start();
  let offset = 0;
  for (const [index, clip] of clips.entries()) {
    const input = openClip(clip.file);
    const progress = frame => self.postMessage({
      type: 'progress', percent: Math.floor(100 * frame / totalFrames),
      index: index + 1, count: clips.length
    });
    try {
      progress(offset);
      const track = await input.getPrimaryVideoTrack();
      const start = await track.getFirstTimestamp();
      const audioTrack = audio ? await input.getPrimaryAudioTrack() : null;
      await Promise.all([
        writeVideo(track, canvas, video, start, clip.frames, offset, progress),
        audio && writeAudio(audioTrack, audio, start, clip.frames, offset)
      ]);
      offset += clip.frames;
    } catch (error) {
      throw Error(clip.file.name + ': ' + error.message);
    } finally {
      input.dispose();
    }
  }
  video.close();
  audio?.close();
  await output.finalize();
  return target.buffer;
}

self.onmessage = async ({ data }) => {
  try {
    if (data.action === 'inspect') {
      const result = [];
      for (const file of data.files) result.push(await getClipInfo(file));
      self.postMessage({ type: 'done', result });
    } else if (data.action === 'export') {
      const result = await encodeSequence(data.clips, data.portrait);
      self.postMessage({ type: 'done', result }, [result]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || 'Could not process this video.' });
  }
};
