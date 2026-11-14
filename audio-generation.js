'use strict';

(() => {
  const get = id => document.getElementById(id);
  const voiceHost = 'https://pendrokar-kokoro-tts.hf.space';
  const musicHost = 'https://ace-step-ace-step.hf.space';
  const status = get('audio-generation-status');
  let request, outputUrl, generatedVoice;
  let refreshLimit = () => {};
  const providerKey = () => get('audio-task').value === 'voice' ? 'kokoro' : 'huggingface-gpu';

  function invalidateConsent() {
    get('audio-consent').checked = false;
  }

  function updateTask() {
    const voice = get('audio-task').value === 'voice';
    get('audio-voice-fields').classList.toggle('hidden', !voice);
    get('audio-music-fields').classList.toggle('hidden', voice);
    get('audio-lyrics-field').classList.toggle('hidden', get('audio-task').value === 'instrumental');
    invalidateConsent();
    refreshLimit();
  }

  async function generate() {
    if (request) return;
    const task = get('audio-task').value;
    const voice = task === 'voice';
    const text = get('audio-text').value.trim();
    const description = get('audio-music-prompt').value.trim();
    const lyrics = get('audio-lyrics').value.trim();
    if (voice && (!text || text.length > 1800)) {
      status.textContent = 'Enter up to 1,800 characters of spoken text.';
      return;
    }
    if (!voice && (!description || description.length > 1000 || (task === 'song' && (!lyrics || lyrics.length > 3000)))) {
      status.textContent = 'Add a music description and original lyrics for a song.';
      return;
    }
    if (!get('audio-consent').checked) {
      status.textContent = 'Confirm sending the text to the public generator.';
      return;
    }
    const host = voice ? voiceHost : musicHost;
    const key = providerKey();
    const blocked = SeekerProvider.blocked(key);
    if (blocked) {
      status.textContent = blocked;
      return;
    }
    const endpoint = voice ? 'predict' : '__call__';
    const controller = new AbortController();
    request = controller;
    const timeout = setTimeout(() => controller.abort('timeout'), 240000);
    get('audio-generate').disabled = true;
    get('audio-stop').classList.remove('hidden');
    invalidateConsent();
    try {
      async function fetchData(path, options = {}) {
        const response = await fetch(host + '/gradio_api/' + path, {
          ...options, credentials: 'omit', signal: controller.signal
        });
        return SeekerProvider.check(response, voice ? 'Kokoro voice demo' : 'Hugging Face music demo');
      }
      status.textContent = 'Connecting to the audio generator…';
      const api = await (await fetchData('info')).json();
      const parameters = api.named_endpoints?.['/' + endpoint]?.parameters;
      if (!parameters) throw Error('This demo changed its audio API. Try again later.');
      const values = voice ? {
        text, voice: get('audio-voice').value, speed: Number(get('audio-speed').value)
      } : {
        audio_duration: Number(get('audio-music-length').value),
        prompt: description + (task === 'instrumental' ? ', instrumental, no vocals' : ''),
        lyrics: task === 'instrumental' ? '[instrumental]' : lyrics,
        infer_step: 27, manual_seeds: '42'
      };
      for (const key of Object.keys(values)) {
        if (!parameters.some(parameter => parameter.parameter_name === key)) throw Error('The audio demo changed its inputs.');
      }
      const data = parameters.map(parameter =>
        Object.hasOwn(values, parameter.parameter_name) ? values[parameter.parameter_name] : parameter.parameter_default
      );
      const job = await (await fetchData('call/' + endpoint, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ data })
      })).json();
      if (typeof job.event_id !== 'string' || !job.event_id) throw Error('The generator did not return a job.');
      status.textContent = voice ? 'Generating the voice take…' : 'Waiting for the music generator…';
      const events = await (await fetchData('call/' + endpoint + '/' + encodeURIComponent(job.event_id))).text();
      const result = SeekerProvider.result(events, voice ? 'Kokoro voice demo' : 'Hugging Face music demo');
      const file = result?.[0];
      if (!file?.url && !file?.path) throw Error('The demo did not return an audio file.');
      const url = new URL(file.url || '/gradio_api/file=' + file.path, host);
      if (url.origin !== host) throw Error('The demo returned an unexpected download host.');
      const response = await fetch(url, { credentials: 'omit', signal: controller.signal });
      if (!response.ok) throw Error('Could not download the generated audio.');
      const blob = await response.blob();
      if (!blob.size || blob.size > 80 * 1024 * 1024) throw Error('The audio file is empty or too large.');
      const extension = (file.orig_name || file.path || '').match(/\.(wav|mp3|flac|ogg|m4a)$/i)?.[1]?.toLowerCase();
      const type = blob.type.startsWith('audio/') ? blob.type : extension === 'wav' ? 'audio/wav' : null;
      if (!type) throw Error('The response was not recognized as audio.');
      const audio = new File([blob], 'seeker-' + task + '.' + (extension || 'wav'), { type });
      const preview = get('audio-generated-preview');
      preview.pause();
      if (outputUrl) URL.revokeObjectURL(outputUrl);
      outputUrl = URL.createObjectURL(audio);
      generatedVoice = voice ? audio : null;
      preview.src = outputUrl;
      get('audio-download').href = outputUrl;
      get('audio-download').download = audio.name;
      get('audio-result-name').textContent = voice ? 'Kokoro voice take · ' + values.voice : task === 'song' ? 'ACE-Step song' : 'ACE-Step instrumental';
      get('audio-attach').classList.toggle('hidden', !voice);
      get('audio-result').classList.remove('hidden');
      status.textContent = 'Audio ready. Listen and download your take.';
    } catch (error) {
      if (!controller.signal.aborted) SeekerProvider.pause(error, key);
      status.textContent = controller.signal.aborted
        ? controller.signal.reason === 'timeout' ? 'The audio request timed out. Try again later.' : 'Stopped waiting. The submitted job may still finish.'
        : error.kind ? error.message : 'Audio generation failed. ' + error.message;
    } finally {
      clearTimeout(timeout);
      request = null;
      get('audio-generate').disabled = false;
      get('audio-stop').classList.add('hidden');
      refreshLimit();
    }
  }

  get('audio-task').onchange = updateTask;
  for (const id of ['audio-text', 'audio-voice', 'audio-speed', 'audio-music-prompt', 'audio-lyrics', 'audio-music-length']) {
    get(id).addEventListener('input', invalidateConsent);
    get(id).addEventListener('change', invalidateConsent);
  }
  get('audio-copy-line').onclick = () => {
    get('audio-text').value = document.getElementById('scene-dialogue').value;
    invalidateConsent();
    status.textContent = 'Director dialogue copied. Review the line before generating.';
  };
  get('audio-generate').onclick = generate;
  get('audio-save-brief').onclick = () => {
    const task = get('audio-task').value;
    const description = get('audio-music-prompt').value.trim();
    const lyrics = task === 'song' ? get('audio-lyrics').value.trim() : '[instrumental]';
    if (!description) {
      status.textContent = 'Add a music description before saving the brief.';
      return;
    }
    const brief = ['SEEKER STUDIO MUSIC BRIEF', task, get('audio-music-length').value + ' seconds', description, lyrics].join('\n\n');
    exportDownload('seeker-music-brief.txt', brief, 'text/plain;charset=utf-8');
    status.textContent = 'Music brief downloaded.';
  };
  get('audio-stop').onclick = () => request?.abort('user');
  get('audio-attach').onclick = () => {
    if (generatedVoice) window.dispatchEvent(new CustomEvent('seeker:generated-voice', {
      detail: { file: generatedVoice, report: message => { status.textContent = message; } }
    }));
  };
  refreshLimit = SeekerProvider.watch({
    key: providerKey, busy: () => Boolean(request),
    button: get('audio-generate'), note: get('audio-provider-limit')
  });
  updateTask();
})();
