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
    let openToken = 0;
    let loadingOlder = false;
    let hasMore = false;
    let oldestMessageId = null;
    let editingMessageId = null;
    let draftBeforeEdit = "";
    let replyTo = null;
    let newBelow = 0;
    let lastPeople = [];
    let toastTimer;
    let hoverTimer;
    let stickBottom = true;
    let voice = null;                 // the voice note that is playing, if any
    const renderedIds = new Set();
    const messageCache = new Map();   // message id -> message data
    const chatCache = new Map();      // chat id -> { messages, hasMore }, for instant paint
    const prefetching = new Set();
    const typingNow = new Map();      // chat id -> { name, timer }
    const list = document.querySelector("#chat-list");
    const history = document.querySelector("#message-history");
    const stream = document.querySelector("#message-stream");
    const composer = document.querySelector("#message-form");
    const input = document.querySelector("#message-input");
    const dialog = document.querySelector("#search-dialog");
    const emojiPicker = document.querySelector("#emoji-picker");
    const sendButton = document.querySelector("#send-button");
    const editCancel = document.querySelector("#edit-cancel");
    const conversationPane = document.querySelector(".conversation");
    const outboxKey = `lol-outbox-${userId}`;
    const recentKey = `lol-recent-react-${userId}`;
    const draftKey = `lol-drafts-${userId}`;
    const socket = typeof window.io === "function" ? window.io({ reconnection: true, reconnectionDelayMax: 5000 }) : null;
    const emojis = ["😀", "😂", "🥹", "😍", "😊", "😮", "😢", "🙏", "👏", "👍", "❤️", "🔥", "🎉", "✨", "💯", "☕"];
    const quickDefaults = ["❤️", "😂", "👍", "😮", "😢", "🙏"];
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const DISAPPEAR_LABELS = { 86400: "24 hours", 604800: "7 days", 7776000: "90 days" };

    const request = async (url, options = {}) => {
        const response = await fetch(url, {
            ...options,
            headers: { "Content-Type": "application/json", "X-CSRFToken": csrf, ...(options.headers || {}) },
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || "Something went wrong.");
        return data;
    };

    const escapeHTML = (value) => String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);
    const escapeAttribute = escapeHTML;
    const avatarHTML = (chat) => chat.avatar_url
        ? `<img src="${escapeAttribute(chat.avatar_url)}" alt="">`
        : escapeHTML(chat.initial || chat.title?.slice(0, 1) || "?");
    const formatClock = (date) => new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(date));
    const isOwnMessage = (message) => Number(message.sender_id) === Number(userId);
    const distanceFromBottom = () => history.scrollHeight - history.scrollTop - history.clientHeight;
    const isNearLatest = () => distanceFromBottom() < 80;
    const clamp = (value, low, high) => (high < low ? (low + high) / 2 : Math.min(Math.max(value, low), high));
    const mod = (n, m) => ((n % m) + m) % m;
    const formatLastSeen = (value) => value
        ? `last seen ${new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value))}`
        : "last seen recently";
    const formatBytes = (bytes) => {
        const n = Number(bytes) || 0;
        if (n < 1024) return `${n} B`;
        if (n < 1048576) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
        return `${(n / 1048576).toFixed(1)} MB`;
    };
    const clockText = (total) => {
        const s = Math.max(0, Math.round(Number(total) || 0));
        return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
    };
    const hueOf = (value) => {
        let hash = 0;
        for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) % 360;
        return hash;
    };
    function listTime(iso) {
        const date = new Date(iso);
        if (Number.isNaN(date.getTime())) return "";
        const now = new Date();
        if (date.toDateString() === now.toDateString()) return formatClock(date);
        const yesterday = new Date(now.getTime() - 86400000);
        if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
        return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
    }
    function fileIcon(name) {
        const ext = String(name).split(".").pop().toLowerCase();
        if (ext === "pdf") return "📕";
        if (["doc", "docx", "rtf", "odt"].includes(ext)) return "📘";
        if (["xls", "xlsx", "csv"].includes(ext)) return "📗";
        if (["ppt", "pptx"].includes(ext)) return "📙";
        if (ext === "zip") return "🗜️";
        if (ext === "txt") return "📄";
        if (["mp3", "m4a", "wav", "ogg", "oga", "aac", "webm", "mp4"].includes(ext)) return "🎵";
        return "📎";
    }

    let isEmojiOnly = () => false;
    try {
        const pattern = /^(?:\p{Extended_Pictographic}(?:\uFE0F|\u200D|\p{Emoji_Modifier})*\s*){1,3}$/u;
        isEmojiOnly = (text) => pattern.test(String(text).trim());
    } catch { /* older browsers just show normal bubbles */ }

    /* ---------- Message formatting: *bold* _italic_ ~strike~ `code` links ---------- */

    function formatText(raw) {
        const stash = [];
        const keep = (html) => { stash.push(html); return `\u0000${stash.length - 1}\u0000`; };
        let s = String(raw ?? "").replace(/\u0000/g, "");
        s = s.replace(/```([\s\S]+?)```/g, (_, code) => keep(`<code class="code-block">${escapeHTML(code.replace(/^\n|\n$/g, ""))}</code>`));
        s = s.replace(/`([^`\n]+?)`/g, (_, code) => keep(`<code>${escapeHTML(code)}</code>`));
        s = s.replace(/\bhttps?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]]/gi, (url) => keep(`<a href="${escapeAttribute(url)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHTML(url)}</a>`));
        s = escapeHTML(s);
        s = s.replace(/(^|[\s(])\*([^\s*](?:[^*\n]*[^\s*])?)\*(?=$|[\s).,!?:;])/g, "$1<strong>$2</strong>");
        s = s.replace(/(^|[\s(])_([^\s_](?:[^_\n]*[^\s_])?)_(?=$|[\s).,!?:;])/g, "$1<em>$2</em>");
        s = s.replace(/(^|[\s(])~([^\s~](?:[^~\n]*[^\s~])?)~(?=$|[\s).,!?:;])/g, "$1<del>$2</del>");
        return s.replace(/\u0000(\d+)\u0000/g, (_, index) => stash[Number(index)]);
    }

    /* ---------- One-line descriptions of a message ---------- */

    function previewCore(message) {
        if (message.deleted) return "🚫 Message deleted";
        if (message.kind === "image") return `📷 ${message.body || "Photo"}`;
        if (message.kind === "video") return `🎥 ${message.body || "Video"}`;
        if (message.kind === "voice") return `🎤 Voice message${message.media?.duration ? ` (${clockText(message.media.duration)})` : ""}`;
        if (message.kind === "file") return `📎 ${message.media?.name || "File"}`;
        return message.body || "";
    }

    function summaryFor(chat, message) {
        const core = previewCore(message);
        if (chat.type !== "group" || message.kind === "system" || message.deleted) return core;
        const who = isOwnMessage(message) ? "You" : ((message.sender_name || "").split(/\s+/)[0] || "Someone");
        return `${who}: ${core}`;
    }

    function subtitleFor(chat) {
        const base = chat.type === "group"
            ? `${chat.member_count || 0} members`
            : (chat.username ? `@${chat.username}` : "A direct conversation");
        return chat.disappear_seconds ? `${base} · ⏱ ${DISAPPEAR_LABELS[chat.disappear_seconds] || "timer on"}` : base;
    }

    function presenceText(chat) {
        if (chat.type === "group") return "";
        return chat.online ? "online" : chat.last_seen_at ? formatLastSeen(chat.last_seen_at) : "offline";
    }

    /* ---------- Toast (with optional action such as Undo) ---------- */

    function showToast(message, { action = null, duration = 3000 } = {}) {
        let toast = document.querySelector(".toast-message");
        if (!toast) {
            toast = document.createElement("div");
            toast.className = "toast-message";
            toast.setAttribute("role", "status");
            document.body.append(toast);
        }
        toast.textContent = message;
        if (action) {
            const button = document.createElement("button");
            button.type = "button";
            button.className = "toast-action";
            button.textContent = action.label;
            button.addEventListener("click", () => {
                action.onClick();
                toast.classList.remove("toast-visible");
            });
            toast.append(button);
        }
        toast.classList.add("toast-visible");
        window.clearTimeout(toastTimer);
        toastTimer = window.setTimeout(() => toast.classList.remove("toast-visible"), duration);
    }

    /* ---------- Drafts: each chat keeps its own unsent text ---------- */

    const drafts = (() => {
        try { return JSON.parse(localStorage.getItem(draftKey) || "{}"); } catch { return {}; }
    })();

    function setDraft(chatId, text) {
        if (!chatId) return;
        if (String(text).trim()) drafts[chatId] = text;
        else delete drafts[chatId];
        try { localStorage.setItem(draftKey, JSON.stringify(drafts)); } catch { /* storage unavailable */ }
    }

    function autosize() {
        input.style.height = "auto";
        if (input.value) input.style.height = `${Math.min(input.scrollHeight, 120)}px`;
    }

    function restoreDraft() {
        input.value = (activeChat?.id && drafts[activeChat.id]) || "";
        autosize();
    }

    /* ---------- Typing indicator ---------- */

    let typingSentAt = 0;
    let typingStopTimer = 0;

    function emitTyping(on) {
        if (!socket?.connected || !activeChat?.id) return;
        socket.emit("typing", { chat_id: activeChat.id, typing: on });
    }

    function noteTyping() {
        const now = Date.now();
        if (now - typingSentAt > 2500) {
            typingSentAt = now;
            emitTyping(true);
        }
        window.clearTimeout(typingStopTimer);
        typingStopTimer = window.setTimeout(() => {
            typingSentAt = 0;
            emitTyping(false);
        }, 3000);
    }

    function stopTyping() {
        window.clearTimeout(typingStopTimer);
        if (typingSentAt) {
            typingSentAt = 0;
            emitTyping(false);
        }
    }

    function typingLabel(chat) {
        const entry = typingNow.get(Number(chat.id));
        if (!entry) return "";
        return chat.type === "group" ? `${entry.name} is typing…` : "typing…";
    }

    function setTyping(chatId, name, on) {
        const key = Number(chatId);
        const previous = typingNow.get(key);
        if (previous) window.clearTimeout(previous.timer);
        if (on) {
            typingNow.set(key, { name, timer: window.setTimeout(() => { typingNow.delete(key); refreshTyping(key); }, 4500) });
        } else {
            typingNow.delete(key);
        }
        refreshTyping(key);
    }

    function refreshTyping(chatId) {
        renderChatList();
        if (Number(activeChat?.id) === Number(chatId)) updateHeaderStatus();
    }

    function updateHeaderStatus() {
        if (!activeChat) return;
        const label = document.querySelector("#active-presence");
        const typing = typingLabel(activeChat);
        label.textContent = typing || presenceText(activeChat);
        label.classList.toggle("is-online", Boolean(typing || activeChat.online));
    }

    function refreshHeader() {
        const chat = activeChat;
        if (!chat) return;
        document.querySelector("#active-title").textContent = chat.title;
        document.querySelector("#active-subtitle").textContent = subtitleFor(chat);
        const avatar = document.querySelector("#active-avatar");
        avatar.innerHTML = avatarHTML(chat);
        avatar.className = "avatar avatar-current";
        updateHeaderStatus();
    }

    /* ---------- Chat list ---------- */

    function previewFor(chat) {
        const typing = typingLabel(chat);
        if (typing) return { text: typing, label: "", cls: " is-typing" };
        const draft = Number(activeChat?.id) !== Number(chat.id) && drafts[chat.id];
        if (draft) return { text: draft, label: "Draft:", cls: " is-draft" };
        return { text: chat.preview || "Start a conversation", label: "", cls: "" };
    }

    function renderChatRow(chat) {
        const active = Number(activeChat?.id) === Number(chat.id) ? " is-active" : "";
        const badge = chat.unread ? `<span class="unread-badge">${chat.unread > 99 ? "99+" : chat.unread}</span>` : "";
        const preview = previewFor(chat);
        const dot = chat.online && chat.type !== "group" ? '<i class="online-dot" aria-hidden="true"></i>' : "";
        const when = chat.last_at ? listTime(chat.last_at) : (chat.time || "");
        return `<button class="chat-row${active}" type="button" role="listitem" data-chat-id="${chat.id}" data-search="${escapeAttribute(`${chat.title} ${chat.username || ""}`.toLowerCase())}">
      <span class="avatar-wrap"><span class="avatar avatar-sky">${avatarHTML(chat)}</span>${dot}</span><span class="chat-row-copy"><span class="chat-row-top"><strong>${escapeHTML(chat.title)}</strong><time>${escapeHTML(when)}</time></span><span class="chat-row-bottom"><span class="chat-preview${preview.cls}">${preview.label ? `<em>${preview.label}</em>` : ""}${escapeHTML(preview.text)}</span>${badge}</span></span></button>`;
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
        chat.preview = summaryFor(chat, message);
        chat.time = formatClock(message.created_at);
        chat.last_at = message.created_at;
        chat.updated_at = message.created_at;
        if (message.kind !== "system" && !isOwnMessage(message) && (Number(activeChat?.id) !== Number(chatId) || !isNearLatest())) {
            chat.unread = (chat.unread || 0) + 1;
        }
        renderChatList();
    }

    function upsertChat(chat) {
        const index = chats.findIndex((item) => Number(item.id) === Number(chat.id));
        if (index >= 0) chats[index] = chat;
        else chats.unshift(chat);
        renderChatList();
        return chat;
    }

    async function refreshChats() {
        try {
            const data = await request("/api/chats");
            const open = activeChat;
            chats = data.chats;
            if (open?.id) {
                const fresh = chats.find((item) => Number(item.id) === Number(open.id));
                if (fresh) {
                    fresh.unread = 0;
                    activeChat = fresh;
                    refreshHeader();
                } else {
                    closeMissingChat();
                }
            }
            renderChatList();
        } catch { /* the next activity will refresh the list */ }
    }

    function closeMissingChat() {
        openToken += 1;
        stopTyping();
        closeEmojiPicker();
        cancelReply();
        stopVoice();
        activeChat = null;
        shell.classList.remove("chat-open");
        document.querySelector("#conversation-empty").hidden = false;
        document.querySelector("#conversation-active").hidden = true;
        document.dispatchEvent(new CustomEvent("lol:chat-change"));
        showToast("You’re no longer in that chat.");
    }

    /* ---------- Per-chat message cache (instant reopen) ---------- */

    function cacheIncoming(message) {
        const entry = chatCache.get(Number(message.chat_id));
        if (!entry || entry.messages.some((item) => item.client_id === message.client_id)) return;
        entry.messages.push(message);
        if (entry.messages.length > 60) entry.messages.shift();
    }

    function patchCached(chatId, messageId, patch) {
        const entry = chatCache.get(Number(chatId));
        const found = entry?.messages.find((item) => String(item.id) === String(messageId));
        if (found) Object.assign(found, patch);
    }

    function prefetch(chatId) {
        const key = Number(chatId);
        if (chatCache.has(key) || prefetching.has(key)) return;
        prefetching.add(key);
        request(`/api/chats/${key}/messages`)
            .then((data) => { if (!chatCache.has(key)) chatCache.set(key, { messages: data.messages, hasMore: data.has_more }); })
            .catch(() => { /* opening the chat will retry and show any error */ })
            .finally(() => prefetching.delete(key));
    }

    /* ---------- Message rendering ---------- */

    function statusHTML(message) {
        if (!isOwnMessage(message) || message.deleted || message.kind === "system") return "";
        const status = message.status || "sent";
        return `<span class="message-status status-${status}" data-message-id="${message.id || ""}" aria-label="${status}">${status === "sent" ? "✓" : "✓✓"}</span>`;
    }

    function actionsHTML(message) {
        if (!message.id || message.deleted) return "";
        const mine = isOwnMessage(message);
        const canEdit = mine && (message.kind || "text") === "text";
        const button = (action, label, icon) => `<button class="message-action" type="button" data-action="${action}" data-message-id="${message.id}" aria-label="${label}" title="${label}">${icon}</button>`;
        return `<div class="message-actions">${button("react", "React to message", "＋")}${button("reply", "Reply", "↩")}${button("star", message.starred ? "Remove star" : "Star message", "★")}${canEdit ? button("edit", "Edit message", "✎") : ""}${button("delete", "Delete message", "🗑")}</div>`;
    }

    function replyQuoteHTML(message) {
        const parent = message.reply_to;
        if (!parent) return "";
        const own = Number(parent.sender_id) === Number(userId);
        const who = own ? "You" : (parent.sender_name || activeChat?.title || "Them");
        const text = parent.deleted ? "🚫 Message deleted" : parent.body;
        return `<blockquote class="reply-quote" data-jump="${parent.id}"><b>${escapeHTML(who)}</b><span>${escapeHTML(text)}</span></blockquote>`;
    }

    function reactionChip(messageId, reaction) {
        return `<button class="reaction-chip${reaction.reacted ? " is-selected" : ""}" type="button" data-action="react-chip" data-message-id="${messageId}" data-emoji="${escapeAttribute(reaction.emoji)}" aria-label="${escapeAttribute(reaction.emoji)} reaction, ${reaction.count}">${escapeHTML(reaction.emoji)} <span>${reaction.count}</span></button>`;
    }

    function mediaHTML(message) {
        const media = message.media;
        if (!media || message.deleted) return "";
        const url = escapeAttribute(media.url);
        const name = escapeAttribute(media.name);
        if (message.kind === "image") {
            return `<button class="media-image" type="button" data-lightbox="${url}" data-name="${name}" aria-label="Open photo ${name}"><img src="${url}" alt="${name}" loading="lazy"></button>`;
        }
        if (message.kind === "video") {
            return `<video class="media-video" src="${url}" controls preload="metadata" playsinline aria-label="Video ${name}"></video>`;
        }
        if (message.kind === "voice") {
            return `<div class="voice" data-voice="${url}" data-duration="${Number(media.duration) || 0}"><button class="voice-play" type="button" aria-label="Play voice message"><span class="v-play">▶</span><span class="v-pause">❚❚</span></button><div class="voice-track" role="progressbar" aria-label="Voice message progress"><i></i></div><span class="voice-time">${clockText(media.duration)}</span></div>`;
        }
        return `<a class="media-file" href="${url}" download="${name}"><span class="file-icon" aria-hidden="true">${fileIcon(media.name)}</span><span class="file-meta"><b>${escapeHTML(media.name)}</b><small>${formatBytes(media.size)}</small></span><span class="file-dl" aria-hidden="true">⬇</span></a>`;
    }

    function bubbleHTML(message) {
        if (message.kind === "system") {
            return `<div class="system-line"><span>${escapeHTML(message.body)}</span></div>`;
        }
        const mine = isOwnMessage(message);
        const group = activeChat?.type === "group";
        const kind = message.kind || "text";
        const reactions = message.deleted ? "" : (message.reactions || []).map((reaction) => reactionChip(message.id, reaction)).join("");
        const big = !message.deleted && kind === "text" && !message.reply_to && isEmojiOnly(message.body || "");
        const sender = group && !mine && !message.deleted
            ? `<b class="sender" style="--h:${hueOf(message.sender_id)}">${escapeHTML(message.sender_name || "Someone")}</b>` : "";
        const caption = message.body ? `<p>${formatText(message.body)}</p>` : "";
        const content = message.deleted
            ? `<p class="deleted-text">🚫 ${mine ? "You deleted this message" : "This message was deleted"}</p>`
            : `${sender}${replyQuoteHTML(message)}${mediaHTML(message)}${caption}`;
        const edited = !message.deleted && message.edited ? '<span class="message-edited">edited</span>' : "";
        const star = !message.deleted && message.starred ? '<span class="msg-star" title="Starred">★</span>' : "";
        const timer = !message.deleted && message.expires_at ? '<span class="msg-timer" title="Disappearing message">⏱</span>' : "";
        const time = message.created_at ? formatClock(message.created_at) : (message.time || "");
        const classes = ["message-bubble"];
        if (message.deleted) classes.push("is-deleted");
        if (big) classes.push("emoji-only");
        if (!message.deleted && (kind === "image" || kind === "video")) classes.push("has-photo");
        return `<div class="message-content"><div class="${classes.join(" ")}">${content}<footer>${star}${timer}${edited}<time>${escapeHTML(time)}</time>${statusHTML(message)}</footer></div>${actionsHTML(message)}<div class="reaction-list" data-reactions-for="${message.id || ""}">${reactions}</div></div>`;
    }

    function cacheMessage(message) {
        if (message.id) messageCache.set(String(message.id), { ...messageCache.get(String(message.id)), ...message });
    }

    const dayKey = (timestamp) => new Date(Number(timestamp)).toDateString();

    function dayLabel(timestamp) {
        const date = new Date(Number(timestamp));
        const today = new Date();
        const yesterday = new Date(today.getTime() - 86400000);
        if (date.toDateString() === today.toDateString()) return "Today";
        if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
        return new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(date);
    }

    function relabelDays() {
        stream.querySelectorAll(".day-sep").forEach((node) => node.remove());
        let previous = "";
        stream.querySelectorAll(".message-row").forEach((row) => {
            const day = row.dataset.day;
            if (day && day !== previous) {
                const separator = document.createElement("div");
                separator.className = "day-sep";
                const label = document.createElement("span");
                label.textContent = dayLabel(row.dataset.ts);
                separator.append(label);
                row.before(separator);
                previous = day;
            }
        });
    }

    function addMessage(message, { scroll = false, prepend = false, batch = false, live = false } = {}) {
        cacheMessage(message);
        if (renderedIds.has(String(message.client_id))) {
            const existing = [...stream.querySelectorAll(".message-row")]
                .find((item) => item.dataset.clientId === String(message.client_id));
            if (existing && message.id) {
                existing.dataset.messageId = message.id;
                if (message.expires_at) existing.dataset.expires = String(Date.parse(message.expires_at));
                existing.innerHTML = bubbleHTML(message);
                if (isOwnMessage(message) && message.status) updateStatus(message.id, message.status);
            }
            return;
        }
        stream.querySelectorAll(".empty-chat, .skeleton-row").forEach((node) => node.remove());
        renderedIds.add(String(message.client_id));
        const system = message.kind === "system";
        const mine = isOwnMessage(message);
        const wasNearLatest = isNearLatest();
        const row = document.createElement("article");
        row.className = `message-row ${system ? "message-system" : mine ? "message-mine" : "message-theirs"}${live ? " is-new" : ""}`;
        row.dataset.messageId = message.id || "";
        row.dataset.clientId = message.client_id;
        row.dataset.ts = String(Date.parse(message.created_at) || Date.now());
        row.dataset.day = dayKey(row.dataset.ts);
        if (message.expires_at) row.dataset.expires = String(Date.parse(message.expires_at));
        row.innerHTML = bubbleHTML(message);
        if (prepend) stream.prepend(row);
        else stream.append(row);
        if (live) row.addEventListener("animationend", () => row.classList.remove("is-new"), { once: true });
        if (!batch) relabelDays();
        if (message.id && !mine && !system && socket && activeChat && !batch && message.status !== "read") {
            socket.emit("message:received", { message_id: message.id, read: document.visibilityState === "visible" && wasNearLatest });
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
        patchCached(message.chat_id, message.id, { body: message.body, edited: true });
        const row = stream.querySelector(`[data-message-id="${message.id}"]`);
        if (!row) return;
        const body = row.querySelector(".message-bubble p:not(.deleted-text)");
        if (body) body.innerHTML = formatText(message.body);
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
            chat.preview = summaryFor(chat, message);
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
        const chat = chats.find((item) => Number(item.other_user_id) === Number(data.user_id) && item.type !== "group");
        if (!chat) return;
        chat.online = data.online;
        chat.last_seen_at = data.last_seen_at;
        renderChatList();
        if (Number(activeChat?.id) === Number(chat.id)) updateHeaderStatus();
    }

    /* ---------- Stars ---------- */

    function applyStar(messageId, starred) {
        const id = String(messageId);
        const cached = messageCache.get(id);
        if (cached) cached.starred = starred;
        patchCached(cached?.chat_id ?? activeChat?.id, id, { starred });
        const row = stream.querySelector(`.message-row[data-message-id="${id}"]`);
        if (!row) return;
        const footer = row.querySelector(".message-bubble footer");
        const existing = footer?.querySelector(".msg-star");
        if (starred && footer && !existing) {
            const mark = document.createElement("span");
            mark.className = "msg-star";
            mark.title = "Starred";
            mark.textContent = "★";
            footer.prepend(mark);
        } else if (!starred && existing) {
            existing.remove();
        }
        const button = row.querySelector('[data-action="star"]');
        if (button) {
            const label = starred ? "Remove star" : "Star message";
            button.title = label;
            button.setAttribute("aria-label", label);
        }
    }

    function toggleStar(messageId) {
        if (!socket?.connected) {
            showToast("Reconnect to star messages.");
            return;
        }
        socket.emit("message:star", { message_id: Number(messageId) }, (result) => {
            if (!result?.ok) {
                showToast(result?.error || "Couldn’t star that message.");
                return;
            }
            applyStar(messageId, result.starred);
            showToast(result.starred ? "Starred ★" : "Removed from starred");
        });
    }

    /* ---------- Voice notes ---------- */

    function paintVoice(el, seconds, total) {
        const fill = el.querySelector(".voice-track i");
        if (fill) fill.style.width = total ? `${clamp((seconds / total) * 100, 0, 100)}%` : "0%";
        const label = el.querySelector(".voice-time");
        if (label) label.textContent = clockText(seconds > 0 ? seconds : total);
    }

    function stopVoice() {
        if (!voice) return;
        voice.audio.pause();
        voice.el.classList.remove("is-playing");
        paintVoice(voice.el, 0, voice.total);
        voice = null;
    }

    function toggleVoice(el) {
        if (voice && voice.el === el) {
            if (voice.audio.paused) {
                voice.audio.play().catch(() => { /* ignore */ });
                el.classList.add("is-playing");
            } else {
                voice.audio.pause();
                el.classList.remove("is-playing");
            }
            return;
        }
        stopVoice();
        const total = Number(el.dataset.duration) || 0;
        const audio = new Audio(el.dataset.voice);
        const current = { audio, el, total };
        voice = current;
        audio.addEventListener("timeupdate", () => {
            const length = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : total;
            paintVoice(el, audio.currentTime, length);
        });
        audio.addEventListener("ended", () => {
            el.classList.remove("is-playing");
            paintVoice(el, 0, total);
            if (voice === current) voice = null;
        });
        audio.addEventListener("error", () => {
            el.classList.remove("is-playing");
            showToast("Couldn’t play that voice message.");
            if (voice === current) voice = null;
        });
        audio.play().then(() => el.classList.add("is-playing")).catch(() => {
            showToast("Couldn’t play that voice message.");
            if (voice === current) voice = null;
        });
    }

    function seekVoice(track, event) {
        const el = track.closest(".voice");
        if (!voice || voice.el !== el) return;
        const length = Number.isFinite(voice.audio.duration) && voice.audio.duration > 0 ? voice.audio.duration : voice.total;
        if (!length) return;
        const box = track.getBoundingClientRect();
        voice.audio.currentTime = clamp((event.clientX - box.left) / box.width, 0, 1) * length;
    }

    /* ---------- Photo viewer ---------- */

    function openLightbox(url, name) {
        const dlg = document.createElement("dialog");
        dlg.className = "lightbox";
        dlg.innerHTML = '<button type="button" class="lightbox-close" aria-label="Close photo">✕</button><a class="lightbox-save">⬇ Save</a><img alt="">';
        const image = dlg.querySelector("img");
        image.src = url;
        image.alt = name || "Photo";
        const save = dlg.querySelector(".lightbox-save");
        save.href = `${url}?download=1`;
        save.download = name || "photo";
        dlg.addEventListener("click", (event) => { if (!event.target.closest(".lightbox-save")) dlg.close(); });
        dlg.addEventListener("close", () => dlg.remove());
        document.body.append(dlg);
        dlg.showModal();
    }

    /* ---------- Loading states ---------- */

    function showSkeleton() {
        stream.replaceChildren();
        [180, 120, 230, 150, 100].forEach((width, index) => {
            const row = document.createElement("div");
            row.className = `skeleton-row${index % 2 ? " mine" : ""}`;
            const bar = document.createElement("span");
            bar.style.width = `${width}px`;
            row.append(bar);
            stream.append(row);
        });
    }

    function showEmptyChat(chat) {
        stream.replaceChildren();
        const box = document.createElement("div");
        box.className = "empty-chat";
        box.innerHTML = '<div class="empty-wave">👋</div><strong></strong><p>No messages yet. Break the ice!</p><div class="icebreakers"></div>';
        box.querySelector("strong").textContent = chat.type === "group" ? `Say hi to ${chat.title}` : `Say hi to ${chat.title}`;
        ["Hey 👋", "How’s your day going?", "😂", "What’s up?"].forEach((text) => {
            const button = document.createElement("button");
            button.type = "button";
            button.dataset.icebreaker = text;
            button.textContent = text;
            box.querySelector(".icebreakers").append(button);
        });
        stream.append(box);
    }

    function paintMessages(messages, more) {
        hasMore = more;
        stream.replaceChildren();
        renderedIds.clear();
        messageCache.clear();
        if (!messages.length) {
            oldestMessageId = null;
            showEmptyChat(activeChat);
            updateJump();
            return;
        }
        messages.forEach((message) => addMessage(message, { batch: true }));
        relabelDays();
        oldestMessageId = messages[0].id;
        history.scrollTop = history.scrollHeight;
        stickBottom = true;
        updateJump();
    }

    /* ---------- Jump to latest ---------- */

    const jumpButton = document.createElement("button");
    jumpButton.type = "button";
    jumpButton.className = "jump-latest";
    jumpButton.hidden = true;
    jumpButton.setAttribute("aria-label", "Jump to latest message");
    jumpButton.innerHTML = '<span class="jump-count" hidden></span>↓';
    conversationPane.append(jumpButton);
    jumpButton.addEventListener("click", () => {
        history.scrollTo({ top: history.scrollHeight, behavior: reduceMotion ? "auto" : "smooth" });
        newBelow = 0;
        updateJump();
    });

    function updateJump() {
        const away = Boolean(activeChat) && stream.querySelector(".message-row") && distanceFromBottom() > 240;
        jumpButton.hidden = !away;
        if (!away) newBelow = 0;
        const badge = jumpButton.querySelector(".jump-count");
        badge.hidden = !newBelow;
        badge.textContent = newBelow > 99 ? "99+" : String(newBelow);
    }

    /* ---------- Little delights ---------- */

    function floatEmoji(messageId, emoji) {
        if (reduceMotion) return;
        const content = stream.querySelector(`.message-row[data-message-id="${messageId}"] .message-content`);
        if (!content) return;
        const node = document.createElement("span");
        node.className = "float-emoji";
        node.textContent = emoji;
        node.addEventListener("animationend", () => node.remove());
        content.append(node);
    }

    function burst() {
        if (reduceMotion) return;
        const layer = document.createElement("div");
        layer.className = "confetti";
        layer.setAttribute("aria-hidden", "true");
        const pieces = ["🎉", "✨", "🎊", "⭐"];
        for (let i = 0; i < 18; i += 1) {
            const piece = document.createElement("span");
            piece.textContent = pieces[i % pieces.length];
            piece.style.setProperty("--dx", `${Math.round((Math.random() - 0.5) * 90)}vw`);
            piece.style.setProperty("--dy", `-${40 + Math.round(Math.random() * 40)}vh`);
            piece.style.setProperty("--r", `${Math.round((Math.random() - 0.5) * 720)}deg`);
            piece.style.animationDelay = `${Math.round(Math.random() * 180)}ms`;
            layer.append(piece);
        }
        document.body.append(layer);
        window.setTimeout(() => layer.remove(), 1800);
    }

    /* ---------- Delete (for me has a 5 second Undo) ---------- */

    function markDeleted(data) {
        const id = String(data.message_id);
        const message = { ...(messageCache.get(id) || { id: data.message_id }), deleted: true, body: "", media: null, reactions: [] };
        messageCache.set(id, message);
        patchCached(data.chat_id, id, { deleted: true, body: "", media: null, reactions: [] });
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

    function removeRow(row) {
        const entry = chatCache.get(Number(activeChat?.id));
        if (entry && row.dataset.messageId) entry.messages = entry.messages.filter((item) => String(item.id) !== row.dataset.messageId);
        renderedIds.delete(row.dataset.clientId);
        row.remove();
    }

    function removeMessageRow(id) {
        const row = stream.querySelector(`.message-row[data-message-id="${id}"]`);
        if (!row) return;
        removeRow(row);
        relabelDays();
    }

    function deleteMessage(id, scope, onFail) {
        if (!socket?.connected) {
            showToast("Reconnect to delete messages.");
            onFail?.();
            return;
        }
        socket.emit("message:delete", { message_id: Number(id), scope }, (result) => {
            if (!result?.ok) {
                showToast(result?.error || "Message could not be deleted.");
                onFail?.();
                return;
            }
            if (scope === "me") removeMessageRow(id);
            else markDeleted({ message_id: id, chat_id: activeChat?.id });
        });
    }

    function deleteForMe(id) {
        const row = stream.querySelector(`.message-row[data-message-id="${id}"]`);
        if (!row) {
            deleteMessage(id, "me");
            return;
        }
        row.hidden = true;
        let undone = false;
        const timer = window.setTimeout(() => {
            if (!undone) deleteMessage(id, "me", () => { row.hidden = false; });
        }, 5000);
        showToast("Message deleted for you.", {
            duration: 5000,
            action: { label: "Undo", onClick: () => { undone = true; window.clearTimeout(timer); row.hidden = false; } },
        });
    }

    function confirmDelete(messageId) {
        const message = messageCache.get(String(messageId));
        if (!message || message.deleted) return;
        const dlg = document.createElement("dialog");
        dlg.className = "confirm-dialog";
        dlg.innerHTML = `<div class="confirm-body"><h2>Delete message?</h2><p class="confirm-preview"></p><div class="confirm-actions">${isOwnMessage(message) ? '<button type="button" class="is-danger" data-scope="everyone">Delete for everyone</button>' : ""}<button type="button" class="is-danger" data-scope="me">Delete for me</button><button type="button" data-cancel>Cancel</button></div></div>`;
        dlg.querySelector(".confirm-preview").textContent = previewCore(message).slice(0, 120);
        dlg.addEventListener("click", (event) => {
            const button = event.target.closest("button");
            if (event.target === dlg || button?.hasAttribute("data-cancel")) {
                dlg.close();
            } else if (button?.dataset.scope) {
                dlg.close();
                if (button.dataset.scope === "me") deleteForMe(messageId);
                else deleteMessage(messageId, "everyone");
            }
        });
        dlg.addEventListener("close", () => dlg.remove());
        document.body.append(dlg);
        dlg.showModal();
    }

    /* ---------- Disappearing messages: remove them from screen when time is up ---------- */

    function sweepExpired() {
        if (!activeChat) return;
        const now = Date.now();
        const gone = [...stream.querySelectorAll(".message-row[data-expires]")].filter((row) => Number(row.dataset.expires) <= now);
        if (!gone.length) return;
        gone.forEach(removeRow);
        relabelDays();
        if (!stream.querySelector(".message-row")) showEmptyChat(activeChat);
        updateJump();
        refreshChats();
    }
    window.setInterval(sweepExpired, 4000);

    /* ---------- Reply ---------- */

    const replyBar = document.createElement("div");
    replyBar.className = "reply-bar";
    replyBar.hidden = true;
    replyBar.innerHTML = '<div class="reply-bar-text"><b></b><span></span></div><button type="button" class="reply-cancel" aria-label="Cancel reply">✕</button>';
    composer.before(replyBar);
    replyBar.querySelector(".reply-cancel").addEventListener("click", cancelReply);

    function startReply(messageId) {
        const message = messageCache.get(String(messageId));
        if (!message || message.deleted || message.kind === "system") return;
        if (editingMessageId) cancelEditing();
        replyTo = { id: message.id, body: previewCore(message), sender_id: message.sender_id, sender_name: message.sender_name };
        replyBar.querySelector("b").textContent = isOwnMessage(message) ? "You" : (message.sender_name || activeChat?.title || "Reply");
        replyBar.querySelector("span").textContent = previewCore(message);
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

    /* ---------- Edit (your unsent draft is kept safe while editing) ---------- */

    function startEditing(messageId) {
        const message = messageCache.get(String(messageId));
        if (!message || message.deleted || (message.kind || "text") !== "text") {
            showToast("Only text messages can be edited.");
            return;
        }
        cancelReply();
        if (!editingMessageId) draftBeforeEdit = input.value;
        editingMessageId = Number(messageId);
        input.value = message.body;           // the original text, with its *formatting* marks
        autosize();
        sendButton.setAttribute("aria-label", "Save edited message");
        sendButton.title = "Save edit";
        editCancel.hidden = false;
        input.focus();
        input.setSelectionRange(input.value.length, input.value.length);
    }

    function cancelEditing() {
        editingMessageId = null;
        input.value = draftBeforeEdit;
        draftBeforeEdit = "";
        autosize();
        sendButton.setAttribute("aria-label", "Send message");
        sendButton.title = "Send message";
        editCancel.hidden = true;
    }

    function runMessageAction(name, messageId) {
        if (name === "reply") startReply(messageId);
        else if (name === "edit") startEditing(messageId);
        else if (name === "delete") confirmDelete(messageId);
        else if (name === "star") toggleStar(messageId);
        else if (name === "copy") {
            const message = messageCache.get(String(messageId));
            if (!navigator.clipboard || !message?.body) {
                showToast(message?.body ? "Copy isn’t available here." : "Nothing to copy.");
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
        const message = messageCache.get(String(messageId)) || {};
        const mine = row.classList.contains("message-mine");
        const canEdit = mine && (message.kind || "text") === "text";
        const bubble = row.querySelector(".message-bubble").getBoundingClientRect();
        const reach = RING + ITEM / 2 + 14;
        const rawX = point && point.x > 0 ? point.x : bubble.left + bubble.width / 2;
        const rawY = point && point.y > 0 ? point.y : bubble.top + bubble.height / 2;
        const x = clamp(rawX, reach, window.innerWidth - reach);
        const y = clamp(rawY, reach, window.innerHeight - reach - 56);

        wheel.selected = new Set([...row.querySelectorAll(".reaction-chip.is-selected")].map((chip) => chip.dataset.emoji));
        const quick = [...new Set([...readRecent(), ...quickDefaults])].slice(0, 12);
        wheel.groups = [{ icon: "🕘", name: "Quick", list: quick }, ...emojiGroups];

        const action = (name, icon, label, cls = "") => `<button type="button" class="${cls}" data-act="${name}" aria-label="${label}" title="${label}"><span aria-hidden="true">${icon}</span><span class="lbl">${label}</span></button>`;
        emojiPicker.dataset.mode = "reaction";
        emojiPicker.dataset.messageId = messageId;
        emojiPicker.innerHTML = `<div class="wheel-disc"></div><span class="wheel-pointer"></span>
            <button type="button" class="wheel-close" data-close aria-label="Close reactions">✕</button>
            <div class="wheel-items"></div>
            <div class="wheel-hub"><button type="button" data-cat="-1" aria-label="Previous group">‹</button><div class="wheel-hub-info"><span class="wheel-hub-icon"></span><small class="wheel-hub-name"></small></div><button type="button" data-cat="1" aria-label="Next group">›</button></div>
            <div class="wheel-actions">${action("reply", "↩", "Reply")}${message.body ? action("copy", "⧉", "Copy") : ""}${canEdit ? action("edit", "✎", "Edit") : ""}${action("star", message.starred ? "★" : "☆", message.starred ? "Unstar" : "Star")}${action("delete", "🗑", "Delete", "is-danger")}</div>`;
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
            if (result.reactions.some((item) => item.emoji === emoji && item.reacted)) floatEmoji(messageId, emoji);
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

    /* ---------- Opening chats (instant, with cache) ---------- */

    function leaveChat() {
        stopTyping();
        stopVoice();
        closeEmojiPicker();
        cancelReply();
        if (editingMessageId) cancelEditing();          // puts your earlier draft back first
        if (activeChat?.id) setDraft(activeChat.id, input.value);
        input.value = "";
        autosize();
    }

    function paintHeader(chat) {
        document.querySelector("#conversation-empty").hidden = true;
        document.querySelector("#conversation-active").hidden = false;
        refreshHeader();
        shell.classList.add("chat-open");
    }

    function beginOpen(chat) {
        const token = ++openToken;
        leaveChat();
        activeChat = chat;
        messageCache.clear();
        newBelow = 0;
        document.dispatchEvent(new CustomEvent("lol:chat-change"));
        paintHeader(chat);
        restoreDraft();
        return token;
    }

    async function loadFirstPage(chat, token, hadCache) {
        try {
            const data = await request(`/api/chats/${chat.id}/messages`);
            if (token !== openToken) return;
            chatCache.set(Number(chat.id), { messages: data.messages, hasMore: data.has_more });
            paintMessages(data.messages, data.has_more);
        } catch (error) {
            if (token !== openToken) return;
            if (!hadCache) stream.replaceChildren();
            showToast(error.message);
        }
    }

    function openChat(chat) {
        const token = beginOpen(chat);
        chat.unread = 0;
        renderChatList();
        if (window.matchMedia("(min-width: 821px)").matches) input.focus({ preventScroll: true });
        if (socket) socket.emit("chat:join", { chat_id: chat.id });
        const cached = chatCache.get(Number(chat.id));
        if (cached) {
            const now = Date.now();
            const fresh = cached.messages.filter((message) => !message.expires_at || Date.parse(message.expires_at) > now);
            paintMessages(fresh, cached.hasMore);
        } else {
            showSkeleton();
        }
        return loadFirstPage(chat, token, Boolean(cached));
    }

    async function startChatWith(person) {
        const existing = chats.find((item) => item.type !== "group" && Number(item.other_user_id) === Number(person.id));
        if (existing) {
            openChat(existing);                           // already have it: no network wait at all
            return;
        }
        const provisional = {
            id: null, type: "direct", title: person.display_name, username: person.username,
            avatar_url: person.avatar_url, initial: person.initial, other_user_id: person.id, online: false,
        };
        const token = beginOpen(provisional);
        showSkeleton();
        try {
            const data = await request("/api/chats", { method: "POST", body: JSON.stringify({ user_id: Number(person.id) }) });
            let chat = chats.find((item) => Number(item.id) === Number(data.chat.id));
            if (!chat) {
                chat = data.chat;
                chats.unshift(chat);
            }
            renderChatList();
            if (token !== openToken) return;
            activeChat = chat;
            refreshHeader();
            if (input.value.trim()) setDraft(chat.id, input.value);
            if (socket) socket.emit("chat:join", { chat_id: chat.id });
            if (data.created) {
                showEmptyChat(chat);
                updateJump();
            } else {
                await loadFirstPage(chat, token, false);
            }
        } catch (error) {
            if (token !== openToken) return;
            stream.replaceChildren();
            showToast(error.message);
        }
    }

    /* ---------- Outbox and sending ---------- */

    function readOutbox() {
        try { return JSON.parse(localStorage.getItem(outboxKey) || "[]"); } catch { return []; }
    }

    function saveOutbox(messages) { localStorage.setItem(outboxKey, JSON.stringify(messages.slice(-100))); }

    function receiveMessage(message) {
        cacheIncoming(message);
        if (Number(activeChat?.id) === Number(message.chat_id)) addMessage(message, { scroll: true });
        updateChatSummary(message.chat_id, message);
    }

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
            cacheIncoming(result.message);
            if (Number(activeChat?.id) === Number(result.message.chat_id)) addMessage(result.message, { scroll: true });
            const remaining = readOutbox().filter((item) => item.client_id !== message.client_id);
            saveOutbox(remaining);
        });
    }

    function flushOutbox() {
        readOutbox().forEach(sendQueuedMessage);
    }

    function sendNewMessage(body) {
        if (!activeChat?.id) {
            showToast("Opening the chat… try again in a moment.");
            return false;
        }
        stopTyping();
        const message = { chat_id: activeChat.id, body, client_id: crypto.randomUUID() };
        if (replyTo) message.reply_to_id = replyTo.id;
        const pending = { ...message, kind: "text", sender_id: Number(userId), created_at: new Date().toISOString(), status: "sent" };
        if (replyTo) pending.reply_to = { id: replyTo.id, body: replyTo.body, sender_id: replyTo.sender_id, sender_name: replyTo.sender_name, deleted: false };
        cancelReply();
        addMessage(pending, { scroll: true, live: true });
        updateJump();
        const queue = readOutbox();
        queue.push(message);
        saveOutbox(queue);
        updateChatSummary(activeChat.id, pending);
        sendQueuedMessage(message);
        if (body.includes("🎉")) burst();
        return true;
    }

    /* ---------- People search ---------- */

    async function searchPeople(query) {
        const results = document.querySelector("#people-results");
        if (query.trim().length < 2) {
            results.innerHTML = '<p class="search-hint">Type at least 2 characters to find people.</p>';
            return;
        }
        results.innerHTML = '<p class="search-hint">Looking around…</p>';
        try {
            const data = await request(`/api/users?q=${encodeURIComponent(query.trim())}`);
            lastPeople = data.users;
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
    document.querySelector("#people-results").addEventListener("click", (event) => {
        const button = event.target.closest("[data-user-id]");
        if (!button) return;
        const person = lastPeople.find((item) => Number(item.id) === Number(button.dataset.userId));
        if (!person) return;
        dialog.close();
        startChatWith(person);
    });
    list.addEventListener("click", (event) => {
        const row = event.target.closest("[data-chat-id]");
        if (row) {
            const chat = chats.find((item) => Number(item.id) === Number(row.dataset.chatId));
            if (chat) openChat(chat);
        }
    });
    list.addEventListener("pointerover", (event) => {
        if (event.pointerType !== "mouse") return;
        const row = event.target.closest("[data-chat-id]");
        if (!row) return;
        window.clearTimeout(hoverTimer);
        hoverTimer = window.setTimeout(() => prefetch(row.dataset.chatId), 120);
    });
    list.addEventListener("pointerleave", () => window.clearTimeout(hoverTimer));

    document.querySelector("#back-to-list").addEventListener("click", () => {
        openToken += 1;
        leaveChat();
        activeChat = null;
        shell.classList.remove("chat-open");
        document.dispatchEvent(new CustomEvent("lol:chat-change"));
        renderChatList();
        updateJump();
    });
    document.querySelector("#emoji-toggle").addEventListener("click", () => {
        if (emojiPicker.hidden || emojiPicker.dataset.mode !== "composer") openEmojiPicker("composer");
        else closeEmojiPicker();
    });

    /* swipe a message to the right to reply (touch screens) */
    let swipe = null;
    let swipeJustHappened = false;
    stream.addEventListener("pointerdown", (event) => {
        if (event.pointerType !== "touch") return;
        const row = event.target.closest(".message-row");
        if (!row || !row.dataset.messageId || row.classList.contains("message-system") || row.querySelector(".is-deleted")) return;
        if (event.target.closest(".voice-track, video")) return;
        swipe = { row, id: event.pointerId, x: event.clientX, y: event.clientY, dx: 0, active: false };
    });
    stream.addEventListener("pointermove", (event) => {
        if (!swipe || event.pointerId !== swipe.id) return;
        const dx = event.clientX - swipe.x;
        const dy = event.clientY - swipe.y;
        if (!swipe.active) {
            if (Math.abs(dy) > 12 && Math.abs(dy) > Math.abs(dx)) { swipe = null; return; }
            if (dx > 12 && dx > Math.abs(dy) * 1.5) swipe.active = true;
            else return;
        }
        swipe.dx = clamp(dx, 0, 90);
        swipe.row.style.setProperty("--swipe", `${swipe.dx}px`);
        swipe.row.classList.toggle("swipe-ready", swipe.dx >= 60);
    });
    const endSwipe = (event) => {
        if (!swipe || event.pointerId !== swipe.id) return;
        const { row, dx, active } = swipe;
        swipe = null;
        row.style.removeProperty("--swipe");
        row.classList.remove("swipe-ready");
        if (active) {
            swipeJustHappened = true;
            window.setTimeout(() => { swipeJustHappened = false; }, 350);
            if (dx >= 60) startReply(row.dataset.messageId);
        }
    };
    stream.addEventListener("pointerup", endSwipe);
    stream.addEventListener("pointercancel", endSwipe);

    stream.addEventListener("click", (event) => {
        if (swipeJustHappened) return;
        const icebreaker = event.target.closest("[data-icebreaker]");
        if (icebreaker) {
            sendNewMessage(icebreaker.dataset.icebreaker);
            return;
        }
        const play = event.target.closest(".voice-play");
        if (play) {
            toggleVoice(play.closest(".voice"));
            return;
        }
        const track = event.target.closest(".voice-track");
        if (track) {
            seekVoice(track, event);
            return;
        }
        const photo = event.target.closest("[data-lightbox]");
        if (photo) {
            openLightbox(photo.dataset.lightbox, photo.dataset.name);
            return;
        }
        if (event.target.closest("a, .voice, video")) return;       // links, files and videos do their own thing
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
    // photos load after the page scrolls: keep the bottom in view if you were at the bottom
    stream.addEventListener("load", (event) => {
        if (event.target.tagName === "IMG" && stickBottom) history.scrollTop = history.scrollHeight;
    }, true);

    stream.addEventListener("loadedmetadata", () => {
        if (stickBottom) history.scrollTop = history.scrollHeight;
    }, true);

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
        if (sendNewMessage(body)) {
            input.value = "";
            autosize();
            setDraft(activeChat.id, "");
        }
    });
    input.addEventListener("input", () => {
        autosize();
        if (editingMessageId || !activeChat?.id) return;
        setDraft(activeChat.id, input.value);
        if (input.value.trim()) noteTyping();
        else stopTyping();
    });

    function wrapSelection(mark) {
        const start = input.selectionStart;
        const end = input.selectionEnd;
        const selected = input.value.slice(start, end);
        input.setRangeText(`${mark}${selected}${mark}`, start, end, "end");
        if (!selected) input.setSelectionRange(start + mark.length, start + mark.length);
        input.dispatchEvent(new Event("input", { bubbles: true }));
    }

    input.addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && !event.shiftKey && !event.altKey) {
            const key = event.key.toLowerCase();
            if (key === "b") { event.preventDefault(); wrapSelection("*"); return; }
            if (key === "i") { event.preventDefault(); wrapSelection("_"); return; }
        }
        if (event.key === "Enter" && !event.shiftKey) {
            event.preventDefault();
            composer.requestSubmit();
        }
    });

    history.addEventListener("scroll", () => {
        if (emojiPicker.classList.contains("wheel")) closeEmojiPicker();
        stickBottom = distanceFromBottom() < 120;
        updateJump();
        if (history.scrollTop < 24 && hasMore && oldestMessageId && !loadingOlder && activeChat?.id) {
            loadingOlder = true;
            const token = openToken;
            request(`/api/chats/${activeChat.id}/messages?before=${oldestMessageId}`)
                .then((data) => {
                    if (token !== openToken) return;
                    hasMore = data.has_more;
                    if (!data.messages.length) return;
                    const oldHeight = history.scrollHeight;
                    [...data.messages].reverse().forEach((message) => addMessage(message, { prepend: true, batch: true }));
                    relabelDays();
                    history.scrollTop += history.scrollHeight - oldHeight;
                    oldestMessageId = data.messages[0].id;
                })
                .catch((error) => showToast(error.message))
                .finally(() => { loadingOlder = false; });
        }
    }, { passive: true });

    if (socket) {
        socket.on("connect", flushOutbox);
        socket.on("message:new", (message) => {
            cacheIncoming(message);
            updateChatSummary(message.chat_id, message);
            if (Number(activeChat?.id) === Number(message.chat_id)) {
                const away = distanceFromBottom() > 240;
                addMessage(message, { scroll: true, live: true });
                if (!isOwnMessage(message) && message.kind !== "system") {
                    setTyping(message.chat_id, "", false);
                    if (away) newBelow += 1;
                    if ((message.body || "").includes("🎉")) burst();
                }
                updateJump();
            } else if (!isOwnMessage(message) && message.kind !== "system") {
                setTyping(message.chat_id, "", false);
                socket.emit("message:received", { message_id: message.id, read: false });
            }
        });
        socket.on("typing", (data) => setTyping(data.chat_id, data.name || "Someone", Boolean(data.typing)));
        socket.on("message:status", (data) => updateStatus(data.message_id, data.status));
        socket.on("message:updated", updateMessage);
        socket.on("message:deleted", markDeleted);
        socket.on("message:starred", (data) => applyStar(data.message_id, data.starred));
        socket.on("message:reactions", (data) => renderReactionList(data.message_id, data.reactions));
        socket.on("presence:update", setPresence);
        socket.on("chat:activity", refreshChats);
    }
    document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible" && activeChat?.id && socket?.connected) {
            socket.emit("chat:join", { chat_id: activeChat.id });
        }
    });

    /* ---------- Shared with chat-plus.js (uploads, groups, stars list) ---------- */

    window.LOLChat = {
        userId: Number(userId),
        csrf,
        request,
        showToast,
        escapeHTML,
        escapeAttribute,
        avatarHTML,
        formatBytes,
        previewCore,
        listTime,
        fileIcon,
        getSocket: () => socket,
        getActiveChat: () => activeChat,
        getChats: () => chats,
        getReply: () => replyTo,
        clearReply: cancelReply,
        receiveMessage,
        addChat: upsertChat,
        refreshChats,
        openChat,
        jumpTo,
    };

    renderChatList();
    if (socket) flushOutbox();
})();