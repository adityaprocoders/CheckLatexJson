let solutionsVisible = false;

document.getElementById('file-input').addEventListener('change', function (e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = function (evt) {
        document.getElementById('json-input').value = evt.target.result;
        renderPaper();
    };
    reader.readAsText(file);
});

document.getElementById('single-col-toggle').addEventListener('change', function () {
    document.getElementById('output').classList.toggle('single-col', this.checked);
});

/* ---------- Normalization layer: accepts near-arbitrary shapes ---------- */

function normalizeData(parsed) {
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
        for (const key of ['questions', 'data', 'items', 'mcqs', 'questionList']) {
            if (Array.isArray(parsed[key])) return parsed[key];
        }
        const questionKeys = ['question', 'text', 'q', 'questionText'];
        if (questionKeys.some(k => k in parsed)) return [parsed];
        const vals = Object.values(parsed);
        if (vals.length && vals.every(v => v && typeof v === 'object')) return vals;
    }
    throw new Error('Could not find a list of questions in this JSON. Expected an array, or an object with a "questions" array, or a single question object.');
}

function pick(obj, keys, fallback) {
    for (const k of keys) {
        if (obj && obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
    }
    return fallback;
}

function getQuestionText(q) {
    const direct = pick(q, ['question', 'text', 'q', 'questionText', 'title'], '');
    if (direct) return direct;
    // Top-level question empty (jaisa aapke schema me hota hai) —
    // English translation se fallback lo, na mile to pehla translation.
    if (Array.isArray(q.translations) && q.translations.length) {
        const eng = q.translations.find(t => /english|eng|en/i.test(pick(t, ['lang', 'language', 'code'], '')));
        const source = eng || q.translations[0];
        return pick(source, ['question', 'text', 'q', 'questionText'], '');
    }
    return '';
}

function getQuestionTextAlt(q) {
    const t = getTranslation(q);
    if (t) return pick(t, ['question', 'text', 'q', 'questionText'], '');
    return pick(q, ['questionHindi', 'text_hi', 'hindiText'], '');
}

function getTranslation(q) {
    if (!Array.isArray(q.translations) || !q.translations.length) return null;
    // Prefer an entry explicitly tagged as Hindi
    const hindi = q.translations.find(t => /hindi|hin|hi/i.test(pick(t, ['lang', 'language', 'code'], '')));
    if (hindi) return hindi;
    // Otherwise, pick the first entry whose question text differs from the main question
    // (this skips a duplicate "English" entry that just repeats the main text)
    const mainQ = getQuestionText(q);
    const diff = q.translations.find(t => pick(t, ['question', 'text', 'q', 'questionText'], '') !== mainQ);
    if (diff) return diff;
    return q.translations[0];
}

function getQuestionImage(q) {
    return pick(q, ['questionImage', 'qImage', 'image'], null);
}

function normalizeOption(opt) {
    if (typeof opt === 'string') return { text: opt, image: null };
    if (opt && typeof opt === 'object') {
        return {
            text: pick(opt, ['text', 'label', 'value', 'option'], ''),
            image: pick(opt, ['image', 'img'], null)
        };
    }
    return { text: String(opt), image: null };
}

function getOptions(q) {
    let raw = pick(q, ['options', 'choices', 'answers'], []);
    // Agar top-level options khaali text wale hain, translation se le lo
    const isBlank = !Array.isArray(raw) || raw.every(o => !pick(normalizeOption(o), ['text'], ''));
    if (isBlank && Array.isArray(q.translations) && q.translations.length) {
        const eng = q.translations.find(t => /english|eng|en/i.test(pick(t, ['lang', 'language', 'code'], '')));
        const source = eng || q.translations[0];
        const altRaw = pick(source, ['options', 'choices', 'answers'], []);
        if (Array.isArray(altRaw) && altRaw.length) raw = altRaw;
    }
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeOption);
}

function getCorrectSet(q, options) {
    let raw = pick(q, ['correctAnswers', 'correctAnswer', 'correct', 'answer', 'correctOption', 'correctOptions'], []);
    if (raw === null || raw === undefined || raw === '') return new Set();
    if (!Array.isArray(raw)) raw = [raw];

    const set = new Set();
    raw.forEach(val => {
        if (typeof val === 'number') { set.add(val); return; }
        if (typeof val === 'string') {
            const trimmed = val.trim();
            if (/^\d+$/.test(trimmed)) { set.add(Number(trimmed)); return; }
            if (/^[A-Za-z]$/.test(trimmed)) { set.add(trimmed.toUpperCase().charCodeAt(0) - 65); return; }
            const idx = options.findIndex(o => o.text.trim().toLowerCase() === trimmed.toLowerCase());
            if (idx !== -1) set.add(idx);
        }
    });
    return set;
}

function getNumericAnswer(q) {
    const v = pick(q, ['numericAnswer', 'numericalAnswer', 'numeric_answer'], null);
    return (v === null || v === undefined || v === '') ? null : v;
}

function getSolutionObj(raw) {
    if (raw === null || raw === undefined) return { text: '', image: null };
    if (typeof raw === 'string') return { text: raw, image: null };
    if (typeof raw === 'object') {
        return { text: pick(raw, ['text', 'explanation'], ''), image: pick(raw, ['image', 'img'], null) };
    }
    return { text: String(raw), image: null };
}

function getSolution(q) {
    const raw = pick(q, ['solution', 'sol', 'explanation'], null);
    return getSolutionObj(raw);
}

function getSolutionAlt(q) {
    const t = getTranslation(q);
    if (t) {
        const raw = pick(t, ['solution', 'sol', 'explanation'], null);
        if (raw) return getSolutionObj(raw);
    }
    return null;
}

function getMeta(q) {
    const parts = [];
    const subject = pick(q, ['subject', 'sub'], null);
    const topic = pick(q, ['topic'], null);
    const subTopic = pick(q, ['subTopic', 'section'], null);
    const difficulty = pick(q, ['difficulty'], null);
    const posMarks = pick(q, ['positiveMarks'], null);
    const negMarks = pick(q, ['negativeMarks'], null);
    if (subject) parts.push(subject);
    if (topic) parts.push(topic);
    if (subTopic) parts.push(subTopic);
    if (difficulty) parts.push(difficulty);
    if (posMarks !== null || negMarks !== null) {
        parts.push(`+${posMarks ?? 0} / -${negMarks ?? 0}`);
    }
    return parts;
}

function escapeHtml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}

function renderImageTag(src, cls) {
    if (!src) return '';
    return `<img class="${cls}" src="${escapeHtml(src)}" />`;
}

/* ---------- Rendering ---------- */

async function renderPaper() {
    const input = document.getElementById('json-input').value;
    const output = document.getElementById('output');
    const status = document.getElementById('status');
    const showMeta = document.getElementById('show-meta-toggle').checked;
    status.textContent = '';

    if (!input.trim()) {
        status.textContent = 'Paste or upload some JSON first.';
        return;
    }

    let parsed, data;
    try {
        parsed = JSON.parse(input);
    } catch (e) {
        output.innerHTML = `<div class="err-msg">Invalid JSON syntax:\n${escapeHtml(e.message)}\n\nCheck for trailing commas, unquoted keys, or mismatched brackets.</div>`;
        status.textContent = 'Invalid JSON syntax — see message in the paper area.';
        return;
    }

    try {
        data = normalizeData(parsed);
    } catch (e) {
        output.innerHTML = `<div class="err-msg">${escapeHtml(e.message)}</div>`;
        status.textContent = 'Could not locate questions in the JSON.';
        return;
    }

    if (!data.length) {
        output.innerHTML = '<div class="empty-msg">No questions found in JSON.</div>';
        return;
    }

    const title = pick(data[0], ['paperTitle', 'title'], null) || pick(data[0], ['subject', 'sub'], null) || 'MCQ Paper';
    let skipped = 0;

    const html = data.map((q, idx) => {
        if (!q || typeof q !== 'object') { skipped++; return ''; }

        const qNum = pick(q, ['order', 'qNo', 'number'], idx + 1);
        const qText = getQuestionText(q);
        const qTextAlt = getQuestionTextAlt(q);
        const qImg = getQuestionImage(q);
        const options = getOptions(q);
        const correctSet = getCorrectSet(q, options);
        const numericAnswer = getNumericAnswer(q);
        const solution = getSolution(q);
        const solutionAlt = getSolutionAlt(q);
        const meta = showMeta ? getMeta(q) : [];

        if (!qText && !qImg) { skipped++; return ''; }

        const metaHtml = meta.length
            ? `<div class="q-head"><span>${meta.map(m => `<span class="badge">${escapeHtml(m)}</span>`).join('')}</span></div>`
            : '';

        const optionsHtml = options.map((opt, i) => {
            const letter = String.fromCharCode(65 + i);
            const isCorrect = correctSet.has(i);
            return `<div class="option${isCorrect ? ' correct' : ''}">
                        <span class="opt-label">(${letter})</span>
                        <span>${escapeHtml(opt.text)}${renderImageTag(opt.image, 'opt-img')}</span>
                    </div>`;
        }).join('');

        const numericHtml = (numericAnswer !== null)
            ? `<div class="numeric-ans">Answer: ${escapeHtml(numericAnswer)}</div>`
            : '';

        const hasSol = solution.text || solution.image || (solutionAlt && (solutionAlt.text || solutionAlt.image));
        const solutionHtml = hasSol ? `
            <div class="sol-btn" onclick="toggleOne(this)">View Solution</div>
            <div class="sol" style="display:${solutionsVisible ? 'block' : 'none'};">
                ${escapeHtml(solution.text)}
                ${renderImageTag(solution.image, 'sol-img')}
                ${solutionAlt ? `<hr style="border:none;border-top:1px dashed #ddd;margin:6px 0;">${escapeHtml(solutionAlt.text)}${renderImageTag(solutionAlt.image, 'sol-img')}` : ''}
            </div>` : '';

        return `<div class="q-box">
                    ${metaHtml}
                    <div class="q-text">Q${escapeHtml(qNum)}. ${escapeHtml(qText)}</div>
                    ${qTextAlt ? `<div class="q-text-hi">${escapeHtml(qTextAlt)}</div>` : ''}
                    ${renderImageTag(qImg, 'q-img')}
                    ${optionsHtml}
                    ${numericHtml}
                    ${solutionHtml}
                </div>`;
    }).join('');

    output.innerHTML = `<div id="paper-title"><h1>${escapeHtml(title)}</h1></div>` + html;

    status.textContent = skipped
        ? `Rendered ${data.length - skipped} question(s). Skipped ${skipped} empty/invalid entr${skipped === 1 ? 'y' : 'ies'}.`
        : `Rendered ${data.length} question(s).`;
    status.style.color = skipped ? '#c0392b' : '#27ae60';

    if (window.MathJax && window.MathJax.typesetPromise) {
        await MathJax.typesetPromise([output]);
    }
}

function toggleOne(btn) {
    const sol = btn.nextElementSibling;
    sol.style.display = (sol.style.display === 'block') ? 'none' : 'block';
}

function toggleAllSolutions() {
    solutionsVisible = !solutionsVisible;
    document.querySelectorAll('.sol').forEach(el => {
        el.style.display = solutionsVisible ? 'block' : 'none';
    });
}
