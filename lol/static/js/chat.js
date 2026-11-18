(() => {
    const shell = document.querySelector(".messenger");
    if (!shell) return;

    const csrf = document.querySelector('meta[name="csrf-token"]').content;
    const userId = shell.dataset.userId;
    const initialChats = JSON.parse(document.querySelector("#initial-chats").textContent);
    let chats = initialChats;
    let activeChat = null;
    let loadingOlder = false;
    let hasMore = false;
    let oldestMessageId = null;
    const renderedIds = new Set();
    const list = document.querySelector("#chat-list");
    const history = document.querySelector("#message-history");
    const stream = document.querySelector("#message-stream");
    const composer = document.querySelector("#message-form");
    const input = document.querySelector("#message-input");
    const dialog = document.querySelector("#search-dialog");
    const outboxKey = `lol-outbox-${userId}`;
    const socket = typeof window.io === "function" ? window.io({ reconnection: true, reconnectionDelayMax: 5000 }) : null;

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
        chat.preview = message.body;
        chat.time = formatClock(message.created_at);
        chat.updated_at = message.created_at;
        if (!message.mine && Number(activeChat?.id) !== Number(chatId)) chat.unread = (chat.unread || 0) + 1;
        renderChatList();
    }

    function addMessage(message, { scroll = false, prepend = false } = {}) {
        if (renderedIds.has(String(message.client_id))) return;
        renderedIds.add(String(message.client_id));
        const status = message.mine ? `<span class="message-status status-${message.status || "sent"}" data-message-id="${message.id || ""}" aria-label="${message.status || "sent"}">${message.status === "read" ? "✓✓" : message.status === "delivered" ? "✓✓" : "✓"}</span>` : "";
        const row = document.createElement("article");
        row.className = `message-row ${message.mine ? "message-mine" : "message-theirs"}`;
        row.dataset.messageId = message.id || "";
        row.dataset.clientId = message.client_id;
        row.innerHTML = `<div class="message-bubble"><p>${escapeHTML(message.body)}</p><footer><time>${escapeHTML(message.time || formatClock(message.created_at))}</time>${status}</footer></div>`;
        if (prepend) stream.prepend(row);
        else stream.append(row);
        if (message.id && !message.mine && socket && activeChat) {
            socket.emit("message:received", { message_id: message.id, read: document.visibilityState === "visible" });
        }
        if (message.mine && message.id && message.status) updateStatus(message.id, message.status);
        if (scroll) history.scrollTop = history.scrollHeight;
    }

    function updateStatus(messageId, status) {
        const element = stream.querySelector(`.message-status[data-message-id="${messageId}"]`);
        if (!element) return;
        element.className = `message-status status-${status}`;
        element.textContent = status === "sent" ? "✓" : "✓✓";
        element.setAttribute("aria-label", status);
    }

    async function loadMessages(chatId, before = null) {
        const url = new URL(`/api/chats/${chatId}/messages`, location.origin);
        if (before) url.searchParams.set("before", before);
        const data = await request(url);
        hasMore = data.has_more;
        if (data.messages.length) {
            if (before) {
                const oldHeight = history.scrollHeight;
                data.messages.forEach((message) => addMessage(message, { prepend: true }));
                history.scrollTop += history.scrollHeight - oldHeight;
            } else {
                data.messages.forEach((message) => addMessage(message));
                history.scrollTop = history.scrollHeight;
            }
            oldestMessageId = data.messages[0].id;
        }
    }

    async function openChat(chat) {
        activeChat = chat;
        document.querySelector("#conversation-empty").hidden = true;
        document.querySelector("#conversation-active").hidden = false;
        document.querySelector("#active-title").textContent = chat.title;
        document.querySelector("#active-subtitle").textContent = chat.username ? `@${chat.username}` : "A direct conversation";
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
        input.focus();
    }

    function readOutbox() {
        try { return JSON.parse(localStorage.getItem(outboxKey) || "[]"); } catch { return []; }
    }

    function saveOutbox(messages) { localStorage.setItem(outboxKey, JSON.stringify(messages.slice(-100))); }

    function sendQueuedMessage(message) {
        if (!socket?.connected) return;
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
    document.querySelector("#back-to-list").addEventListener("click", () => shell.classList.remove("chat-open"));
    composer.addEventListener("submit", (event) => {
        event.preventDefault();
        const body = input.value.trim();
        if (!body || !activeChat) return;
        const message = { chat_id: activeChat.id, body, client_id: crypto.randomUUID() };
        input.value = "";
        input.style.height = "auto";
        const pending = { ...message, created_at: new Date().toISOString(), time: formatClock(new Date()), mine: true, status: "sent" };
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
        if (history.scrollTop < 24 && hasMore && oldestMessageId && !loadingOlder && activeChat) {
            loadingOlder = true;
            loadMessages(activeChat.id, oldestMessageId).finally(() => { loadingOlder = false; });
        }
    });
    if (socket) {
        socket.on("connect", flushOutbox);
        socket.on("message:new", (message) => {
            updateChatSummary(message.chat_id, message);
            if (Number(activeChat?.id) === Number(message.chat_id)) addMessage(message, { scroll: true });
            else if (!message.mine) socket.emit("message:received", { message_id: message.id, read: false });
        });
        socket.on("message:status", (data) => updateStatus(data.message_id, data.status));
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