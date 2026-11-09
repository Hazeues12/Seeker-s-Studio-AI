'use strict';

(() => {
  const get = id => document.getElementById(id);
  const fps = 24;
  const maxFrames = 5 * 60 * fps;
  const maxBytes = 256 * 1024 * 1024;
  const status = get('sequence-status');
  const videoStatus = get('video-sequence-status');
  const download = get('sequence-download');
  const preview = get('sequence-preview');
  const list = get('sequence-list');
  let db, currentClip, rejectExport, outputUrl;
  let clips = [];
  let busy = true;

  const sortClips = entries => entries.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
  const total = entries => entries.reduce((sum, clip) => sum + clip.frames, 0);
  const time = frames => {
    const seconds = Math.floor(frames / fps);
    return Math.floor(seconds / 60) + ':' + String(seconds % 60).padStart(2, '0');
  };

  function openDb() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('seeker_studio_sequence', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('clips', { keyPath: 'id' });
      request.onsuccess = () => resolve(request.result);
      request.onerror = request.onblocked = () => reject(Error('Clip storage is unavailable.'));
    });
  }

  function sequenceTransaction(change) {
    if (!db) return Promise.resolve(change ? change(clips) : clips);
    return new Promise((resolve, reject) => {
      const tx = db.transaction('clips', change ? 'readwrite' : 'readonly');
      const store = tx.objectStore('clips');
      const request = store.getAll();
      let next, failure;
      request.onsuccess = () => {
        try {
          const previous = sortClips(request.result);
          next = change ? change(previous) : previous;
          if (!change) return;
          const before = new Map(previous.map(clip => [clip.id, clip]));
          for (const clip of next) {
            if (before.get(clip.id) !== clip) store.put(clip);
            before.delete(clip.id);
          }
          for (const id of before.keys()) store.delete(id);
        } catch (error) {
          failure = error;
          tx.abort();
        }
      };
      tx.oncomplete = () => resolve(next);
      tx.onabort = () => reject(failure || tx.error || Error('Could not save the sequence on this device.'));
    });
  }

  function mediaJob(message, onProgress) {
    return new Promise((resolve, reject) => {
      const task = new Worker('sequence-worker.js?v=2');
      function finish(callback, value) {
        task.terminate();
        rejectExport = null;
        callback(value);
      }
      if (message.action === 'export') {
        rejectExport = () => finish(reject, new DOMException('Export canceled.', 'AbortError'));
      }
      task.onerror = () => finish(reject, Error('The video encoder could not start. Reload Studio and try again.'));
      task.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress?.(data);
        else if (data.type === 'done') finish(resolve, data.result);
        else if (data.type === 'error') finish(reject, Error(data.message));
      };
      try {
        task.postMessage(message);
      } catch (error) {
        finish(reject, error);
      }
    });
  }

  function clearOutput() {
    if (!outputUrl) return;
    preview.pause();
    preview.removeAttribute('src');
    preview.load();
    preview.classList.add('hidden');
    download.removeAttribute('href');
    download.classList.add('hidden');
    URL.revokeObjectURL(outputUrl);
    outputUrl = null;
  }

  function updateButtons() {
    get('video-add-sequence').disabled = busy || !currentClip;
    get('sequence-export').disabled = busy || !clips.length;
    get('sequence-files').disabled = busy;
    get('sequence-frame').disabled = busy;
    for (const button of list.querySelectorAll('button')) {
      button.disabled = busy || button.dataset.boundary === 'true';
    }
  }

  function actionButton(label, description, action, boundary = false) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'ghost compact-action';
    button.textContent = label;
    button.setAttribute('aria-label', description);
    button.dataset.boundary = String(boundary);
    button.onclick = action;
    return button;
  }

  function renderList() {
    const count = clips.length;
    get('sequence-length').textContent = time(total(clips)) + ' / 5:00 · ' + count + (count === 1 ? ' clip' : ' clips');
    get('sequence-empty').classList.toggle('hidden', Boolean(count));
    list.replaceChildren();
    for (const [index, clip] of clips.entries()) {
      const row = document.createElement('li');
      row.className = 'sequence-row';
      const title = document.createElement('div');
      title.className = 'sequence-clip-title';
      const name = document.createElement('strong');
      name.textContent = clip.file.name;
      const duration = document.createElement('small');
      duration.textContent = 'Shot ' + (index + 1) + ' · ' + (clip.frames / fps).toFixed(1) + ' s';
      title.append(name, duration);
      const actions = document.createElement('div');
      actions.className = 'sequence-actions';
      actions.append(
        actionButton('↑', 'Move shot ' + (index + 1) + ' earlier', () => moveClip(clip.id, -1), index === 0),
        actionButton('↓', 'Move shot ' + (index + 1) + ' later', () => moveClip(clip.id, 1), index === count - 1),
        actionButton('Remove', 'Remove shot ' + (index + 1) + ' from sequence', () => removeClip(clip.id))
      );
      row.append(title, actions);
      list.append(row);
    }
    updateButtons();
  }

  async function changeSequence(change, message) {
    if (busy) return;
    busy = true;
    updateButtons();
    try {
      clips = await sequenceTransaction(change);
      clearOutput();
      status.textContent = message;
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      renderList();
    }
  }

  function moveClip(id, direction) {
    return changeSequence(entries => {
      const index = entries.findIndex(clip => clip.id === id);
      const neighbor = entries[index + direction];
      if (index < 0 || !neighbor) return entries;
      const moved = entries.slice();
      moved[index + direction] = { ...entries[index], order: neighbor.order };
      moved[index] = { ...neighbor, order: entries[index].order };
      return moved;
    }, 'Shot order updated.');
  }

  function removeClip(id) {
    return changeSequence(entries => entries.filter(clip => clip.id !== id), 'Shot removed from the sequence.');
  }

  async function addFiles(files, messageTarget) {
    if (!files.length || busy) return;
    busy = true;
    updateButtons();
    try {
      if (files.length > 300 || files.reduce((sum, file) => sum + file.size, 0) > maxBytes) {
        throw Error('Choose up to 256 MB of video for one sequence.');
      }
      messageTarget.textContent = 'Reading clip details…';
      const info = await mediaJob({ action: 'inspect', files });
      clips = await sequenceTransaction(entries => {
        const start = (entries.at(-1)?.order ?? -1) + 1;
        const next = entries.concat(files.map((file, index) => ({
          ...info[index], file, id: crypto.randomUUID(), order: start + index
        })));
        if (total(next) > maxFrames) throw Error('This would put the sequence over 5:00.');
        if (next.reduce((sum, clip) => sum + clip.file.size, 0) > maxBytes) {
          throw Error('The sequence can hold up to 256 MB of source clips.');
        }
        return next;
      });
      clearOutput();
      messageTarget.textContent = 'Added to sequence · ' + time(total(clips)) + ' / 5:00';
    } catch (error) {
      messageTarget.textContent = error.message;
    } finally {
      busy = false;
      renderList();
    }
  }

  async function exportSequence() {
    if (busy || !clips.length) return;
    const progress = get('sequence-progress');
    const cancel = get('sequence-cancel');
    busy = true;
    updateButtons();
    status.textContent = 'Preparing MP4 export…';
    progress.value = 0;
    progress.classList.remove('hidden');
    try {
      clips = await sequenceTransaction();
      if (!clips.length) throw Error('Add a clip to the sequence first.');
      const frame = get('sequence-frame').value;
      const portrait = frame === 'portrait' || (frame === 'auto' && clips[0].height > clips[0].width);
      cancel.classList.remove('hidden');
      const buffer = await mediaJob({ action: 'export', clips, portrait }, data => {
        progress.value = data.percent;
        const message = 'Exporting clip ' + data.index + ' of ' + data.count + '…';
        if (status.textContent !== message) status.textContent = message;
      });
      clearOutput();
      outputUrl = URL.createObjectURL(new Blob([buffer], { type: 'video/mp4' }));
      preview.src = outputUrl;
      preview.classList.remove('hidden');
      download.href = outputUrl;
      download.classList.remove('hidden');
      status.textContent = 'MP4 ready · ' + time(total(clips));
    } catch (error) {
      status.textContent = error.message;
    } finally {
      busy = false;
      progress.classList.add('hidden');
      cancel.classList.add('hidden');
      renderList();
    }
  }

  get('sequence-files').onchange = event => {
    const files = Array.from(event.target.files);
    event.target.value = '';
    addFiles(files, status);
  };
  get('sequence-frame').onchange = () => {
    clearOutput();
    status.textContent = '';
  };
  get('sequence-export').onclick = exportSequence;
  get('sequence-cancel').onclick = () => rejectExport?.();
  get('video-add-sequence').onclick = () => {
    if (currentClip) addFiles([currentClip], videoStatus);
  };
  window.addEventListener('seeker:clip', event => {
    currentClip = event.detail;
    videoStatus.textContent = '';
    get('video-add-sequence').classList.remove('hidden');
    updateButtons();
  });

  (async () => {
    try {
      db = await openDb();
      clips = await sequenceTransaction();
    } catch (error) {
      db = null;
      get('sequence-storage').textContent = 'Storage is unavailable. Keep this tab open to keep your clips.';
    } finally {
      busy = false;
      renderList();
    }
  })();
})();
