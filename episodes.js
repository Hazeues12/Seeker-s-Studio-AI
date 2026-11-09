'use strict';

(() => {
  const by = id => document.getElementById(id);
  const titleKey = title => String(title || '')
    .replace(/^(?:(?:chapter|ch\.?)\s+\d+\b\s*[:.·–—-]?\s*|\d+\s*[:.·–—-]\s*)/i, '')
    .normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/[’']/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
    .replace(/^trial by mercy /, '').replace(/\bpt (\d+)\b/g, 'part $1');
  const cleanLine = text => text.trim().replace(/^[“"]|[”"]$/g, '').replace(/\s+/g, ' ');

  function chapterMatch(catalog, series, title) {
    const key = titleKey(title);
    if (!key) return null;
    const matches = (catalog?.series?.[series]?.chapters || []).filter(chapter => titleKey(chapter.title) === key);
    return matches.length === 1 ? matches[0] : null;
  }

  function sourceQuotes(text) {
    return [...text.matchAll(/“([^”]+)”|"([^"\n]+)"/g)].map(match => cleanLine(match[1] ?? match[2])).filter(Boolean);
  }

  function matchesDialogue(excerpt, dialogue) {
    const quotes = new Set(sourceQuotes(excerpt));
    return dialogue.split(/\r\n?|\n/).map(cleanLine).filter(Boolean).every(line => quotes.has(line));
  }

  function lineStarts(text) {
    return [0, ...Array.from(text.matchAll(/\r\n?|\n/g), match => match.index + match[0].length)];
  }

  function lineNumber(starts, offset) {
    let low = 0, high = starts.length;
    while (low + 1 < high) {
      const middle = Math.floor((low + high) / 2);
      if (starts[middle] <= offset) low = middle;
      else high = middle;
    }
    return low + 1;
  }

  function passage(text, start, end, starts = lineStarts(text)) {
    const selection = text.slice(start, end);
    const excerpt = selection.trim();
    if (!excerpt) return null;
    const first = start + selection.length - selection.trimStart().length;
    return {
      excerpt,
      firstLine: lineNumber(starts, first),
      lastLine: lineNumber(starts, first + excerpt.length - 1)
    };
  }

  function planBeats(text) {
    const starts = lineStarts(text);
    const breaks = Array.from(text.matchAll(/^[ \t]*(?:\*{3,}|-{3,}|_{3,}|={3,})[ \t]*\r?$/gm));
    const boundaries = breaks.map(match => [match.index, match.index + match[0].length]);
    boundaries.push([text.length, text.length]);
    const beats = [];
    let offset = 0;
    for (const [sectionEnd, nextSection] of boundaries) {
      const section = text.slice(offset, sectionEnd);
      const words = Array.from(section.matchAll(/\S{1,800}/g));
      for (let from = 0; from < words.length;) {
        const start = words[from].index;
        let to = Math.min(words.length, from + 65);
        while (to > from + 1 && words[to - 1].index + words[to - 1][0].length - start > 1800) to--;
        if (to < words.length) {
          for (let i = to; i >= from + 36; i--) {
            if (/[.!?…][”"’)]?$/.test(words[i - 1][0])) {
              to = i;
              break;
            }
          }
        }
        const last = words[to - 1];
        beats.push(passage(text, offset + start, offset + last.index + last[0].length, starts));
        from = to;
      }
      offset = nextSection;
    }
    return beats;
  }

  function actionStarter(excerpt) {
    const first = excerpt.match(/^[^“"\r\n.!?…]{1,310}[.!?…](?=\s|$)/);
    return first?.[0].trim() || '';
  }

  function init({ currentChapter, documents, openChapter, stageBeat, navigate, notify }) {
    const series = by('episode-series');
    const chapters = by('episode-chapter');
    const picker = by('episode-beat');
    const catalogStatus = by('episode-coverage');
    const planPanel = by('episode-plan');
    let catalog, activeDoc, beats = [], savedByChapter = new Map();

    function findSaved(chapter) {
      return savedByChapter.get(chapter?.id);
    }

    function currentEntry() {
      return catalog?.series[series.value]?.chapters.find(chapter => chapter.id === chapters.value);
    }

    function updateSelection() {
      const chapter = currentEntry();
      const link = by('episode-publisher');
      link.classList.toggle('hidden', !chapter);
      if (chapter) link.href = chapter.url;
      else link.removeAttribute('href');
      const saved = findSaved(chapter);
      by('episode-open-text').textContent = saved ? 'Open chapter text' : 'Add chapter text';
      by('episode-open-text').disabled = !chapter;
      by('episode-plan-saved').disabled = !saved;
      by('episode-text-status').textContent = !chapter ? '' : !saved
        ? 'The chapter is indexed. Add its manuscript text to plan it.'
        : saved.kind === 'published' ? 'Published text saved here (author-marked).' : 'Draft text saved here.';
    }

    function renderCatalog(preferredId = chapters.value) {
      const entries = catalog?.series[series.value]?.chapters || [];
      savedByChapter = new Map();
      for (const doc of documents()) {
        if (doc.series !== series.value || doc.kind === 'notes' || !doc.content.trim()) continue;
        const match = chapterMatch(catalog, doc.series, doc.title);
        if (!match) continue;
        const previous = findSaved(match);
        if (!previous || (doc.kind === previous.kind ? doc.updated > previous.updated : doc.kind === 'published')) {
          savedByChapter.set(match.id, doc);
        }
      }
      const savedCount = entries.filter(chapter => findSaved(chapter)?.kind === 'published').length;
      const placeholder = document.createElement('option');
      placeholder.value = '';
      placeholder.textContent = entries.length ? 'Choose a published chapter' : 'Chapter index unavailable';
      chapters.replaceChildren(placeholder, ...entries.map((chapter, index) => {
        const option = document.createElement('option');
        option.value = chapter.id;
        option.textContent = (index + 1) + ' · ' + chapter.title;
        return option;
      }));
      chapters.disabled = !entries.length;
      if (entries.some(chapter => chapter.id === preferredId)) chapters.value = preferredId;
      if (entries.length) {
        catalogStatus.textContent = savedCount + ' of ' + entries.length + ' indexed entries have author-marked published text saved here.';
      }
      updateSelection();
    }

    function renderBeat() {
      const index = Number(picker.value);
      const beat = beats[index];
      if (!beat) return;
      by('episode-excerpt').textContent = beat.excerpt;
      const quotes = [...new Set(sourceQuotes(beat.excerpt))].filter(quote => quote.length <= 160);
      const quoteSelect = by('episode-quote');
      quoteSelect.replaceChildren();
      const noLine = document.createElement('option');
      noLine.value = '';
      noLine.textContent = 'No dialogue';
      quoteSelect.append(noLine);
      for (const quote of quotes) {
        const option = document.createElement('option');
        option.value = quote;
        option.textContent = quote;
        quoteSelect.append(option);
      }
      by('episode-quote-field').classList.toggle('hidden', !quotes.length);
      by('episode-prev').disabled = index === 0;
      by('episode-next').disabled = index >= beats.length - 1;
    }

    function plan(doc) {
      if (!doc?.title?.trim() || !doc.content.trim() || doc.kind === 'notes') {
        notify('Open a chapter with a title and manuscript text to make an episode plan.');
        return false;
      }
      const next = planBeats(doc.content);
      if (!next.length) {
        notify('Add chapter prose before planning an episode.');
        return false;
      }
      activeDoc = doc;
      beats = next;
      series.value = doc.series;
      renderCatalog(chapterMatch(catalog, doc.series, doc.title)?.id || '');
      by('episode-plan-title').textContent = doc.title;
      by('episode-plan-summary').textContent = beats.length + (beats.length === 1 ? ' source beat' : ' source beats') +
        ' · ' + (doc.kind === 'published' ? 'Published text (author-marked)' : 'Draft text') +
        (doc.saved ? ' · saved' : ' · unsaved snapshot');
      picker.replaceChildren(...beats.map((beat, index) => {
        const option = document.createElement('option');
        option.value = String(index);
        option.textContent = 'Beat ' + (index + 1) + ' · lines ' + beat.firstLine + '–' + beat.lastLine;
        return option;
      }));
      planPanel.classList.remove('hidden');
      renderBeat();
      navigate('episode');
      return true;
    }

    function openSource(source) {
      const sameVersion = doc => doc?.id === source.documentId && doc.updated === source.updated;
      if (!sameVersion(activeDoc)) {
        const doc = documents().find(sameVersion);
        if (doc) plan({ ...doc, saved: true });
        else {
          planPanel.classList.add('hidden');
          series.value = source.series;
          renderCatalog(chapterMatch(catalog, source.series, source.title)?.id || '');
          navigate('episode');
          return;
        }
      }
      if (source.beat && beats[source.beat - 1]) picker.value = String(source.beat - 1);
      planPanel.classList.remove('hidden');
      renderBeat();
      navigate('episode');
    }

    by('brain-episode').onclick = () => {
      const current = currentChapter();
      if (current.title.trim() && current.content.trim() && current.kind !== 'notes') {
        if (activeDoc?.series === current.series && activeDoc.title === current.title && activeDoc.content === current.content && activeDoc.kind === current.kind && activeDoc.saved === current.saved) {
          planPanel.classList.remove('hidden');
          renderCatalog();
          navigate('episode');
        } else {
          plan(current);
        }
      } else {
        renderCatalog();
        navigate('episode');
      }
    };
    by('episode-back').onclick = () => navigate('brain');
    series.onchange = () => renderCatalog('');
    chapters.onchange = updateSelection;
    by('episode-open-text').onclick = () => {
      const chapter = currentEntry();
      if (chapter) openChapter(findSaved(chapter), series.value, chapter.title);
    };
    by('episode-plan-saved').onclick = () => {
      const doc = findSaved(currentEntry());
      if (doc) plan({ ...doc, saved: true });
    };
    picker.onchange = renderBeat;
    for (const [id, delta] of [['episode-prev', -1], ['episode-next', 1]]) {
      by(id).onclick = () => {
        picker.value = String(Number(picker.value) + delta);
        renderBeat();
      };
    }
    by('episode-stage').onclick = () => {
      const index = Number(picker.value);
      const beat = beats[index];
      if (beat) stageBeat(activeDoc, beat, index + 1, by('episode-quote').value);
    };

    fetch('chapter-catalog.json?v=1', { credentials: 'same-origin' }).then(response => {
      if (!response.ok) throw Error('Catalog unavailable.');
      return response.json();
    }).then(data => {
      if (!data.series || !data.checked) throw Error('Catalog unavailable.');
      catalog = data;
      by('episode-index-date').textContent = 'Royal Road index · ' + data.checked;
      renderCatalog(activeDoc ? chapterMatch(catalog, activeDoc.series, activeDoc.title)?.id || '' : '');
    }).catch(() => {
      catalogStatus.textContent = 'Published index unavailable. You can still plan from saved or pasted chapter text.';
    });

    return { refresh: () => renderCatalog(), plan, openSource };
  }

  globalThis.SeekerEpisodes = { init, planBeats, passage, actionStarter, matchesDialogue, chapterMatch, titleKey };
})();
