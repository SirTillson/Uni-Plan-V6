"use strict";

/* =========================================================
   KONFIGURATION UND DATEN
   ========================================================= */

const DB_KEY = "uniplan_v7";
const SCHEMA_VERSION = 7;

const LEGACY_KEYS = [
    "uniplan_v6",
    "uniplan_v5",
    "uniplan_v3",
    "uniplan_data_v1"
];

const DAYS = [
    "Montag",
    "Dienstag",
    "Mittwoch",
    "Donnerstag",
    "Freitag",
    "Samstag",
    "Sonntag"
];

const COURSE_COLORS = [
    "#3b82f6",
    "#10b981",
    "#8b5cf6",
    "#f59e0b",
    "#ec4899",
    "#06b6d4",
    "#ef4444",
    "#84cc16"
];

let state = createDefaultState();
let todoFilter = "open";
let toastTimer = null;
let undoTimer = null;
let confirmResolver = null;
let importResolver = null;
let audioContext = null;

function defaultTimer() {
    return {
        status: "idle",
        durationSec: 25 * 60,
        remainingSec: 25 * 60,
        endsAt: null,
        task: "Bereit für Fokus",
        todoId: null,
        isBreak: false,
        lastFocusMin: 25,
        lastTask: ""
    };
}

function createDefaultState() {
    return {
        schema: SCHEMA_VERSION,
        courses: [],
        sessions: [],
        events: [],
        todos: [],
        exams: [],
        sources: [],
        focus: {
            log: {},
            timer: defaultTimer()
        },
        meta: {
            lastBackupAt: null
        }
    };
}

function uid() {
    return "u" +
        Date.now().toString(36) +
        Math.random().toString(36).slice(2, 8);
}

function stableId(prefix, value) {
    let hash = 5381;
    const text = String(value || "");

    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash << 5) + hash) ^ text.charCodeAt(i);
    }

    return `${prefix}_${(hash >>> 0).toString(36)}`;
}

/* =========================================================
   HILFSFUNKTIONEN
   ========================================================= */

function esc(value) {
    return String(value === undefined || value === null ? "" : value)
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;")
        .replace(/"/g, "&quot;")
        .replace(/'/g, "&#039;");
}

function localDateKey(date = new Date()) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");

    return `${y}-${m}-${d}`;
}

function dateOrdinal(isoDate) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(isoDate || ""))) {
        return null;
    }

    const parts = isoDate.split("-").map(Number);
    return Math.floor(Date.UTC(parts[0], parts[1] - 1, parts[2]) / 86400000);
}

function daysFromToday(isoDate) {
    const target = dateOrdinal(isoDate);
    const today = dateOrdinal(localDateKey());

    if (target === null || today === null) {
        return null;
    }

    return target - today;
}

function shiftDate(isoDate, days) {
    const ordinal = dateOrdinal(isoDate);

    if (ordinal === null) {
        return "";
    }

    const date = new Date((ordinal + Number(days)) * 86400000);
    return date.toISOString().slice(0, 10);
}

function formatDate(isoDate) {
    if (!isoDate) {
        return "kein Datum";
    }

    const parts = isoDate.split("-").map(Number);

    if (parts.length !== 3) {
        return isoDate;
    }

    const date = new Date(parts[0], parts[1] - 1, parts[2]);

    return new Intl.DateTimeFormat("de-DE", {
        day: "2-digit",
        month: "2-digit",
        year: "numeric"
    }).format(date);
}

function formatShortDate(isoDate) {
    if (!isoDate) {
        return "";
    }

    const parts = isoDate.split("-").map(Number);
    const date = new Date(parts[0], parts[1] - 1, parts[2]);

    return new Intl.DateTimeFormat("de-DE", {
        day: "2-digit",
        month: "2-digit"
    }).format(date);
}

function timeToMinutes(time) {
    if (!/^\d{2}:\d{2}$/.test(String(time || ""))) {
        return null;
    }

    const parts = time.split(":").map(Number);
    const hour = parts[0];
    const minute = parts[1];

    if (hour < 0 || hour > 23 || minute < 0 || minute > 59) {
        return null;
    }

    return hour * 60 + minute;
}

function parseOptionalGrade(value) {
    if (value === null || value === undefined || value === "") {
        return null;
    }

    const grade = Number(String(value).replace(",", "."));

    if (!Number.isFinite(grade)) {
        return null;
    }

    return Math.max(1, Math.min(5, grade));
}

function gradeBadgeClass(grade) {
    if (grade === null || grade === undefined) {
        return "blue";
    }

    if (grade <= 2.5) {
        return "green";
    }

    if (grade <= 4.0) {
        return "amber";
    }

    return "red";
}

function courseColor(name) {
    const course = state.courses.find(item => item.name === name);

    if (course && course.color) {
        return course.color;
    }

    let hash = 0;
    const text = String(name || "");

    for (let i = 0; i < text.length; i += 1) {
        hash = ((hash * 31) + text.charCodeAt(i)) >>> 0;
    }

    return COURSE_COLORS[hash % COURSE_COLORS.length];
}

function courseMeta(name) {
    return state.courses.find(item => item.name === name) || null;
}

function isArchivedCourse(name) {
    const course = courseMeta(name);
    return Boolean(course && course.archived);
}

function activeCourse(name) {
    return !isArchivedCourse(name);
}

function getSourceName(sourceId) {
    const source = state.sources.find(item => item.id === sourceId);
    return source ? source.name : "";
}

function getCourses() {
    const names = new Set();

    state.courses.forEach(course => names.add(course.name));
    state.sessions.forEach(item => names.add(item.course));
    state.todos.forEach(item => item.course && names.add(item.course));
    state.exams.forEach(item => names.add(item.course));
    state.events.forEach(item => item.course && names.add(item.course));

    return Array.from(names)
        .filter(Boolean)
        .sort((a, b) => a.localeCompare(b, "de"));
}

function refreshCourseList() {
    const list = document.getElementById("course-list");

    list.innerHTML = getCourses()
        .map(course => `<option value="${esc(course)}"></option>`)
        .join("");
}

/* =========================================================
   DATEN LADEN UND SPEICHERN
   ========================================================= */

function normalizeData(raw) {
    const output = createDefaultState();
    const input = raw && typeof raw === "object" ? raw : {};

    output.courses = Array.isArray(input.courses)
        ? input.courses.map(item => ({
            id: String(item.id || uid()),
            name: String(item.name || "Unbekannt"),
            short: String(item.short || item.short_name || ""),
            ects: Math.max(0, Number(item.ects) || 0),
            lecturer: String(item.lecturer || ""),
            semester: String(item.semester || ""),
            color: String(item.color || ""),
            archived: Boolean(item.archived)
        }))
        : [];

    output.sessions = Array.isArray(input.sessions)
        ? input.sessions.map(item => ({
            id: String(item.id || uid()),
            course: String(item.course || "Unbenannt"),
            type: String(item.type || "Vorlesung"),
            day: Math.max(0, Math.min(6, Number(item.day) || 0)),
            start: String(item.start || "08:00"),
            end: String(item.end || "09:30"),
            room: String(item.room || ""),
            lecturer: String(item.lecturer || ""),
            sourceId: item.sourceId || null,
            externalKey: item.externalKey || item.uid || null
        }))
        : [];

    output.events = Array.isArray(input.events)
        ? input.events.map(item => ({
            id: String(item.id || uid()),
            title: String(item.title || "Sondertermin"),
            course: String(item.course || ""),
            type: String(item.type || "Termin"),
            date: String(item.date || ""),
            start: String(item.start || ""),
            end: String(item.end || ""),
            room: String(item.room || ""),
            lecturer: String(item.lecturer || ""),
            sourceId: item.sourceId || null,
            externalKey: item.externalKey || null
        }))
        : [];

    output.todos = Array.isArray(input.todos)
        ? input.todos.map(item => ({
            id: String(item.id || uid()),
            title: String(item.title || "Unbenannte Aufgabe"),
            course: String(item.course || ""),
            due: String(item.due || ""),
            min: Math.max(1, Number(item.min || item.estimated_minutes) || 45),
            prio: Math.max(1, Math.min(3, Number(item.prio || item.priority) || 2)),
            notes: String(item.notes || item.description || ""),
            repeatDays: Math.max(0, Number(item.repeatDays || item.repeat) || 0),
            done: Boolean(item.done || item.status === "erledigt"),
            created: String(item.created || item.created_at || new Date().toISOString()),
            completedAt: item.completedAt || item.completed_at || null,
            sourceId: item.sourceId || null,
            generatedNextId: item.generatedNextId || null
        }))
        : [];

    output.exams = Array.isArray(input.exams)
        ? input.exams.map(item => ({
            id: String(item.id || uid()),
            course: String(item.course || "Unbekannter Kurs"),
            name: String(item.name || "Klausur"),
            date: String(item.date || item.exam_date || ""),
            time: String(item.time || "09:00"),
            room: String(item.room || ""),
            weight: Math.max(0, Number(item.weight) || 100),
            ects: Math.max(0, Number(item.ects) || 0),
            prepWeeks: Math.max(1, Number(item.prepWeeks || item.prep_weeks) || 4),
            prepHours: Math.max(
                1,
                Number(item.prepHours || item.prep_hours) ||
                Math.max(20, (Number(item.weight) || 100) * 0.4)
            ),
            grade: parseOptionalGrade(item.grade)
        }))
        : [];

    output.sources = Array.isArray(input.sources)
        ? input.sources.map(item => ({
            id: String(item.id || uid()),
            name: String(item.name || "Kalenderquelle"),
            type: String(item.type || "ics_file"),
            url: String(item.url || ""),
            lastImport: item.lastImport || null,
            sessionCount: Number(item.sessionCount || item.eventCount) || 0,
            eventCount: Number(item.eventCount) || 0,
            todoCount: Number(item.todoCount) || 0
        }))
        : [];

    if (input.focus && input.focus.log && typeof input.focus.log === "object") {
        output.focus.log = input.focus.log;
    } else if (input.focus && input.focus.date) {
        output.focus.log[input.focus.date] = Number(input.focus.minutes) || 0;
    } else if (input.focusMinToday) {
        output.focus.log[localDateKey()] = Number(input.focusMinToday) || 0;
    }

    if (input.focus && input.focus.timer && typeof input.focus.timer === "object") {
        output.focus.timer = {
            ...defaultTimer(),
            ...input.focus.timer
        };
    }

    if (input.meta && typeof input.meta === "object") {
        output.meta = {
            ...output.meta,
            ...input.meta
        };
    }

    output.schema = SCHEMA_VERSION;

    return output;
}

function loadData() {
    let raw = null;

    try {
        const current = localStorage.getItem(DB_KEY);

        if (current) {
            raw = JSON.parse(current);
        } else {
            for (const key of LEGACY_KEYS) {
                const legacy = localStorage.getItem(key);

                if (legacy) {
                    raw = JSON.parse(legacy);
                    break;
                }
            }

            if (!raw) {
                const oldSessions = localStorage.getItem("uniplan_sessions");
                const oldTodos = localStorage.getItem("uniplan_todos");

                if (oldSessions || oldTodos) {
                    raw = {
                        sessions: JSON.parse(oldSessions || "[]"),
                        todos: JSON.parse(oldTodos || "[]")
                    };
                }
            }
        }
    } catch (error) {
        console.error("Fehler beim Laden:", error);
    }

    state = normalizeData(raw || {});
    saveData(false);
}

function saveData(updateHeaderView = true) {
    state.schema = SCHEMA_VERSION;
    localStorage.setItem(DB_KEY, JSON.stringify(state));

    if (updateHeaderView) {
        updateHeader();
    }
}

/* =========================================================
   OBERFLÄCHE UND MODALS
   ========================================================= */

function showToast(message) {
    const element = document.getElementById("toast");
    element.textContent = message;
    element.classList.add("show");

    clearTimeout(toastTimer);

    toastTimer = setTimeout(() => {
        element.classList.remove("show");
    }, 2300);
}

function showUndo(message, callback) {
    const bar = document.getElementById("snackbar");
    const button = document.getElementById("snackbar-undo");

    clearTimeout(undoTimer);

    document.getElementById("snackbar-text").textContent = message;
    bar.classList.add("show");

    button.onclick = () => {
        clearTimeout(undoTimer);
        bar.classList.remove("show");
        callback();
    };

    undoTimer = setTimeout(() => {
        bar.classList.remove("show");
        button.onclick = null;
    }, 5000);
}

function askUser(title, text, okText = "Fortfahren", icon = "⚠️") {
    return new Promise(resolve => {
        confirmResolver = resolve;

        document.getElementById("confirm-title").textContent = title;
        document.getElementById("confirm-text").textContent = text;
        document.getElementById("confirm-icon").textContent = icon;
        document.getElementById("confirm-ok").textContent = okText;

        document.getElementById("confirm-dialog").classList.add("show");
        document.body.style.overflow = "hidden";
    });
}

function finishConfirm(result) {
    document.getElementById("confirm-dialog").classList.remove("show");
    document.body.style.overflow = "";

    if (confirmResolver) {
        const resolver = confirmResolver;
        confirmResolver = null;
        resolver(result);
    }
}

function openModal(id) {
    document.getElementById(id).classList.add("show");
    document.body.style.overflow = "hidden";
}

function closeModal(id) {
    document.getElementById(id).classList.remove("show");
    document.body.style.overflow = "";
}

document.getElementById("confirm-ok").onclick = () => finishConfirm(true);
document.getElementById("confirm-cancel").onclick = () => finishConfirm(false);

document.querySelectorAll(".modal-bg").forEach(modal => {
    if (modal.id === "confirm-dialog" || modal.id === "import-dialog") {
        return;
    }

    modal.addEventListener("click", event => {
        if (event.target === modal) {
            closeModal(modal.id);
        }
    });
});

function switchTab(name) {
    document.querySelectorAll(".tab").forEach(tab => {
        tab.classList.remove("active");
    });

    document.querySelectorAll(".bottom-nav button").forEach(button => {
        button.classList.remove("active");
    });

    document.getElementById(`tab-${name}`).classList.add("active");
    document.getElementById(`nav-${name}`).classList.add("active");

    window.scrollTo(0, 0);

    if (name === "today") renderToday();
    if (name === "schedule") renderSchedule();
    if (name === "todos") renderTodos();
    if (name === "workload") renderWorkload();
    if (name === "focus") renderFocusStatistics();
}

function updateHeader() {
    const openTodos = state.todos.filter(todo => !todo.done).length;
    const todayFocus = Number(state.focus.log[localDateKey()] || 0);

    document.getElementById("top-subtitle").textContent =
        `${todayFocus} Min. Fokus · ${openTodos} Todos offen`;
}

function updateNetworkStatus() {
    const element = document.getElementById("network-status");

    if (navigator.onLine) {
        element.textContent = "Online";
        element.className = "badge green";
    } else {
        element.textContent = "Offline";
        element.className = "badge amber";
    }
}

window.addEventListener("online", updateNetworkStatus);
window.addEventListener("offline", updateNetworkStatus);

/* =========================================================
   KURSVERWALTUNG
   ========================================================= */

function ensureCourse(name, lecturer = "") {
    if (!name) return;

    const existing = state.courses.find(course => course.name === name);

    if (!existing) {
        state.courses.push({
            id: uid(),
            name,
            short: "",
            ects: 0,
            lecturer,
            semester: "",
            color: "",
            archived: false
        });
    } else if (!existing.lecturer && lecturer) {
        existing.lecturer = lecturer;
    }
}

function openCoursesModal() {
    renderCoursesManager();
    openModal("modal-courses");
}

function renderCoursesManager() {
    const container = document.getElementById("course-manager-list");

    const courses = [...state.courses]
        .sort((a, b) => {
            if (a.archived !== b.archived) {
                return Number(a.archived) - Number(b.archived);
            }

            return a.name.localeCompare(b.name, "de");
        });

    if (!courses.length) {
        container.innerHTML = `
            <div class="empty">
                Noch keine zentralen Kurse angelegt.
            </div>
        `;
        return;
    }

    container.innerHTML = courses.map(course => `
        <article class="item"
                 style="border-left:4px solid ${courseColor(course.name)}">
            <div class="item-main">
                <div class="item-content">
                    <div class="item-title">
                        ${esc(course.name)}
                        ${course.archived ? '<span class="badge amber">archiviert</span>' : ""}
                    </div>

                    <div class="item-sub">
                        ${course.short ? `${esc(course.short)} · ` : ""}
                        ${course.ects ? `${esc(course.ects)} ECTS · ` : ""}
                        ${esc(course.lecturer || "kein Dozent eingetragen")}
                    </div>
                </div>

                <div class="item-actions">
                    <button class="mini-btn edit"
                            type="button"
                            onclick="openCourseModal('${course.id}')">
                        ✏️
                    </button>

                    <button class="mini-btn"
                            type="button"
                            onclick="toggleCourseArchive('${course.id}')">
                        ${course.archived ? "↩️" : "📦"}
                    </button>
                </div>
            </div>
        </article>
    `).join("");
}

function openCourseModal(id = null) {
    const course = id
        ? state.courses.find(item => item.id === id)
        : null;

    document.getElementById("course-modal-title").textContent =
        course ? "Kurs bearbeiten" : "Kurs hinzufügen";

    document.getElementById("course-id").value = course ? course.id : "";
    document.getElementById("course-name").value = course ? course.name : "";
    document.getElementById("course-short").value = course ? course.short : "";
    document.getElementById("course-ects").value = course ? course.ects : 0;
    document.getElementById("course-lecturer").value = course ? course.lecturer : "";
    document.getElementById("course-semester").value = course ? course.semester : "";
    document.getElementById("course-color").value =
        course && course.color ? course.color : "#3b82f6";
    document.getElementById("course-archived").checked =
        course ? Boolean(course.archived) : false;

    openModal("modal-course");
}

function saveCourse() {
    const id = document.getElementById("course-id").value;
    const name = document.getElementById("course-name").value.trim();

    if (!name) {
        showToast("Bitte einen Kursnamen angeben");
        return;
    }

    const values = {
        name,
        short: document.getElementById("course-short").value.trim(),
        ects: Math.max(0, Number(document.getElementById("course-ects").value) || 0),
        lecturer: document.getElementById("course-lecturer").value.trim(),
        semester: document.getElementById("course-semester").value.trim(),
        color: document.getElementById("course-color").value,
        archived: document.getElementById("course-archived").checked
    };

    if (id) {
        const index = state.courses.findIndex(item => item.id === id);

        if (index >= 0) {
            const oldName = state.courses[index].name;

            state.courses[index] = {
                ...state.courses[index],
                ...values
            };

            if (oldName !== name) {
                state.sessions.forEach(item => {
                    if (item.course === oldName) item.course = name;
                });

                state.todos.forEach(item => {
                    if (item.course === oldName) item.course = name;
                });

                state.exams.forEach(item => {
                    if (item.course === oldName) item.course = name;
                });

                state.events.forEach(item => {
                    if (item.course === oldName) item.course = name;
                });
            }
        }

        showToast("Kurs aktualisiert");
    } else {
        state.courses.push({
            id: uid(),
            ...values
        });

        showToast("Kurs hinzugefügt");
    }

    saveData();
    closeModal("modal-course");
    renderAll();
    renderCoursesManager();
}

function toggleCourseArchive(id) {
    const course = state.courses.find(item => item.id === id);

    if (!course) return;

    course.archived = !course.archived;

    saveData();
    renderAll();
    renderCoursesManager();

    showToast(
        course.archived
            ? "Kurs archiviert"
            : "Kurs wieder aktiviert"
    );
}

/* =========================================================
   TERMINE
   ========================================================= */

function openSessionModal(id = null) {
    refreshCourseList();

    const session = id
        ? state.sessions.find(item => item.id === id)
        : null;

    document.getElementById("session-modal-title").textContent =
        session ? "Termin bearbeiten" : "Termin hinzufügen";

    document.getElementById("session-id").value = session ? session.id : "";
    document.getElementById("session-course").value = session ? session.course : "";
    document.getElementById("session-type").value = session ? session.type : "Vorlesung";
    document.getElementById("session-day").value = session ? String(session.day) : "0";
    document.getElementById("session-start").value = session ? session.start : "08:00";
    document.getElementById("session-end").value = session ? session.end : "09:30";
    document.getElementById("session-room").value = session ? session.room : "";
    document.getElementById("session-lecturer").value = session ? session.lecturer : "";

    openModal("modal-session");
}

function saveSession() {
    const id = document.getElementById("session-id").value;
    const course = document.getElementById("session-course").value.trim();
    const start = document.getElementById("session-start").value;
    const end = document.getElementById("session-end").value;

    const startMinutes = timeToMinutes(start);
    const endMinutes = timeToMinutes(end);

    if (!course || startMinutes === null || endMinutes === null) {
        showToast("Bitte Kurs, Start und Ende angeben");
        return;
    }

    if (endMinutes <= startMinutes) {
        showToast("Die Endzeit muss nach der Startzeit liegen");
        return;
    }

    const values = {
        course,
        type: document.getElementById("session-type").value,
        day: Number(document.getElementById("session-day").value),
        start,
        end,
        room: document.getElementById("session-room").value.trim(),
        lecturer: document.getElementById("session-lecturer").value.trim()
    };

    ensureCourse(course, values.lecturer);

    if (id) {
        const index = state.sessions.findIndex(item => item.id === id);

        if (index >= 0) {
            state.sessions[index] = {
                ...state.sessions[index],
                ...values
            };
        }

        showToast("Termin aktualisiert");
    } else {
        state.sessions.push({
            id: uid(),
            sourceId: null,
            externalKey: null,
            ...values
        });

        showToast("Termin hinzugefügt");
    }

    saveData();
    closeModal("modal-session");
    renderAll();
}

function duplicateSession(id) {
    const original = state.sessions.find(item => item.id === id);

    if (!original) return;

    const copy = {
        ...original,
        id: uid(),
        sourceId: null,
        externalKey: null
    };

    state.sessions.push(copy);

    saveData();
    renderAll();
    openSessionModal(copy.id);

    showToast("Kopie erstellt – jetzt anpassen");
}

function sessionHasConflict(session) {
    const start = timeToMinutes(session.start);
    const end = timeToMinutes(session.end);

    return state.sessions.some(other => {
        if (other.id === session.id ||
            Number(other.day) !== Number(session.day) ||
            isArchivedCourse(other.course)) {
            return false;
        }

        const otherStart = timeToMinutes(other.start);
        const otherEnd = timeToMinutes(other.end);

        return otherStart < end && start < otherEnd;
    });
}

function sessionCard(session) {
    const conflict = sessionHasConflict(session);
    const sourceName = session.sourceId
        ? getSourceName(session.sourceId)
        : "";

    return `
        <article class="item"
                 style="border-left:4px solid ${courseColor(session.course)}">
            <div class="item-main">
                <div class="item-content">
                    <div class="item-title">
                        ${esc(session.course)}
                        ${conflict ? '<span class="badge red">⚠ Überschneidung</span>' : ""}
                        ${sourceName ? '<span class="badge blue">importiert</span>' : ""}
                    </div>

                    <div class="item-sub">
                        ${esc(session.type)}
                        · ${esc(session.start)}–${esc(session.end)}
                    </div>

                    <div class="item-sub">
                        📍 ${esc(session.room || "Online / kein Raum")}
                        ${session.lecturer ? ` · ${esc(session.lecturer)}` : ""}
                    </div>

                    ${sourceName
                        ? `<div class="item-sub">Quelle: ${esc(sourceName)}</div>`
                        : ""}
                </div>

                <div class="item-actions">
                    <button class="mini-btn"
                            type="button"
                            title="Termin duplizieren"
                            onclick="duplicateSession('${session.id}')">
                        ⧉
                    </button>

                    <button class="mini-btn edit"
                            type="button"
                            title="Termin bearbeiten"
                            onclick="openSessionModal('${session.id}')">
                        ✏️
                    </button>

                    <button class="mini-btn delete"
                            type="button"
                            title="Termin löschen"
                            onclick="deleteItem('sessions','${session.id}','Termin')">
                        🗑️
                    </button>
                </div>
            </div>
        </article>
    `;
}

function eventCard(event) {
    const sourceName = event.sourceId
        ? getSourceName(event.sourceId)
        : "";

    return `
        <article class="item"
                 style="border-left:4px solid ${courseColor(event.course || event.title)}">
            <div class="item-main">
                <div class="item-content">
                    <div class="item-title">
                        📌 ${esc(event.title)}
                    </div>

                    <div class="item-sub">
                        ${esc(formatDate(event.date))}
                        ${event.start ? ` · ${esc(event.start)}–${esc(event.end || "")}` : ""}
                    </div>

                    <div class="item-sub">
                        ${event.course ? `${esc(event.course)} · ` : ""}
                        ${event.room ? `📍 ${esc(event.room)}` : ""}
                    </div>

                    ${sourceName
                        ? `<div class="item-sub">Quelle: ${esc(sourceName)}</div>`
                        : ""}
                </div>

                <div class="item-actions">
                    <button class="mini-btn delete"
                            type="button"
                            onclick="deleteItem('events','${event.id}','Sondertermin')">
                        🗑️
                    </button>
                </div>
            </div>
        </article>
    `;
}

function renderSchedule() {
    const container = document.getElementById("schedule-container");

    let html = "";

    DAYS.forEach((dayName, dayIndex) => {
        const sessions = state.sessions
            .filter(item =>
                Number(item.day) === dayIndex &&
                activeCourse(item.course)
            )
            .sort((a, b) => a.start.localeCompare(b.start));

        if (!sessions.length) return;

        html += `<div class="section-title">${dayName}</div>`;
        html += sessions.map(sessionCard).join("");
    });

    const upcomingEvents = state.events
        .filter(item => {
            const days = daysFromToday(item.date);
            return days !== null && days >= 0 && days <= 30;
        })
        .sort((a, b) => {
            const dateCompare = a.date.localeCompare(b.date);

            if (dateCompare !== 0) return dateCompare;
            return (a.start || "").localeCompare(b.start || "");
        });

    if (upcomingEvents.length) {
        html += `<div class="section-title">Sondertermine (nächste 30 Tage)</div>`;
        html += upcomingEvents.map(eventCard).join("");
    }

    container.innerHTML = html || `
        <div class="empty">
            Noch keine Termine.<br>
            Tippe oben auf „＋ Termin“ oder importiere eine Kalenderquelle.
        </div>
    `;
}

/* =========================================================
   TODOS
   ========================================================= */

function openTodoModal(id = null) {
    refreshCourseList();

    const todo = id
        ? state.todos.find(item => item.id === id)
        : null;

    document.getElementById("todo-modal-title").textContent =
        todo ? "Todo bearbeiten" : "Todo hinzufügen";

    document.getElementById("todo-id").value = todo ? todo.id : "";
    document.getElementById("todo-title").value = todo ? todo.title : "";
    document.getElementById("todo-course").value = todo ? todo.course : "";
    document.getElementById("todo-due").value = todo ? todo.due : "";
    document.getElementById("todo-minutes").value = todo ? todo.min : 45;
    document.getElementById("todo-priority").value = todo ? String(todo.prio) : "2";
    document.getElementById("todo-repeat").value = todo ? String(todo.repeatDays || 0) : "0";
    document.getElementById("todo-notes").value = todo ? todo.notes : "";

    openModal("modal-todo");
}

function saveTodo() {
    const id = document.getElementById("todo-id").value;
    const title = document.getElementById("todo-title").value.trim();
    const minutes = Number(document.getElementById("todo-minutes").value);

    if (!title) {
        showToast("Bitte einen Titel eingeben");
        return;
    }

    if (!Number.isFinite(minutes) || minutes < 1) {
        showToast("Bitte einen gültigen Aufwand eingeben");
        return;
    }

    const values = {
        title,
        course: document.getElementById("todo-course").value.trim(),
        due: document.getElementById("todo-due").value,
        min: Math.round(minutes),
        prio: Number(document.getElementById("todo-priority").value),
        repeatDays: Number(document.getElementById("todo-repeat").value),
        notes: document.getElementById("todo-notes").value.trim()
    };

    if (values.course) {
        ensureCourse(values.course);
    }

    if (id) {
        const index = state.todos.findIndex(item => item.id === id);

        if (index >= 0) {
            state.todos[index] = {
                ...state.todos[index],
                ...values
            };
        }

        showToast("Todo aktualisiert");
    } else {
        state.todos.push({
            id: uid(),
            done: false,
            created: new Date().toISOString(),
            completedAt: null,
            sourceId: null,
            generatedNextId: null,
            ...values
        });

        showToast("Todo hinzugefügt");
    }

    saveData();
    closeModal("modal-todo");
    renderAll();
}

function toggleTodo(id) {
    const todo = state.todos.find(item => item.id === id);

    if (!todo) return;

    const willBeDone = !todo.done;

    todo.done = willBeDone;
    todo.completedAt = willBeDone ? new Date().toISOString() : null;

    if (willBeDone && todo.repeatDays > 0 && todo.due) {
        const exists = todo.generatedNextId
            ? state.todos.find(item => item.id === todo.generatedNextId)
            : null;

        if (!exists) {
            const nextTodo = {
                ...todo,
                id: uid(),
                due: shiftDate(todo.due, todo.repeatDays),
                done: false,
                created: new Date().toISOString(),
                completedAt: null,
                sourceId: null,
                generatedNextId: null
            };

            todo.generatedNextId = nextTodo.id;
            state.todos.push(nextTodo);

            showToast("Nächste Wiederholung wurde angelegt");
        }
    }

    if (!willBeDone && todo.generatedNextId) {
        const index = state.todos.findIndex(item =>
            item.id === todo.generatedNextId &&
            item.sourceId === null &&
            !item.done
        );

        if (index >= 0) {
            state.todos.splice(index, 1);
        }

        todo.generatedNextId = null;
    }

    saveData();
    renderAll();
}

function setTodoFilter(filter) {
    todoFilter = filter;

    ["open", "all", "done"].forEach(name => {
        document.getElementById(`filter-${name}`)
            .classList.toggle("active", name === filter);
    });

    renderTodos();
}

function todoBucket(todo) {
    if (!todo.due) return "Ohne Datum";

    const days = daysFromToday(todo.due);

    if (days < 0) return "⚠ Überfällig";
    if (days === 0) return "Heute";
    if (days <= 7) return "Diese Woche";

    return "Später";
}

function todoCard(todo) {
    const priority =
        todo.prio === 3 ? "🔴" :
        todo.prio === 2 ? "🟡" : "🟢";

    const overdue =
        !todo.done &&
        todo.due &&
        daysFromToday(todo.due) < 0;

    const sourceName = todo.sourceId
        ? getSourceName(todo.sourceId)
        : "";

    return `
        <article class="item ${overdue ? "danger-card" : ""}">
            <div class="item-main">
                <div class="row"
                     style="align-items:flex-start;flex:1;min-width:0">
                    <input class="checkbox"
                           type="checkbox"
                           ${todo.done ? "checked" : ""}
                           onchange="toggleTodo('${todo.id}')">

                    <div class="item-content">
                        <div class="item-title"
                             style="${todo.done ? "text-decoration:line-through;opacity:.65" : ""}">
                            ${priority} ${esc(todo.title)}
                        </div>

                        <div class="item-sub">
                            ${todo.course ? `${esc(todo.course)} · ` : ""}
                            ${todo.due ? `Fällig: ${esc(formatDate(todo.due))} · ` : ""}
                            ca. ${esc(todo.min)} Min.
                        </div>

                        ${todo.repeatDays
                            ? `<div class="item-sub">🔁 Wiederholung alle ${todo.repeatDays} Tage</div>`
                            : ""}

                        ${todo.notes
                            ? `<div class="item-sub">📝 ${esc(todo.notes)}</div>`
                            : ""}

                        ${sourceName
                            ? `<div class="item-sub">Quelle: ${esc(sourceName)}</div>`
                            : ""}

                        ${!todo.done
                            ? `
                                <button class="btn"
                                        type="button"
                                        style="min-height:36px;margin-top:8px;padding:6px 10px"
                                        onclick="startTodoFocus('${todo.id}')">
                                    🎯 Fokus starten
                                </button>
                              `
                            : ""}
                    </div>
                </div>

                <div class="item-actions">
                    <button class="mini-btn edit"
                            type="button"
                            onclick="openTodoModal('${todo.id}')">
                        ✏️
                    </button>

                    <button class="mini-btn delete"
                            type="button"
                            onclick="deleteItem('todos','${todo.id}','Todo')">
                        🗑️
                    </button>
                </div>
            </div>
        </article>
    `;
}

function renderTodos() {
    const searchInput = document.getElementById("todo-search");
    const query = String(searchInput.value || "").trim().toLowerCase();

    const todos = state.todos
        .filter(todo => {
            if (todo.course && isArchivedCourse(todo.course)) {
                return false;
            }

            const text = `${todo.title} ${todo.course} ${todo.notes}`.toLowerCase();

            if (query && !text.includes(query)) return false;
            if (todoFilter === "open" && todo.done) return false;
            if (todoFilter === "done" && !todo.done) return false;

            return true;
        })
        .sort((a, b) => {
            if (a.done !== b.done) {
                return Number(a.done) - Number(b.done);
            }

            const dueA = a.due || "9999-12-31";
            const dueB = b.due || "9999-12-31";

            if (dueA !== dueB) return dueA.localeCompare(dueB);

            return b.prio - a.prio;
        });

    const container = document.getElementById("todo-list");

    if (!todos.length) {
        container.innerHTML = `
            <div class="empty">
                Keine passenden Todos gefunden.
            </div>
        `;
        return;
    }

    const groups = {};

    todos.forEach(todo => {
        const key = todo.done ? "Erledigt" : todoBucket(todo);

        if (!groups[key]) {
            groups[key] = [];
        }

        groups[key].push(todo);
    });

    const order = [
        "⚠ Überfällig",
        "Heute",
        "Diese Woche",
        "Später",
        "Ohne Datum",
        "Erledigt"
    ];

    let html = "";

    order.forEach(group => {
        if (!groups[group]) return;

        html += `
            <div class="section-title ${group.includes("Überfällig") ? "danger" : ""}">
                ${group} (${groups[group].length})
            </div>
        `;

        html += groups[group].map(todoCard).join("");
    });

    container.innerHTML = html;
}

/* =========================================================
   KLAUSUREN, WORKLOAD UND NOTEN
   ========================================================= */

function openExamModal(id = null) {
    refreshCourseList();

    const exam = id
        ? state.exams.find(item => item.id === id)
        : null;

    document.getElementById("exam-modal-title").textContent =
        exam ? "Klausur bearbeiten" : "Klausur hinzufügen";

    document.getElementById("exam-id").value = exam ? exam.id : "";
    document.getElementById("exam-course").value = exam ? exam.course : "";
    document.getElementById("exam-name").value = exam ? exam.name : "";
    document.getElementById("exam-date").value = exam ? exam.date : "";
    document.getElementById("exam-time").value = exam ? exam.time : "09:00";
    document.getElementById("exam-room").value = exam ? exam.room : "";
    document.getElementById("exam-prep-weeks").value = exam ? exam.prepWeeks : 4;
    document.getElementById("exam-prep-hours").value = exam ? exam.prepHours : 40;
    document.getElementById("exam-weight").value = exam ? exam.weight : 100;
    document.getElementById("exam-ects").value = exam ? exam.ects : 0;
    document.getElementById("exam-grade").value =
        exam && exam.grade !== null && exam.grade !== undefined
            ? exam.grade
            : "";

    openModal("modal-exam");
}

function saveExam() {
    const id = document.getElementById("exam-id").value;
    const course = document.getElementById("exam-course").value.trim();
    const name = document.getElementById("exam-name").value.trim();
    const date = document.getElementById("exam-date").value;

    if (!course || !name || !date) {
        showToast("Bitte Kurs, Bezeichnung und Datum angeben");
        return;
    }

    const values = {
        course,
        name,
        date,
        time: document.getElementById("exam-time").value || "09:00",
        room: document.getElementById("exam-room").value.trim(),
        prepWeeks: Math.max(
            1,
            Number(document.getElementById("exam-prep-weeks").value) || 4
        ),
        prepHours: Math.max(
            1,
            Number(document.getElementById("exam-prep-hours").value) || 40
        ),
        weight: Math.max(
            0,
            Number(document.getElementById("exam-weight").value) || 100
        ),
        ects: Math.max(
            0,
            Number(document.getElementById("exam-ects").value) || 0
        ),
        grade: parseOptionalGrade(
            document.getElementById("exam-grade").value
        )
    };

    ensureCourse(course);

    if (id) {
        const index = state.exams.findIndex(item => item.id === id);

        if (index >= 0) {
            state.exams[index] = {
                ...state.exams[index],
                ...values
            };
        }

        showToast("Klausur aktualisiert");
    } else {
        state.exams.push({
            id: uid(),
            ...values
        });

        showToast("Klausur hinzugefügt");
    }

    saveData();
    closeModal("modal-exam");
    renderAll();
}

function todoWeeklyHours(todo) {
    if (todo.done) return 0;

    const hours = todo.min / 60;

    if (todo.repeatDays > 0) {
        return hours * (7 / todo.repeatDays);
    }

    if (!todo.due) {
        return hours;
    }

    const days = daysFromToday(todo.due);
    return days !== null && days <= 7 ? hours : 0;
}

function examWeeklyHours(exam) {
    const days = daysFromToday(exam.date);
    const prepDays = exam.prepWeeks * 7;

    if (days === null || days < 0 || days > prepDays) {
        return 0;
    }

    return exam.prepHours / Math.max(1, exam.prepWeeks);
}

function calculateWorkload() {
    const map = {};

    function ensure(course) {
        const name = course || "Allgemein";

        if (!map[name]) {
            map[name] = {
                sessions: 0,
                todos: 0,
                exams: 0
            };
        }

        return map[name];
    }

    state.sessions.forEach(session => {
        if (isArchivedCourse(session.course)) return;

        const start = timeToMinutes(session.start);
        const end = timeToMinutes(session.end);

        if (start !== null && end !== null && end > start) {
            ensure(session.course).sessions += (end - start) / 60;
        }
    });

    state.todos.forEach(todo => {
        if (todo.course && isArchivedCourse(todo.course)) return;

        ensure(todo.course || "Allgemein").todos += todoWeeklyHours(todo);
    });

    state.exams.forEach(exam => {
        if (isArchivedCourse(exam.course)) return;

        ensure(exam.course).exams += examWeeklyHours(exam);
    });

    return map;
}

function examGradeWeight(exam) {
    const ects = Number(exam.ects) || 0;
    const ectsFactor = ects > 0 ? ects : 1;
    const percentFactor = (Number(exam.weight) || 0) / 100;

    return ectsFactor * percentFactor;
}

function calculateGradeOverview() {
    const perCourse = {};
    let overallWeighted = 0;
    let overallWeight = 0;
    let usesEcts = false;

    state.exams.forEach(exam => {
        if (isArchivedCourse(exam.course)) return;

        const course = exam.course || "Unbekannt";

        if (!perCourse[course]) {
            perCourse[course] = {
                weighted: 0,
                weight: 0,
                percentSum: 0,
                gradedCount: 0,
                examCount: 0,
                ects: 0
            };
        }

        const entry = perCourse[course];

        entry.examCount += 1;
        entry.percentSum += Number(exam.weight) || 0;
        entry.ects = Math.max(entry.ects, Number(exam.ects) || 0);

        if ((Number(exam.ects) || 0) > 0) {
            usesEcts = true;
        }

        if (exam.grade !== null && exam.grade !== undefined) {
            const weight = examGradeWeight(exam);

            entry.weighted += weight * exam.grade;
            entry.weight += weight;
            entry.gradedCount += 1;

            overallWeighted += weight * exam.grade;
            overallWeight += weight;
        }
    });

    const rows = Object.entries(perCourse)
        .map(([course, data]) => ({
            course,
            average: data.weight > 0 ? data.weighted / data.weight : null,
            totalWeight: data.percentSum,
            gradedCount: data.gradedCount,
            examCount: data.examCount,
            ects: data.ects,
            overWeighted: data.percentSum > 100.5
        }))
        .sort((a, b) => a.course.localeCompare(b.course, "de"));

    return {
        rows,
        overallAverage: overallWeight > 0
            ? overallWeighted / overallWeight
            : null,
        usesEcts
    };
}

function examPhases(exam) {
    const totalDays = Math.max(21, exam.prepWeeks * 7);
    const start = shiftDate(exam.date, -totalDays);
    const phaseTwo = shiftDate(start, Math.round(totalDays * 0.4));
    const phaseThree = shiftDate(start, Math.round(totalDays * 0.75));
    const end = shiftDate(exam.date, -1);

    return [
        {
            icon: "📖",
            name: "Grundlagen",
            range: `${formatShortDate(start)}–${formatShortDate(shiftDate(phaseTwo, -1))}`,
            text: "Skript, Folien und Zusammenfassungen durcharbeiten."
        },
        {
            icon: "✍️",
            name: "Aktive Übung",
            range: `${formatShortDate(phaseTwo)}–${formatShortDate(shiftDate(phaseThree, -1))}`,
            text: "Aufgaben ohne Musterlösung bearbeiten und Lücken schließen."
        },
        {
            icon: "🎯",
            name: "Prüfungssimulation",
            range: `${formatShortDate(phaseThree)}–${formatShortDate(end)}`,
            text: "Altklausuren unter Zeitdruck und gezieltes Wiederholen."
        }
    ];
}

function examCard(exam) {
    const days = daysFromToday(exam.date);
    const weekly = exam.prepHours / Math.max(1, exam.prepWeeks);

    let countdown = "Datum offen";

    if (days !== null) {
        if (days < 0) countdown = "vorbei";
        else if (days === 0) countdown = "heute";
        else if (days === 1) countdown = "morgen";
        else countdown = `noch ${days} Tage`;
    }

    const badge =
        days !== null && days <= 7 && days >= 0 ? "red" :
        days !== null && days <= 21 && days >= 0 ? "amber" :
        "blue";

    const phases = examPhases(exam);

    return `
        <article class="item"
                 style="border-left:4px solid ${courseColor(exam.course)}">
            <div class="item-main">
                <div class="item-content">
                    <div class="item-title">
                        📝 ${esc(exam.course)} – ${esc(exam.name)}
                    </div>

                    <div class="item-sub">
                        ${esc(formatDate(exam.date))}
                        · ${esc(exam.time)}
                        ${exam.room ? ` · ${esc(exam.room)}` : ""}
                    </div>

                    <div class="item-sub">
                        ${esc(exam.prepHours)} Lernstunden in
                        ${esc(exam.prepWeeks)} Wochen
                        · ca. ${weekly.toFixed(1)} h/Woche
                    </div>

                    <div class="top-space-small">
                        <span class="badge ${badge}">
                            ${esc(countdown)}
                        </span>

                        <span class="badge blue">
                            Gewichtung ${esc(exam.weight)} %
                        </span>

                        ${exam.grade !== null && exam.grade !== undefined
                            ? `<span class="badge ${gradeBadgeClass(exam.grade)}">
                                Note ${exam.grade.toFixed(1)}
                               </span>`
                            : `<span class="badge blue">Note offen</span>`}
                    </div>

                    <details>
                        <summary>Lernphasen anzeigen</summary>

                        ${phases.map(phase => `
                            <div class="phase">
                                <strong>${phase.icon} ${esc(phase.name)} · ${esc(phase.range)}</strong>
                                <br>
                                ${esc(phase.text)}
                            </div>
                        `).join("")}
                    </details>
                </div>

                <div class="item-actions">
                    <button class="mini-btn edit"
                            type="button"
                            onclick="openExamModal('${exam.id}')">
                        ✏️
                    </button>

                    <button class="mini-btn delete"
                            type="button"
                            onclick="deleteItem('exams','${exam.id}','Klausur')">
                        🗑️
                    </button>
                </div>
            </div>
        </article>
    `;
}

function renderExams() {
    const container = document.getElementById("exam-list");

    const exams = state.exams
        .filter(exam => activeCourse(exam.course))
        .sort((a, b) => a.date.localeCompare(b.date));

    container.innerHTML = exams.length
        ? exams.map(examCard).join("")
        : `<div class="empty">Noch keine Klausuren eingetragen.</div>`;
}

function renderGradeOverview() {
    const container = document.getElementById("grade-overview");
    const result = calculateGradeOverview();

    if (!result.rows.length) {
        container.innerHTML = `
            <div class="empty">
                Noch keine Klausuren für eine Notenübersicht vorhanden.
            </div>
        `;
        return;
    }

    let html = "";

    if (result.overallAverage !== null) {
        html += `
            <div class="card">
                <div class="row between">
                    <strong>Gesamtdurchschnitt</strong>

                    <span class="badge ${gradeBadgeClass(result.overallAverage)}"
                          style="font-size:13px;padding:6px 12px">
                        ${result.overallAverage.toFixed(2)}
                    </span>
                </div>

                <div class="item-sub">
                    ${
                        result.usesEcts
                            ? "Gewichtet nach ECTS und Prozentanteil."
                            : "Gewichtet nach Prozentanteil. ECTS verbessern die Berechnung."
                    }
                </div>
            </div>
        `;
    } else {
        html += `
            <div class="card">
                <div class="item-sub">
                    Trage bei einer Klausur eine Note ein, um einen Durchschnitt zu sehen.
                </div>
            </div>
        `;
    }

    html += result.rows.map(row => `
        <article class="item"
                 style="border-left:4px solid ${courseColor(row.course)}">
            <div class="item-main">
                <div class="item-content">
                    <div class="item-title">${esc(row.course)}</div>

                    <div class="item-sub">
                        ${row.gradedCount} von ${row.examCount} Klausuren benotet
                        · Gewichtung: ${row.totalWeight.toFixed(0)} %
                        ${row.ects > 0 ? ` · ${row.ects} ECTS` : ""}
                        ${row.overWeighted ? " · ⚠️ Gewichtung über 100 %" : ""}
                    </div>
                </div>

                ${
                    row.average !== null
                        ? `<span class="badge ${gradeBadgeClass(row.average)}">
                            ${row.average.toFixed(2)}
                           </span>`
                        : `<span class="badge blue">offen</span>`
                }
            </div>
        </article>
    `).join("");

    container.innerHTML = html;
}

function renderWorkload() {
    const map = calculateWorkload();

    const entries = Object.entries(map)
        .map(([course, values]) => ({
            course,
            ...values,
            total: values.sessions + values.todos + values.exams
        }))
        .filter(item => item.total > 0)
        .sort((a, b) => b.total - a.total);

    const total = entries.reduce((sum, item) => sum + item.total, 0);

    document.getElementById("workload-total").textContent =
        `${total.toFixed(1)} h/Woche`;

    const summary = document.getElementById("workload-summary");

    if (total > 50) {
        summary.innerHTML = `
            <div class="card danger-card">
                <strong>Sehr hohe Belastung</strong>
                <div class="item-sub">
                    Dein Workload liegt über 50 Stunden pro Woche.
                    Prüfe Prioritäten und Lernzeiten.
                </div>
            </div>
        `;
    } else if (total > 40) {
        summary.innerHTML = `
            <div class="card warning">
                <strong>Hohe Belastung</strong>
                <div class="item-sub">
                    Dein Workload liegt über einer typischen 40-Stunden-Woche.
                </div>
            </div>
        `;
    } else {
        summary.innerHTML = `
            <div class="card success-card">
                <strong>${total.toFixed(1)} Stunden aktuell geplant</strong>
                <div class="item-sub">
                    Termine, relevante Todos und Klausurvorbereitung werden berücksichtigt.
                </div>
            </div>
        `;
    }

    document.getElementById("workload-cards").innerHTML =
        entries.length
            ? entries.map(item => {
                const level =
                    item.total < 6 ? "green" :
                    item.total < 12 ? "amber" : "red";

                return `
                    <article class="item"
                             style="border-left:4px solid ${courseColor(item.course)}">
                        <div class="item-main">
                            <div class="item-content">
                                <div class="item-title">${esc(item.course)}</div>
                                <div class="item-sub">
                                    Termine: ${item.sessions.toFixed(1)} h
                                    · Todos: ${item.todos.toFixed(1)} h
                                    · Klausur: ${item.exams.toFixed(1)} h
                                </div>
                            </div>

                            <span class="badge ${level}">
                                ${item.total.toFixed(1)} h
                            </span>
                        </div>
                    </article>
                `;
            }).join("")
            : `<div class="empty">Noch keine Workload-Daten vorhanden.</div>`;

    renderExams();
    renderGradeOverview();
}

/* =========================================================
   LÖSCHEN
   ========================================================= */

function deleteItem(listName, id, label) {
    const list = state[listName];

    if (!Array.isArray(list)) return;

    const index = list.findIndex(item => item.id === id);

    if (index < 0) return;

    const removed = list[index];
    list.splice(index, 1);

    saveData();
    renderAll();

    showUndo(`${label} gelöscht`, () => {
        list.splice(Math.min(index, list.length), 0, removed);

        saveData();
        renderAll();

        showToast(`${label} wiederhergestellt`);
    });
}

/* =========================================================
   HEUTE
   ========================================================= */

function renderToday() {
    const container = document.getElementById("today-container");
    const now = new Date();
    const today = localDateKey();
    const dayIndex = (now.getDay() + 6) % 7;
    const currentMinutes = now.getHours() * 60 + now.getMinutes();

    const sessions = state.sessions
        .filter(session =>
            Number(session.day) === dayIndex &&
            activeCourse(session.course)
        )
        .sort((a, b) => a.start.localeCompare(b.start));

    const currentSession = sessions.find(session => {
        const start = timeToMinutes(session.start);
        const end = timeToMinutes(session.end);

        return start !== null &&
            end !== null &&
            start <= currentMinutes &&
            currentMinutes < end;
    });

    const nextSession = sessions.find(session => {
        const start = timeToMinutes(session.start);
        return start !== null && start > currentMinutes;
    });

    const todayTodos = state.todos.filter(todo =>
        todo.due === today &&
        activeCourse(todo.course)
    );

    const doneToday = todayTodos.filter(todo => todo.done).length;
    const progress = todayTodos.length
        ? Math.round((doneToday / todayTodos.length) * 100)
        : 100;

    const overdue = state.todos
        .filter(todo =>
            !todo.done &&
            todo.due &&
            daysFromToday(todo.due) < 0 &&
            activeCourse(todo.course)
        )
        .sort((a, b) => a.due.localeCompare(b.due));

    const openToday = todayTodos.filter(todo => !todo.done);

    const specialEvents = state.events
        .filter(event => event.date === today && activeCourse(event.course))
        .sort((a, b) => (a.start || "").localeCompare(b.start || ""));

    let html = "";

    const lastBackup = Number(state.meta.lastBackupAt || 0);
    const backupAge = lastBackup
        ? Math.floor((Date.now() - lastBackup) / 86400000)
        : null;

    if (backupAge === null || backupAge >= 7) {
        html += `
            <div class="card warning">
                <div class="row between">
                    <div>
                        <strong>💾 Backup empfohlen</strong>
                        <div class="item-sub">
                            ${
                                backupAge === null
                                    ? "Es wurde noch kein Backup erstellt."
                                    : `Das letzte Backup ist ${backupAge} Tage alt.`
                            }
                        </div>
                    </div>

                    <button class="btn" type="button" onclick="exportBackup()">
                        Sichern
                    </button>
                </div>
            </div>
        `;
    }

    html += `
        <div class="card">
            <div class="row between">
                <div>
                    <strong>
                        ${new Intl.DateTimeFormat("de-DE", {
                            weekday: "long",
                            day: "2-digit",
                            month: "long"
                        }).format(now)}
                    </strong>

                    <div class="item-sub">
                        ${doneToday} von ${todayTodos.length} heute fälligen Todos erledigt
                    </div>
                </div>

                <span class="badge blue">${progress} %</span>
            </div>

            <div class="progress">
                <div style="width:${progress}%"></div>
            </div>
        </div>
    `;

    if (currentSession) {
        html += `
            <div class="card success-card">
                <span class="badge green">● Läuft gerade</span>

                <div class="item-title top-space-small">
                    ${esc(currentSession.course)}
                </div>

                <div class="item-sub">
                    ${esc(currentSession.type)}
                    · bis ${esc(currentSession.end)}
                    · ${esc(currentSession.room || "kein Raum")}
                </div>
            </div>
        `;
    } else if (nextSession) {
        const minutesUntil = timeToMinutes(nextSession.start) - currentMinutes;

        html += `
            <div class="card">
                <span class="badge blue">
                    Nächster Termin in ${minutesUntil} Min.
                </span>

                <div class="item-title top-space-small">
                    ${esc(nextSession.course)}
                </div>

                <div class="item-sub">
                    ${esc(nextSession.start)}–${esc(nextSession.end)}
                    · ${esc(nextSession.room || "kein Raum")}
                </div>
            </div>
        `;
    } else {
        html += `
            <div class="card">
                <strong>Keine weiteren regelmäßigen Termine heute 🎉</strong>
            </div>
        `;
    }

    if (specialEvents.length) {
        html += `<div class="section-title">Sondertermine heute</div>`;
        html += specialEvents.map(eventCard).join("");
    }

    if (overdue.length) {
        html += `<div class="section-title danger">Überfällig (${overdue.length})</div>`;
        html += overdue.map(todoCard).join("");
    }

    html += `
        <div class="section-title">Heute fällig (${openToday.length})</div>
        ${
            openToday.length
                ? openToday.map(todoCard).join("")
                : '<div class="card"><div class="item-sub">Heute ist nichts mehr fällig.</div></div>'
        }
    `;

    container.innerHTML = html;
}

/* =========================================================
   FOKUS-TIMER
   ========================================================= */

function timerRemainingSeconds() {
    const timer = state.focus.timer;

    if (timer.status === "running" && timer.endsAt) {
        return Math.max(0, Math.ceil((timer.endsAt - Date.now()) / 1000));
    }

    return Math.max(0, Number(timer.remainingSec || timer.durationSec || 0));
}

function setTimerMode(minutes) {
    const timer = state.focus.timer;

    if (timer.status === "running") {
        showToast("Timer zuerst pausieren oder zurücksetzen");
        return;
    }

    const duration = Math.max(60, Math.round(minutes * 60));

    state.focus.timer = {
        ...defaultTimer(),
        durationSec: duration,
        remainingSec: duration,
        task: `${minutes} Minuten Fokus`,
        lastFocusMin: minutes
    };

    saveData();
    updateTimerDisplay();
}

function unlockAudio() {
    try {
        if (!audioContext) {
            audioContext = new (window.AudioContext || window.webkitAudioContext)();
        }

        if (audioContext.state === "suspended") {
            audioContext.resume();
        }
    } catch (error) {
        console.warn("Audio konnte nicht aktiviert werden:", error);
    }
}

function toggleTimer() {
    unlockAudio();

    const timer = state.focus.timer;

    if (timer.status === "running") {
        timer.remainingSec = timerRemainingSeconds();
        timer.status = "paused";
        timer.endsAt = null;
    } else {
        const remaining = timerRemainingSeconds() || timer.durationSec || 25 * 60;

        timer.remainingSec = remaining;
        timer.endsAt = Date.now() + remaining * 1000;
        timer.status = "running";
    }

    saveData();
    updateTimerDisplay();
}

function resetTimer() {
    const timer = state.focus.timer;

    if (timer.isBreak) {
        const duration = Math.max(60, (timer.lastFocusMin || 25) * 60);

        state.focus.timer = {
            ...defaultTimer(),
            durationSec: duration,
            remainingSec: duration,
            task: timer.lastTask || "Bereit für Fokus",
            todoId: timer.todoId || null,
            lastFocusMin: timer.lastFocusMin || 25,
            lastTask: timer.lastTask || ""
        };
    } else {
        timer.status = "idle";
        timer.remainingSec = timer.durationSec || 25 * 60;
        timer.endsAt = null;
        timer.isBreak = false;
        timer.task = "Bereit für Fokus";
        timer.todoId = null;
    }

    saveData();
    updateTimerDisplay();
}

function startTodoFocus(id) {
    const todo = state.todos.find(item => item.id === id);

    if (!todo) return;

    const duration = Math.max(60, todo.min * 60);

    state.focus.timer = {
        ...defaultTimer(),
        durationSec: duration,
        remainingSec: duration,
        task: todo.title,
        todoId: todo.id,
        lastFocusMin: Math.round(duration / 60),
        lastTask: todo.title
    };

    saveData();
    switchTab("focus");
    updateTimerDisplay();
}

function breakMinutesFor(focusMinutes) {
    if (focusMinutes <= 30) return 5;
    if (focusMinutes <= 60) return 10;
    return 20;
}

function playCompletionSound() {
    try {
        unlockAudio();

        const oscillator = audioContext.createOscillator();
        const gain = audioContext.createGain();

        oscillator.type = "sine";
        oscillator.frequency.setValueAtTime(660, audioContext.currentTime);

        gain.gain.setValueAtTime(0.18, audioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(
            0.001,
            audioContext.currentTime + 1.2
        );

        oscillator.connect(gain);
        gain.connect(audioContext.destination);

        oscillator.start();
        oscillator.stop(audioContext.currentTime + 1.2);
    } catch (error) {
        console.warn("Ton konnte nicht abgespielt werden:", error);
    }
}

function finishTimer() {
    const timer = state.focus.timer;

    if (timer.status !== "running") {
        return;
    }

    const isBreak = Boolean(timer.isBreak);
    const completedMinutes = Math.max(1, Math.round(timer.durationSec / 60));

    playCompletionSound();

    if (isBreak) {
        const duration = Math.max(60, (timer.lastFocusMin || 25) * 60);

        state.focus.timer = {
            ...defaultTimer(),
            durationSec: duration,
            remainingSec: duration,
            task: timer.lastTask || "Bereit für Fokus",
            todoId: timer.todoId || null,
            lastFocusMin: timer.lastFocusMin || 25,
            lastTask: timer.lastTask || ""
        };

        saveData();
        renderAll();
        showToast("Pause beendet – weiter geht’s");
        return;
    }

    const today = localDateKey();

    state.focus.log[today] =
        Number(state.focus.log[today] || 0) + completedMinutes;

    const breakMinutes = breakMinutesFor(completedMinutes);
    const breakSeconds = breakMinutes * 60;

    state.focus.timer = {
        status: "running",
        durationSec: breakSeconds,
        remainingSec: breakSeconds,
        endsAt: Date.now() + breakSeconds * 1000,
        task: `☕ Pause (${breakMinutes} Min.)`,
        todoId: timer.todoId || null,
        isBreak: true,
        lastFocusMin: completedMinutes,
        lastTask: timer.task || "Bereit für Fokus"
    };

    saveData();
    renderAll();

    showToast(`🎉 ${completedMinutes} Min. geschafft – Pause läuft`);
}

function updateTimerDisplay() {
    const timer = state.focus.timer;
    let remaining = timerRemainingSeconds();

    if (timer.status === "running" && remaining <= 0) {
        finishTimer();
        remaining = timerRemainingSeconds();
    }

    const minutes = Math.floor(remaining / 60);
    const seconds = remaining % 60;

    document.getElementById("timer-display").textContent =
        `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;

    document.getElementById("timer-task").textContent =
        timer.task || "Bereit für Fokus";

    const duration = Math.max(1, timer.durationSec || 1);
    const progress = Math.min(100, Math.max(0, ((duration - remaining) / duration) * 100));

    const ring = document.getElementById("timer-ring");

    ring.style.setProperty("--progress", `${progress}%`);
    ring.classList.toggle("break", Boolean(timer.isBreak));

    document.getElementById("timer-main-button").textContent =
        timer.status === "running"
            ? "Pause"
            : timer.status === "paused"
                ? "Fortsetzen"
                : "Starten";
}

function calculateStreak() {
    const log = state.focus.log || {};
    let date = localDateKey();
    let count = 0;

    if (Number(log[date] || 0) <= 0) {
        date = shiftDate(date, -1);
    }

    while (Number(log[date] || 0) > 0) {
        count += 1;
        date = shiftDate(date, -1);
    }

    return count;
}

function calculateLongestStreak() {
    const dates = Object.keys(state.focus.log || {})
        .filter(date => Number(state.focus.log[date] || 0) > 0)
        .sort();

    let longest = 0;
    let current = 0;
    let previous = null;

    dates.forEach(date => {
        const ordinal = dateOrdinal(date);

        if (previous !== null && ordinal === previous + 1) {
            current += 1;
        } else {
            current = 1;
        }

        longest = Math.max(longest, current);
        previous = ordinal;
    });

    return longest;
}

function renderFocusStatistics() {
    const today = localDateKey();
    const values = [];

    for (let offset = 6; offset >= 0; offset -= 1) {
        const date = shiftDate(today, -offset);
        const minutes = Number(state.focus.log[date] || 0);

        const parts = date.split("-").map(Number);
        const dateObject = new Date(parts[0], parts[1] - 1, parts[2]);

        values.push({
            date,
            minutes,
            label: new Intl.DateTimeFormat("de-DE", {
                weekday: "short"
            }).format(dateObject).slice(0, 2)
        });
    }

    const maximum = Math.max(1, ...values.map(item => item.minutes));

    document.getElementById("focus-chart").innerHTML =
        values.map(item => {
            const height = Math.max(4, Math.round((item.minutes / maximum) * 55));

            return `
                <div class="chart-col" title="${item.minutes} Minuten">
                    <div class="chart-bar" style="height:${height}px"></div>
                    <div class="chart-label">${esc(item.label)}</div>
                </div>
            `;
        }).join("");

    const weekTotal = values.reduce((sum, item) => sum + item.minutes, 0);
    const activeDays = values.filter(item => item.minutes > 0).length;
    const bestDay = values.reduce(
        (best, item) => item.minutes > best.minutes ? item : best,
        { minutes: 0, date: "" }
    );

    document.getElementById("focus-today").textContent =
        `${Number(state.focus.log[today] || 0)} Min. heute`;

    document.getElementById("stat-week-total").textContent =
        `${Math.round(weekTotal)} Min.`;

    document.getElementById("stat-week-avg").textContent =
        `${activeDays ? Math.round(weekTotal / activeDays) : 0} Min.`;

    document.getElementById("stat-best-day").textContent =
        bestDay.minutes
            ? `${bestDay.minutes} Min. (${formatShortDate(bestDay.date)})`
            : "–";

    const streak = calculateStreak();
    const longest = calculateLongestStreak();

    document.getElementById("streak-badge").textContent =
        `🔥 ${streak} ${streak === 1 ? "Tag" : "Tage"}`;

    document.getElementById("stat-longest-streak").textContent =
        `${longest} ${longest === 1 ? "Tag" : "Tage"}`;

    updateTimerDisplay();
}

/* =========================================================
   ICS IMPORT: HISINONE, MOODLE, GOOGLE, OUTLOOK
   ========================================================= */

function unfoldIcs(text) {
    return String(text || "").replace(/\r?\n[ \t]/g, "");
}

function unescapeIcs(text) {
    return String(text || "")
        .replace(/\\n/gi, "\n")
        .replace(/\\,/g, ",")
        .replace(/\\;/g, ";")
        .replace(/\\\\/g, "\\");
}

function parseIcsProperty(line) {
    const separator = line.indexOf(":");

    if (separator < 0) {
        return null;
    }

    const left = line.slice(0, separator);
    const value = line.slice(separator + 1);
    const pieces = left.split(";");

    return {
        name: pieces[0].toUpperCase(),
        parameters: pieces.slice(1),
        value
    };
}

function parseIcsDateTime(value) {
    const clean = String(value || "").trim();
    const match = clean.match(
        /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})?)?(Z)?$/
    );

    if (!match) {
        return null;
    }

    const year = Number(match[1]);
    const month = Number(match[2]) - 1;
    const day = Number(match[3]);
    const hour = Number(match[4] || 0);
    const minute = Number(match[5] || 0);
    const second = Number(match[6] || 0);
    const isUtc = Boolean(match[7]);
    const allDay = !match[4];

    let date;

    if (isUtc) {
        date = new Date(Date.UTC(year, month, day, hour, minute, second));
    } else {
        date = new Date(year, month, day, hour, minute, second);
    }

    return {
        date: localDateKey(date),
        time: allDay
            ? ""
            : `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`,
        allDay
    };
}

function parseRRule(value) {
    const rule = {};

    String(value || "").split(";").forEach(part => {
        const pieces = part.split("=");

        if (pieces.length === 2) {
            rule[pieces[0].toUpperCase()] = pieces[1];
        }
    });

    return rule;
}

function parseIcs(text) {
    const lines = unfoldIcs(text).split(/\r?\n/);
    const events = [];

    let current = null;

    lines.forEach(rawLine => {
        const line = rawLine.trim();

        if (line === "BEGIN:VEVENT") {
            current = {
                uid: "",
                summary: "",
                description: "",
                location: "",
                startRaw: "",
                endRaw: "",
                allDay: false,
                rrule: {}
            };

            return;
        }

        if (line === "END:VEVENT") {
            if (current && current.startRaw) {
                events.push(current);
            }

            current = null;
            return;
        }

        if (!current) {
            return;
        }

        const property = parseIcsProperty(line);

        if (!property) {
            return;
        }

        if (property.name === "UID") {
            current.uid = unescapeIcs(property.value);
        }

        if (property.name === "SUMMARY") {
            current.summary = unescapeIcs(property.value);
        }

        if (property.name === "DESCRIPTION") {
            current.description = unescapeIcs(property.value);
        }

        if (property.name === "LOCATION") {
            current.location = unescapeIcs(property.value);
        }

        if (property.name === "DTSTART") {
            current.startRaw = property.value;
            current.allDay = property.parameters.some(param =>
                param.toUpperCase() === "VALUE=DATE"
            );
        }

        if (property.name === "DTEND") {
            current.endRaw = property.value;
        }

        if (property.name === "RRULE") {
            current.rrule = parseRRule(property.value);
        }
    });

    return events;
}

function detectSessionType(summary, description = "") {
    const text = `${summary} ${description}`.toLowerCase();

    if (/(übung|ubung|tutorial|tutorium|exercise)/i.test(text)) return "Übung";
    if (/(praktikum|labor|lab)/i.test(text)) return "Praktikum";
    if (/(seminar)/i.test(text)) return "Seminar";
    if (/(sprechstunde|office hour)/i.test(text)) return "Sprechstunde";
    if (/(vorlesung|lecture)/i.test(text)) return "Vorlesung";

    return "Termin";
}

function extractLecturer(text) {
    const patterns = [
        /Doz\.?\s*:\s*(.+?)(?:\n|$)/i,
        /Dozent(?:in)?\s*:\s*(.+?)(?:\n|$)/i,
        /Lehrende?\s*:\s*(.+?)(?:\n|$)/i,
        /Tutor(?:in)?\s*:\s*(.+?)(?:\n|$)/i,
        /Veranstalter\s*:\s*(.+?)(?:\n|$)/i
    ];

    for (const pattern of patterns) {
        const match = String(text || "").match(pattern);

        if (match) {
            return match[1].trim();
        }
    }

    return "";
}

function extractRoom(text) {
    const patterns = [
        /Raum\s*:\s*(.+?)(?:\n|$)/i,
        /Ort\s*:\s*(.+?)(?:\n|$)/i,
        /Room\s*:\s*(.+?)(?:\n|$)/i,
        /Location\s*:\s*(.+?)(?:\n|$)/i
    ];

    for (const pattern of patterns) {
        const match = String(text || "").match(pattern);

        if (match) {
            return match[1].trim();
        }
    }

    return "";
}

function cleanCourseName(summary) {
    let name = String(summary || "Unbekannt").trim();

    const prefixes = [
        "Vorlesung:",
        "Übung:",
        "Uebung:",
        "Seminar:",
        "Praktikum:",
        "Tutorium:",
        "Tutorial:",
        "Vorlesung ",
        "Übung ",
        "Uebung ",
        "Seminar ",
        "Praktikum ",
        "VO ",
        "UE ",
        "VL "
    ];

    prefixes.forEach(prefix => {
        if (name.toLowerCase().startsWith(prefix.toLowerCase())) {
            name = name.slice(prefix.length).trim();
        }
    });

    const typeSuffix = name.match(
        /^(.*?)\s*[-–]\s*(Vorlesung|Übung|Uebung|Seminar|Praktikum|Tutorial|Tutorium)$/i
    );

    if (typeSuffix) {
        name = typeSuffix[1].trim();
    }

    const typeBracket = name.match(
        /^(.*?)\s*\((Vorlesung|Übung|Uebung|Seminar|Praktikum|Tutorial|Tutorium)\)$/i
    );

    if (typeBracket) {
        name = typeBracket[1].trim();
    }

    return name || "Unbekannt";
}

function convertIcsEvents(events, sourceId) {
    const timed = [];
    const todos = [];

    events.forEach(event => {
        const start = parseIcsDateTime(event.startRaw);
        const end = parseIcsDateTime(event.endRaw);

        if (!start) return;

        const course = cleanCourseName(event.summary);
        const type = detectSessionType(event.summary, event.description);
        const room = event.location || extractRoom(event.description);
        const lecturer = extractLecturer(event.description);

        if (start.allDay) {
            const externalKey = event.uid || `${event.summary}|${start.date}`;

            todos.push({
                id: stableId(`todo_${sourceId}`, externalKey),
                title: event.summary || "Kalenderaufgabe",
                course,
                due: start.date,
                min: 45,
                prio: 2,
                notes: event.description || "",
                repeatDays: 0,
                done: false,
                created: new Date().toISOString(),
                completedAt: null,
                sourceId,
                generatedNextId: null
            });

            return;
        }

        const dayDate = new Date(
            Number(start.date.slice(0, 4)),
            Number(start.date.slice(5, 7)) - 1,
            Number(start.date.slice(8, 10))
        );

        const signature = [
            course,
            type,
            dayDate.getDay(),
            start.time,
            end ? end.time : "",
            room,
            lecturer
        ].join("|");

        timed.push({
            title: event.summary || "Termin",
            course,
            type,
            date: start.date,
            start: start.time,
            end: end ? end.time : "",
            room,
            lecturer,
            uid: event.uid,
            rrule: event.rrule || {},
            signature
        });
    });

    const signatureCounts = {};

    timed.forEach(item => {
        signatureCounts[item.signature] =
            Number(signatureCounts[item.signature] || 0) + 1;
    });

    const sessions = [];
    const specialEvents = [];
    const sessionKeys = new Set();
    const eventKeys = new Set();
    const todoKeys = new Set();

    timed.forEach(item => {
        const recurring =
            item.rrule.FREQ === "WEEKLY" ||
            signatureCounts[item.signature] >= 2;

        if (recurring) {
            const dayDate = new Date(
                Number(item.date.slice(0, 4)),
                Number(item.date.slice(5, 7)) - 1,
                Number(item.date.slice(8, 10))
            );

            const key = item.uid || item.signature;

            if (sessionKeys.has(key)) {
                return;
            }

            sessionKeys.add(key);

            sessions.push({
                id: stableId(`session_${sourceId}`, key),
                course: item.course,
                type: item.type === "Termin" ? "Vorlesung" : item.type,
                day: (dayDate.getDay() + 6) % 7,
                start: item.start,
                end: item.end || "09:30",
                room: item.room,
                lecturer: item.lecturer,
                sourceId,
                externalKey: key
            });
        } else {
            const key = `${item.uid || item.signature}|${item.date}|${item.start}`;

            if (eventKeys.has(key)) {
                return;
            }

            eventKeys.add(key);

            specialEvents.push({
                id: stableId(`event_${sourceId}`, key),
                title: item.title,
                course: item.course,
                type: item.type,
                date: item.date,
                start: item.start,
                end: item.end,
                room: item.room,
                lecturer: item.lecturer,
                sourceId,
                externalKey: key
            });
        }
    });

    const uniqueTodos = todos.filter(todo => {
        const key = `${todo.title}|${todo.due}`;

        if (todoKeys.has(key)) return false;

        todoKeys.add(key);
        return true;
    });

    return {
        sessions,
        events: specialEvents,
        todos: uniqueTodos
    };
}

/* =========================================================
   KALENDERQUELLEN
   ========================================================= */

function openSourcesModal() {
    renderSources();
    openModal("modal-sources");
}

function renderSources() {
    const container = document.getElementById("source-list");

    if (!state.sources.length) {
        container.innerHTML = `
            <div class="empty">
                Noch keine Quellen angelegt.<br>
                Importiere eine HISinOne- oder Moodle-ICS-Datei.
            </div>
        `;
        return;
    }

    container.innerHTML = state.sources.map(source => `
        <article class="item">
            <div class="item-main">
                <div class="item-content">
                    <div class="item-title">
                        ${esc(source.name)}
                        <span class="badge blue">
                            ${source.type === "ics_url" ? "URL" : "Datei"}
                        </span>
                    </div>

                    <div class="item-sub">
                        Letzter Import:
                        ${source.lastImport ? esc(formatDate(source.lastImport.slice(0, 10))) : "nie"}
                    </div>

                    <div class="item-sub">
                        ${source.sessionCount || 0} Wochen-Termine
                        · ${source.eventCount || 0} Sondertermine
                        · ${source.todoCount || 0} Kalender-Todos
                    </div>
                </div>

                <div class="item-actions">
                    <button class="mini-btn"
                            type="button"
                            title="Quelle aktualisieren"
                            onclick="refreshSource('${source.id}')">
                        ↻
                    </button>

                    <button class="mini-btn edit"
                            type="button"
                            title="Quelle bearbeiten"
                            onclick="openSourceModal('${source.id}')">
                        ✏️
                    </button>

                    <button class="mini-btn delete"
                            type="button"
                            title="Quelle löschen"
                            onclick="deleteSource('${source.id}')">
                        🗑️
                    </button>
                </div>
            </div>
        </article>
    `).join("");
}

function updateSourceFields() {
    const type = document.getElementById("source-type").value;

    document.getElementById("source-file-wrap")
        .classList.toggle("hidden", type !== "ics_file");

    document.getElementById("source-url-wrap")
        .classList.toggle("hidden", type !== "ics_url");
}

function openSourceModal(id = null) {
    const source = id
        ? state.sources.find(item => item.id === id)
        : null;

    document.getElementById("source-modal-title").textContent =
        source ? "Kalenderquelle bearbeiten" : "Kalenderquelle hinzufügen";

    document.getElementById("source-id").value = source ? source.id : "";
    document.getElementById("source-name").value = source ? source.name : "";
    document.getElementById("source-type").value = source ? source.type : "ics_file";
    document.getElementById("source-url").value = source ? source.url : "";
    document.getElementById("source-file").value = "";

    updateSourceFields();
    openModal("modal-source");
}

async function saveSource() {
    const id = document.getElementById("source-id").value;
    const name = document.getElementById("source-name").value.trim() || "Kalenderquelle";
    const type = document.getElementById("source-type").value;
    const url = document.getElementById("source-url").value.trim();
    const file = document.getElementById("source-file").files[0];

    let source = id
        ? state.sources.find(item => item.id === id)
        : null;

    if (!source) {
        source = {
            id: uid(),
            name,
            type,
            url: "",
            lastImport: null,
            sessionCount: 0,
            eventCount: 0,
            todoCount: 0
        };
    }

    source.name = name;
    source.type = type;
    source.url = type === "ics_url" ? url : "";

    if (type === "ics_file") {
        if (!file) {
            if (id) {
                const existingIndex = state.sources.findIndex(item => item.id === source.id);

                if (existingIndex >= 0) {
                    state.sources[existingIndex] = source;
                    saveData();
                    closeModal("modal-source");
                    renderSources();
                    showToast("Quelle gespeichert");
                }

                return;
            }

            showToast("Bitte eine .ics-Datei auswählen");
            return;
        }

        try {
            const text = await file.text();

            applyIcsImport(source, text);
            closeModal("modal-source");
            renderSources();
        } catch (error) {
            console.error(error);
            showToast("Datei konnte nicht gelesen werden");
        }

        return;
    }

    if (!url) {
        showToast("Bitte einen ICS-Kalenderlink eingeben");
        return;
    }

    await fetchAndImportSource(source);
    closeModal("modal-source");
    renderSources();
}

async function fetchAndImportSource(source) {
    try {
        const response = await fetch(source.url, {
            method: "GET",
            mode: "cors",
            cache: "no-store"
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const text = await response.text();

        if (!text.includes("BEGIN:VCALENDAR")) {
            throw new Error("Keine gültige ICS-Datei");
        }

        applyIcsImport(source, text);
    } catch (error) {
        console.error(error);

        showToast(
            "URL-Import blockiert. Nutze bei HISinOne/Moodle die heruntergeladene .ics-Datei."
        );
    }
}

async function refreshSource(id) {
    const source = state.sources.find(item => item.id === id);

    if (!source) return;

    if (source.type === "ics_url") {
        await fetchAndImportSource(source);
        renderSources();
        return;
    }

    openSourceModal(source.id);

    showToast(
        "Bitte die neu heruntergeladene .ics-Datei auswählen und importieren."
    );
}

async function deleteSource(id) {
    const source = state.sources.find(item => item.id === id);

    if (!source) return;

    const confirmed = await askUser(
        "Quelle löschen?",
        "Die Quelle und alle daraus importierten Termine, Sondertermine und Kalender-Todos werden entfernt.",
        "Löschen",
        "🗑️"
    );

    if (!confirmed) return;

    state.sources = state.sources.filter(item => item.id !== id);
    state.sessions = state.sessions.filter(item => item.sourceId !== id);
    state.events = state.events.filter(item => item.sourceId !== id);
    state.todos = state.todos.filter(item => item.sourceId !== id);

    saveData();
    renderAll();
    renderSources();

    showToast("Quelle gelöscht");
}

function applyIcsImport(source, text) {
    const rawEvents = parseIcs(text);

    if (!rawEvents.length) {
        showToast("Keine Termine in der ICS-Datei gefunden");
        return;
    }

    const converted = convertIcsEvents(rawEvents, source.id);

    state.sessions = state.sessions.filter(item => item.sourceId !== source.id);
    state.events = state.events.filter(item => item.sourceId !== source.id);
    state.todos = state.todos.filter(item => item.sourceId !== source.id);

    state.sessions.push(...converted.sessions);
    state.events.push(...converted.events);
    state.todos.push(...converted.todos);

    const courseNames = new Set();

    converted.sessions.forEach(item => {
        courseNames.add(item.course);
        ensureCourse(item.course, item.lecturer);
    });

    converted.events.forEach(item => {
        if (item.course) {
            courseNames.add(item.course);
            ensureCourse(item.course, item.lecturer);
        }
    });

    converted.todos.forEach(item => {
        if (item.course) {
            courseNames.add(item.course);
            ensureCourse(item.course);
        }
    });

    source.lastImport = new Date().toISOString();
    source.sessionCount = converted.sessions.length;
    source.eventCount = converted.events.length;
    source.todoCount = converted.todos.length;

    const sourceIndex = state.sources.findIndex(item => item.id === source.id);

    if (sourceIndex >= 0) {
        state.sources[sourceIndex] = source;
    } else {
        state.sources.push(source);
    }

    saveData();
    renderAll();

    showToast(
        `${converted.sessions.length} Termine importiert · ${courseNames.size} Kurse erkannt`
    );
}

/* =========================================================
   BACKUP / IMPORT / EXPORT
   ========================================================= */

async function shareOrDownload(blob, filename, title) {
    const file = new File([blob], filename, {
        type: blob.type
    });

    if (navigator.share &&
        navigator.canShare &&
        navigator.canShare({ files: [file] })) {
        try {
            await navigator.share({
                files: [file],
                title
            });

            return true;
        } catch (error) {
            if (error.name === "AbortError") {
                return false;
            }
        }
    }

    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");

    link.href = url;
    link.download = filename;

    document.body.appendChild(link);
    link.click();
    link.remove();

    setTimeout(() => URL.revokeObjectURL(url), 2000);

    return true;
}

async function exportBackup() {
    const timestamp = Date.now();

    const data = JSON.parse(JSON.stringify(state));
    data.meta.lastBackupAt = timestamp;

    const blob = new Blob(
        [JSON.stringify(data, null, 2)],
        { type: "application/json;charset=utf-8" }
    );

    const success = await shareOrDownload(
        blob,
        `uniplan_backup_${localDateKey()}.json`,
        "UniPlan Backup"
    );

    if (success) {
        state.meta.lastBackupAt = timestamp;
        saveData();

        renderToday();
        showToast("Backup erstellt");
    }
}

function mergeArray(currentArray, incomingArray) {
    const positions = new Map();

    currentArray.forEach((item, index) => {
        positions.set(item.id, index);
    });

    let added = 0;
    let updated = 0;

    incomingArray.forEach(item => {
        if (positions.has(item.id)) {
            currentArray[positions.get(item.id)] = item;
            updated += 1;
        } else {
            currentArray.push(item);
            added += 1;
        }
    });

    return { added, updated };
}

function mergeIntoState(incoming) {
    const totals = { added: 0, updated: 0 };

    [
        "courses",
        "sessions",
        "events",
        "todos",
        "exams",
        "sources"
    ].forEach(key => {
        const result = mergeArray(state[key], incoming[key]);

        totals.added += result.added;
        totals.updated += result.updated;
    });

    Object.entries(incoming.focus.log || {}).forEach(([day, minutes]) => {
        const current = Number(state.focus.log[day] || 0);
        state.focus.log[day] = Math.max(current, Number(minutes) || 0);
    });

    state.meta.lastBackupAt = Math.max(
        Number(state.meta.lastBackupAt || 0),
        Number(incoming.meta.lastBackupAt || 0)
    );

    return totals;
}

function askImportMode(incoming) {
    return new Promise(resolve => {
        importResolver = resolve;

        document.getElementById("import-summary").textContent =
            `Gefunden: ${incoming.sessions.length} Termine, ` +
            `${incoming.events.length} Sondertermine, ` +
            `${incoming.todos.length} Todos und ` +
            `${incoming.exams.length} Klausuren.`;

        document.getElementById("import-dialog").classList.add("show");
        document.body.style.overflow = "hidden";
    });
}

function finishImportMode(mode) {
    document.getElementById("import-dialog").classList.remove("show");
    document.body.style.overflow = "";

    if (importResolver) {
        const resolver = importResolver;
        importResolver = null;
        resolver(mode);
    }
}

document.getElementById("import-merge").onclick = () => finishImportMode("merge");
document.getElementById("import-replace").onclick = () => finishImportMode("replace");
document.getElementById("import-cancel").onclick = () => finishImportMode(null);

function importBackup() {
    const input = document.createElement("input");

    input.type = "file";
    input.accept = ".json,application/json";

    input.onchange = async event => {
        const file = event.target.files[0];

        if (!file) return;

        let incoming;

        try {
            incoming = normalizeData(JSON.parse(await file.text()));
        } catch (error) {
            console.error(error);
            showToast("Die Datei ist kein gültiges UniPlan-Backup");
            return;
        }

        const mode = await askImportMode(incoming);

        if (!mode) return;

        if (mode === "merge") {
            const report = mergeIntoState(incoming);

            saveData();
            renderAll();

            showToast(`${report.added} neu, ${report.updated} aktualisiert`);
            return;
        }

        const confirmed = await askUser(
            "Wirklich alles ersetzen?",
            "Alle aktuellen Termine, Todos, Quellen und Klausuren werden überschrieben.",
            "Ersetzen",
            "⚠️"
        );

        if (!confirmed) return;

        state = incoming;

        saveData();
        renderAll();

        showToast("Daten ersetzt");
    };

    input.click();
}

/* =========================================================
   ICS EXPORT
   ========================================================= */

function escapeICS(value) {
    return String(value || "")
        .replace(/\\/g, "\\\\")
        .replace(/;/g, "\\;")
        .replace(/,/g, "\\,")
        .replace(/\r?\n/g, "\\n");
}

function formatICSLocal(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    const h = String(date.getHours()).padStart(2, "0");
    const min = String(date.getMinutes()).padStart(2, "0");
    const sec = String(date.getSeconds()).padStart(2, "0");

    return `${y}${m}${d}T${h}${min}${sec}`;
}

function formatICSUTC(date) {
    return date.toISOString()
        .replace(/[-:]/g, "")
        .replace(/\.\d{3}Z$/, "Z");
}

function nextSessionDate(session) {
    const now = new Date();
    const targetDay = (Number(session.day) + 1) % 7;
    const delta = (targetDay - now.getDay() + 7) % 7;

    const startParts = session.start.split(":").map(Number);

    const result = new Date(
        now.getFullYear(),
        now.getMonth(),
        now.getDate() + delta,
        startParts[0],
        startParts[1],
        0
    );

    if (result <= now) {
        result.setDate(result.getDate() + 7);
    }

    return result;
}

async function exportICS() {
    const lines = [
        "BEGIN:VCALENDAR",
        "VERSION:2.0",
        "CALSCALE:GREGORIAN",
        "METHOD:PUBLISH",
        "PRODID:-//UniPlan Pro//DE",
        "X-WR-CALNAME:UniPlan"
    ];

    const stamp = formatICSUTC(new Date());

    state.sessions
        .filter(session => activeCourse(session.course))
        .forEach(session => {
            const start = nextSessionDate(session);
            const duration =
                timeToMinutes(session.end) - timeToMinutes(session.start);

            const end = new Date(start.getTime() + duration * 60000);

            lines.push(
                "BEGIN:VEVENT",
                `UID:session-${session.id}@uniplan`,
                `DTSTAMP:${stamp}`,
                `DTSTART:${formatICSLocal(start)}`,
                `DTEND:${formatICSLocal(end)}`,
                "RRULE:FREQ=WEEKLY;COUNT=16",
                `SUMMARY:${escapeICS(`${session.type}: ${session.course}`)}`,
                `LOCATION:${escapeICS(session.room)}`,
                `DESCRIPTION:${escapeICS(session.lecturer)}`,
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                "DESCRIPTION:UniPlan-Erinnerung",
                "TRIGGER:-PT30M",
                "END:VALARM",
                "END:VEVENT"
            );
        });

    state.events
        .filter(event => event.date)
        .forEach(event => {
            const dateParts = event.date.split("-").map(Number);
            const timeParts = (event.start || "09:00").split(":").map(Number);

            const start = new Date(
                dateParts[0],
                dateParts[1] - 1,
                dateParts[2],
                timeParts[0],
                timeParts[1],
                0
            );

            const endParts = event.end
                ? event.end.split(":").map(Number)
                : null;

            const end = endParts
                ? new Date(dateParts[0], dateParts[1] - 1, dateParts[2], endParts[0], endParts[1], 0)
                : new Date(start.getTime() + 60 * 60000);

            lines.push(
                "BEGIN:VEVENT",
                `UID:event-${event.id}@uniplan`,
                `DTSTAMP:${stamp}`,
                `DTSTART:${formatICSLocal(start)}`,
                `DTEND:${formatICSLocal(end)}`,
                `SUMMARY:${escapeICS(event.title)}`,
                `LOCATION:${escapeICS(event.room)}`,
                `DESCRIPTION:${escapeICS(event.lecturer)}`,
                "END:VEVENT"
            );
        });

    state.exams
        .filter(exam => activeCourse(exam.course))
        .forEach(exam => {
            if (!exam.date) return;

            const dateParts = exam.date.split("-").map(Number);
            const timeParts = (exam.time || "09:00").split(":").map(Number);

            const start = new Date(
                dateParts[0],
                dateParts[1] - 1,
                dateParts[2],
                timeParts[0],
                timeParts[1],
                0
            );

            const end = new Date(start.getTime() + 120 * 60000);

            lines.push(
                "BEGIN:VEVENT",
                `UID:exam-${exam.id}@uniplan`,
                `DTSTAMP:${stamp}`,
                `DTSTART:${formatICSLocal(start)}`,
                `DTEND:${formatICSLocal(end)}`,
                `SUMMARY:${escapeICS(`Klausur: ${exam.course} – ${exam.name}`)}`,
                `LOCATION:${escapeICS(exam.room)}`,
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                "DESCRIPTION:Klausur morgen",
                "TRIGGER:-P1D",
                "END:VALARM",
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                "DESCRIPTION:Klausur in zwei Stunden",
                "TRIGGER:-PT2H",
                "END:VALARM",
                "END:VEVENT"
            );
        });

    state.todos
        .filter(todo => !todo.done && todo.due && activeCourse(todo.course))
        .forEach(todo => {
            const start = todo.due.replace(/-/g, "");
            const end = shiftDate(todo.due, 1).replace(/-/g, "");

            lines.push(
                "BEGIN:VEVENT",
                `UID:todo-${todo.id}@uniplan`,
                `DTSTAMP:${stamp}`,
                `DTSTART;VALUE=DATE:${start}`,
                `DTEND;VALUE=DATE:${end}`,
                `SUMMARY:${escapeICS(`Abgabe: ${todo.title}`)}`,
                `DESCRIPTION:${escapeICS(todo.notes)}`,
                "BEGIN:VALARM",
                "ACTION:DISPLAY",
                "DESCRIPTION:Abgabe steht bevor",
                "TRIGGER:-PT12H",
                "END:VALARM",
                "END:VEVENT"
            );
        });

    lines.push("END:VCALENDAR");

    const blob = new Blob(
        [lines.join("\r\n")],
        { type: "text/calendar;charset=utf-8" }
    );

    const success = await shareOrDownload(
        blob,
        `uniplan_kalender_${localDateKey()}.ics`,
        "UniPlan Kalender"
    );

    if (success) {
        showToast("Kalenderdatei erstellt");
    }
}

/* =========================================================
   GESAMT-RENDERING UND START
   ========================================================= */

function renderAll() {
    renderSchedule();
    renderTodos();
    renderWorkload();
    renderToday();
    renderFocusStatistics();
    refreshCourseList();
    updateHeader();
    updateNetworkStatus();
}

loadData();
renderAll();
updateTimerDisplay();

setInterval(updateTimerDisplay, 1000);

document.addEventListener("visibilitychange", () => {
    if (!document.hidden) {
        updateTimerDisplay();
        renderToday();
    }
});

window.addEventListener("focus", () => {
    updateTimerDisplay();
    renderToday();
});

if ("serviceWorker" in navigator) {
    window.addEventListener("load", async () => {
        try {
            await navigator.serviceWorker.register("./sw.js");
        } catch (error) {
            console.error("Service Worker konnte nicht registriert werden:", error);
        }
    });
}
