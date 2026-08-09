let solutionsVisible = false;

/* Live state: the full parsed JSON object, and the array reference inside it
   that actually holds the question objects. Both are refreshed on every
   render, and edit/delete/add mutate them then re-render from the result. */
let currentParsed = null;
let currentDataArr = null;
let editingIndex = null;

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

/* Returns true if a value counts as "present" (non-empty string, non-empty array, etc) */
function hasValue(v) {
    if (v === null || v === undefined) return false;
    if (typeof v === 'string') return v.trim() !== '';
    if (Array.isArray(v)) return v.length > 0;
    return true;
}

/* All translation entries, safely, regardless of key name variants */
function getTranslations(q) {
    const t = pick(q, ['translations', 'translation', 'langs', 'languages'], []);
    return Array.isArray(t) ? t : [];
}

/* Find a translation entry by language pattern (e.g. /english|eng|en/i) */
function findTranslation(q, langRegex) {
    return getTranslations(q).find(t => langRegex.test(pick(t, ['lang', 'language', 'code'], '')));
}

/* The "primary" translation to source main text/options/solution/image from
   when the top-level fields are empty. Prefers English, else first entry. */
function getPrimaryTranslation(q) {
    const list = getTranslations(q);
    if (!list.length) return null;
    return findTranslation(q, /english|eng|^en$/i) || list[0];
}

/* The "secondary" translation shown as the alt/second-language line.
   Prefers Hindi, else the first entry that differs from the primary. */
function getSecondaryTranslation(q) {
    const list = getTranslations(q);
    if (!list.length) return null;
    const hindi = findTranslation(q, /hindi|hin|^hi$/i);
    if (hindi) return hindi;
    const primary = getPrimaryTranslation(q);
    const diff = list.find(t => t !== primary);
    return diff || null;
}

/* Generic resolver: try top-level keys first; if empty, try the same keys
   inside the primary translation. */
function resolveField(q, keys, primary) {
    const direct = pick(q, keys, undefined);
    if (hasValue(direct)) return direct;
    if (primary) {
        const alt = pick(primary, keys, undefined);
        if (hasValue(alt)) return alt;
    }
    return undefined;
}

function getQuestionText(q, primary) {
    return resolveField(q, ['question', 'text', 'q', 'questionText', 'title'], primary) || '';
}

function getQuestionTextAlt(q, secondary) {
    if (secondary) {
        const t = pick(secondary, ['question', 'text', 'q', 'questionText'], '');
        if (hasValue(t)) return t;
    }
    return pick(q, ['questionHindi', 'text_hi', 'hindiText'], '');
}

function getQuestionImage(q, primary) {
    return resolveField(q, ['questionImage', 'qImage', 'image'], primary) || null;
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

/* True if every option in the array has blank text and no image */
function optionsAreBlank(rawOptions) {
    if (!Array.isArray(rawOptions) || !rawOptions.length) return true;
    return rawOptions.every(o => {
        const n = normalizeOption(o);
        return !hasValue(n.text) && !hasValue(n.image);
    });
}

function getOptions(q, primary) {
    let raw = pick(q, ['options', 'choices', 'answers'], []);
    if (optionsAreBlank(raw) && primary) {
        const altRaw = pick(primary, ['options', 'choices', 'answers'], []);
        if (!optionsAreBlank(altRaw)) raw = altRaw;
    }
    if (!Array.isArray(raw)) return [];
    return raw.map(normalizeOption);
}

/* Options from the secondary (e.g. Hindi) translation, shown alongside
   the main options — same pattern as getQuestionTextAlt for the question. */
function getOptionsAlt(q, secondary) {
    if (!secondary) return [];
    const raw = pick(secondary, ['options', 'choices', 'answers'], []);
    if (optionsAreBlank(raw)) return [];
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

function getSolution(q, primary) {
    let raw = pick(q, ['solution', 'sol', 'explanation'], null);
    let obj = getSolutionObj(raw);
    if (!hasValue(obj.text) && !hasValue(obj.image) && primary) {
        const altRaw = pick(primary, ['solution', 'sol', 'explanation'], null);
        const altObj = getSolutionObj(altRaw);
        if (hasValue(altObj.text) || hasValue(altObj.image)) obj = altObj;
    }
    return obj;
}

function getSolutionAlt(q, secondary) {
    if (secondary) {
        const raw = pick(secondary, ['solution', 'sol', 'explanation'], null);
        if (raw) {
            const obj = getSolutionObj(raw);
            if (hasValue(obj.text) || hasValue(obj.image)) return obj;
        }
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
        currentParsed = null;
        currentDataArr = null;
        return;
    }

    let parsed, data;
    try {
        parsed = JSON.parse(input);
    } catch (e) {
        output.innerHTML = `<div class="err-msg">Invalid JSON syntax:\n${escapeHtml(e.message)}\n\nCheck for trailing commas, unquoted keys, or mismatched brackets.</div>`;
        status.textContent = 'Invalid JSON syntax — see message in the paper area.';
        currentParsed = null;
        currentDataArr = null;
        return;
    }

    try {
        data = normalizeData(parsed);
    } catch (e) {
        output.innerHTML = `<div class="err-msg">${escapeHtml(e.message)}</div>`;
        status.textContent = 'Could not locate questions in the JSON.';
        currentParsed = null;
        currentDataArr = null;
        return;
    }

    /* Keep live references so edit/delete/add can mutate the real JSON
       structure (whatever shape it came in as) and stay in sync. */
    currentParsed = parsed;
    currentDataArr = data;

    if (!data.length) {
        output.innerHTML = '<div class="empty-msg">No questions found in JSON.</div>';
        return;
    }

    const title = pick(data[0], ['paperTitle', 'title'], null) || pick(data[0], ['subject', 'sub'], null) || 'MCQ Paper';
    let skipped = 0;

    const html = data.map((q, idx) => {
        if (!q || typeof q !== 'object') { skipped++; return ''; }

        const primary = getPrimaryTranslation(q);
        const secondary = getSecondaryTranslation(q);

        const qNum = pick(q, ['order', 'qNo', 'number'], idx + 1);
        const qText = getQuestionText(q, primary);
        const qTextAlt = getQuestionTextAlt(q, secondary);
        const qImg = getQuestionImage(q, primary);
        const options = getOptions(q, primary);
        const optionsAlt = getOptionsAlt(q, secondary);
        const correctSet = getCorrectSet(q, options);
        const numericAnswer = getNumericAnswer(q);
        const solution = getSolution(q, primary);
        const solutionAlt = getSolutionAlt(q, secondary);
        const meta = showMeta ? getMeta(q) : [];

        if (!hasValue(qText) && !hasValue(qImg)) { skipped++; return ''; }

        const toolbarHtml = `<div class="q-card-toolbar">
                <button type="button" class="edit-btn" onclick="openEditForm(${idx})">Edit</button>
                <button type="button" class="delete-btn" onclick="deleteQuestion(${idx})">Delete</button>
            </div>`;

        const metaHtml = meta.length
            ? `<div class="q-head"><span>${meta.map(m => `<span class="badge">${escapeHtml(m)}</span>`).join('')}</span></div>`
            : '';

        const optionsHtml = options.map((opt, i) => {
            const letter = String.fromCharCode(65 + i);
            const isCorrect = correctSet.has(i);
            const altOpt = optionsAlt[i];
            const altHtml = (altOpt && hasValue(altOpt.text))
                ? `<span class="opt-alt">${escapeHtml(altOpt.text)}${renderImageTag(altOpt.image, 'opt-img')}</span>`
                : '';
            return `<div class="option${isCorrect ? ' correct' : ''}">
                        <span class="opt-label">(${letter})</span>
                        <span>${escapeHtml(opt.text)}${renderImageTag(opt.image, 'opt-img')}${altHtml}</span>
                    </div>`;
        }).join('');

        const numericHtml = (numericAnswer !== null)
            ? `<div class="numeric-ans">Answer: ${escapeHtml(numericAnswer)}</div>`
            : '';

        const hasSol = hasValue(solution.text) || hasValue(solution.image) || (solutionAlt && (hasValue(solutionAlt.text) || hasValue(solutionAlt.image)));
        const solutionHtml = hasSol ? `
            <div class="sol-btn" onclick="toggleOne(this)">View Solution</div>
            <div class="sol" style="display:${solutionsVisible ? 'block' : 'none'};">
                ${escapeHtml(solution.text)}
                ${renderImageTag(solution.image, 'sol-img')}
                ${solutionAlt ? `<hr style="border:none;border-top:1px dashed #ddd;margin:6px 0;">${escapeHtml(solutionAlt.text)}${renderImageTag(solutionAlt.image, 'sol-img')}` : ''}
            </div>` : '';

        return `<div class="q-box" data-index="${idx}">
                    ${toolbarHtml}
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

/* ---------- Sync helper: push in-memory changes back into the JSON textarea ---------- */

function syncTextareaFromState() {
    if (!currentParsed) return;
    document.getElementById('json-input').value = JSON.stringify(currentParsed, null, 2);
}

/* ---------- Delete ---------- */

function deleteQuestion(idx) {
    if (!currentDataArr || !currentDataArr[idx]) return;
    const qText = getQuestionText(currentDataArr[idx], getPrimaryTranslation(currentDataArr[idx]));
    const preview = qText ? (qText.length > 60 ? qText.slice(0, 60) + '…' : qText) : `question #${idx + 1}`;
    if (!confirm(`Delete this question?\n\n"${preview}"\n\nThis removes it from the JSON too.`)) return;

    currentDataArr.splice(idx, 1);
    syncTextareaFromState();
    renderPaper();
}

/* ---------- Add ---------- */

function addNewQuestion() {
    if (!currentParsed || !currentDataArr) {
        // Nothing rendered yet — start a fresh minimal document.
        currentParsed = [];
        currentDataArr = currentParsed;
    }
    const blank = {
        question: '',
        questionImage: null,
        options: [{ text: '', image: null }, { text: '', image: null }],
        correctAnswers: [],
        numericAnswer: null,
        solution: { text: '', image: null }
    };
    currentDataArr.push(blank);
    syncTextareaFromState();
    renderPaper().then(() => openEditForm(currentDataArr.length - 1));
}

/* ---------- Edit modal ---------- */

function openEditForm(idx) {
    if (!currentDataArr || !currentDataArr[idx]) return;
    editingIndex = idx;
    const q = currentDataArr[idx];
    const primary = getPrimaryTranslation(q);
    const options = getOptions(q, primary);
    const correctSet = getCorrectSet(q, options);
    const numericAnswer = getNumericAnswer(q);
    const solution = getSolution(q, primary);

    document.getElementById('modal-title').textContent = `Edit Question ${idx + 1}`;
    document.getElementById('f-question').value = getQuestionText(q, primary);
    document.getElementById('f-question-image').value = getQuestionImage(q, primary) || '';
    document.getElementById('f-numeric-answer').value = (numericAnswer === null) ? '' : numericAnswer;
    document.getElementById('f-solution').value = solution.text || '';
    document.getElementById('f-solution-image').value = solution.image || '';

    const list = document.getElementById('f-options-list');
    list.innerHTML = '';
    const optsToShow = options.length ? options : [{ text: '', image: null }, { text: '', image: null }];
    optsToShow.forEach((opt, i) => addOptionRow(opt.text, opt.image, correctSet.has(i)));

    document.getElementById('edit-modal-overlay').classList.add('open');
}

function closeEditForm() {
    document.getElementById('edit-modal-overlay').classList.remove('open');
    editingIndex = null;
}

function addOptionRow(text = '', image = null, checked = false) {
    const list = document.getElementById('f-options-list');
    const row = document.createElement('div');
    row.className = 'opt-row';
    const letterIndex = list.children.length;
    row.innerHTML = `
        <span class="opt-letter">${String.fromCharCode(65 + letterIndex)}</span>
        <input type="checkbox" class="opt-correct" ${checked ? 'checked' : ''} title="Mark as correct" />
        <input type="text" class="opt-text" placeholder="Option text" value="${escapeHtml(text)}" />
        <input type="text" class="opt-img-input" placeholder="Image URL (optional)" value="${escapeHtml(image || '')}" />
        <button type="button" class="remove-opt-btn" onclick="removeOptionRow(this)" title="Remove option">&times;</button>
    `;
    list.appendChild(row);
}

function removeOptionRow(btn) {
    const list = document.getElementById('f-options-list');
    if (list.children.length <= 1) return; // keep at least one option row
    btn.closest('.opt-row').remove();
    // Re-letter remaining rows
    Array.from(list.children).forEach((row, i) => {
        row.querySelector('.opt-letter').textContent = String.fromCharCode(65 + i);
    });
}

function saveEditForm() {
    if (editingIndex === null || !currentDataArr || !currentDataArr[editingIndex]) {
        closeEditForm();
        return;
    }
    const q = currentDataArr[editingIndex];

    const questionText = document.getElementById('f-question').value.trim();
    if (!questionText) {
        alert('Question text cannot be empty.');
        return;
    }

    const questionImage = document.getElementById('f-question-image').value.trim();
    const numericAnswerRaw = document.getElementById('f-numeric-answer').value.trim();
    const solutionText = document.getElementById('f-solution').value.trim();
    const solutionImage = document.getElementById('f-solution-image').value.trim();

    const optionRows = Array.from(document.getElementById('f-options-list').children);
    const options = [];
    const correctAnswers = [];
    optionRows.forEach((row, i) => {
        const text = row.querySelector('.opt-text').value.trim();
        const image = row.querySelector('.opt-img-input').value.trim();
        const isCorrect = row.querySelector('.opt-correct').checked;
        if (!text && !image) return; // skip fully empty rows
        options.push({ text, image: image || null });
        if (isCorrect) correctAnswers.push(options.length - 1);
    });

    // Write edited values directly onto the top-level question object —
    // these take precedence over any translation fallback when rendered.
    q.question = questionText;
    q.questionImage = questionImage || null;
    q.options = options;
    q.correctAnswers = correctAnswers;
    q.numericAnswer = numericAnswerRaw === '' ? null : numericAnswerRaw;
    q.solution = { text: solutionText, image: solutionImage || null };

    syncTextareaFromState();
    closeEditForm();
    renderPaper();
}

// Close modal when clicking the dark overlay (outside the modal box)
document.getElementById('edit-modal-overlay').addEventListener('click', function (e) {
    if (e.target === this) closeEditForm();
});
