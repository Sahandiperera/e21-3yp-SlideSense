// Intersection Observer for reveal animations
const observer = new IntersectionObserver(
    (entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                entry.target.classList.add('vis');
            }
        });
    },
    { threshold: 0.08 }
);

document.querySelectorAll('.rev').forEach((el) => observer.observe(el));

// Interactive feature list (click to activate)
document.querySelectorAll('.fi').forEach((item) => {
    item.addEventListener('click', () => {
        document.querySelectorAll('.fi').forEach((i) => i.classList.remove('act'));
        item.classList.add('act');
    });
});

// Dark / Light mode toggle
(function () {
    const toggle = document.getElementById('theme-toggle');
    const root = document.documentElement;

    // Apply saved preference on page load
    const saved = localStorage.getItem('slidesense-theme');
    if (saved === 'light') {
        root.setAttribute('data-theme', 'light');
    }

    toggle.addEventListener('click', () => {
        const isLight = root.getAttribute('data-theme') === 'light';
        if (isLight) {
            root.removeAttribute('data-theme');
            localStorage.setItem('slidesense-theme', 'dark');
        } else {
            root.setAttribute('data-theme', 'light');
            localStorage.setItem('slidesense-theme', 'light');
        }
    });
})();