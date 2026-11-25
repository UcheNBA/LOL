(() => {
    "use strict";

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const WELCOME_KEY = "lol-welcome";
    const PREFS_KEY = "lol-prefs";

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];
    const text = (root, selector) => (root.querySelector(selector)?.textContent || "").trim();
    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
    const pick = (list) => list[Math.floor(Math.random() * list.length)];
    const make = (tag, className = "", content = "") => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (content) element.textContent = content;
        return element;
    };
    const store = {
        get(key, fallback) {
            try {
                const raw = localStorage.getItem(key);
                return raw === null ? fallback : JSON.parse(raw);
            } catch { return fallback; }
        },
        set(key, value) {
            try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
        },
    };

    /* =====================================================
       1. LOL splash (shown when logging in)
       ===================================================== */

    let splashEl = null;

    function buildSplash(message, duration) {
        const el = make("div", "lol-splash");
        el.setAttribute("role", "status");
        el.setAttribute("aria-live", "polite");
        el.style.setProperty("--dur", `${duration}ms`);
        el.innerHTML = `
            <div class="lol-splash-inner">
                <div class="lol-word" aria-label="LOL">
                    <span class="lol-letter l1" aria-hidden="true">L</span>
                    <span class="lol-face" aria-hidden="true">
                        <span class="eye"></span><span class="eye r"></span>
                        <span class="mouth"></span>
                        <span class="tear"></span><span class="tear r"></span>
                    </span>
                    <span class="lol-letter l2" aria-hidden="true">L</span>
                </div>
                <p class="lol-tag"></p>
                <div class="lol-bar" aria-hidden="true"><i></i></div>
            </div>
            <span class="lol-ha h1" aria-hidden="true">ha</span>
            <span class="lol-ha h2" aria-hidden="true">HA</span>
            <span class="lol-ha h3" aria-hidden="true">ha!</span>
            <span class="lol-ha h4" aria-hidden="true">ha</span>`;
        $(".lol-tag", el).textContent = message;
        return el;
    }

    function showSplash(message, minMs) {
        hideSplash(true);
        const duration = reduceMotion ? Math.min(minMs, 500) : minMs;
        splashEl = buildSplash(message, duration);
        document.body.append(splashEl);
        document.documentElement.classList.add("lol-splashing");
        const shown = splashEl;
        requestAnimationFrame(() => shown.classList.add("is-on"));
        return wait(duration);
    }

    function hideSplash(instant = false) {
        if (!splashEl) return;
        const el = splashEl;
        splashEl = null;
        document.documentElement.classList.remove("lol-splashing");
        if (instant || reduceMotion) {
            el.remove();
            return;
        }
        el.classList.add("is-off");
        window.setTimeout(() => el.remove(), 350);
    }

    window.addEventListener("pageshow", (event) => { if (event.persisted) hideSplash(true); });

    function initLogin() {
        const identifier = $('input[name="identifier"]');
        const form = identifier && identifier.form;
        if (form) {
            // A failed attempt lands back here, so it must not trigger the welcome splash later.
            try { sessionStorage.removeItem(WELCOME_KEY); } catch { /* ignore */ }
            let busy = false;
            form.addEventListener("submit", (event) => {
                if (busy) return;
                event.preventDefault();
                busy = true;
                const button = $('[type="submit"]', form);
                if (button) button.disabled = true;
                try { sessionStorage.setItem(WELCOME_KEY, "1"); } catch { /* ignore */ }
                showSplash("Signing you in…", 1700).then(() => form.submit());
            });
        }

        document.addEventListener("click", (event) => {
            const link = event.target.closest('a[href*="/auth/login"]');
            if (!link || event.defaultPrevented || event.button !== 0) return;
            if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target === "_blank") return;
            if (location.pathname.startsWith("/auth/login")) return;
            event.preventDefault();
            showSplash("Hold tight…", 1100).then(() => { location.href = link.href; });
        });
    }

    function initWelcome() {
        if (!$(".messenger")) return;
        let flagged = false;
        try {
            flagged = sessionStorage.getItem(WELCOME_KEY) === "1";
            sessionStorage.removeItem(WELCOME_KEY);
        } catch { /* ignore */ }
        if (!flagged) return;
        const first = text(document, ".self-label strong").split(/\s+/)[0];
        const promise = showSplash(first ? `Welcome back, ${first} 👋` : "Welcome back 👋", 1100);
        splashEl?.addEventListener("click", () => hideSplash());
        promise.then(() => hideSplash());
    }

    /* =====================================================
       2. Preferences (accent, wallpaper, text size, alerts)
       ===================================================== */

    const ACCENTS = [["Green", ""], ["Violet", "#7c5cff"], ["Blue", "#1e88e5"], ["Coral", "#ef5b4f"], ["Amber", "#d98a00"], ["Pink", "#d63384"]];
    const WALLS = [["doodle", "Doodle"], ["plain", "Plain"], ["aurora", "Aurora"], ["night", "Night sky"]];
    const SIZES = [["small", "Small"], ["normal", "Normal"], ["large", "Large"]];
    const prefs = { accent: "", wall: "doodle", size: "normal", sound: true, desktop: false, ...store.get(PREFS_KEY, {}) };
    const savePrefs = () => store.set(PREFS_KEY, prefs);

    function applyPrefs() {
        const root = document.documentElement;
        if (prefs.accent) {
            root.dataset.accent = "custom";
            root.style.setProperty("--user-accent", prefs.accent);
        } else {
            delete root.dataset.accent;
            root.style.removeProperty("--user-accent");
        }
        root.dataset.size = prefs.size;
        root.dataset.wall = prefs.wall;
    }

    /* ---------- sound ---------- */

    let audio = null;
    const unlockAudio = () => {
        try {
            audio = audio || new (window.AudioContext || window.webkitAudioContext)();
            if (audio.state === "suspended") audio.resume();
        } catch { /* no audio available */ }
    };
    window.addEventListener("pointerdown", unlockAudio, { once: true });
    window.addEventListener("keydown", unlockAudio, { once: true });

    function ping() {
        if (!prefs.sound) return;
        try {
            unlockAudio();
            if (!audio) return;
            const now = audio.currentTime;
            [[880, 0], [1320, 0.09]].forEach(([frequency, delay]) => {
                const oscillator = audio.createOscillator();
                const gain = audio.createGain();
                oscillator.type = "sine";
                oscillator.frequency.value = frequency;
                gain.gain.setValueAtTime(0.0001, now + delay);
                gain.gain.exponentialRampToValueAtTime(0.12, now + delay + 0.015);
                gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 0.16);
                oscillator.connect(gain).connect(audio.destination);
                oscillator.start(now + delay);
                oscillator.stop(now + delay + 0.18);
            });
        } catch { /* ignore */ }
    }

    /* ---------- settings dialog ---------- */

    function initSettings() {
        const head = $(".sidebar-head");
        const plus = head && $(".new-chat-button", head);
        if (!head || !plus) return;

        const gear = make("button", "icon-button", "⚙");
        gear.type = "button";
        gear.title = "Settings";
        gear.setAttribute("aria-label", "Settings");
        const actions = make("div", "lol-head-actions");
        plus.before(actions);
        actions.append(gear, plus);

        const dlg = make("dialog", "lol-settings");
        dlg.setAttribute("aria-labelledby", "lol-settings-title");
        dlg.innerHTML = `
            <form method="dialog" class="lol-settings-close"><button class="icon-button" aria-label="Close settings">×</button></form>
            <h2 id="lol-settings-title">Make it yours</h2>
            <section><h3>Accent colour</h3><div class="lol-swatches" role="radiogroup" aria-label="Accent colour"></div></section>
            <section><h3>Chat wallpaper</h3><div class="lol-walls" role="radiogroup" aria-label="Chat wallpaper"></div></section>
            <section><h3>Message size</h3><div class="lol-seg" role="radiogroup" aria-label="Message size"></div></section>
            <section><h3>Alerts</h3>
                <label class="lol-switch"><input type="checkbox" data-pref="sound"><span>Message sounds</span></label>
                <label class="lol-switch"><input type="checkbox" data-pref="desktop"><span>Desktop notifications</span></label>
                <p class="lol-note" role="status" hidden></p>
            </section>
            <section><h3>Handy tips</h3>
                <ul class="lol-tips">
                    <li><kbd>Ctrl</kbd> + <kbd>K</kbd> jumps to any chat</li>
                    <li>Right-click or long-press a chat to pin or mute it</li>
                    <li>Type <kbd>/</kbd> in a message for fun commands</li>
                    <li>Swipe a message right to reply (phones)</li>
                </ul>
            </section>`;
        document.body.append(dlg);

        const note = $(".lol-note", dlg);
        const showNote = (message) => { note.textContent = message; note.hidden = !message; };

        ACCENTS.forEach(([name, color]) => {
            const button = make("button", "lol-swatch");
            button.type = "button";
            button.setAttribute("role", "radio");
            button.setAttribute("aria-label", name);
            button.title = name;
            button.dataset.color = color;
            button.style.background = color || "#00a884";
            $(".lol-swatches", dlg).append(button);
        });
        WALLS.forEach(([key, label]) => {
            const button = make("button", `lol-wall w-${key}`, label);
            button.type = "button";
            button.setAttribute("role", "radio");
            button.dataset.wall = key;
            $(".lol-walls", dlg).append(button);
        });
        SIZES.forEach(([key, label]) => {
            const button = make("button", "", label);
            button.type = "button";
            button.setAttribute("role", "radio");
            button.dataset.size = key;
            $(".lol-seg", dlg).append(button);
        });

        function sync() {
            $$(".lol-swatch", dlg).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.color === prefs.accent)));
            $$(".lol-wall", dlg).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.wall === prefs.wall)));
            $$(".lol-seg button", dlg).forEach((b) => b.setAttribute("aria-checked", String(b.dataset.size === prefs.size)));
            $$("input[data-pref]", dlg).forEach((input) => { input.checked = Boolean(prefs[input.dataset.pref]); });
        }

        dlg.addEventListener("click", (event) => {
            if (event.target === dlg) { dlg.close(); return; }
            const swatch = event.target.closest(".lol-swatch");
            const wall = event.target.closest(".lol-wall");
            const size = event.target.closest(".lol-seg button");
            if (swatch) prefs.accent = swatch.dataset.color;
            else if (wall) prefs.wall = wall.dataset.wall;
            else if (size) prefs.size = size.dataset.size;
            else return;
            savePrefs();
            applyPrefs();
            sync();
        });

        dlg.addEventListener("change", async (event) => {
            const input = event.target.closest("input[data-pref]");
            if (!input) return;
            showNote("");
            if (input.dataset.pref === "sound") {
                prefs.sound = input.checked;
                if (prefs.sound) ping();
            } else if (input.dataset.pref === "desktop") {
                if (input.checked) {
                    if (!("Notification" in window)) {
                        input.checked = false;
                        showNote("This browser doesn’t support desktop notifications.");
                        return;
                    }
                    const result = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
                    if (result !== "granted") {
                        input.checked = false;
                        prefs.desktop = false;
                        savePrefs();
                        showNote("Notifications are blocked. Allow them in your browser’s site settings, then try again.");
                        return;
                    }
                }
                prefs.desktop = input.checked;
            }
            savePrefs();
        });

        gear.addEventListener("click", () => { sync(); showNote(""); dlg.showModal(); });
    }

    /* =====================================================
       3. Pin and mute chats, alerts for new messages
       ===================================================== */

    const userId = $(".messenger")?.dataset.userId || "anon";
    const FLAGS_KEY = `lol-chat-flags-${userId}`;
    const flags = store.get(FLAGS_KEY, {});
    const flagOf = (id) => flags[id] || {};
    const lastUnread = new Map();
    let seeded = false;
    let listObserver = null;
    let decorateQueued = false;
    let menuEl = null;

    function setFlag(id, key, on) {
        const next = { ...flagOf(id) };
        if (on) next[key] = 1;
        else delete next[key];
        if (Object.keys(next).length) flags[id] = next;
        else delete flags[id];
        store.set(FLAGS_KEY, flags);
        decorateList();
    }

    const unreadOf = (row) => {
        const badge = $(".unread-badge", row);
        const count = badge ? parseInt(badge.textContent, 10) : 0;
        return Number.isFinite(count) ? count : 0;
    };

    function announce(row, id) {
        ping();
        if (!prefs.desktop || !document.hidden || !("Notification" in window) || Notification.permission !== "granted") return;
        try {
            const notice = new Notification(text(row, ".chat-row-top strong") || "New message", {
                body: text(row, ".chat-preview"),
                tag: `lol-${id}`,
            });
            notice.onclick = () => {
                window.focus();
                $(`#chat-list .chat-row[data-chat-id="${id}"]`)?.click();
                notice.close();
            };
        } catch { /* ignore */ }
    }

    function watchUnread(rows) {
        rows.forEach((row) => {
            const id = row.dataset.chatId;
            const now = unreadOf(row);
            const before = lastUnread.get(id) || 0;
            lastUnread.set(id, now);
            if (seeded && now > before && !flagOf(id).mute && !row.classList.contains("is-active")) announce(row, id);
        });
        seeded = true;
    }

    function decorateList() {
        const list = $("#chat-list");
        if (!list) return;
        listObserver?.disconnect();
        const rows = $$(".chat-row", list);
        rows.forEach((row) => {
            const f = flagOf(row.dataset.chatId);
            row.classList.toggle("is-pinned", Boolean(f.pin));
            row.classList.toggle("is-muted", Boolean(f.mute));
        });
        const pinned = rows.filter((row) => row.classList.contains("is-pinned"));
        if (!pinned.every((row, index) => list.children[index] === row)) {
            [...pinned].reverse().forEach((row) => list.insertBefore(row, list.firstChild));
        }
        listObserver?.observe(list, { childList: true });
        watchUnread(rows);
    }

    function scheduleDecorate() {
        if (decorateQueued) return;
        decorateQueued = true;
        requestAnimationFrame(() => { decorateQueued = false; decorateList(); });
    }

    function closeMenu() {
        if (menuEl) { menuEl.remove(); menuEl = null; }
    }

    function openChatMenu(row, x, y) {
        closeMenu();
        const id = row.dataset.chatId;
        const f = flagOf(id);
        const menu = make("div", "lol-menu");
        menu.setAttribute("role", "menu");
        [
            [f.pin ? "Unpin chat" : "📌 Pin chat to top", "pin", !f.pin],
            [f.mute ? "Unmute notifications" : "🔕 Mute notifications", "mute", !f.mute],
        ].forEach(([label, key, on]) => {
            const button = make("button", "", label);
            button.type = "button";
            button.setAttribute("role", "menuitem");
            button.addEventListener("click", () => { setFlag(id, key, on); closeMenu(); });
            menu.append(button);
        });
        document.body.append(menu);
        menu.style.left = `${Math.max(8, Math.min(x, window.innerWidth - menu.offsetWidth - 8))}px`;
        menu.style.top = `${Math.max(8, Math.min(y, window.innerHeight - menu.offsetHeight - 8))}px`;
        menuEl = menu;
        $("button", menu).focus();
    }

    function initChatList() {
        const list = $("#chat-list");
        if (!list) return;
        listObserver = new MutationObserver(scheduleDecorate);
        decorateList();

        list.addEventListener("contextmenu", (event) => {
            const row = event.target.closest(".chat-row");
            if (!row) return;
            event.preventDefault();
            openChatMenu(row, event.clientX, event.clientY);
        });

        // long-press on touch screens
        let pressTimer = 0;
        let longPressed = false;
        const cancelPress = () => window.clearTimeout(pressTimer);
        list.addEventListener("pointerdown", (event) => {
            if (event.pointerType !== "touch") return;
            const row = event.target.closest(".chat-row");
            if (!row) return;
            const { clientX, clientY } = event;
            pressTimer = window.setTimeout(() => {
                longPressed = true;
                openChatMenu(row, clientX, clientY);
            }, 550);
        });
        ["pointerup", "pointercancel", "pointermove", "pointerleave"].forEach((name) => list.addEventListener(name, cancelPress));
        list.addEventListener("click", (event) => {
            if (!longPressed) return;
            longPressed = false;
            event.preventDefault();
            event.stopImmediatePropagation();      // the long-press must not also open the chat
        }, true);

        document.addEventListener("click", (event) => { if (menuEl && !event.target.closest(".lol-menu")) closeMenu(); });
        window.addEventListener("scroll", closeMenu, true);
        window.addEventListener("resize", closeMenu);

        // sound for live messages that arrive in the open chat
        const stream = $("#message-stream");
        if (stream) {
            new MutationObserver((mutations) => {
                for (const mutation of mutations) {
                    for (const node of mutation.addedNodes) {
                        if (node.nodeType !== 1 || !node.classList.contains("message-theirs") || !node.classList.contains("is-new")) continue;
                        const active = $(".chat-row.is-active");
                        if (active && flagOf(active.dataset.chatId).mute) continue;
                        ping();
                    }
                }
            }).observe(stream, { childList: true });
        }
    }

    /* =====================================================
       4. Quick switcher (Ctrl/Cmd + K)
       ===================================================== */

    let switcher = null;

    function closeSwitcher() {
        if (switcher) { switcher.remove(); switcher = null; }
    }

    function openSwitcher() {
        if (!$(".messenger") || switcher) return;
        const items = $$("#chat-list .chat-row").map((row) => ({
            id: row.dataset.chatId,
            title: text(row, ".chat-row-top strong"),
            preview: text(row, ".chat-preview"),
        }));
        const overlay = make("div", "lol-switcher");
        overlay.innerHTML = '<div class="lol-switcher-box" role="dialog" aria-modal="true" aria-label="Jump to a chat"><input type="search" placeholder="Jump to a chat…" aria-label="Jump to a chat" autocomplete="off"><ul role="listbox"></ul><p class="lol-switcher-hint">↑ ↓ to move · Enter to open · Esc to close</p></div>';
        const field = $("input", overlay);
        const ul = $("ul", overlay);
        let shown = [];
        let index = 0;

        const choose = (n) => {
            const item = shown[n];
            closeSwitcher();
            if (item) $(`#chat-list .chat-row[data-chat-id="${item.id}"]`)?.click();
        };
        const paint = () => {
            const query = field.value.trim().toLowerCase();
            shown = items.filter((item) => item.title.toLowerCase().includes(query));
            index = Math.min(index, Math.max(0, shown.length - 1));
            ul.textContent = "";
            if (!shown.length) { ul.append(make("li", "lol-empty", "No chats match.")); return; }
            shown.forEach((item, n) => {
                const li = make("li", n === index ? "is-on" : "");
                li.setAttribute("role", "option");
                li.setAttribute("aria-selected", String(n === index));
                li.append(make("b", "", item.title), make("span", "", item.preview));
                li.addEventListener("click", () => choose(n));
                ul.append(li);
            });
            $(".is-on", ul)?.scrollIntoView({ block: "nearest" });
        };

        field.addEventListener("input", () => { index = 0; paint(); });
        field.addEventListener("keydown", (event) => {
            if (event.key === "ArrowDown") { event.preventDefault(); index = Math.min(index + 1, shown.length - 1); paint(); }
            else if (event.key === "ArrowUp") { event.preventDefault(); index = Math.max(index - 1, 0); paint(); }
            else if (event.key === "Enter") { event.preventDefault(); choose(index); }
        });
        overlay.addEventListener("click", (event) => { if (event.target === overlay) closeSwitcher(); });
        document.body.append(overlay);
        switcher = overlay;
        paint();
        field.focus();
    }

    document.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "k" && $(".messenger")) {
            event.preventDefault();
            if (switcher) closeSwitcher();
            else openSwitcher();
        } else if (event.key === "Escape") {
            closeSwitcher();
            closeMenu();
        }
    });

    /* =====================================================
       5. Search inside a chat
       ===================================================== */

    function initFind() {
        const head = $(".conversation-head");
        const stream = $("#message-stream");
        if (!head || !stream) return;

        const toggle = make("button", "icon-button lol-find-toggle", "⌕");
        toggle.type = "button";
        toggle.title = "Search in this chat";
        toggle.setAttribute("aria-label", "Search in this chat");
        head.insertBefore(toggle, $(".head-decoration", head));

        const bar = make("div", "lol-find");
        bar.hidden = true;
        bar.innerHTML = '<input type="search" placeholder="Search messages on screen" aria-label="Search messages in this chat" autocomplete="off"><span class="lol-find-count" aria-live="polite"></span><button type="button" data-dir="-1" aria-label="Older match">↑</button><button type="button" data-dir="1" aria-label="Newer match">↓</button><button type="button" data-close aria-label="Close search">✕</button>';
        head.after(bar);

        const field = $("input", bar);
        const count = $(".lol-find-count", bar);
        let hits = [];
        let at = -1;

        const clear = () => $$(".find-hit, .find-current", stream).forEach((node) => node.classList.remove("find-hit", "find-current"));

        function show() {
            $$(".find-current", stream).forEach((node) => node.classList.remove("find-current"));
            count.textContent = hits.length ? `${at + 1} of ${hits.length}` : (field.value.trim() ? "No matches" : "");
            if (at < 0 || !hits[at]) return;
            hits[at].querySelector(".message-bubble").classList.add("find-current");
            hits[at].scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
        }

        function run() {
            clear();
            const query = field.value.trim().toLowerCase();
            hits = query ? $$(".message-row", stream).filter((row) => {
                const paragraph = $(".message-bubble p:not(.deleted-text)", row);
                return paragraph && paragraph.textContent.toLowerCase().includes(query);
            }) : [];
            hits.forEach((row) => $(".message-bubble", row).classList.add("find-hit"));
            at = hits.length - 1;                    // start at the newest match
            show();
        }

        function step(direction) {
            if (!hits.length) return;
            at = (at + direction + hits.length) % hits.length;
            show();
        }

        function close() {
            bar.hidden = true;
            field.value = "";
            hits = [];
            at = -1;
            clear();
            count.textContent = "";
        }

        toggle.addEventListener("click", () => {
            if (bar.hidden) { bar.hidden = false; field.focus(); }
            else close();
        });
        field.addEventListener("input", run);
        field.addEventListener("keydown", (event) => {
            if (event.key === "Enter") { event.preventDefault(); step(event.shiftKey ? 1 : -1); }
            else if (event.key === "Escape") { event.stopPropagation(); close(); }
        });
        bar.addEventListener("click", (event) => {
            const button = event.target.closest("button");
            if (!button) return;
            if (button.hasAttribute("data-close")) close();
            else step(Number(button.dataset.dir));
        });

        const title = $("#active-title");
        if (title) new MutationObserver(close).observe(title, { childList: true, characterData: true, subtree: true });
    }

    /* =====================================================
       6. Fun slash commands
       ===================================================== */

    const COMMANDS = [
        ["/flip", "Flip a coin"],
        ["/roll", "Roll a dice, like /roll 20"],
        ["/8ball", "Ask the magic 8-ball"],
        ["/rps", "Rock, paper, scissors"],
        ["/shrug", "Add a shrug"],
        ["/party", "Start a party 🎉"],
    ];
    const EIGHT_BALL = ["It is certain.", "Without a doubt.", "Yes, definitely.", "Most likely.", "Ask again later.", "Cannot predict now.", "Don’t count on it.", "My sources say no.", "Very doubtful."];

    function runSlash(input) {
        const [command, ...rest] = input.split(/\s+/);
        const argument = rest.join(" ").trim();
        switch (command.toLowerCase()) {
            case "/flip": return `🪙 ${pick(["Heads", "Tails"])}!`;
            case "/roll": {
                const sides = Math.min(Math.max(parseInt(argument, 10) || 6, 2), 1000);
                return `🎲 Rolled a ${1 + Math.floor(Math.random() * sides)} (1–${sides})`;
            }
            case "/8ball": return `🎱 ${argument ? `${argument.replace(/\?*$/, "?")} ` : ""}${pick(EIGHT_BALL)}`;
            case "/rps": return pick(["✊ Rock!", "✋ Paper!", "✌️ Scissors!"]);
            case "/shrug": return `${argument ? `${argument} ` : ""}¯\\_(ツ)_/¯`;
            case "/party": return "🎉 Party time! 🎉";
            default: return null;
        }
    }

    function initSlash() {
        const field = $("#message-input");
        const form = $("#message-form");
        const conversation = $("#conversation");
        const editCancel = $("#edit-cancel");
        if (!field || !form || !conversation) return;

        const popup = make("div", "lol-cmds");
        popup.hidden = true;
        popup.setAttribute("role", "listbox");
        popup.setAttribute("aria-label", "Commands");
        conversation.append(popup);

        const editing = () => Boolean(editCancel && !editCancel.hidden);

        function paint() {
            const value = field.value;
            if (editing() || !/^\/\S*$/.test(value)) { popup.hidden = true; return; }
            const matches = COMMANDS.filter(([command]) => command.startsWith(value.toLowerCase()));
            if (!matches.length) { popup.hidden = true; return; }
            popup.textContent = "";
            matches.forEach(([command, description]) => {
                const button = make("button");
                button.type = "button";
                button.append(make("b", "", command), make("span", "", description));
                button.addEventListener("click", () => {
                    field.value = `${command} `;
                    field.dispatchEvent(new Event("input", { bubbles: true }));
                    field.focus();
                    popup.hidden = true;
                });
                popup.append(button);
            });
            popup.hidden = false;
        }

        field.addEventListener("input", paint);
        field.addEventListener("blur", () => window.setTimeout(() => { popup.hidden = true; }, 150));
        // Runs before the messenger's own submit handler, so it can swap in the command's result.
        form.addEventListener("submit", () => {
            popup.hidden = true;
            if (editing()) return;
            const value = field.value.trim();
            if (!value.startsWith("/")) return;
            const result = runSlash(value);
            if (result) field.value = result;
        }, true);
    }

    /* =====================================================
       Start
       ===================================================== */

    function init() {
        applyPrefs();
        initLogin();
        initWelcome();
        if ($(".messenger")) {
            initSettings();
            initChatList();
            initFind();
            initSlash();
        }
    }

    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init);
    else init();
})();