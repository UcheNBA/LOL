(() => {
    const root = document.documentElement;
    const savedTheme = localStorage.getItem("lol-theme");
    if (savedTheme === "dark" || savedTheme === "light") root.dataset.theme = savedTheme;

    document.querySelectorAll(".theme-toggle").forEach((button) => {
        button.addEventListener("click", () => {
            root.dataset.theme = root.dataset.theme === "dark" ? "light" : "dark";
            localStorage.setItem("lol-theme", root.dataset.theme);
        });
    });

    document.querySelectorAll(".flash-stack").forEach((stack) => {
        const notices = [...stack.querySelectorAll(".flash:not(.flash-error)")];
        if (notices.length) {
            window.setTimeout(() => {
                stack.classList.add("flash-stack-dismissed");
                window.setTimeout(() => stack.remove(), 250);
            }, 4000);
        }
    });

    if ("serviceWorker" in navigator) {
        window.addEventListener("load", () => navigator.serviceWorker.register("/static/service-worker.js").catch(() => { }));
    }
})();

