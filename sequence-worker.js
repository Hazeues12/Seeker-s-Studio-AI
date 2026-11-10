'use strict';

// Release bundles from https://github.com/Vanilagy/mediabunny/releases/tag/v1.61.6
// Media stays in this worker.
importScripts('vendor/mediabunny.min.js');
const {
  Input, BlobSource, MP4, QTFF, WEBM, WAVE, MP3, ADTS, Output, Mp4OutputFormat, BufferTarget,
  CanvasSink, CanvasSource, AudioSampleSink, AudioSampleSource, AudioSample,
  Quality, canEncodeVideo, canEncodeAudio
} = Mediabunny;

const fps = 24;
const sampleRate = 48000;
const maxFrames = 5 * 60 * fps;
const videoFormats = [MP4, QTFF, WEBM];
const voiceFormats = [...videoFormats, WAVE, MP3, ADTS];

function openClip(file, formats = videoFormats) {
  return new Input({ formats, source: new BlobSource(file) });
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

async function getVoiceDuration(file) {
  const input = openClip(file, voiceFormats);
  try {
    const track = await input.getPrimaryAudioTrack();
    if (!track || !(await track.canDecode())) throw Error('Choose a voice take this browser can decode. WAV is a good fallback.');
    const [start, end] = await Promise.all([track.getFirstTimestamp(), track.computeDuration()]);
    const duration = end - start;
    if (!Number.isFinite(duration) || duration <= 0) throw Error('Could not read the voice take duration.');
    return duration;
  } finally {
    input.dispose();
  }
}

function wrapCaption(context, caption, maxWidth) {
  const lines = [];
  for (const paragraph of caption.split('\n')) {
    let line = '';
    for (const word of paragraph.split(/\s+/)) {
      if (line && context.measureText(line + ' ' + word).width > maxWidth) {
        lines.push(line);
        line = '';
      }
      if (context.measureText(word).width <= maxWidth) {
        line += (line ? ' ' : '') + word;
      } else {
        for (const letter of word) {
          if (line && context.measureText(line + letter).width > maxWidth) {
            lines.push(line);
            line = '';
          }
          line += letter;
        }
      }
    }
    if (line) lines.push(line);
  }
  return lines;
}

function layoutCaption(context, canvas, caption) {
  for (let size = 32; size >= 16; size -= 2) {
    const font = '600 ' + size + 'px sans-serif';
    context.font = font;
    const padding = Math.ceil(size * .4);
    const lines = wrapCaption(context, caption, canvas.width * .88 - padding * 2);
    const lineHeight = Math.ceil(size * 1.25);
    const height = lineHeight * lines.length + padding * 2;
    if (height > canvas.height * .36) continue;
    const width = Math.max(...lines.map(line => context.measureText(line).width)) + padding * 2;
    return { font, padding, lines, lineHeight, width, height };
  }
  throw Error('This dialogue is too long to fit on screen. Download the SRT or shorten the line in Director.');
}

function drawCaption(context, canvas, layout) {
  const y = canvas.height * .92 - layout.height;
  context.save();
  context.fillStyle = 'rgba(4, 8, 14, .85)';
  context.fillRect((canvas.width - layout.width) / 2, y, layout.width, layout.height);
  context.font = layout.font;
  context.textAlign = 'center';
  context.textBaseline = 'top';
  context.fillStyle = '#fff';
  for (const [index, line] of layout.lines.entries()) {
    context.fillText(line, canvas.width / 2, y + layout.padding + index * layout.lineHeight);
  }
  context.restore();
}

async function writeVideo(track, canvas, source, start, frameCount, offset, progress, caption) {
  const sink = new CanvasSink(track, {
    width: canvas.width, height: canvas.height, fit: 'contain', poolSize: 2
  });
  const context = canvas.getContext('2d', { alpha: false });
  const layout = caption ? layoutCaption(context, canvas, caption) : null;
  const timestamps = Array.from({ length: frameCount }, (_, index) => start + index / fps);
  let index = 0;
  for await (const frame of sink.canvasesAtTimestamps(timestamps)) {
    if (frame) {
      context.drawImage(frame.canvas, 0, 0);
      if (layout) drawCaption(context, canvas, layout);
    } else if (index === 0) throw Error('The first video frame could not be decoded.');
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

function* silence(samples) {
  for (let position = 0; position < samples; position += 4096) {
    yield new Float32Array(Math.min(4096, samples - position) * 2);
  }
}

async function* readPcm(track, start, length) {
  let cursor = 0;
  if (track) {
    if (!(await track.canDecode())) throw Error('This browser cannot decode the clip audio.');
    const sink = new AudioSampleSink(track);
    for await (const sample of sink.samples(start, start + length / sampleRate)) {
      let begin, end, stereo;
      try {
        const sourceStart = (sample.timestamp - start) * sampleRate;
        begin = Math.max(cursor, Math.round(sourceStart));
        end = Math.min(length, Math.round(sourceStart + sample.duration * sampleRate));
        if (end <= begin) continue;

        const left = new Float32Array(sample.numberOfFrames);
        const right = sample.numberOfChannels > 1 ? new Float32Array(sample.numberOfFrames) : left;
        sample.copyTo(left, { planeIndex: 0, format: 'f32-planar' });
        if (right !== left) sample.copyTo(right, { planeIndex: 1, format: 'f32-planar' });
        stereo = new Float32Array((end - begin) * 2);
        for (let index = begin; index < end; index++) {
          const inputIndex = Math.max(0, Math.min(left.length - 1, (index - sourceStart) * sample.sampleRate / sampleRate));
          const first = Math.floor(inputIndex);
          const second = Math.min(left.length - 1, first + 1);
          const fraction = inputIndex - first;
          const targetIndex = (index - begin) * 2;
          stereo[targetIndex] = left[first] + (left[second] - left[first]) * fraction;
          stereo[targetIndex + 1] = right[first] + (right[second] - right[first]) * fraction;
        }
      } finally {
        sample.close();
      }
      yield* silence(begin - cursor);
      yield stereo;
      cursor = end;
    }
  }
  yield* silence(length - cursor);
}

async function* mixPcm(voice, ambience) {
  let bed = new Float32Array(0);
  let bedOffset = 0;
  try {
    for await (const block of voice) {
      let offset = 0;
      while (offset < block.length) {
        if (bedOffset === bed.length) {
          const next = await ambience.next();
          if (next.done) break;
          bed = next.value;
          bedOffset = 0;
        }
        const count = Math.min(block.length - offset, bed.length - bedOffset);
        for (let i = 0; i < count; i++) {
          const mixed = block[offset + i] + bed[bedOffset + i] * .22;
          block[offset + i] = Math.max(-1, Math.min(1, mixed));
        }
        offset += count;
        bedOffset += count;
      }
      yield block;
    }
  } finally {
    await ambience.return();
  }
}

async function writeAudio(source, { track, start, voice }, frames, offset) {
  const samplesPerFrame = sampleRate / fps;
  // Leave room for AAC priming and packet padding at the five-minute boundary.
  const length = Math.max(0, Math.min(frames * samplesPerFrame, (maxFrames - offset) * samplesPerFrame - 4096));
  if (!length) return;
  const original = readPcm(track, start, length);
  const speech = voice && readPcm(voice, await voice.getFirstTimestamp(), length);
  const audio = speech && track ? mixPcm(speech, original) : speech || original;
  let cursor = 0;
  for await (const samples of audio) {
    await appendPcm(source, samples, offset / fps + cursor / sampleRate);
    cursor += samples.length / 2;
  }
}

async function encodeSequence(clips, portrait, captions) {
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
  if (clips.some(clip => clip.audio || clip.voice)) {
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
    let voiceInput;
    const progress = frame => self.postMessage({
      type: 'progress', percent: Math.floor(100 * frame / totalFrames),
      index: index + 1, count: clips.length
    });
    try {
      progress(offset);
      const track = await input.getPrimaryVideoTrack();
      const start = await track.getFirstTimestamp();
      const audioTrack = audio && (!clip.voice || clip.voice.blend) ? await input.getPrimaryAudioTrack() : null;
      let voice;
      if (clip.voice) {
        voiceInput = openClip(clip.voice.file, voiceFormats);
        voice = await voiceInput.getPrimaryAudioTrack();
        if (!voice) throw Error('The attached voice take has no audio track.');
      }
      await Promise.all([
        writeVideo(track, canvas, video, start, clip.frames, offset, progress, captions && clip.caption),
        audio && writeAudio(audio, { track: audioTrack, start, voice }, clip.frames, offset)
      ]);
      offset += clip.frames;
    } catch (error) {
      throw Error(clip.file.name + ': ' + error.message);
    } finally {
      voiceInput?.dispose();
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
    } else if (data.action === 'inspect-audio') {
      self.postMessage({ type: 'done', result: await getVoiceDuration(data.file) });
    } else if (data.action === 'export') {
      const result = await encodeSequence(data.clips, data.portrait, data.captions);
      self.postMessage({ type: 'done', result }, [result]);
    }
  } catch (error) {
    self.postMessage({ type: 'error', message: error.message || 'Could not process this video.' });
  }
};
