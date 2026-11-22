(() => {
    const shell = document.querySelector(".messenger");
    if (!shell) return;

    document.body.classList.add("messenger-page");
    const updateMobileViewport = () => {
        if (window.matchMedia("(max-width: 820px)").matches) {
            const viewport = window.visualViewport;
            const viewportTop = viewport?.offsetTop || 0;
            const viewportBottom = viewportTop + (viewport?.height || window.innerHeight);
            const panelTop = Math.max(64, viewportTop);
            document.documentElement.style.setProperty("--mobile-chat-top", `${panelTop}px`);
            document.documentElement.style.setProperty("--mobile-chat-height", `${Math.max(0, viewportBottom - panelTop)}px`);
        } else {
            document.documentElement.style.removeProperty("--mobile-chat-top");
            document.documentElement.style.removeProperty("--mobile-chat-height");
        }
    };
    updateMobileViewport();
    window.addEventListener("resize", updateMobileViewport);
    window.addEventListener("focus", updateMobileViewport);
    window.visualViewport?.addEventListener("resize", updateMobileViewport);
    window.visualViewport?.addEventListener("scroll", updateMobileViewport);
    document.addEventListener("focusin", () => {
        updateMobileViewport();
        window.setTimeout(updateMobileViewport, 250);
    });

    const csrf = document.querySelector('meta[name="csrf-token"]').content;
    const userId = shell.dataset.userId;
    const initialChats = JSON.parse(document.querySelector("#initial-chats").textContent);
    let chats = initialChats;
    let activeChat = null;
    let loadingOlder = false;
    let hasMore = false;
    let oldestMessageId = null;
    let editingMessageId = null;
    let replyTo = null;
    const renderedIds = new Set();
    const messageCache = new Map();
    const list = document.querySelector("#chat-list");
    const history = document.querySelector("#message-history");
    const stream = document.querySelector("#message-stream");
    const composer = document.querySelector("#message-form");
    const input = document.querySelector("#message-input");
    const dialog = document.querySelector("#search-dialog");
    const emojiPicker = document.querySelector("#emoji-picker");
    const sendButton = document.querySelector("#send-button");
    const editCancel = document.querySelector("#edit-cancel");
    const outboxKey = `lol-outbox-${userId}`;
    const recentKey = `lol-recent-react-${userId}`;
    const socket = typeof window.io === "function" ? window.io({ reconnection: true, reconnectionDelayMax: 5000 }) : null;
    const emojis = ["😀", "😂", "🥹", "😍", "😊", "😮", "😢", "🙏", "👏", "👍", "❤️", "🔥", "🎉", "✨", "💯", "☕"];
    const quickDefaults = ["❤️", "😂", "👍", "😮", "😢", "🙏"];
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    const request = async (url, options = {}) => {
        const response = await fetch(url, {
            ...options,
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrf, ...(options.headers || {}) },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Something went wrong.");
        return data;
    };

    const avatarHTML = (chat) => chat.avatar_url
        ? `<img src="${escapeAttribute(chat.avatar_url)}" alt="">`
        : escapeHTML(chat.initial || chat.title?.slice(0, 1) || "?");
    const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const escapeAttribute = escapeHTML;
    const formatClock = (date) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(date));
    const isOwnMessage = (message) => Number(message.sender_id) === Number(userId);
    const isNearLatest = () => history.scrollHeight - history.scrollTop - history.clientHeight < 80;
    const clamp = (value, low, high) => (high < low ? (low + high) / 2 : Math.min(Math.max(value, low), high));
    const mod = (n, m) => ((n % m) + m) % m;
    const formatLastSeen = (value) => value
        ? `last seen ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))}`
        : "last seen recently";

    function presenceText(chat) {
        return chat.online ? "online" : chat.last_seen_at ? formatLastSeen(chat.last_seen_at) : "offline";
    }

    /* ---------- Chat list ---------- */

    function renderChatRow(chat) {
        const active = Number(activeChat?.id) === Number(chat.id) ? " is-active" : "";
        const badge = chat.unread ? `<span class="unread-badge">${chat.unread > 99 ? "99+" : chat.unread}</span>` : "";
        return `<button class="chat-row${active}" type="button" role="listitem" data-chat-id="${chat.id}" data-search="${escapeAttribute(`${chat.title} ${chat.username || ""}`.toLowerCase())}">
      <span class="avatar avatar-sky">${avatarHTML(chat)}</span><span class="chat-row-copy"><span class="chat-row-top"><strong>${escapeHTML(chat.title)}</strong><time>${escapeHTML(chat.time || "")}</time></span><span class="chat-row-bottom"><span class="chat-preview">${escapeHTML(chat.preview || "Start a conversation")}</span>${badge}</span></span></button>`;
    }

    function renderChatList() {
        const sorted = [...chats].sort((a, b) => new Date(b.updated_at) - new Date(a.updated_at));
        const empty = document.querySelector("#empty-list");
        empty.hidden = sorted.length > 0;
        list.querySelectorAll(".chat-row").forEach((row) => row.remove());
        empty.insertAdjacentHTML("beforebegin", sorted.map(renderChatRow).join(""));
        filterChats();
    }

    function filterChats() {
        const query = document.querySelector("#chat-filter").value.trim().toLowerCase();
        let visible = 0;
        list.querySelectorAll(".chat-row").forEach((row) => {
            const match = !query || row.dataset.search.includes(query);
            row.hidden = !match;
            if (match) visible += 1;
        });
        document.querySelector("#no-results").hidden = !query || visible > 0;
    }

    function updateChatSummary(chatId, message) {
        const chat = chats.find((item) => Number(item.id) === Number(chatId));
        if (!chat) return;
        chat.preview = message.deleted ? "🚫 Message deleted" : message.body;
        chat.time = formatClock(message.created_at);
        chat.updated_at = message.created_at;
        if (!isOwnMessage(message) && (Number(activeChat?.id) !== Number(chatId) || !isNearLatest())) {
            chat.unread = (chat.unread || 0) + 1;
        }
        renderChatList();
    }

    /* ---------- Message rendering ---------- */

    function statusHTML(message) {
        if (!isOwnMessage(message) || message.deleted) return "";
        const status = message.status || "sent";
        return `<span class="message-status status-${status}" data-message-id="${message.id || ""}" aria-label="${status}">${status === "sent" ? "✓" : "✓✓"}</span>`;
    }

    function actionsHTML(message) {
        if (!message.id || message.deleted) return "";
        const mine = isOwnMessage(message);
        const button = (action, label, icon) => `<button class="message-action" type="button" data-action="${action}" data-message-id="${message.id}" aria-label="${label}" title="${label}">${icon}</button>`;
        return `<div class="message-actions">${button("react", "React to message", "＋")}${button("reply", "Reply", "↩")}${mine ? button("edit", "Edit message", "✎") : ""}${button("delete", "Delete message", "🗑")}</div>`;
    }

    function replyQuoteHTML(message) {
        const parent = message.reply_to;
        if (!parent) return "";
        const own = Number(parent.sender_id) === Number(userId);
        const who = own ? "You" : (activeChat?.title || "Them");
        const text = parent.deleted ? "🚫 Message deleted" : parent.body;
        return `<blockquote class="reply-quote" data-jump="${parent.id}"><b>${escapeHTML(who)}</b><span>${escapeHTML(text)}</span></blockquote>`;
    }

    function reactionChip(messageId, reaction) {
        return `<button class="reaction-chip${reaction.reacted ? " is-selected" : ""}" type="button" data-action="react-chip" data-message-id="${messageId}" data-emoji="${escapeAttribute(reaction.emoji)}" aria-label="${escapeAttribute(reaction.emoji)} reaction, ${reaction.count}">${escapeHTML(reaction.emoji)} <span>${reaction.count}</span></button>`;
    }

    function bubbleHTML(message) {
        const mine = isOwnMessage(message);
        const reactions = message.deleted ? "" : (message.reactions || []).map((reaction) => reactionChip(message.id, reaction)).join("");
        const body = message.deleted
            ? `<p class="deleted-text">🚫 ${mine ? "You deleted this message" : "This message was deleted"}</p>`
            : `${replyQuoteHTML(message)}<p>${escapeHTML(message.body)}</p>`;
        const edited = !message.deleted && message.edited ? '<span class="message-edited">edited</span>' : "";
        return `<div class="message-content"><div class="message-bubble${message.deleted ? " is-deleted" : ""}">${body}<footer>${edited}<time>${escapeHTML(message.time || formatClock(message.created_at))}</time>${statusHTML(message)}</footer></div>${actionsHTML(message)}<div class="reaction-list" data-reactions-for="${message.id || ""}">${reactions}</div></div>`;
    }

    function cacheMessage(message) {
        if (message.id) messageCache.set(String(message.id), { ...messageCache.get(String(message.id)), ...message });
    }

    function addMessage(message, { scroll = false, prepend = false } = {}) {
        cacheMessage(message);
        if (renderedIds.has(String(message.client_id))) {
            const existing = [...stream.querySelectorAll(".message-row")]
                .find((item) => item.dataset.clientId === String(message.client_id));
            if (existing && message.id) {
                existing.dataset.messageId = message.id;
                existing.innerHTML = bubbleHTML(message);
                if (isOwnMessage(message) && message.status) updateStatus(message.id, message.status);
            }
            return;
        }
        renderedIds.add(String(message.client_id));
        const mine = isOwnMessage(message);
        const wasNearLatest = isNearLatest();
        const shouldMarkRead = !mine && document.visibilityState === "visible" && wasNearLatest;
        const row = document.createElement("article");
        row.className = `message-row ${mine ? "message-mine" : "message-theirs"}`;
        row.dataset.messageId = message.id || "";
        row.dataset.clientId = message.client_id;
        row.innerHTML = bubbleHTML(message);
        if (prepend) stream.prepend(row);
        else stream.append(row);
        if (message.id && !mine && socket && activeChat) {
            socket.emit("message:received", { message_id: message.id, read: shouldMarkRead });
        }
        if (mine && message.id && message.status) updateStatus(message.id, message.status);
        if (scroll && (mine || wasNearLatest)) history.scrollTop = history.scrollHeight;
    }

    function renderReactionList(messageId, reactions) {
        const container = stream.querySelector(`[data-reactions-for="${messageId}"]`);
        if (container) container.innerHTML = reactions.map((reaction) => reactionChip(messageId, reaction)).join("");
    }

    function updateMessage(message) {
        cacheMessage(message);
        const row = stream.querySelector(`[data-message-id="${message.id}"]`);
        if (!row) return;
        const body = row.querySelector(".message-bubble p:not(.deleted-text)");
        if (body) body.textContent = message.body;
        let edited = row.querySelector(".message-edited");
        if (!edited) {
            edited = document.createElement("span");
            edited.className = "message-edited";
            edited.textContent = "edited";
            row.querySelector(".message-bubble footer").prepend(edited);
        }
        stream.querySelectorAll(`.reply-quote[data-jump="${message.id}"] span`).forEach((node) => { node.textContent = message.body; });
        const chat = chats.find((item) => Number(item.id) === Number(message.chat_id));
        if (chat?.last_message_id === message.id) {
            chat.preview = message.body;
            renderChatList();
        }
    }

    function updateStatus(messageId, status) {
        const element = stream.querySelector(`.message-status[data-message-id="${messageId}"]`);
        if (!element) return;
        element.className = `message-status status-${status}`;
        element.textContent = status === "sent" ? "✓" : "✓✓";
        element.setAttribute("aria-label", status);
    }

    function setPresence(data) {
        const chat = chats.find((item) => Number(item.other_user_id) === Number(data.user_id));
        if (!chat) return;
        chat.online = data.online;
        chat.last_seen_at = data.last_seen_at;
        if (Number(activeChat?.id) === Number(chat.id)) {
            const label = document.querySelector("#active-presence");
            label.textContent = presenceText(chat);
            label.classList.toggle("is-online", Boolean(chat.online));
        }
    }

    /* ---------- Delete ---------- */

    function markDeleted(data) {
        const id = String(data.message_id);
        const message = { ...(messageCache.get(id) || { id: data.message_id }), deleted: true, body: "", reactions: [] };
        messageCache.set(id, message);
        const row = stream.querySelector(`.message-row[data-message-id="${id}"]`);
        if (row) row.innerHTML = bubbleHTML(message);
        stream.querySelectorAll(`.reply-quote[data-jump="${id}"] span`).forEach((node) => { node.textContent = "🚫 Message deleted"; });
        if (replyTo && String(replyTo.id) === id) cancelReply();
        if (editingMessageId && String(editingMessageId) === id) cancelEditing();
        const chat = chats.find((item) => Number(item.id) === Number(data.chat_id));
        if (chat && Number(chat.last_message_id) === Number(data.message_id)) {
            chat.preview = "🚫 Message deleted";
            renderChatList();
        }
    }

    function removeMessageRow(id) {
        const row = stream.querySelector(`.message-row[data-message-id="${id}"]`);
        if (!row) return;
        renderedIds.delete(row.dataset.clientId);
        row.remove();
    }

    function deleteMessage(id, scope) {
        if (!socket?.connected) {
            showToast("Reconnect to delete messages.");
            return;
        }
        socket.emit("message:delete", { message_id: Number(id), scope }, (result) => {
            if (!result?.ok) {
                showToast(result?.error || "Message could not be deleted.");
                return;
            }
            if (scope === "me") removeMessageRow(id);
            else markDeleted({ message_id: id, chat_id: activeChat?.id });
        });
    }

    function confirmDelete(messageId) {
        const message = messageCache.get(String(messageId));
        if (!message || message.deleted) return;
        const dlg = document.createElement("dialog");
        dlg.className = "confirm-dialog";
        dlg.innerHTML = `<div class="confirm-body"><h2>Delete message?</h2><p class="confirm-preview"></p><div class="confirm-actions">${isOwnMessage(message) ? '<button type="button" class="is-danger" data-scope="everyone">Delete for everyone</button>' : ""}<button type="button" class="is-danger" data-scope="me">Delete for me</button><button type="button" data-cancel>Cancel</button></div></div>`;
        dlg.querySelector(".confirm-preview").textContent = (message.body || "").slice(0, 120);
        dlg.addEventListener("click", (event) => {
            const button = event.target.closest("button");
            if (event.target === dlg || button?.hasAttribute("data-cancel")) {
                dlg.close();
            } else if (button?.dataset.scope) {
                dlg.close();
                deleteMessage(messageId, button.dataset.scope);
            }
        });
        dlg.addEventListener("close", () => dlg.remove());
        document.body.append(dlg);
        dlg.showModal();
    }

    /* ---------- Reply ---------- */

    const replyBar = document.createElement("div");
    replyBar.className = "reply-bar";
    replyBar.hidden = true;
    replyBar.innerHTML = '<div class="reply-bar-text"><b></b><span></span></div><button type="button" class="reply-cancel" aria-label="Cancel reply">✕</button>';
    composer.before(replyBar);
    replyBar.querySelector(".reply-cancel").addEventListener("click", cancelReply);

    function startReply(messageId) {
        const message = messageCache.get(String(messageId));
        if (!message || message.deleted) return;
        if (editingMessageId) cancelEditing();
        replyTo = { id: message.id, body: message.body, sender_id: message.sender_id };
        replyBar.querySelector("b").textContent = isOwnMessage(message) ? "You" : (activeChat?.title || "Reply");
        replyBar.querySelector("span").textContent = message.body;
        replyBar.hidden = false;
        input.focus();
    }

    function cancelReply() {
        replyTo = null;
        replyBar.hidden = true;
    }

    function jumpTo(messageId) {
        const row = stream.querySelector(`.message-row[data-message-id="${messageId}"]`);
        if (!row) {
            showToast("The original message isn’t loaded yet. Scroll up to load older messages.");
            return;
        }
        row.scrollIntoView({ block: "center", behavior: reduceMotion ? "auto" : "smooth" });
        row.classList.remove("flash");
        void row.offsetWidth;
        row.classList.add("flash");
        window.setTimeout(() => row.classList.remove("flash"), 1300);
    }

    /* ---------- Edit ---------- */

    function startEditing(messageId) {
        const row = stream.querySelector(`.message-row[data-message-id="${messageId}"]`);
        const body = row?.querySelector(".message-bubble p:not(.deleted-text)");
        if (!body) return;
        cancelReply();
        editingMessageId = Number(messageId);
        input.value = body.textContent;
        input.dispatchEvent(new Event("input", { bubbles: true }));
        sendButton.setAttribute("aria-label", "Save edited message");
        sendButton.title = "Save edit";
        editCancel.hidden = false;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    function cancelEditing() {
        editingMessageId = null;
        input.value = "";
        input.style.height = "auto";
        sendButton.setAttribute("aria-label", "Send message");
        sendButton.title = "Send message";
        editCancel.hidden = true;
    }

    function runMessageAction(name, messageId) {
        if (name === "reply") startReply(messageId);
        else if (name === "edit") startEditing(messageId);
        else if (name === "delete") confirmDelete(messageId);
        else if (name === "copy") {
            const message = messageCache.get(String(messageId));
            if (!navigator.clipboard || !message) {
                showToast("Copy isn’t available here.");
                return;
            }
            navigator.clipboard.writeText(message.body).then(() => showToast("Copied"), () => showToast("Couldn’t copy."));
        }
    }

    /* ---------- Emoji data (built from what this device supports) ---------- */

    const emojiGroups = (() => {
        let supported = () => false;
        try {
            const pattern = /^\p{Emoji_Presentation}$/u;
            supported = (char) => pattern.test(char);
        } catch { /* very old browser: only the manual lists below are used */ }
        const seen = new Set();
        const collect = (ranges, extra = []) => {
            const out = [];
            extra.forEach((emoji) => { if (!seen.has(emoji)) { seen.add(emoji); out.push(emoji); } });
            ranges.forEach(([from, to]) => {
                for (let code = from; code <= to; code += 1) {
                    if (code >= 0x1F3FB && code <= 0x1F3FF) continue; // skin-tone swatches
                    const char = String.fromCodePoint(code);
                    if (supported(char) && !seen.has(char)) { seen.add(char); out.push(char); }
                }
            });
            return out;
        };
        return [
            { icon: "😀", name: "Faces", list: collect([[0x1F600, 0x1F64F], [0x1F910, 0x1F92F], [0x1F970, 0x1F97F], [0x1FAE0, 0x1FAE8]], ["☺️"]) },
            { icon: "👋", name: "People", list: collect([[0x1F440, 0x1F494], [0x1F930, 0x1F93F], [0x1F9D0, 0x1F9DF]], ["✌️", "☝️", "✍️"]) },
            { icon: "❤️", name: "Hearts", list: collect([[0x1F495, 0x1F4AF], [0x1F90D, 0x1F90E], [0x1F9E1, 0x1F9E1]], ["❤️", "❣️"]) },
            { icon: "🐶", name: "Nature", list: collect([[0x1F300, 0x1F344], [0x1F400, 0x1F43F], [0x1F980, 0x1F9AF]], ["☀️", "☁️", "❄️", "☘️"]) },
            { icon: "🍔", name: "Food", list: collect([[0x1F345, 0x1F37F], [0x1F950, 0x1F96F], [0x1F9C0, 0x1F9CB]]) },
            { icon: "⚽", name: "Activity", list: collect([[0x1F380, 0x1F3FA], [0x1F945, 0x1F94F], [0x1F9E7, 0x1F9FF]]) },
            { icon: "🚗", name: "Travel", list: collect([[0x1F680, 0x1F6FF]], ["✈️"]) },
            { icon: "💡", name: "Objects", list: collect([[0x1F4B0, 0x1F4FF], [0x1F5FA, 0x1F5FF], [0x1F9E0, 0x1F9E0], [0x1FA70, 0x1FAFF]]) },
            { icon: "✨", name: "Symbols", list: collect([[0x1F500, 0x1F53D], [0x1F7E0, 0x1F7EB], [0x2600, 0x27BF], [0x2B1B, 0x2B55]], ["✔️", "✖️", "❗", "❓", "♻️", "⚠️"]) },
        ].filter((group) => group.list.length);
    })();

    const readRecent = () => {
        try { return JSON.parse(localStorage.getItem(recentKey) || "[]"); } catch { return []; }
    };
    const pushRecent = (emoji) => {
        try { localStorage.setItem(recentKey, JSON.stringify([emoji, ...readRecent().filter((item) => item !== emoji)].slice(0, 12))); } catch { /* storage unavailable */ }
    };

    /* ---------- Emoji wheel (turn the ring to find an emoji) ---------- */

    const RING = 108;
    const ITEM = 44;
    const wheel = { groups: [], group: 0, list: [], len: 0, M: 12, step: 0, offset: 0, slots: [], raf: 0, selected: new Set() };
    let drag = null;

    function wheelCenter() {
        return { x: parseFloat(emojiPicker.style.left) || 0, y: parseFloat(emojiPicker.style.top) || 0 };
    }

    function placeSlot(slot, emoji, r, opacity) {
        const angle = r * wheel.step - Math.PI / 2;
        slot.hidden = false;
        if (slot.dataset.emoji !== emoji) {
            slot.dataset.emoji = emoji;
            slot.textContent = emoji;
            slot.setAttribute("aria-label", `React with ${emoji}`);
        }
        slot.classList.toggle("is-selected", wheel.selected.has(emoji));
        slot.style.setProperty("--x", `${(Math.cos(angle) * RING).toFixed(1)}px`);
        slot.style.setProperty("--y", `${(Math.sin(angle) * RING).toFixed(1)}px`);
        slot.style.setProperty("--s", (1 + 0.3 * Math.max(0, 1 - Math.abs(r))).toFixed(2));
        slot.style.opacity = opacity.toFixed(2);
        slot.style.pointerEvents = opacity < 0.4 ? "none" : "";
    }

    function renderWheel() {
        const { list: items, len, slots } = wheel;
        let used = 0;
        if (len <= 12) {
            for (let i = 0; i < len; i += 1) {
                let r = i - wheel.offset;
                r -= len * Math.round(r / len);
                placeSlot(slots[used], items[i], r, 1);
                used += 1;
            }
        } else {
            const half = 6;
            const base = Math.floor(wheel.offset);
            for (let k = -7; k <= 7; k += 1) {
                const index = base + k;
                const r = index - wheel.offset;
                if (Math.abs(r) > half) continue;
                placeSlot(slots[used], items[mod(index, len)], r, clamp(half - Math.abs(r), 0, 1));
                used += 1;
            }
        }
        for (let j = used; j < slots.length; j += 1) slots[j].hidden = true;
    }

    function setWheelGroup(index) {
        const count = wheel.groups.length;
        wheel.group = mod(index, count);
        const group = wheel.groups[wheel.group];
        wheel.list = group.list;
        wheel.len = group.list.length;
        wheel.M = Math.min(wheel.len, 12);
        wheel.step = (Math.PI * 2) / wheel.M;
        wheel.offset = 0;
        cancelAnimationFrame(wheel.raf);
        emojiPicker.querySelector(".wheel-hub-icon").textContent = group.icon;
        emojiPicker.querySelector(".wheel-hub-name").textContent = group.name;
        wheel.slots.forEach((slot) => { slot.dataset.emoji = ""; });
        renderWheel();
    }

    function glide(target) {
        cancelAnimationFrame(wheel.raf);
        const from = wheel.offset;
        if (reduceMotion) {
            wheel.offset = target;
            renderWheel();
            return;
        }
        const start = performance.now();
        const tick = (now) => {
            const t = Math.min(1, (now - start) / 170);
            wheel.offset = from + (target - from) * (1 - Math.pow(1 - t, 3));
            renderWheel();
            if (t < 1) wheel.raf = requestAnimationFrame(tick);
        };
        wheel.raf = requestAnimationFrame(tick);
    }

    function spin(velocity) {
        cancelAnimationFrame(wheel.raf);
        if (reduceMotion || Math.abs(velocity) < 0.0008) {
            glide(Math.round(wheel.offset));
            return;
        }
        let speed = clamp(velocity, -0.03, 0.03);
        let last = performance.now();
        const tick = (now) => {
            const dt = Math.min(48, now - last);
            last = now;
            wheel.offset += speed * dt;
            speed *= Math.pow(0.992, dt);
            renderWheel();
            if (Math.abs(speed) > 0.0008) wheel.raf = requestAnimationFrame(tick);
            else glide(Math.round(wheel.offset));
        };
        wheel.raf = requestAnimationFrame(tick);
    }

    function openReactionWheel(messageId, point) {
        const row = stream.querySelector(`.message-row[data-message-id="${messageId}"]`);
        if (!row) return;
        const mine = row.classList.contains("message-mine");
        const bubble = row.querySelector(".message-bubble").getBoundingClientRect();
        const reach = RING + ITEM / 2 + 14;
        const rawX = point && point.x > 0 ? point.x : bubble.left + bubble.width / 2;
        const rawY = point && point.y > 0 ? point.y : bubble.top + bubble.height / 2;
        const x = clamp(rawX, reach, window.innerWidth - reach);
        const y = clamp(rawY, reach, window.innerHeight - reach - 56);

        wheel.selected = new Set([...row.querySelectorAll(".reaction-chip.is-selected")].map((chip) => chip.dataset.emoji));
        const quick = [...new Set([...readRecent(), ...quickDefaults])].slice(0, 12);
        wheel.groups = [{ icon: "🕘", name: "Quick", list: quick }, ...emojiGroups];

        const action = (name, icon, label, cls = "") => `<button type="button" class="${cls}" data-act="${name}">${icon} ${label}</button>`;
        emojiPicker.dataset.mode = "reaction";
        emojiPicker.dataset.messageId = messageId;
        emojiPicker.innerHTML = `<div class="wheel-disc"></div><span class="wheel-pointer"></span>
            <button type="button" class="wheel-close" data-close aria-label="Close reactions">✕</button>
            <div class="wheel-items"></div>
            <div class="wheel-hub"><button type="button" data-cat="-1" aria-label="Previous group">‹</button><div class="wheel-hub-info"><span class="wheel-hub-icon"></span><small class="wheel-hub-name"></small></div><button type="button" data-cat="1" aria-label="Next group">›</button></div>
            <div class="wheel-actions">${action("reply", "↩", "Reply")}${action("copy", "⧉", "Copy")}${mine ? action("edit", "✎", "Edit") : ""}${action("delete", "🗑", "Delete", "is-danger")}</div>`;
        const items = emojiPicker.querySelector(".wheel-items");
        wheel.slots = Array.from({ length: 15 }, () => {
            const slot = document.createElement("button");
            slot.type = "button";
            slot.className = "wheel-item";
            slot.tabIndex = -1;
            slot.hidden = true;
            items.append(slot);
            return slot;
        });
        emojiPicker.classList.add("wheel");
        emojiPicker.style.left = `${x}px`;
        emojiPicker.style.top = `${y}px`;
        emojiPicker.setAttribute("aria-label", "Choose a reaction. Turn the ring to browse emojis.");
        emojiPicker.tabIndex = -1;
        emojiPicker.hidden = false;
        setWheelGroup(0);
        emojiPicker.focus({ preventScroll: true });
    }

    function openEmojiPicker(mode, messageId = null, point = null) {
        if (mode === "reaction") {
            openReactionWheel(messageId, point);
            return;
        }
        cancelAnimationFrame(wheel.raf);
        emojiPicker.dataset.mode = mode;
        emojiPicker.dataset.messageId = "";
        emojiPicker.classList.remove("wheel");
        emojiPicker.removeAttribute("style");
        emojiPicker.removeAttribute("aria-label");
        emojiPicker.removeAttribute("tabindex");
        emojiPicker.innerHTML = emojis.map((emoji) => `<button type="button" data-emoji="${emoji}" aria-label="${emoji}">${emoji}</button>`).join("");
        emojiPicker.hidden = false;
    }

    function closeEmojiPicker() {
        cancelAnimationFrame(wheel.raf);
        drag = null;
        emojiPicker.hidden = true;
        emojiPicker.classList.remove("wheel");
        emojiPicker.removeAttribute("style");
        delete emojiPicker.dataset.mode;
        delete emojiPicker.dataset.messageId;
    }

    function sendReaction(messageId, emoji) {
        if (!socket?.connected) {
            showToast("Reconnect to react to messages.");
            return;
        }
        socket.emit("message:react", { message_id: Number(messageId), emoji }, (result) => {
            if (!result?.ok) {
                showToast(result?.error || "Reaction could not be saved.");
                return;
            }
            renderReactionList(messageId, result.reactions);
        });
    }

    /* ---------- Wheel interaction: drag, flick, mouse wheel, keyboard ---------- */

    emojiPicker.addEventListener("pointerdown", (event) => {
        if (!emojiPicker.classList.contains("wheel") || event.target.closest(".wheel-hub, .wheel-actions, .wheel-close")) return;
        const center = wheelCenter();
        const angle = Math.atan2(event.clientY - center.y, event.clientX - center.x);
        cancelAnimationFrame(wheel.raf);
        drag = { id: event.pointerId, prev: angle, total: 0, start: wheel.offset, moved: false, velocity: 0, time: performance.now() };
    });
    emojiPicker.addEventListener("pointermove", (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const center = wheelCenter();
        const angle = Math.atan2(event.clientY - center.y, event.clientX - center.x);
        const delta = Math.atan2(Math.sin(angle - drag.prev), Math.cos(angle - drag.prev));
        drag.prev = angle;
        drag.total += delta;
        if (!drag.moved && Math.abs(drag.total) * RING > 6) {
            drag.moved = true;
            emojiPicker.setPointerCapture(event.pointerId);
        }
        if (!drag.moved) return;
        const now = performance.now();
        const dt = now - drag.time;
        if (dt > 0) drag.velocity = (-delta / wheel.step) / dt;
        drag.time = now;
        wheel.offset = drag.start - drag.total / wheel.step;
        renderWheel();
    });
    const endDrag = (event) => {
        if (!drag || event.pointerId !== drag.id) return;
        const wasDrag = drag.moved;
        const velocity = performance.now() - drag.time < 80 ? drag.velocity : 0;
        drag = null;
        if (wasDrag) spin(velocity);
    };
    emojiPicker.addEventListener("pointerup", endDrag);
    emojiPicker.addEventListener("pointercancel", endDrag);

    let wheelTimer;
    emojiPicker.addEventListener("wheel", (event) => {
        if (!emojiPicker.classList.contains("wheel")) return;
        event.preventDefault();
        cancelAnimationFrame(wheel.raf);
        wheel.offset += event.deltaY / 100;
        renderWheel();
        window.clearTimeout(wheelTimer);
        wheelTimer = window.setTimeout(() => glide(Math.round(wheel.offset)), 120);
    }, { passive: false });

    document.addEventListener("keydown", (event) => {
        if (emojiPicker.hidden) return;
        if (event.key === "Escape") {
            closeEmojiPicker();
            return;
        }
        if (!emojiPicker.classList.contains("wheel")) return;
        const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
        if (step) {
            event.preventDefault();
            glide(Math.round(wheel.offset) + step);
        } else if (event.key === "Enter" && !event.target.closest("button")) {
            event.preventDefault();
            const emoji = wheel.list[mod(Math.round(wheel.offset), wheel.len)];
            sendReaction(emojiPicker.dataset.messageId, emoji);
            pushRecent(emoji);
            closeEmojiPicker();
        }
    });

    emojiPicker.addEventListener("click", (event) => {
        if (event.target.closest("[data-close]")) {
            closeEmojiPicker();
            return;
        }
        const category = event.target.closest("[data-cat]");
        if (category) {
            setWheelGroup(wheel.group + Number(category.dataset.cat));
            return;
        }
        const act = event.target.closest("[data-act]");
        if (act) {
            const id = emojiPicker.dataset.messageId;
            closeEmojiPicker();
            runMessageAction(act.dataset.act, id);
            return;
        }
        const button = event.target.closest("[data-emoji]");
        if (!button) return;
        const emoji = button.dataset.emoji;
        if (emojiPicker.dataset.mode === "reaction") {
            sendReaction(emojiPicker.dataset.messageId, emoji);
            pushRecent(emoji);
        } else {
            const start = input.selectionStart;
            const end = input.selectionEnd;
            input.setRangeText(emoji, start, end, "end");
            input.dispatchEvent(new Event("input", { bubbles: true }));
            input.focus();
        }
        closeEmojiPicker();
    });

    /* ---------- Loading, opening chats, outbox ---------- */

    async function loadMessages(chatId, before = null) {
        const url = new URL(`/api/chats/${chatId}/messages`, location.origin);
        if (before) url.searchParams.set("before", before);
        const data = await request(url);
        hasMore = data.has_more;
        if (data.messages.length) {
            if (before) {
                const oldHeight = history.scrollHeight;
                [...data.messages].reverse().forEach((message) => addMessage(message, { prepend: true }));
                history.scrollTop += history.scrollHeight - oldHeight;
            } else {
                data.messages.forEach((message) => addMessage(message));
                history.scrollTop = history.scrollHeight;
            }
            oldestMessageId = data.messages[0].id;
        }
    }

    async function openChat(chat) {
        closeEmojiPicker();
        cancelReply();
        if (editingMessageId) cancelEditing();
        activeChat = chat;
        messageCache.clear();
        document.querySelector("#conversation-empty").hidden = true;
        document.querySelector("#conversation-active").hidden = false;
        document.querySelector("#active-title").textContent = chat.title;
        document.querySelector("#active-subtitle").textContent = chat.username ? `@${chat.username}` : "A direct conversation";
        const presence = document.querySelector("#active-presence");
        presence.textContent = presenceText(chat);
        presence.classList.toggle("is-online", Boolean(chat.online));
        const avatar = document.querySelector("#active-avatar");
        avatar.innerHTML = avatarHTML(chat);
        avatar.className = "avatar avatar-current";
        shell.classList.add("chat-open");
        stream.replaceChildren();
        renderedIds.clear();
        oldestMessageId = null;
        const empty = list.querySelector(`[data-chat-id="${chat.id}"]`);
        list.querySelectorAll(".chat-row").forEach((row) => row.classList.toggle("is-active", row === empty));
        chat.unread = 0;
        renderChatList();
        history.scrollTop = 0;
        try {
            await loadMessages(chat.id);
            if (socket) {
                socket.emit("chat:join", { chat_id: chat.id }, (result) => {
                    if (!result?.ok) console.warn(result?.error || "Unable to join chat");
                });
            }
        } catch (error) {
            showToast(error.message);
        }
    }

    function readOutbox() {
        try { return JSON.parse(localStorage.getItem(outboxKey) || "[]"); } catch { return []; }
    }

    function saveOutbox(messages) { localStorage.setItem(outboxKey, JSON.stringify(messages.slice(-100))); }

    function sendQueuedMessage(message) {
        if (!socket) return;
        if (!socket.connected) {
            socket.connect();
            return;
        }
        socket.emit("message:send", message, (result) => {
            if (!result?.ok) {
                showToast(result?.error || "Message could not be sent.");
                return;
            }
            addMessage(result.message, { scroll: true });
            const remaining = readOutbox().filter((item) => item.client_id !== message.client_id);
            saveOutbox(remaining);
        });
    }

    function flushOutbox() {
        readOutbox().forEach(sendQueuedMessage);
    }

    function showToast(message) {
        let toast = document.querySelector(".toast-message");
        if (!toast) {
            toast = document.createElement("div");
            toast.className = "toast-message";
            toast.setAttribute("role", "status");
            document.body.append(toast);
        }
        toast.textContent = message;
        toast.classList.add("toast-visible");
        window.setTimeout(() => toast.classList.remove("toast-visible"), 3000);
    }

    async function searchPeople(query) {
        const results = document.querySelector("#people-results");
        if (query.trim().length < 2) {
            results.innerHTML = '<p class="search-hint">Type at least 2 characters to find people.</p>';
            return;
        }
        results.innerHTML = '<p class="search-hint">Looking around…</p>';
        try {
            const data = await request(`/api/users?q=${encodeURIComponent(query.trim())}`);
            if (!data.users.length) {
                results.innerHTML = '<p class="search-hint">No one found. Try a username or phone number.</p>';
                return;
            }
            results.innerHTML = data.users.map((person) => `<button class="person-result" type="button" data-user-id="${person.id}"><span class="avatar avatar-lilac">${person.avatar_url ? `<img src="${escapeAttribute(person.avatar_url)}" alt="">` : escapeHTML(person.initial)}</span><span><strong>${escapeHTML(person.display_name)}</strong><small>@${escapeHTML(person.username)}${person.about ? ` · ${escapeHTML(person.about)}` : ""}</small></span><span class="person-arrow">↗</span></button>`).join("");
        } catch (error) {
            results.innerHTML = `<p class="search-hint">${escapeHTML(error.message)}</p>`;
        }
    }

    /* ---------- Event wiring ---------- */

    let searchTimer;
    document.querySelectorAll(".new-chat-button").forEach((button) => button.addEventListener("click", () => {
        dialog.showModal();
        document.querySelector("#people-query").focus();
    }));
    document.querySelector("#chat-filter").addEventListener("input", filterChats);
    document.querySelector("#people-query").addEventListener("input", (event) => {
        window.clearTimeout(searchTimer);
        searchTimer = window.setTimeout(() => searchPeople(event.target.value), 180);
    });
    document.querySelector("#people-results").addEventListener("click", async (event) => {
        const button = event.target.closest("[data-user-id]");
        if (!button) return;
        try {
            const data = await request("/api/chats", { method: "POST", body: JSON.stringify({ user_id: Number(button.dataset.userId) }) });
            const result = await request(`/api/chats/${data.chat_id}`);
            let chat = chats.find((item) => Number(item.id) === Number(data.chat_id));
            if (!chat) {
                chat = result.chat;
                chats.unshift(chat);
                renderChatList();
            }
            dialog.close();
            await openChat(chat);
        } catch (error) {
            showToast(error.message);
        }
    });
    list.addEventListener("click", (event) => {
        const row = event.target.closest("[data-chat-id]");
        if (row) {
            const chat = chats.find((item) => Number(item.id) === Number(row.dataset.chatId));
            if (chat) openChat(chat);
        }
    });
    document.querySelector("#back-to-list").addEventListener("click", () => {
        closeEmojiPicker();
        shell.classList.remove("chat-open");
    });
    document.querySelector("#emoji-toggle").addEventListener("click", () => {
        if (emojiPicker.hidden || emojiPicker.dataset.mode !== "composer") openEmojiPicker("composer");
        else closeEmojiPicker();
    });

    stream.addEventListener("click", (event) => {
        const quote = event.target.closest("[data-jump]");
        if (quote) {
            jumpTo(quote.dataset.jump);
            return;
        }
        const action = event.target.closest("[data-action]");
        if (action) {
            const { messageId } = action.dataset;
            if (action.dataset.action === "react") {
                const box = action.getBoundingClientRect();
                openEmojiPicker("reaction", messageId, { x: box.left + box.width / 2, y: box.top + box.height / 2 });
            } else if (action.dataset.action === "react-chip") {
                sendReaction(messageId, action.dataset.emoji);
            } else {
                runMessageAction(action.dataset.action, messageId);
            }
            return;
        }
        const row = event.target.closest(".message-bubble")?.closest(".message-row");
        if (!row || !row.dataset.messageId || row.querySelector(".is-deleted")) return; // unsent or deleted messages have no menu
        openEmojiPicker("reaction", row.dataset.messageId, { x: event.clientX, y: event.clientY });
    });
    document.addEventListener("click", (event) => {
        if (emojiPicker.hidden) return;
        if (event.target.closest("#emoji-picker, #emoji-toggle, [data-action='react'], .message-bubble")) return;
        closeEmojiPicker();
    });
    window.addEventListener("resize", () => {
        if (emojiPicker.classList.contains("wheel")) closeEmojiPicker();
    });
    editCancel.addEventListener("click", cancelEditing);

    composer.addEventListener("submit", (event) => {
        event.preventDefault();
        const body = input.value.trim();
        if (!body) return;
        if (editingMessageId) {
            socket?.emit("message:edit", { message_id: editingMessageId, body }, (result) => {
                if (!result?.ok) {
                    showToast(result?.error || "Message could not be edited.");
                    return;
                }
                updateMessage(result.message);
                cancelEditing();
            });
            return;
        }
        if (!activeChat) return;
        const message = { chat_id: activeChat.id, body, client_id: crypto.randomUUID() };
        if (replyTo) message.reply_to_id = replyTo.id;
        input.value = "";
        input.style.height = "auto";
        const pending = { ...message, sender_id: Number(userId), created_at: new Date().toISOString(), time: formatClock(new Date()), status: "sent" };
        if (replyTo) pending.reply_to = { id: replyTo.id, body: replyTo.body, sender_id: replyTo.sender_id, deleted: false };
        cancelReply();
        addMessage(pending, { scroll: true });
        const queue = readOutbox();
        queue.push(message);
        saveOutbox(queue);
        updateChatSummary(activeChat.id, pending);
        sendQueuedMessage(message);
    });
    input.addEventListener("input", () => {
        input.style.height = "auto";
        input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    });
    input.addEventListener("keydown", (event) => {
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            composer.requestSubmit();
        }
    });
    history.addEventListener("scroll", () => {
        if (emojiPicker.classList.contains("wheel")) closeEmojiPicker();
        if (history.scrollTop < 24 && hasMore && oldestMessageId && !loadingOlder && activeChat) {
            loadingOlder = true;
            loadMessages(activeChat.id, oldestMessageId).finally(() => { loadingOlder = false; });
        }
    }, { passive: true });

    if (socket) {
        socket.on("connect", flushOutbox);
        socket.on("message:new", (message) => {
            updateChatSummary(message.chat_id, message);
            if (Number(activeChat?.id) === Number(message.chat_id)) addMessage(message, { scroll: true });
            else if (!isOwnMessage(message)) socket.emit("message:received", { message_id: message.id, read: false });
        });
        socket.on("message:status", (data) => updateStatus(data.message_id, data.status));
        socket.on("message:updated", updateMessage);
        socket.on("message:deleted", markDeleted);
        socket.on("message:reactions", (data) => renderReactionList(data.message_id, data.reactions));
        socket.on("presence:update", setPresence);
        socket.on("chat:activity", async () => {
            try {
                const data = await request("/api/chats");
                chats = data.chats;
                renderChatList();
            } catch { /* Reconnection will refresh the list on the next activity. */ }
        });
    }
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && activeChat && socket?.connected) {
            socket.emit("chat:join", { chat_id: activeChat.id });
        }
    });

    renderChatList();
    if (socket) flushOutbox();
})();