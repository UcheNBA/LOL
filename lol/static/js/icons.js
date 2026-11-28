(() => {
    "use strict";

    // [selector, icon name]. The icons themselves are defined in app.css (--i-<name>).
    const MAP = [
        // layout
        [".sidebar-head .new-chat-button", "plus"],
        [".button-primary > span[aria-hidden]", "arrow"],
        [".chat-search > span, .people-search > span", "search"],
        [".empty-graphic, .empty-wave", "message"],
        [".profile-shortcut", "user"],
        [".theme-toggle > span", "contrast"],
        ["#back-to-list", "back"],
        ["#chat-info", "more"],
        [".jump-latest", "down"],
        [".compose-send", "send"],
        [".dialog-dismiss .icon-button, .dlg-close .icon-button, .lol-settings-close .icon-button", "x"],
        // composer
        ["#emoji-toggle", "smile"],
        ["#attach-button", "clip"],
        ["#camera-button", "camera"],
        ["#mic-button", "mic"],
        ["#send-button > span", "send"],
        [".rec-cancel", "trash"],
        [".rec-send", "send"],
        [".reply-cancel, .up-cancel, .wheel-close, .lightbox-close, .lol-find button[data-close]", "x"],
        // message toolbar
        ['.message-action[data-action="react"]', "smile"],
        ['.message-action[data-action="reply"]', "reply"],
        ['.message-action[data-action="star"]', "star"],
        ['.message-action[data-action="edit"]', "pencil"],
        ['.message-action[data-action="delete"]', "trash"],
        // inside messages
        [".voice-play .v-play", "play"],
        [".voice-play .v-pause", "pause"],
        [".file-icon", "file"],
        [".file-dl", "download"],
        [".msg-star", "star-fill"],
        [".msg-timer", "timer"],
        // emoji wheel
        ['.wheel-hub [data-cat="-1"]', "chev-left"],
        ['.wheel-hub [data-cat="1"]', "chev-right"],
        ['.wheel-actions [data-act="reply"] > span:first-child', "reply"],
        ['.wheel-actions [data-act="copy"] > span:first-child', "copy"],
        ['.wheel-actions [data-act="edit"] > span:first-child', "pencil"],
        ['.wheel-actions [data-act="star"] > span:first-child', "star"],
        ['.wheel-actions [data-act="delete"] > span:first-child', "trash"],
        // lists, extras
        [".person-arrow", "chev-right"],
        [".st-un", "star-fill"],
        [".lol-head-actions .icon-button:not(.new-chat-button)", "sliders"],
        [".lol-find-toggle", "search"],
        ['.lol-find button[data-dir="-1"]', "up"],
        ['.lol-find button[data-dir="1"]', "down"],
    ];
    // icon placed before the text
    const LEAD = [[".lightbox-save", "download"]];

    const setIcon = (el, name) => {
        el.dataset.ic = name;
        el.style.setProperty("--ic", `var(--i-${name})`);
    };
    const setLead = (el, name) => {
        el.dataset.icLead = name;
        el.style.setProperty("--ic", `var(--i-${name})`);
    };

    function scan(root) {
        if (root.nodeType !== 1 && root.nodeType !== 9) return;
        const each = (selector, fn) => {
            if (root.nodeType === 1 && root.matches(selector)) fn(root);
            root.querySelectorAll(selector).forEach(fn);
        };
        MAP.forEach(([selector, name]) => each(selector, (el) => { if (!el.dataset.ic) setIcon(el, name); }));
        LEAD.forEach(([selector, name]) => each(selector, (el) => { if (!el.dataset.icLead) setLead(el, name); }));
        each("[data-ic-lead]", (el) => { if (!el.style.getPropertyValue("--ic")) setLead(el, el.dataset.icLead); });
    }

    scan(document);
    new MutationObserver((mutations) => {
        for (const mutation of mutations) mutation.addedNodes.forEach(scan);
    }).observe(document.documentElement, { childList: true, subtree: true });
})();