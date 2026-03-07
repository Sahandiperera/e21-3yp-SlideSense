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

// Typewriter effect
class TypewriterEffect {
    constructor(element, text, speed = 100) {
        this.element = element;
        this.text = text;
        this.speed = speed;
        this.currentIndex = 0;
        this.isDeleting = false;
    }

    start() {
        this.type();
    }

    type() {
        this.element.textContent = this.text.substring(0, this.currentIndex);

        if (!this.isDeleting && this.currentIndex < this.text.length) {
            this.currentIndex++;
            setTimeout(() => this.type(), this.speed);
        } else if (!this.isDeleting && this.currentIndex === this.text.length) {
            setTimeout(() => { this.isDeleting = true; this.type(); }, 2000);
        } else if (this.isDeleting && this.currentIndex > 0) {
            this.currentIndex--;
            setTimeout(() => this.type(), this.speed / 2);
        } else {
            this.isDeleting = false;
            setTimeout(() => this.type(), 500);
        }
    }
}

document.addEventListener('DOMContentLoaded', function () {
    const el = document.querySelector('.typewriter-text');
    if (el) {
        const text = el.getAttribute('data-text');
        const tw = new TypewriterEffect(el, text, 80);
        tw.start();
    }
});

// Mobile nav hamburger
(function () {
    const hamburger = document.getElementById('nav-hamburger');
    const navList = document.querySelector('.nls');
    if (!hamburger || !navList) return;

    hamburger.addEventListener('click', function () {
        const isOpen = navList.classList.toggle('open');
        hamburger.classList.toggle('open', isOpen);
        hamburger.setAttribute('aria-expanded', String(isOpen));
        document.body.style.overflow = isOpen ? 'hidden' : '';
    });

    navList.querySelectorAll('a').forEach(function (link) {
        link.addEventListener('click', function () {
            navList.classList.remove('open');
            hamburger.classList.remove('open');
            hamburger.setAttribute('aria-expanded', 'false');
            document.body.style.overflow = '';
        });
    });
})();

// Architecture layer tab switcher
function arcSwitchTab(index) {
    document.querySelectorAll('.arc-tab').forEach((t, i) => t.classList.toggle('active', i === index));
    document.querySelectorAll('.arc-panel').forEach((p, i) => {
        p.classList.toggle('active', i === index);
        if (i === index) { p.style.animation = 'none'; p.offsetHeight; p.style.animation = ''; }
    });
}