(() => {
    "use strict";
    const api = window.LOLChat;
    if (!api) return;
    const { request, showToast, escapeHTML, escapeAttribute } = api;

    const $ = (selector, root = document) => root.querySelector(selector);
    const make = (tag, className = "", text = "") => {
        const element = document.createElement(tag);
        if (className) element.className = className;
        if (text) element.textContent = text;
        return element;
    };
    const wait = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    const MAX_BYTES = 25 * 1024 * 1024;
    const TIMERS = [[0, "Off"], [86400, "24 hours"], [604800, "7 days"], [7776000, "90 days"]];
    const composer = $("#message-form");
    const input = $("#message-input");
    const pane = $("#conversation");

    /* =====================================================
       1. Sending photos and files
       ===================================================== */

    const bar = make("div", "upload-bar");
    bar.hidden = true;
    bar.innerHTML = '<span class="up-name"></span><div class="up-track"><i></i></div><button type="button" class="up-cancel" aria-label="Cancel upload">✕</button>';
    composer.before(bar);
    let currentUpload = null;

    function hideBar() {
        bar.hidden = true;
        $(".up-track i", bar).style.transform = "scaleX(0)";
    }

    $(".up-cancel", bar).addEventListener("click", () => currentUpload?.abort());

    function upload(file, { kind = "", duration = 0, caption = "" } = {}) {
        const chat = api.getActiveChat();
        if (!chat?.id) { showToast("Open a chat first."); return; }
        if (file.size > MAX_BYTES) { showToast("That file is too big. The limit is 25 MB."); return; }
        if (currentUpload) { showToast("Wait for the current upload to finish."); return; }

        const form = new FormData();
        form.append("file", file, file.name);
        form.append("client_id", crypto.randomUUID());
        form.append("kind", kind);
        form.append("duration", String(Math.round(duration)));
        form.append("body", caption);
        const reply = api.getReply();
        if (reply) form.append("reply_to_id", String(reply.id));

        const xhr = new XMLHttpRequest();
        currentUpload = xhr;
        $(".up-name", bar).textContent = kind === "voice" ? "Voice message" : file.name;
        bar.hidden = false;
        const fill = $(".up-track i", bar);
        fill.style.transform = "scaleX(0.04)";

        xhr.open("POST", `/api/chats/${chat.id}/upload`);
        xhr.setRequestHeader("X-CSRFToken", api.csrf);
        xhr.responseType = "json";
        xhr.upload.onprogress = (event) => {
            if (event.lengthComputable) fill.style.transform = `scaleX(${Math.max(0.04, event.loaded / event.total)})`;
        };
        xhr.onload = () => {
            currentUpload = null;
            hideBar();
            const data = xhr.response;
            if (xhr.status >= 200 && xhr.status < 300 && data?.ok) {
                api.receiveMessage(data.message);
                if (reply) api.clearReply();
            } else if (xhr.status === 413) {
                showToast("That file is too big. The limit is 25 MB.");
            } else {
                showToast(data?.error || "Couldn’t send that file.");
            }
        };
        xhr.onerror = () => { currentUpload = null; hideBar(); showToast("Couldn’t send that file. Check your connection."); };
        xhr.onabort = () => { currentUpload = null; hideBar(); showToast("Upload cancelled."); };
        xhr.send(form);
    }

    function askToSend(original) {
        const chat = api.getActiveChat();
        if (!chat?.id) { showToast("Open a chat first."); return; }
        let file = original;
        if (file.size > MAX_BYTES) { showToast("That file is too big. The limit is 25 MB."); return; }
        if (!file.name) file = new File([file], file.type.startsWith("image/") ? "photo.png" : "file", { type: file.type });
        const isImage = /\.(png|jpe?g|gif|webp)$/i.test(file.name);
        const isVideo = /\.(mp4|webm|mov|m4v)$/i.test(file.name);

        const dlg = make("dialog", "lol-dialog send-preview");
        dlg.setAttribute("aria-label", "Send a file");
        dlg.innerHTML = `<h2>Send to ${escapeHTML(chat.title)}</h2><div class="pv-body"></div><label class="field"><span class="sr-only">Caption</span><input class="pv-caption" maxlength="1000" placeholder="Add a caption (optional)" autocomplete="off"></label><div class="pv-actions"><button type="button" class="btn-quiet" data-cancel>Cancel</button><button type="button" class="button button-primary pv-send">Send</button></div>`;
        const body = $(".pv-body", dlg);
        let objectUrl = "";
        if (isImage || isVideo) {
            objectUrl = URL.createObjectURL(file);
            const preview = make(isVideo ? "video" : "img");
            preview.src = objectUrl;
        if (isVideo) {
                preview.controls = true;
                preview.muted = true;
                preview.playsInline = true;
                preview.preload = "metadata";
            } else {
                preview.alt = "Preview";
            }
            body.append(preview);
        } else {
            body.innerHTML = `<div class="pv-file"><span aria-hidden="true">${api.fileIcon(file.name)}</span><div><b>${escapeHTML(file.name)}</b><small>${api.formatBytes(file.size)}</small></div></div>`;
        }
        const caption = $(".pv-caption", dlg);
        const send = () => {
            const text = caption.value.trim();
            dlg.close();
            upload(file, { caption: text });
        };
        $(".pv-send", dlg).addEventListener("click", send);
        caption.addEventListener("keydown", (event) => { if (event.key === "Enter") { event.preventDefault(); send(); } });
        dlg.addEventListener("click", (event) => { if (event.target === dlg || event.target.closest("[data-cancel]")) dlg.close(); });
        dlg.addEventListener("close", () => { if (objectUrl) URL.revokeObjectURL(objectUrl); dlg.remove(); });
        document.body.append(dlg);
        dlg.showModal();
        caption.focus();
    }

    const fileInput = $("#file-input");
    $("#attach-button")?.addEventListener("click", () => {
        if (!api.getActiveChat()?.id) { showToast("Open a chat first."); return; }
        fileInput.click();
    });
    fileInput?.addEventListener("change", () => {
        const file = fileInput.files[0];
        fileInput.value = "";
        if (file) askToSend(file);
    });
    input.addEventListener("paste", (event) => {
        const file = [...(event.clipboardData?.files || [])][0];
        if (!file) return;
        event.preventDefault();
        askToSend(file);
    });

    // drag a file onto the conversation
    const dropLayer = make("div", "drop-overlay", "Drop a file to send it");
    dropLayer.hidden = true;
    pane.append(dropLayer);
    let dragDepth = 0;
    const hasFiles = (event) => [...(event.dataTransfer?.types || [])].includes("Files");
    const chatOpen = () => !$("#conversation-active").hidden;
    pane.addEventListener("dragenter", (event) => {
        if (!hasFiles(event) || !chatOpen()) return;
        event.preventDefault();
        dragDepth += 1;
        dropLayer.hidden = false;
    });
    pane.addEventListener("dragover", (event) => { if (hasFiles(event) && chatOpen()) event.preventDefault(); });
    pane.addEventListener("dragleave", () => {
        dragDepth = Math.max(0, dragDepth - 1);
        if (!dragDepth) dropLayer.hidden = true;
    });
    pane.addEventListener("drop", (event) => {
        if (!hasFiles(event) || !chatOpen()) return;
        event.preventDefault();
        dragDepth = 0;
        dropLayer.hidden = true;
        const file = event.dataTransfer.files[0];
        if (file) askToSend(file);
    });

    /* =====================================================
       2. Voice notes
       ===================================================== */

    const mic = $("#mic-button");
    const supported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
    const recBar = make("div", "rec-bar");
    recBar.hidden = true;
    recBar.innerHTML = '<button type="button" class="rec-cancel" aria-label="Discard recording">🗑</button><span class="rec-dot"></span><span class="rec-time">0:00</span><span class="rec-hint">Recording…</span><button type="button" class="rec-send" aria-label="Send voice message">↗</button>';
    composer.append(recBar);
    let rec = null;

    function recClock() {
        const total = Math.floor((Date.now() - rec.startedAt) / 1000);
        $(".rec-time", recBar).textContent = `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
        if (total >= 300) stopRecording(true);
    }

    async function startRecording() {
        if (rec) return;
        if (!api.getActiveChat()?.id) { showToast("Open a chat first."); return; }
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        } catch {
            showToast("Microphone access is blocked. Allow it in your browser’s site settings.");
            return;
        }
        const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"].find((type) => MediaRecorder.isTypeSupported(type)) || "";
        const recorder = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
        const chunks = [];
        recorder.ondataavailable = (event) => { if (event.data.size) chunks.push(event.data); };
        rec = { recorder, stream, chunks, startedAt: Date.now(), timer: window.setInterval(recClock, 250) };
        recorder.start(250);
        recBar.hidden = false;
        $(".rec-time", recBar).textContent = "0:00";
        mic?.classList.add("is-recording");
    }

    function stopRecording(send) {
        if (!rec) return;
        const current = rec;
        rec = null;
        window.clearInterval(current.timer);
        recBar.hidden = true;
        mic?.classList.remove("is-recording");
        const seconds = (Date.now() - current.startedAt) / 1000;
        current.recorder.onstop = () => {
            current.stream.getTracks().forEach((track) => track.stop());
            if (!send || !current.chunks.length) return;
            if (seconds < 1) { showToast("Hold on a little longer to record."); return; }
            const type = current.recorder.mimeType || "audio/webm";
            const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
            upload(new File(current.chunks, `voice.${ext}`, { type }), { kind: "voice", duration: seconds });
        };
        try { current.recorder.stop(); } catch { current.stream.getTracks().forEach((track) => track.stop()); }
    }

    if (mic && !supported) mic.remove();
    mic?.addEventListener("click", () => (rec ? stopRecording(true) : startRecording()));
    $(".rec-cancel", recBar).addEventListener("click", () => stopRecording(false));
    $(".rec-send", recBar).addEventListener("click", () => stopRecording(true));
    document.addEventListener("lol:chat-change", () => stopRecording(false));
    window.addEventListener("pagehide", () => stopRecording(false));

    /* =====================================================
       3. A people picker (used for new groups and adding people)
       ===================================================== */

    function createPicker(host, { exclude = () => [] } = {}) {
        const state = { selected: new Map(), onchange: () => { } };
        host.innerHTML = '<label class="field"><span class="sr-only">Search people</span><input type="search" placeholder="Search by name or username" autocomplete="off"></label><div class="chips" aria-live="polite"></div><div class="people-list" aria-live="polite"></div>';
        const search = $("input", host);
        const chips = $(".chips", host);
        const results = $(".people-list", host);
        let people = [];
        let timer;

        function renderChips() {
            chips.textContent = "";
            state.selected.forEach((person, id) => {
                const chip = make("button", "chip", `${person.display_name} ✕`);
                chip.type = "button";
                chip.setAttribute("aria-label", `Remove ${person.display_name}`);
                chip.addEventListener("click", () => { state.selected.delete(id); renderChips(); renderResults(); state.onchange(); });
                chips.append(chip);
            });
        }

        function renderResults() {
            const hidden = new Set(exclude().map(Number));
            const shown = people.filter((person) => !hidden.has(Number(person.id)));
            if (!shown.length) {
                results.innerHTML = `<p class="search-hint">${search.value.trim().length < 2 ? "Type at least 2 characters to find people." : "No one found."}</p>`;
                return;
            }
            results.innerHTML = shown.map((person) => {
                const on = state.selected.has(person.id);
                return `<button type="button" class="pick-row${on ? " is-on" : ""}" data-id="${person.id}" aria-pressed="${on}"><span class="avatar avatar-lilac">${person.avatar_url ? `<img src="${escapeAttribute(person.avatar_url)}" alt="">` : escapeHTML(person.initial)}</span><span class="pick-name"><b>${escapeHTML(person.display_name)}</b><small>@${escapeHTML(person.username)}</small></span><span class="pick-mark" aria-hidden="true">${on ? "✓" : "＋"}</span></button>`;
            }).join("");
        }

        results.addEventListener("click", (event) => {
            const row = event.target.closest("[data-id]");
            if (!row) return;
            const id = Number(row.dataset.id);
            const person = people.find((item) => Number(item.id) === id);
            if (!person) return;
            if (state.selected.has(id)) state.selected.delete(id);
            else state.selected.set(id, person);
            renderChips();
            renderResults();
            state.onchange();
        });

        search.addEventListener("input", () => {
            window.clearTimeout(timer);
            const query = search.value.trim();
            if (query.length < 2) { people = []; renderResults(); return; }
            timer = window.setTimeout(async () => {
                try {
                    const data = await request(`/api/users?q=${encodeURIComponent(query)}`);
                    people = data.users;
                } catch { people = []; }
                renderResults();
            }, 200);
        });

        state.ids = () => [...state.selected.keys()];
        state.reset = () => { state.selected.clear(); people = []; search.value = ""; renderChips(); renderResults(); };
        renderResults();
        return state;
    }

    /* =====================================================
       4. New group
       ===================================================== */

    function openGroupDialog() {
        const dlg = make("dialog", "lol-dialog");
        dlg.setAttribute("aria-labelledby", "group-title");
        dlg.innerHTML = '<form method="dialog" class="dlg-close"><button class="icon-button" aria-label="Close">×</button></form><h2 id="group-title">New group</h2><label class="field"><span>Group name</span><input id="group-name" maxlength="80" placeholder="Weekend plans" autocomplete="off"></label><div class="picker-host"></div><p class="dlg-error" role="alert" hidden></p><button class="button button-primary dlg-primary" type="button" disabled>Create group</button>';
        document.body.append(dlg);
        const name = $("#group-name", dlg);
        const create = $(".dlg-primary", dlg);
        const error = $(".dlg-error", dlg);
        const picker = createPicker($(".picker-host", dlg));
        const refresh = () => { create.disabled = !(name.value.trim() && picker.selected.size); };
        picker.onchange = refresh;
        name.addEventListener("input", refresh);
        create.addEventListener("click", async () => {
            create.disabled = true;
            error.hidden = true;
            try {
                const data = await request("/api/groups", { method: "POST", body: JSON.stringify({ name: name.value.trim(), member_ids: picker.ids() }) });
                dlg.close();
                api.addChat(data.chat);
                api.openChat(data.chat);
            } catch (failure) {
                error.textContent = failure.message;
                error.hidden = false;
                refresh();
            }
        });
        dlg.addEventListener("close", () => dlg.remove());
        dlg.showModal();
        name.focus();
    }
    $("#new-group")?.addEventListener("click", openGroupDialog);

    /* =====================================================
       5. Chat info (members, rename, disappearing messages)
       ===================================================== */

    async function openInfo() {
        const first = api.getActiveChat();
        if (!first?.id) { showToast("Open a chat first."); return; }
        const dlg = make("dialog", "lol-dialog");
        dlg.setAttribute("aria-label", "Chat info");
        dlg.innerHTML = '<form method="dialog" class="dlg-close"><button class="icon-button" aria-label="Close">×</button></form><div class="info-body"><p class="search-hint">Loading…</p></div>';
        document.body.append(dlg);
        dlg.addEventListener("close", () => dlg.remove());
        dlg.showModal();
        const body = $(".info-body", dlg);
        let members = [];
        let picker = null;

        const currentChat = () => api.getChats().find((item) => Number(item.id) === Number(first.id)) || first;

        async function load() {
            const chat = currentChat();
            if (chat.type === "group") members = (await request(`/api/chats/${chat.id}/members`)).members;
            render(chat);
        }

        function render(chat) {
            const group = chat.type === "group";
            const me = members.find((member) => member.me);
            const admin = group && me?.role === "admin";
            const canTimer = !group || admin;
            const timerOptions = TIMERS.map(([seconds, label]) => `<option value="${seconds}"${Number(chat.disappear_seconds || 0) === seconds ? " selected" : ""}>${label}</option>`).join("");
            const memberRows = members.map((member) => `<li class="member-row" data-id="${member.id}"><span class="avatar avatar-sky">${member.avatar_url ? `<img src="${escapeAttribute(member.avatar_url)}" alt="">` : escapeHTML(member.initial)}</span><span class="member-name"><b>${escapeHTML(member.display_name)}${member.me ? " (You)" : ""}</b><small>@${escapeHTML(member.username)}${member.online ? " · online" : ""}</small></span>${member.role === "admin" ? '<span class="role-badge">Admin</span>' : ""}${admin && !member.me ? `<span class="member-actions"><button type="button" data-act="${member.role === "admin" ? "demote" : "promote"}" data-id="${member.id}">${member.role === "admin" ? "Remove admin" : "Make admin"}</button><button type="button" class="is-danger" data-act="remove" data-id="${member.id}">Remove</button></span>` : ""}</li>`).join("");
            body.innerHTML = `
                <div class="info-head"><span class="avatar avatar-sky">${api.avatarHTML(chat)}</span><div><h2>${escapeHTML(chat.title)}</h2><p>${group ? `${members.length} member${members.length === 1 ? "" : "s"}` : (chat.username ? `@${escapeHTML(chat.username)}` : "")}</p></div></div>
                ${admin ? `<h3>Group name</h3><div class="inline-row"><input id="info-name" value="${escapeAttribute(chat.title)}" maxlength="80" aria-label="Group name"><button type="button" class="button button-primary" data-act="rename">Save</button></div>` : ""}
                <h3>Disappearing messages</h3>
                <label class="field"><span class="sr-only">Disappearing messages</span><select id="info-timer"${canTimer ? "" : " disabled"}>${timerOptions}</select></label>
                <p class="hint">${canTimer ? "New messages in this chat are deleted for everyone after the time you pick. People can still screenshot or copy them." : "Only group admins can change this."}</p>
                ${group ? `<h3>Members</h3><ul class="member-list">${memberRows}</ul>` : ""}
                ${admin ? '<h3>Add people</h3><div class="add-host"></div><button type="button" class="button button-primary" data-act="add" id="info-add" disabled>Add to group</button>' : ""}
                ${group ? '<button type="button" class="btn-danger" data-act="leave">Leave group</button>' : ""}
                <p class="dlg-error" role="alert" hidden></p>`;
            if (admin) {
                picker = createPicker($(".add-host", body), { exclude: () => members.map((member) => member.id) });
                picker.onchange = () => { $("#info-add", body).disabled = !picker.selected.size; };
            }
        }

        const fail = (error) => {
            const box = $(".dlg-error", body);
            if (box) { box.textContent = error.message; box.hidden = false; }
            else showToast(error.message);
        };
        const reload = async () => { await load(); await api.refreshChats(); };

        body.addEventListener("change", async (event) => {
            if (event.target.id !== "info-timer") return;
            try {
                await request(`/api/chats/${first.id}`, { method: "PATCH", body: JSON.stringify({ disappear_seconds: Number(event.target.value) }) });
                await reload();
                showToast("Disappearing messages updated");
            } catch (error) { fail(error); await load(); }
        });

        body.addEventListener("click", async (event) => {
            const button = event.target.closest("[data-act]");
            if (!button) return;
            const act = button.dataset.act;
            const id = Number(button.dataset.id);
            try {
                if (act === "rename") {
                    await request(`/api/chats/${first.id}`, { method: "PATCH", body: JSON.stringify({ name: $("#info-name", body).value }) });
                    await reload();
                } else if (act === "promote" || act === "demote") {
                    await request(`/api/chats/${first.id}/members/${id}/role`, { method: "POST", body: JSON.stringify({ role: act === "promote" ? "admin" : "member" }) });
                    await reload();
                } else if (act === "remove") {
                    if (!window.confirm("Remove this person from the group?")) return;
                    await request(`/api/chats/${first.id}/members/${id}`, { method: "DELETE" });
                    await reload();
                } else if (act === "add") {
                    await request(`/api/chats/${first.id}/members`, { method: "POST", body: JSON.stringify({ user_ids: picker.ids() }) });
                    await reload();
                } else if (act === "leave") {
                    if (!window.confirm("Leave this group? You won’t get its messages any more.")) return;
                    const me = members.find((member) => member.me);
                    await request(`/api/chats/${first.id}/members/${me.id}`, { method: "DELETE" });
                    dlg.close();
                    await api.refreshChats();
                }
            } catch (error) { fail(error); }
        });

        try { await load(); } catch (error) { body.innerHTML = `<p class="search-hint">${escapeHTML(error.message)}</p>`; }
    }
    $("#chat-info")?.addEventListener("click", openInfo);

    /* =====================================================
       6. Starred messages
       ===================================================== */

    async function openStarred() {
        const dlg = make("dialog", "lol-dialog");
        dlg.setAttribute("aria-labelledby", "starred-title");
        dlg.innerHTML = '<form method="dialog" class="dlg-close"><button class="icon-button" aria-label="Close">×</button></form><h2 id="starred-title">Starred messages</h2><ul class="starred-list"><li class="search-hint">Loading…</li></ul>';
        document.body.append(dlg);
        dlg.addEventListener("close", () => dlg.remove());
        dlg.showModal();
        const listEl = $(".starred-list", dlg);
        let items = [];

        function paint() {
            if (!items.length) {
                listEl.innerHTML = '<li class="search-hint">Nothing starred yet. Open a message’s menu and choose Star.</li>';
                return;
            }
            listEl.innerHTML = items.map((item) => `<li class="st-row" data-id="${item.id}"><button type="button" class="st-open" data-open="${item.id}"><span class="st-meta"><b>${escapeHTML(item.chat_title)}</b><small>${escapeHTML(item.sender_name || "")} · ${escapeHTML(api.listTime(item.created_at))}</small></span><span class="st-text">${escapeHTML(api.previewCore(item))}</span></button><button type="button" class="st-un" data-unstar="${item.id}" aria-label="Remove star" title="Remove star">★</button></li>`).join("");
        }

        listEl.addEventListener("click", async (event) => {
            const open = event.target.closest("[data-open]");
            const unstar = event.target.closest("[data-unstar]");
            if (unstar) {
                const id = Number(unstar.dataset.unstar);
                api.getSocket()?.emit("message:star", { message_id: id }, (result) => {
                    if (!result?.ok) { showToast(result?.error || "Couldn’t update that star."); return; }
                    items = items.filter((item) => item.id !== id);
                    paint();
                });
                return;
            }
            if (!open) return;
            const item = items.find((entry) => entry.id === Number(open.dataset.open));
            const chat = item && api.getChats().find((entry) => Number(entry.id) === Number(item.chat_id));
            dlg.close();
            if (!chat) { showToast("That chat isn’t available any more."); return; }
            await api.openChat(chat);
            await wait(60);
            api.jumpTo(item.id);
        });

        try {
            items = (await request("/api/starred")).starred;
            paint();
        } catch (error) {
            listEl.innerHTML = `<li class="search-hint">${escapeHTML(error.message)}</li>`;
        }
    }
    $("#open-starred")?.addEventListener("click", openStarred);
})();